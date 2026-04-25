import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { relative, resolve } from 'path';
import { logger } from '../logger.js';
import { reindexFiles } from '../index-manager.js';
import { getSupportedExtensions } from '../../handlers/handler-registry.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WatchOptions {
  debounceMs?: number;
}

export interface FileWatcher {
  /** Resolves once chokidar has finished its initial scan and is ready to receive events. */
  ready: Promise<void>;
  /** Stop watching and clean up the chokidar instance. */
  stop(): Promise<void>;
}

// ─── Default ignore patterns ──────────────────────────────────────────────────

const IGNORE_PATTERNS = [
  /(^|[/\\])\../,          // dotfiles / dotdirs
  /node_modules/,
  /[/\\]\.git([/\\]|$)/,
  /[/\\]dist([/\\]|$)/,
  /[/\\]build([/\\]|$)/,
  /[/\\]\.claude([/\\]|$)/,
  /[/\\]coverage([/\\]|$)/,
  /\.lock$/,
  /\.log$/,
];

const DEFAULT_DEBOUNCE_MS = 2000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start watching `rootPath` for changes. When files are added, modified, or
 * deleted, the relevant paths are batched during the debounce window and then
 * flushed to `reindexFiles`.
 *
 * Only files with a registered language handler extension are considered.
 */
export function startWatching(
  rootPath: string,
  repoId: string,
  options: WatchOptions = {},
): FileWatcher {
  const absRoot = resolve(rootPath);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const supportedExts = new Set(getSupportedExtensions());

  // Batches of paths accumulated during the debounce window
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function hasHandler(filePath: string): boolean {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot) : '';
    return supportedExts.has(ext);
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  async function flush(): Promise<void> {
    timer = null;

    const changedPaths = [...changed];
    const deletedPaths = [...deleted];
    changed.clear();
    deleted.clear();

    if (changedPaths.length === 0 && deletedPaths.length === 0) return;

    logger.info(
      `Watcher: flushing ${changedPaths.length} changed, ` +
      `${deletedPaths.length} deleted in repo ${repoId}`,
    );

    try {
      const result = await reindexFiles(repoId, changedPaths, deletedPaths);
      logger.info(
        `Watcher reindex complete: ${result.filesIndexed} files, ` +
        `${result.symbolsFound} symbols in ${result.durationMs}ms`,
      );
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          logger.warn(`Watcher reindex error in ${e.file}: ${e.message}`);
        }
      }
    } catch (err) {
      logger.error(`Watcher reindex failed: ${err}`);
    }
  }

  const watcher: FSWatcher = chokidarWatch(absRoot, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,    // Don't fire for files already on disk at startup
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  const readyPromise = new Promise<void>((resolve) => {
    watcher.once('ready', resolve);
  });

  watcher.on('add', (absPath: string) => {
    const rel = relative(absRoot, absPath).replace(/\\/g, '/');
    if (!hasHandler(rel)) return;
    logger.debug(`Watcher: add ${rel}`);
    changed.add(rel);
    deleted.delete(rel);   // no longer deleted if re-added
    schedule();
  });

  watcher.on('change', (absPath: string) => {
    const rel = relative(absRoot, absPath).replace(/\\/g, '/');
    if (!hasHandler(rel)) return;
    logger.debug(`Watcher: change ${rel}`);
    changed.add(rel);
    schedule();
  });

  watcher.on('unlink', (absPath: string) => {
    const rel = relative(absRoot, absPath).replace(/\\/g, '/');
    if (!hasHandler(rel)) return;
    logger.debug(`Watcher: unlink ${rel}`);
    deleted.add(rel);
    changed.delete(rel);   // don't try to re-index a deleted file
    schedule();
  });

  watcher.on('error', (err: unknown) => {
    logger.error(`Watcher error: ${err}`);
  });

  logger.info(`Watching ${absRoot} (repo ${repoId}, debounce ${debounceMs}ms)`);

  return {
    ready: readyPromise,
    async stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
      logger.info(`Watcher stopped for ${absRoot}`);
    },
  };
}
