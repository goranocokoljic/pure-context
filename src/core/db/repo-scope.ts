import { readdirSync, existsSync } from 'fs';
import { basename } from 'path';
import { getIndexDir, openDatabase, getRepo } from './schema.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RepoRef {
  id: string;
  /** Human-readable name derived from the basename of root_path. */
  name: string;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the set of repos to target for a cross-repo operation.
 *
 * - `repoId` provided:   single-repo backward-compatible path
 * - `repoIds` provided:  explicit list, filtered to repos that exist and match `tenantId`
 * - neither:             ALL indexed repos matching `tenantId`
 *
 * Opens each candidate DB briefly to read metadata, then closes it.
 * The caller is responsible for re-opening for actual data operations.
 *
 * Corrupt or unreadable DBs are silently skipped.
 */
export function resolveRepoScope(opts: {
  repoId?: string;
  repoIds?: string[];
  tenantId?: string;
}): RepoRef[] {
  const { repoId, repoIds, tenantId } = opts;
  const dir = getIndexDir();

  // ── Build candidate ID list ───────────────────────────────────────────────
  let candidateIds: string[];
  if (repoId) {
    candidateIds = [repoId];
  } else if (repoIds && repoIds.length > 0) {
    candidateIds = repoIds;
  } else {
    // All repos on disk
    if (!existsSync(dir)) return [];
    candidateIds = readdirSync(dir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => f.slice(0, -3));
  }

  // ── Validate each candidate against the DB ────────────────────────────────
  const result: RepoRef[] = [];
  for (const id of candidateIds) {
    try {
      const db = openDatabase(id);
      const meta = getRepo(db, id);
      db.close();
      if (!meta) continue;
      if (tenantId !== undefined && meta.tenantId !== tenantId) continue;
      result.push({ id, name: basename(meta.rootPath) });
    } catch {
      // Corrupt or unreadable DB — skip silently
    }
  }
  return result;
}
