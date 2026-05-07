import { readdirSync, existsSync } from 'node:fs';
import { logger } from '../../core/logger.js';
import { getIndexDir, openDatabase, getRepo } from '../../core/db/schema.js';
import { reindexFiles, indexFolder } from '../../core/index-manager.js';
import type { RepoMetadata } from '../../core/types.js';

// ─── Rate limiting ────────────────────────────────────────────────────────────

/** Minimum gap between reindex triggers for the same repo (1 minute). */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Module-level map: repoId → timestamp of last triggered reindex. */
const lastReindexTime = new Map<string, number>();

export function isRateLimited(repoId: string): boolean {
  const last = lastReindexTime.get(repoId);
  return last !== undefined && Date.now() - last < RATE_LIMIT_WINDOW_MS;
}

export function markReindexed(repoId: string): void {
  lastReindexTime.set(repoId, Date.now());
}

// ─── Repo lookup ──────────────────────────────────────────────────────────────

/**
 * Find an indexed repo by its GitHub/GitLab full name (owner/repo).
 * Matches root_path ending with /owner/repo or /repo (case-insensitive).
 */
export function findRepoByFullName(fullName: string): RepoMetadata | null {
  const dir = getIndexDir();
  if (!existsSync(dir)) return null;

  const normalized = fullName.replace(/\\/g, '/').toLowerCase();
  const repoSlug = normalized.split('/').pop() ?? '';

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const repoId = file.slice(0, -3);
    try {
      const db = openDatabase(repoId);
      const meta = getRepo(db, repoId);
      db.close();
      if (!meta) continue;

      const rootNorm = meta.rootPath.replace(/\\/g, '/').toLowerCase();
      if (rootNorm.endsWith(`/${normalized}`) || rootNorm.endsWith(`/${repoSlug}`)) {
        return meta;
      }
    } catch {
      // Corrupt or unreadable DB — skip
    }
  }

  return null;
}

/**
 * Find an indexed repo by its exact local root path.
 */
export function findRepoByPath(repoPath: string): RepoMetadata | null {
  const dir = getIndexDir();
  if (!existsSync(dir)) return null;

  const target = repoPath.replace(/\\/g, '/').toLowerCase();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const repoId = file.slice(0, -3);
    try {
      const db = openDatabase(repoId);
      const meta = getRepo(db, repoId);
      db.close();
      if (!meta) continue;

      if (meta.rootPath.replace(/\\/g, '/').toLowerCase() === target) {
        return meta;
      }
    } catch {
      // skip
    }
  }

  return null;
}

// ─── Background reindex ───────────────────────────────────────────────────────

/**
 * Fire an incremental reindex in the background (non-blocking).
 * Marks the repo as recently reindexed for rate-limiting purposes.
 */
export function triggerIncrementalReindex(
  repoId: string,
  changedPaths: string[],
  deletedPaths: string[],
  label: string,
): void {
  markReindexed(repoId);
  setImmediate(() => {
    reindexFiles(repoId, changedPaths, deletedPaths)
      .then((result) => {
        logger.info(
          `Webhook reindex complete for ${label}: ` +
            `${result.filesIndexed} files, ${result.symbolsFound} symbols`,
        );
      })
      .catch((err: unknown) => {
        logger.warn(`Webhook reindex failed for ${label}: ${err}`);
      });
  });
}

/**
 * Fire a full index of a new repo in the background (non-blocking).
 * Only called when AUTO_INDEX_ON_WEBHOOK / autoIndex is enabled.
 */
export function triggerAutoIndex(repoPath: string): void {
  setImmediate(() => {
    indexFolder(repoPath)
      .then((result) => {
        logger.info(
          `Webhook auto-index complete for ${repoPath}: ` +
            `${result.filesIndexed} files, ${result.symbolsFound} symbols`,
        );
      })
      .catch((err: unknown) => {
        logger.warn(`Webhook auto-index failed for ${repoPath}: ${err}`);
      });
  });
}
