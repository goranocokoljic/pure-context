import { readFileSync, unlinkSync, existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { cpus } from 'os';
import type Database from 'better-sqlite3';
import type { IndexOptions, IndexResult, ImportRecord, SymbolRecord } from './types.js';
import { IndexError, WorkspaceLimitError } from './errors.js';
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
import { getAdapterExtensions, getRegisteredAdapters, discoverAdapters } from '../adapters/adapter-registry.js';
import { getConfig } from '../config/config-loader.js';
import { processFile } from './file-processor.js';
import { createWorkerPool } from './worker-pool.js';
import type { ParseJob } from './worker-pool.js';
import { createResolver } from '../graph/path-resolver.js';
import { buildGraph } from '../graph/graph-builder.js';
import { createJvmResolver, isDeclaredModuleSourceFile } from '../graph/jvm-resolver.js';
import { join } from 'path';
import { track } from './telemetry.js';
import { discoverProviders } from '../providers/provider-registry.js';
import { isGitRepo, readRepoFileHistories, readRepoCommitFiles } from './git-log-reader.js';
import { updateFileGitMeta } from './db/file-store.js';
import { insertGitCommits, deleteGitMetadataForFile } from './db/git-metadata-store.js';
import { insertCommitFiles, deleteCommitFilesForRepo } from './db/co-change-store.js';
import { buildTestMappings } from './test-mapper.js';

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

  // ── 0. Workspace plan limits ──────────────────────────────────────────────
  const FREE_REPO_LIMIT = 999;   // Temporarily unlimited — enforce when paid plans launch
  const FREE_FILE_LIMIT = 10_000_000; // Temporarily unlimited — enforce when paid plans launch

  if (options.workspacePlan === 'free') {
    // Repo count limit
    if (options.workspaceRepoCount !== undefined && options.workspaceRepoCount >= FREE_REPO_LIMIT) {
      throw new WorkspaceLimitError('repos', FREE_REPO_LIMIT, options.workspaceRepoCount);
    }
  }

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
    tenantId: options.tenantId ?? 'local',
  });

  // ── 2. Ensure parser is ready ──────────────────────────────────────────────
  if (!isInitialized()) {
    await initParser();
  }

  // ── 3. Discover files ─────────────────────────────────────────────────────
  // Auto-discover active framework adapters when the caller didn't supply an
  // explicit set. Without this, adapter-only extensions (e.g. `.vue`) are never
  // added to the discovery allowlist, so those files are silently skipped — and
  // framework symbol extraction (Vue SFC <script> parsing, route metadata, …)
  // never runs. Adapters must be registered in this process (the MCP server
  // entry and the worker both import every standard adapter for self-registration).
  const adapters =
    options.adapters ?? (await discoverAdapters(absRoot, { adapters: getConfig().adapters }));
  const allExtensions = [...getSupportedExtensions(), ...getAdapterExtensions(adapters)];
  const effectiveFileLimit = options.fileLimit ?? DEFAULT_FILE_LIMIT;

  const { files: discovered, totalBeforeLimit } = discoverFiles(absRoot, {
    extensions: allExtensions,
    fileLimit: effectiveFileLimit,
    extraExcludePatterns: options.excludePatterns,
    ...(options.maxFileSizeBytes !== undefined && { maxFileSizeBytes: options.maxFileSizeBytes }),
    ...(options.extensionlessFilenames && { extensionlessFilenames: options.extensionlessFilenames }),
  });

  // ── 3b. Filter to files with known language handlers OR active adapters ──
  const supportedExts = new Set(getSupportedExtensions());
  const adapterExts = new Set(getAdapterExtensions(adapters));
  // Extensionless files: basename → routed via shebang in file-processor
  const extensionlessAllowlist = options.extensionlessFilenames
    ? new Set(options.extensionlessFilenames)
    : null; // null = allow all extensionless files (shebang detection handles them)
  const supportedFiles = discovered.filter((df) => {
    const dot = df.path.lastIndexOf('.');
    const ext = dot >= 0 ? df.path.slice(dot).toLowerCase() : '';
    if (ext === '') {
      if (extensionlessAllowlist === null) return true; // allow all; shebang detection filters
      const base = df.path.split('/').pop() ?? df.path;
      return extensionlessAllowlist.has(base);
    }
    return supportedExts.has(ext) || adapterExts.has(ext);
  });

  // ── 3c-ws. Workspace file limit ───────────────────────────────────────────
  if (options.workspacePlan === 'free' && totalBeforeLimit > FREE_FILE_LIMIT) {
    db.close();
    throw new WorkspaceLimitError('files', FREE_FILE_LIMIT, totalBeforeLimit);
  }

  // ── 3c. Check if fileLimit was hit ────────────────────────────────────────
  const warnings: string[] = [];
  const limitSkipped =
    effectiveFileLimit > 0 && totalBeforeLimit > effectiveFileLimit
      ? totalBeforeLimit - effectiveFileLimit
      : 0;

  if (limitSkipped > 0) {
    const msg =
      `fileLimit of ${effectiveFileLimit} reached — ${limitSkipped} file(s) were skipped. ` +
      `Raise 'fileLimit' in ~/.purecontext/config.json to index the full project.`;
    warnings.push(msg);
    logger.warn(msg);
  }

  // ── 4. Load hash cache from DB ────────────────────────────────────────────
  const cache = createHashCache();
  const existingHashes = getAllFileHashes(db, repoId);
  for (const [path, hash] of existingHashes) {
    cache.set(path, hash);
  }

  // ── 5. Filter to changed / new files (carry content to avoid double-read) ──
  interface FileEntry { relPath: string; content: Buffer; hash: string }
  const toProcess: FileEntry[] = [];
  let filesSkipped = limitSkipped;

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

          allImports.push(...pr.imports);

          deleteByFile(db, repoId, relPath);
          deleteEdgesByFile(db, repoId, relPath);
          if (pr.symbols.length > 0) {
            insertSymbols(db, repoId, pr.symbols);
          }
          symbolsFound += pr.symbols.length;

          // Always persist the file record — even when this file yielded 0 symbols
          // AND 0 imports. Skipping the upsert here was the cause of the recurring
          // re-parse churn: such files were never recorded, so every subsequent
          // no-op index re-read and re-parsed them. Recording the hash lets the
          // next run recognise them as unchanged and skip them.
          upsertFile(db, repoId, relPath, hash, content, 'local', pr.declaredPackage ?? null);
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
        const { symbols, imports, declaredPackage } = await processFile(relPath, content, adapters);

        allImports.push(...imports);

        // Persist: clear old data for this file, insert new
        deleteByFile(db, repoId, relPath);
        deleteEdgesByFile(db, repoId, relPath);
        if (symbols.length > 0) {
          insertSymbols(db, repoId, symbols);
        }
        symbolsFound += symbols.length;

        // Update file record (hash already computed in step 5). We persist even
        // when symbols.length === 0 && imports.length === 0 so a true no-op
        // re-index recognises the file next time instead of re-parsing it on
        // every run (the recurring-churn fix).
        upsertFile(db, repoId, relPath, hash, content, 'local', declaredPackage);
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
  // JVM imports need the package resolver, built here — after file/symbol
  // persistence — so it sees the full declared_package + symbol tables. The
  // map build is skipped when the batch has no JVM source files.
  const jvmResolver = allImports.some((imp) => isDeclaredModuleSourceFile(imp.sourceFile))
    ? createJvmResolver(db, repoId, absRoot)
    : undefined;
  const edges = buildGraph(allImports, resolver, repoId, jvmResolver);
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

  // ── 10d. Run context providers ───────────────────────────────────────────
  // Providers enrich already-indexed symbols with ecosystem metadata (dbt, etc.).
  // Provider errors never abort indexing — log at warn and continue.
  const providersToRun = options.providers ?? await discoverProviders(absRoot);
  for (const provider of providersToRun) {
    try {
      const enrichResult = await provider.enrich(repoId, absRoot, db);
      logger.info(
        `Provider '${provider.name}': enriched ${enrichResult.symbolsEnriched} symbols`,
      );
    } catch (err) {
      logger.warn(`Provider '${provider.name}' enrich() failed: ${err}`);
    }
  }

  // ── 10e. Test coverage mapping ────────────────────────────────────────────
  // Heuristic: find which production symbols are referenced in test files.
  // Runs after symbols are indexed; errors never abort indexing.
  if (!options.skipTestMapper) {
    try {
      const mappedCount = buildTestMappings(repoId, db);
      logger.info(`Test mapper: ${mappedCount} production symbols mapped`);
    } catch (err) {
      logger.warn(`Test mapper failed: ${err}`);
    }
  }

  // ── 10f. Git metadata capture ─────────────────────────────────────────────
  // Runs after file content is indexed so git metadata is additive; failures
  // never abort indexing.  Skipped silently for non-git directories.
  if (toProcess.length > 0 && !options.skipGit && await isGitRepo(absRoot)) {
    logger.info(`Capturing git metadata for ${toProcess.length} file(s)`);

    // Single repo-level `git log` pass instead of 2 spawns per file. On a
    // many-file repo the old per-file path spawned thousands of git processes
    // (4-wide), which dominated indexing time — minutes on a fast disk, far
    // worse on machines where each `git.exe` launch is scanned by antivirus.
    const fileHistoryDepth = getConfig().git?.fileHistoryDepth ?? 0;
    try {
      const histories = await readRepoFileHistories(absRoot, { maxCommits: fileHistoryDepth });
      if (histories) {
        db.transaction(() => {
          for (const { relPath } of toProcess) {
            const meta = histories.get(relPath.replace(/\\/g, '/'));
            if (!meta) continue;

            updateFileGitMeta(db, repoId, relPath, {
              lastCommitSha: meta.lastCommit.sha,
              lastCommitAuthor: meta.lastCommit.authorName,
              lastCommitDate: meta.lastCommit.date,
              lastCommitMessage: meta.lastCommit.message,
              commitCount: meta.commitCount,
            });

            // Replace stored commit history for this file.
            deleteGitMetadataForFile(db, repoId, relPath);
            insertGitCommits(db, repoId, relPath, meta.history);
          }
        })();
      }
    } catch (err) {
      logger.debug(`Git metadata capture skipped: ${err}`);
    }

    logger.info('Git metadata capture complete');

    // ── Co-change capture (repo-level commit→files) ──────────────────────────
    // A single `git log --name-only -n N` at the repo root, stored in the
    // dedicated commit_files table (separate from git_metadata). Gated on
    // git.coChangeDepth > 0; failures never abort indexing.
    const coChangeDepth = getConfig().git?.coChangeDepth ?? 0;
    if (coChangeDepth > 0) {
      try {
        const commits = await readRepoCommitFiles(absRoot, coChangeDepth);
        if (commits && commits.length > 0) {
          deleteCommitFilesForRepo(db, repoId);
          insertCommitFiles(db, repoId, commits);
          logger.info(`Co-change capture: ${commits.length} commit(s) recorded`);
        }
      } catch (err) {
        logger.debug(`Co-change capture skipped: ${err}`);
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
    tenantId: options.tenantId ?? 'local',
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
    warnings,
    limitReached: limitSkipped > 0,
    totalBeforeLimit,
  };

  logger.info(
    `Index complete: ${result.filesIndexed} files, ${result.symbolsFound} symbols, ` +
      `${result.edgesFound} edges in ${result.durationMs}ms`,
  );

  // Fire-and-forget telemetry — never awaited, never affects the result
  track({
    event: 'index_complete',
    languages: ['typescript', 'javascript'],
    adapterNames: adapters.map((a) => a.name),
    fileCount: result.filesIndexed,
    symbolCount: result.symbolsFound,
    durationMs: result.durationMs,
    workerCount: concurrency,
  }).catch(() => { /* telemetry errors are always silent */ });

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
      const { symbols, imports, declaredPackage } = await processFile(relPath, content, adapters);

      // Always clear this file's prior rows so a re-index FULLY replaces them —
      // even when the edit removed the file's last symbol/import. Leaving stale
      // rows here would let a targeted re-index diverge from a full index_folder
      // (parity), so the empty case clears rows and updates the hash too.
      deleteByFile(db, repoId, relPath);
      deleteEdgesByFile(db, repoId, relPath);

      const hash = computeHash(content);
      upsertFile(db, repoId, relPath, hash, content, 'local', declaredPackage);

      if (symbols.length === 0 && imports.length === 0) {
        filesSkipped++;
        continue;
      }

      allImports.push(...imports);

      if (symbols.length > 0) {
        insertSymbols(db, repoId, symbols);
      }
      symbolsFound += symbols.length;

      logger.debug(`Re-indexed ${relPath}: ${symbols.length} symbols`);
    } catch (err) {
      errors.push({
        file: relPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Build edges only for the re-processed files. The JVM resolver reads the
  // full files/symbols tables (already updated above), so targeted re-index
  // edges match what a full index_folder would produce.
  const jvmResolver = allImports.some((imp) => isDeclaredModuleSourceFile(imp.sourceFile))
    ? createJvmResolver(db, repoId, absRoot)
    : undefined;
  const edges = buildGraph(allImports, resolver, repoId, jvmResolver);
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
    warnings: [],
    // Targeted re-index takes an explicit file list — no discovery, no limit.
    limitReached: false,
    totalBeforeLimit: changedPaths.length,
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
