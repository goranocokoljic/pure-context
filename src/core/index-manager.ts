import { readFileSync, unlinkSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { cpus } from 'os';
import type Database from 'better-sqlite3';
import type { IndexOptions, IndexResult, ImportRecord, SymbolRecord } from './types.js';
import { IndexError } from './errors.js';
import { logger } from './logger.js';
import {
  computeRepoId,
  openDatabase,
  getIndexDir,
  upsertRepo,
  getRepo,
  SCHEMA_VERSION,
} from './db/schema.js';
import { insertSymbols, deleteByFile, getSymbolsByRepo, getSymbolsByFile, updateSymbolSummaries } from './db/symbol-store.js';
import { upsertFile, deleteFile, getAllFileHashes } from './db/file-store.js';
import {
  insertEdges,
  deleteEdgesByFile,
  getForwardDeps,
  getReverseDeps,
} from './db/dep-store.js';
import { discoverFiles, DEFAULT_FILE_LIMIT } from './file-discovery.js';
import { createHashCache, computeHash } from './hash-cache.js';
import { initParser, isInitialized } from './parse-dispatcher.js';
import { getSupportedExtensions } from '../handlers/handler-registry.js';
import { getAdapterExtensions, getRegisteredAdapters } from '../adapters/adapter-registry.js';
import { processFile } from './file-processor.js';
import { createWorkerPool } from './worker-pool.js';
import type { ParseJob } from './worker-pool.js';
import { createResolver } from '../graph/path-resolver.js';
import { buildGraph } from '../graph/graph-builder.js';
import { join } from 'path';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Index a folder end-to-end:
 * discover files → parse → extract symbols + imports → build dep graph → persist.
 */
export async function indexFolder(
  rootPath: string,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const absRoot = resolve(rootPath);
  const repoId = computeRepoId(absRoot);
  const start = Date.now();

  logger.info(`Indexing ${absRoot} (repo ${repoId})`);

  // ── 1. Open database and ensure repo row exists ───────────────────────────
  const db = openDatabase(repoId);
  upsertRepo(db, {
    id: repoId,
    rootPath: absRoot,
    symbolCount: 0,
    fileCount: 0,
    languages: ['typescript', 'javascript'],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: options.clonePath ?? null,
  });

  // ── 2. Ensure parser is ready ──────────────────────────────────────────────
  if (!isInitialized()) {
    await initParser();
  }

  // ── 3. Discover files ─────────────────────────────────────────────────────
  const adapters = options.adapters ?? [];
  const allExtensions = [...getSupportedExtensions(), ...getAdapterExtensions(adapters)];

  const discovered = discoverFiles(absRoot, {
    extensions: allExtensions,
    fileLimit: options.fileLimit ?? DEFAULT_FILE_LIMIT,
    extraExcludePatterns: options.excludePatterns,
  });

  // ── 3b. Filter to files with known language handlers OR active adapters ──
  const supportedExts = new Set(getSupportedExtensions());
  const adapterExts = new Set(getAdapterExtensions(adapters));
  const supportedFiles = discovered.filter((df) => {
    const dot = df.path.lastIndexOf('.');
    const ext = dot >= 0 ? df.path.slice(dot) : '';
    return supportedExts.has(ext) || adapterExts.has(ext);
  });

  // ── 4. Load hash cache from DB ────────────────────────────────────────────
  const cache = createHashCache();
  const existingHashes = getAllFileHashes(db, repoId);
  for (const [path, hash] of existingHashes) {
    cache.set(path, hash);
  }

  // ── 5. Filter to changed / new files (carry content to avoid double-read) ──
  interface FileEntry { relPath: string; content: Buffer; hash: string }
  const toProcess: FileEntry[] = [];
  let filesSkipped = 0;

  for (const df of supportedFiles) {
    let content: Buffer;
    try {
      content = readFileSync(join(absRoot, df.path));
    } catch {
      filesSkipped++;
      continue;
    }
    const hash = computeHash(content);
    if (!cache.hasChanged(df.path, hash)) {
      filesSkipped++;
      continue;
    }
    toProcess.push({ relPath: df.path, content, hash });
  }

  logger.info(`${toProcess.length} files to process, ${filesSkipped} unchanged`);

  // ── 6–9. Process each changed file ────────────────────────────────────────
  const resolver = createResolver(absRoot);
  const allImports: ImportRecord[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  let symbolsFound = 0;

  const concurrency = Math.min(options.concurrency ?? cpus().length, 8);

  // Parallel path requires that every active adapter is a standard registered
  // adapter (workers import all standard adapters). Custom/test adapters that
  // aren't in the registry would be silently ignored by workers, causing
  // missing symbols. Fall back to sequential for those cases.
  const knownAdapterNames = new Set(getRegisteredAdapters().map((a) => a.name));
  const canParallelize = adapters.every((a) => knownAdapterNames.has(a.name));

  if (concurrency > 1 && toProcess.length > 1 && canParallelize) {
    // ── Parallel path: dispatch to worker thread pool ──────────────────────
    const pool = createWorkerPool(concurrency);
    try {
      const adapterNames = adapters.map((a) => a.name);
      const jobs: ParseJob[] = toProcess.map(({ relPath, content }) => ({
        relPath,
        // Uint8Array view over the Buffer — structured clone copies just this slice.
        content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
        adapterNames,
      }));

      const parseResults = await pool.run(jobs);

      // Single outer transaction for all DB writes — major speedup on spinning disk.
      db.transaction(() => {
        for (let i = 0; i < parseResults.length; i++) {
          const pr = parseResults[i];
          const { relPath, content, hash } = toProcess[i];

          if (pr.error) {
            errors.push({ file: pr.relPath, message: pr.error });
            logger.warn(`Worker failed to process ${pr.relPath}: ${pr.error}`);
            continue;
          }

          if (pr.symbols.length === 0 && pr.imports.length === 0) {
            filesSkipped++;
            continue;
          }

          allImports.push(...pr.imports);

          deleteByFile(db, repoId, relPath);
          deleteEdgesByFile(db, repoId, relPath);
          if (pr.symbols.length > 0) {
            insertSymbols(db, repoId, pr.symbols);
          }
          symbolsFound += pr.symbols.length;

          upsertFile(db, repoId, relPath, hash, content);
          cache.set(relPath, hash);

          logger.debug(`Processed ${relPath}: ${pr.symbols.length} symbols, ${pr.imports.length} imports`);
        }
      })();
    } finally {
      await pool.terminate();
    }
  } else {
    // ── Sequential path: concurrency=1 or single file ─────────────────────
    for (const entry of toProcess) {
      const { relPath, content, hash } = entry;

      try {
        const { symbols, imports } = await processFile(relPath, content, adapters);

        if (symbols.length === 0 && imports.length === 0) {
          // No handler and no adapter matched — skip silently
          filesSkipped++;
          continue;
        }

        allImports.push(...imports);

        // Persist: clear old data for this file, insert new
        deleteByFile(db, repoId, relPath);
        deleteEdgesByFile(db, repoId, relPath);
        if (symbols.length > 0) {
          insertSymbols(db, repoId, symbols);
        }
        symbolsFound += symbols.length;

        // Update file record (hash already computed in step 5)
        upsertFile(db, repoId, relPath, hash, content);
        cache.set(relPath, hash);

        logger.debug(`Processed ${relPath}: ${symbols.length} symbols, ${imports.length} imports`);
      } catch (err) {
        errors.push({
          file: relPath,
          message: err instanceof Error ? err.message : String(err),
        });
        logger.warn(`Failed to process ${relPath}: ${err}`);
      }
    }
  }

  // ── 10. Build and store dependency graph ─────────────────────────────────
  const edges = buildGraph(allImports, resolver, repoId);
  if (edges.length > 0) {
    insertEdges(db, edges);
  }

  // ── 10b. Stage 3: AI summarization (optional) ────────────────────────────
  // ── 10c. Semantic indexing (Phase 11, optional) ───────────────────────────
  // Load all symbols once if either post-processor needs them — avoids up to
  // three separate full-table scans for repos with many symbols.
  const allRepoSymbols =
    options.semanticIndexer || options.aiSummarizer
      ? getSymbolsByRepo(db, repoId)
      : [];

  if (options.semanticIndexer) {
    if (options.semanticIndexer.shouldIndex(repoId, allRepoSymbols.length)) {
      logger.info(`Semantic indexing: ${allRepoSymbols.length} symbols`);
      try {
        const semanticResult = await options.semanticIndexer.index(repoId, allRepoSymbols, db);
        logger.info(
          `Semantic index built: ${semanticResult.symbolsIndexed} symbols in ` +
            `${semanticResult.embeddingTimeMs + semanticResult.indexBuildTimeMs}ms`,
        );
      } catch (err) {
        logger.warn(`Semantic indexing failed: ${err}`);
      }
    } else {
      logger.debug('Semantic indexing skipped (threshold not met or disabled)');
    }
  }

  if (options.aiSummarizer) {
    // Filter to symbols that still fall back to the signature (no docstring/framework summary).
    const needsSummary = allRepoSymbols.filter(
      (s) => !s.summary || s.summary === s.signature.slice(0, 100).trim(),
    );

    if (needsSummary.length > 0) {
      logger.info(`AI summarizing ${needsSummary.length} symbols`);
      try {
        const aiSummaries = await options.aiSummarizer.summarizeBatch(needsSummary);
        if (aiSummaries.size > 0) {
          updateSymbolSummaries(db, repoId, aiSummaries);
          logger.info(`AI summaries applied to ${aiSummaries.size} symbols`);
        }
      } catch (err) {
        logger.warn(`AI summarization failed: ${err}`);
      }
    }
  }

  // ── 11. Update repo metadata ──────────────────────────────────────────────
  const totalSymbols =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?')
      .get(repoId)?.c ?? 0;
  const totalFiles =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM files WHERE repo_id = ?')
      .get(repoId)?.c ?? 0;

  upsertRepo(db, {
    id: repoId,
    rootPath: absRoot,
    symbolCount: totalSymbols,
    fileCount: totalFiles,
    languages: ['typescript', 'javascript'],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: options.clonePath ?? null,
  });

  db.close();

  const result: IndexResult = {
    repoId,
    filesIndexed: toProcess.length,
    filesSkipped,
    symbolsFound,
    totalSymbolsInDb: totalSymbols,
    totalFilesInDb: totalFiles,
    edgesFound: edges.length,
    durationMs: Date.now() - start,
    errors,
  };

  logger.info(
    `Index complete: ${result.filesIndexed} files, ${result.symbolsFound} symbols, ` +
      `${result.edgesFound} edges in ${result.durationMs}ms`,
  );

  return result;
}

/**
 * Re-index a specific set of files (fast path for watcher events).
 * Handles additions, modifications, and deletions.
 */
export async function reindexFiles(
  repoId: string,
  changedPaths: string[],
  deletedPaths: string[] = [],
  options?: Pick<IndexOptions, 'adapters' | 'aiSummarizer' | 'semanticIndexer'>,
): Promise<IndexResult> {
  const start = Date.now();
  const db = openDatabase(repoId);
  const repo = getRepo(db, repoId);

  if (!repo) {
    db.close();
    throw new IndexError(
      `Repository ${repoId} not found — run indexFolder first`,
      'reindexFiles',
    );
  }

  const absRoot = repo.rootPath;

  if (!isInitialized()) {
    await initParser();
  }

  // ── Handle deletions ──────────────────────────────────────────────────────
  for (const relPath of deletedPaths) {
    deleteByFile(db, repoId, relPath);
    deleteEdgesByFile(db, repoId, relPath);
    deleteFile(db, repoId, relPath);
    logger.debug(`Removed ${relPath} from index`);
  }

  // ── Re-process changed/added files ────────────────────────────────────────
  const adapters = options?.adapters ?? [];
  const resolver = createResolver(absRoot);
  const allImports: ImportRecord[] = [];
  const errors: Array<{ file: string; message: string }> = [];
  let symbolsFound = 0;
  let filesSkipped = 0;

  for (const relPath of changedPaths) {
    const absPath = join(absRoot, relPath);
    let content: Buffer;
    try {
      content = readFileSync(absPath);
    } catch (err) {
      errors.push({ file: relPath, message: String(err) });
      filesSkipped++;
      continue;
    }

    try {
      const { symbols, imports } = await processFile(relPath, content, adapters);

      if (symbols.length === 0 && imports.length === 0) {
        filesSkipped++;
        continue;
      }

      allImports.push(...imports);

      deleteByFile(db, repoId, relPath);
      deleteEdgesByFile(db, repoId, relPath);
      if (symbols.length > 0) {
        insertSymbols(db, repoId, symbols);
      }
      symbolsFound += symbols.length;

      const hash = computeHash(content);
      upsertFile(db, repoId, relPath, hash, content);

      logger.debug(`Re-indexed ${relPath}: ${symbols.length} symbols`);
    } catch (err) {
      errors.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Build edges only for the re-processed files
  const edges = buildGraph(allImports, resolver, repoId);
  if (edges.length > 0) {
    insertEdges(db, edges);
  }

  // ── Re-summarize changed symbols with AI (if available) ───────────────────
  if (options?.aiSummarizer && changedPaths.length > 0) {
    // Collect newly-indexed symbols that still fall back to the signature summary
    // (those are candidates for AI summarization)
    const changedSymbols: SymbolRecord[] = [];
    for (const relPath of changedPaths) {
      changedSymbols.push(...getSymbolsByFile(db, repoId, relPath));
    }

    const needsSummary = changedSymbols.filter(
      (s) => !s.summary || s.summary === s.signature.slice(0, 100).trim(),
    );

    if (needsSummary.length > 0) {
      logger.info(`AI re-summarizing ${needsSummary.length} changed symbols`);
      try {
        const aiSummaries = await options.aiSummarizer.summarizeBatch(needsSummary);
        if (aiSummaries.size > 0) {
          updateSymbolSummaries(db, repoId, aiSummaries);
          logger.info(`AI re-summaries applied to ${aiSummaries.size} symbols`);
        }
      } catch (err) {
        logger.warn(`AI re-summarization failed: ${err}`);
      }
    }
  }

  // ── Semantic incremental update (Phase 11, optional) ─────────────────────
  if (options?.semanticIndexer) {
    // Collect the symbols that were just indexed (added/modified)
    const addedSymbols: SymbolRecord[] = [];
    for (const relPath of changedPaths) {
      addedSymbols.push(...getSymbolsByFile(db, repoId, relPath));
    }

    // Deleted symbols are identified by their file path — we removed them from
    // the DB already, so we can't look them up. We pass empty string IDs here
    // and rely on the HNSW remove being a no-op for unknown IDs.
    // For a real implementation the watcher would track symbol IDs before deletion.
    const removedIds: string[] = [];

    if (addedSymbols.length > 0 || removedIds.length > 0) {
      try {
        await options.semanticIndexer.updateIncremental(repoId, addedSymbols, removedIds, db);
      } catch (err) {
        logger.warn(`Semantic incremental update failed: ${err}`);
      }
    }
  }

  // Update repo metadata counts
  const totalSymbols =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ?')
      .get(repoId)?.c ?? 0;
  const totalFiles =
    db.prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM files WHERE repo_id = ?')
      .get(repoId)?.c ?? 0;
  upsertRepo(db, {
    ...repo,
    symbolCount: totalSymbols,
    fileCount: totalFiles,
    indexedAt: Date.now(),
  });

  db.close();

  return {
    repoId,
    filesIndexed: changedPaths.length - filesSkipped,
    filesSkipped,
    symbolsFound,
    totalSymbolsInDb: totalSymbols,
    totalFilesInDb: totalFiles,
    edgesFound: edges.length,
    durationMs: Date.now() - start,
    errors,
  };
}

/**
 * Remove the SQLite index file for a repo. No-op if it does not exist.
 * If the repo was cloned (clonePath is set), also removes the clone directory.
 */
export function deleteIndex(repoId: string, indexDir?: string): void {
  const dir = indexDir ?? getIndexDir();
  const dbPath = join(dir, `${repoId}.db`);

  // Read clone path BEFORE deleting the database
  let clonePath: string | null = null;
  if (existsSync(dbPath)) {
    try {
      const db = openDatabase(repoId, dir);
      const meta = getRepo(db, repoId);
      clonePath = meta?.clonePath ?? null;
      db.close();
    } catch {
      // If we can't read the DB, skip clone removal
    }
    unlinkSync(dbPath);
    logger.info(`Deleted index for repo ${repoId}`);
  }

  // Remove clone directory if present
  if (clonePath && existsSync(clonePath)) {
    rmSync(clonePath, { recursive: true });
    logger.info(`Deleted clone dir ${clonePath}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Re-export for consumers that only need the ID computation
export { computeRepoId } from './db/schema.js';
