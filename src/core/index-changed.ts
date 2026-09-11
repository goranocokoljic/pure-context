/**
 * Changed-only re-index (Phase 97, Task 601).
 *
 * `indexFolder` is DISCOVERY-bound: it stats every file in the tree before it
 * can decide that nothing changed (the Phase-80 spike measured ~11 s on a
 * 582-file no-op; minutes on the reporter's 26k-file tree). After a
 * `git checkout` / `pull` / `merge` / `rebase` the set of changed files is
 * something git already knows exactly — so `reindexChanged` asks git for the
 * delta between the sha the index was last brought up to (`repos.git_tree_sha`)
 * and HEAD, unions the working-tree changes (`git status`), and hands that list
 * to the targeted `reindexFiles` path. No directory walk.
 *
 * Fail-soft to the full path (P2): every missing precondition — no index, no
 * stored sha, not a git checkout, sha no longer in the object store, too many
 * changes, index schema outdated — falls back to a full `indexFolder`, with
 * `mode: 'full'` and a `reason` on the result so the fallback is visible.
 *
 * Parity (P3): admission rules for a changed path are exactly discovery's
 * (`createIgnorePredicate` + `fileGuardSize`), so changed-only ≡ full index —
 * proven byte-for-byte in `test/core/index-changed.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { FrameworkAdapter, IndexOptions, IndexResult } from './types.js';
import { logger } from './logger.js';
import { computeRepoId, getIndexDir, getRepo, openDatabase, SCHEMA_VERSION } from './db/schema.js';
import { setGitTreeSha } from './db/schema.js';
import { getConfig } from '../config/config-loader.js';
import { getSupportedExtensions } from '../handlers/handler-registry.js';
import { discoverAdapters, getAdapterExtensions } from '../adapters/adapter-registry.js';
import { createIgnorePredicate, fileGuardSize } from './file-discovery.js';
import { getAllFileHashes } from './db/file-store.js';
import { computeHash } from './hash-cache.js';
import {
  gitChangedFilesBetween,
  gitCommitExists,
  gitDirtyFiles,
  gitHeadSha,
  isGitWorkTree,
} from './git-head.js';
import { captureGitMetadata, indexFolder, reindexFiles } from './index-manager.js';
import { maybeCloneWorktreeIndex, type CloneResult } from './worktree-clone.js';

export type ReindexMode = 'changed' | 'full';

export type FullFallbackReason =
  | 'not_indexed'
  | 'not_git'
  | 'no_head'
  | 'no_stored_sha'
  | 'schema_outdated'
  | 'since_unreachable'
  | 'git_diff_failed'
  | 'too_many_changes';

export interface ReindexChangedOptions
  extends Pick<
    IndexOptions,
    | 'adapters'
    | 'concurrency'
    | 'fileLimit'
    | 'tenantId'
    | 'skipGit'
    | 'skipTestMapper'
    | 'skipSymbolEdges'
    | 'excludePatterns'
    | 'maxFileSizeBytes'
    | 'cloneFromWorktree'
  > {
  /** Delta base. Default: the sha stored on the index. */
  since?: string;
  /**
   * Above this many changed paths a full walk is cheaper (and prunes too).
   * Default: config `indexing.changedOnlyMaxFiles` (5000). 0 = no cap.
   */
  maxFiles?: number;
  /**
   * Also re-hash every file the index already holds and re-index the ones
   * whose content differs (no directory walk — only indexed paths are read).
   * Covers changes git cannot report: `git checkout -- <path>` (post-checkout
   * flag 0), reverted working-tree edits, external writes to tracked files.
   */
  verifyIndexed?: boolean;
}

export interface ReindexChangedResult extends IndexResult {
  mode: ReindexMode;
  /** The sha the delta was computed from (null on a full run without one). */
  since: string | null;
  /** Why the full path ran instead of the changed-only path. */
  reason?: FullFallbackReason;
  /** Changed-only path: paths re-parsed / removed. */
  changedFiles?: number;
  deletedFiles?: number;
  /** Paths git reported that discovery rules would not index (ignored / unsupported). */
  skippedByRules?: number;
  /** `verifyIndexed`: indexed files whose on-disk content no longer matches. */
  verifiedStale?: number;
}

const fmtClone = (c: CloneResult) => ({
  clonedFrom: {
    repoId: c.source.repoId,
    rootPath: c.source.rootPath,
    sha: c.source.sha,
    cloneMs: c.cloneMs,
  },
});

/**
 * Bring the index for `rootPath` up to the working tree using git's change
 * list. See the module header for the fallback contract.
 */
