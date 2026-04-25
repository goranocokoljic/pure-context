import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import ignore, { type Ignore } from 'ignore';
import type { DiscoveredFile } from './types.js';
import { isSecretFile, isBinaryFile, peekFileContent, checkFileSize, DEFAULT_MAX_FILE_BYTES } from './security.js';
import { logger } from './logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BUILT_IN_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.claude',
  '.env',
  '.env.*',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/** Higher number = higher priority (indexed first). */
const PRIORITY_MAP: Array<[string, number]> = [
  ['src', 100],
  ['lib', 90],
  ['app', 80],
  ['pages', 70],
  ['components', 60],
  ['server', 50],
  // default: 30 (see getPriority)
  ['test', 20],
  ['__tests__', 10],
];

export const DEFAULT_FILE_LIMIT = 1000;

// ─── Options ──────────────────────────────────────────────────────────────────

export interface DiscoveryOptions {
  extensions?: string[];
  fileLimit?: number;
  extraExcludePatterns?: string[];
  /** Maximum file size in bytes — files larger than this are skipped. Default: 1 MB. */
  maxFileSizeBytes?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function discoverFiles(
  rootPath: string,
  options: DiscoveryOptions = {},
): DiscoveredFile[] {
  const {
    extensions,
    fileLimit = DEFAULT_FILE_LIMIT,
    extraExcludePatterns = [],
    maxFileSizeBytes = DEFAULT_MAX_FILE_BYTES,
  } = options;

  const ig = buildIgnoreFilter(rootPath, extraExcludePatterns);
  const results: DiscoveredFile[] = [];

  walk(rootPath, rootPath, ig, extensions, maxFileSizeBytes, results);

  results.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.path.localeCompare(b.path);
  });

  return results.slice(0, fileLimit);
}

// ─── Internals ────────────────────────────────────────────────────────────────

function buildIgnoreFilter(rootPath: string, extra: string[]): Ignore {
  const ig = ignore();
  ig.add(BUILT_IN_EXCLUDES);
  ig.add(extra);

  try {
    const gitignorePath = join(rootPath, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf8');
    ig.add(content);
  } catch {
    // No .gitignore present — that's fine.
  }

  return ig;
}

function walk(
  rootPath: string,
  currentPath: string,
  ig: Ignore,
  extensions: string[] | undefined,
  maxFileSizeBytes: number,
  results: DiscoveredFile[],
): void {
  let entries;
  try {
    entries = readdirSync(currentPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absPath = join(currentPath, entry.name);
    // Relative path from root, using forward slashes (ignore package expects /)
    const relPath = relative(rootPath, absPath).split(sep).join('/');

    if (ig.ignores(relPath)) continue;

    if (entry.isDirectory()) {
      // Also prune if the directory name alone is ignored (e.g. node_modules)
      if (!ig.ignores(entry.name + '/')) {
        walk(rootPath, absPath, ig, extensions, maxFileSizeBytes, results);
      }
      continue;
    }

    if (!entry.isFile()) continue;

    if (extensions) {
      const dot = entry.name.lastIndexOf('.');
      if (dot === -1) continue;
      const ext = entry.name.slice(dot);
      if (!extensions.includes(ext)) continue;
    }

    // Skip files matching credential/secret patterns
    if (isSecretFile(entry.name)) {
      logger.debug('Skipping secret file', { path: relPath });
      continue;
    }

    let size = 0;
    try {
      size = statSync(absPath).size;
    } catch {
      // skip unreadable files
      continue;
    }

    // Skip files exceeding the size limit
    try {
      checkFileSize(size, maxFileSizeBytes);
    } catch {
      logger.warn('Skipping oversized file', { path: relPath, size, maxFileSizeBytes });
      continue;
    }

    // Skip binary files (detect via null-byte scan of first 8 KB)
    const peek = peekFileContent(absPath);
    if (isBinaryFile(peek)) {
      logger.debug('Skipping binary file', { path: relPath });
      continue;
    }

    results.push({
      path: relPath,
      size,
      priority: getPriority(relPath),
    });
  }
}

function getPriority(relPath: string): number {
  const topDir = relPath.split('/')[0];
  for (const [name, priority] of PRIORITY_MAP) {
    if (topDir === name) return priority;
  }
  return 30;
}