export async function reindexChanged(
  rootPath: string,
  options: ReindexChangedOptions = {},
): Promise<ReindexChangedResult> {
  const absRoot = resolve(rootPath);
  const repoId = computeRepoId(absRoot);
  const cfg = getConfig();

  const full = async (
    reason: FullFallbackReason,
    since: string | null = null,
  ): Promise<ReindexChangedResult> => {
    logger.info(`index-changed: full index for ${absRoot} (${reason})`);
    const result = await indexFolder(absRoot, {
      adapters: options.adapters,
      concurrency: options.concurrency ?? cfg.concurrency,
      fileLimit: options.fileLimit ?? cfg.fileLimit,
      tenantId: options.tenantId,
      skipGit: options.skipGit,
      skipTestMapper: options.skipTestMapper,
      skipSymbolEdges: options.skipSymbolEdges,
      excludePatterns: options.excludePatterns,
      maxFileSizeBytes: options.maxFileSizeBytes,
      cloneFromWorktree: options.cloneFromWorktree,
    });
    return { ...result, mode: 'full', since, reason };
  };

  // ── Preconditions ─────────────────────────────────────────────────────────
  let since = options.since ?? null;
  let clone: CloneResult | null = null;
  const dbPath = join(getIndexDir(), `${repoId}.db`);
  if (!existsSync(dbPath)) {
    // A brand-new worktree of an indexed repository: seed from a sibling and
    // continue with the delta from the sibling's sha (Task 602). Otherwise
    // there is nothing to diff against — full index.
    clone = options.cloneFromWorktree === false ? null : maybeCloneWorktreeIndex(absRoot, repoId);
    if (!clone) return full('not_indexed');
    since = since ?? clone.source.sha;
  }

  const db = openDatabase(repoId);
  const repo = getRepo(db, repoId);
  db.close();
  if (!repo) return full('not_indexed');
  if (repo.schemaVersion < SCHEMA_VERSION) return full('schema_outdated');
  if (!isGitWorkTree(absRoot)) return full('not_git');

  since = since ?? repo.gitTreeSha ?? null;
  if (!since) return full('no_stored_sha');

  const head = gitHeadSha(absRoot);
  if (!head) return full('no_head', since);
  if (!gitCommitExists(absRoot, since)) return full('since_unreachable', since);

  // ── Change set: committed delta ∪ working-tree changes ────────────────────
  const committed = since === head ? [] : gitChangedFilesBetween(absRoot, since, head);
  const dirty = gitDirtyFiles(absRoot);
  if (committed === null || dirty === null) return full('git_diff_failed', since);

  const candidates = new Set<string>([...committed, ...dirty]);

  // Optional hash verification of what the index already holds (post-checkout
  // flag 0: git gives no path list; a `git checkout -- <path>` leaves the
  // file clean AND unchanged since the stored sha, so neither list above
  // sees it). Reads only indexed paths — never walks the tree.
  let verifiedStale = 0;
  if (options.verifyIndexed) {
    const dbv = openDatabase(repoId);
    const stored = getAllFileHashes(dbv, repoId);
    dbv.close();
    for (const [rel, hash] of stored) {
      if (candidates.has(rel)) continue;
      const abs = join(absRoot, rel);
      let current: string | null = null;
      try {
        current = computeHash(readFileSync(abs));
      } catch {
        current = null; // gone → deletion below
      }
      if (current !== hash) {
        candidates.add(rel);
        verifiedStale++;
      }
    }
  }
  // Cloned seed: the sibling's uncommitted edits may be baked into the copy
  // (their committed state is what THIS tree has) — re-check those paths too.
  for (const p of clone?.sourceDirtyFiles ?? []) candidates.add(p);
  const maxFiles = options.maxFiles ?? cfg.indexing?.changedOnlyMaxFiles ?? 5000;
  if (maxFiles > 0 && candidates.size > maxFiles) return full('too_many_changes', since);

  // ── Admission: exactly discovery's rules (parity) ─────────────────────────
  const adapters =
    options.adapters ?? (await discoverAdapters(absRoot, { adapters: cfg.adapters }));
  const extensions = [...getSupportedExtensions(), ...getAdapterExtensions(adapters)];
  const ignored = createIgnorePredicate(absRoot, options.excludePatterns ?? cfg.excludePatterns);
  const maxFileSizeBytes = options.maxFileSizeBytes ?? cfg.maxFileSizeBytes;

  const changed: string[] = [];
  const deleted: string[] = [];
  let skippedByRules = 0;
  for (const rel of candidates) {
    if (ignored(rel)) {
      skippedByRules++;
      continue;
    }
    const abs = join(absRoot, rel);
    if (!existsSync(abs)) {
      deleted.push(rel); // deleted on disk — the index row (if any) must go
      continue;
    }
    const size = fileGuardSize(abs, basename(rel), rel, { extensions, maxFileSizeBytes });
    if (size === null) {
      // Not indexable now (unsupported / too big / binary / secret). If an
      // earlier run indexed it, a full walk would prune it — mirror that.
      deleted.push(rel);
      skippedByRules++;
      continue;
    }
    changed.push(rel);
  }

  logger.info(
    `index-changed: ${changed.length} changed, ${deleted.length} removed ` +
      `(${candidates.size} git paths, since ${since.slice(0, 12)})`,
  );

  // ── Targeted re-index + git metadata + new sha ────────────────────────────
  // Phase 99: a cloned seed lost the sibling's cross edges (they were the
  // sibling worktree's) — rediscover THIS root's links and re-resolve once.
  const result = await reindexFiles(repoId, changed, deleted, {
    adapters,
    ...(clone ? { refreshLinks: true } : {}),
  });

  if (!options.skipGit && changed.length > 0) {
    const db2 = openDatabase(repoId);
    try {
      await captureGitMetadata(db2, repoId, absRoot, changed);
    } finally {
      db2.close();
    }
  }

  const db3 = openDatabase(repoId);
  try {
    setGitTreeSha(db3, repoId, head);
  } finally {
    db3.close();
  }

  return {
    ...result,
    ...(clone ? fmtClone(clone) : {}),
    headSha: head,
    mode: 'changed',
    since,
    changedFiles: changed.length,
    deletedFiles: deleted.length,
    skippedByRules,
    ...(options.verifyIndexed ? { verifiedStale } : {}),
  };
}

/** Adapter set for a repo when the caller has none (CLI entry points). */
export async function adaptersForRepo(absRoot: string): Promise<FrameworkAdapter[]> {
  try {
    return await discoverAdapters(absRoot, { adapters: getConfig().adapters });
  } catch {
    return [];
  }
}
