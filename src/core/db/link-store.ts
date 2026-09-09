/**
 * `repo_links` (schema v12, Phase 99): the linked indexes the LAST graph build
 * of a repo resolved cross-index edges against, with each sibling's HEAD sha
 * at that moment. Cross edges are stored in the SOURCE index only, so this
 * table is what a traversal reads to know which other databases to open, and
 * what staleness reporting compares against the sibling's current HEAD.
 */
import type Database from 'better-sqlite3';

export type LinkSource = 'auto' | 'config';
export type LinkRelation = 'nested' | 'parent' | 'sibling' | 'config';

export interface RepoLink {
  repoId: string;
  linkedRepoId: string;
  linkedRootPath: string;
  /** The linked index's stored HEAD when the edges were built (null: not git / unknown). */
  linkedSha: string | null;
  linkedAt: number;
  source: LinkSource;
  relation: LinkRelation;
  /**
   * true  — THIS index built its edges against the link (its own graph build
   *         wrote the row);
   * false — the row was recorded by the OTHER side (it built against us) and
   *         this index has not yet resolved its own imports into it: run
   *         `index_folder` here (status `pending` in drift reports).
   */
  built: boolean;
}

interface Row {
  repo_id: string;
  linked_repo_id: string;
  linked_root_path: string;
  linked_sha: string | null;
  linked_at: number;
  source: string;
  relation: string;
  built?: number | null;
}

function rowToLink(r: Row): RepoLink {
  return {
    repoId: r.repo_id,
    linkedRepoId: r.linked_repo_id,
    linkedRootPath: r.linked_root_path,
    linkedSha: r.linked_sha,
    linkedAt: r.linked_at,
    source: r.source === 'config' ? 'config' : 'auto',
    relation: (['nested', 'parent', 'sibling', 'config'] as const).includes(r.relation as LinkRelation)
      ? (r.relation as LinkRelation)
      : 'sibling',
    built: (r.built ?? 1) !== 0,
  };
}

/** Links recorded for `repoId`, sorted by linked root path (deterministic). */
export function getRepoLinks(db: Database.Database, repoId: string): RepoLink[] {
  return db
    .prepare<[string], Row>('SELECT * FROM repo_links WHERE repo_id = ? ORDER BY linked_root_path')
    .all(repoId)
    .map(rowToLink);
}

/** Replace the link set for `repoId` (delete-then-insert, one transaction). */
export function replaceRepoLinks(
  db: Database.Database,
  repoId: string,
  links: Array<Omit<RepoLink, 'repoId' | 'linkedAt' | 'built'>>,
): void {
  const del = db.prepare('DELETE FROM repo_links WHERE repo_id = ?');
  const ins = db.prepare(`
    INSERT INTO repo_links (repo_id, linked_repo_id, linked_root_path, linked_sha, linked_at, source, relation, built)
    VALUES (@repoId, @linkedRepoId, @linkedRootPath, @linkedSha, @linkedAt, @source, @relation, 1)
  `);
  const now = Date.now();
  db.transaction(() => {
    del.run(repoId);
    for (const l of links) {
      ins.run({
        repoId,
        linkedRepoId: l.linkedRepoId,
        linkedRootPath: l.linkedRootPath,
        linkedSha: l.linkedSha,
        linkedAt: now,
        source: l.source,
        relation: l.relation,
      });
    }
  })();
}

/**
 * Record a REVERSE link row without touching the rest of the set — used by
 * the OTHER side: when B builds against A, B also records itself in A's
 * `repo_links` so A's traversals open B and see B's edges into A (the
 * reporter's "blast radius of a library file must return the app files").
 * Insert-if-absent: when A already built against B, A's row keeps A's own
 * sha and `built = 1` (B's current head is what A's drift compares against);
 * a fresh row is `built = 0` — A has not resolved its imports into B yet.
 */
export function recordReverseLink(
  db: Database.Database,
  repoId: string,
  link: Omit<RepoLink, 'repoId' | 'linkedAt' | 'built'>,
): void {
  db.prepare(`
    INSERT INTO repo_links (repo_id, linked_repo_id, linked_root_path, linked_sha, linked_at, source, relation, built)
    VALUES (@repoId, @linkedRepoId, @linkedRootPath, @linkedSha, @linkedAt, @source, @relation, 0)
    ON CONFLICT(repo_id, linked_repo_id) DO UPDATE SET
      linked_root_path = excluded.linked_root_path
  `).run({
    repoId,
    linkedRepoId: link.linkedRepoId,
    linkedRootPath: link.linkedRootPath,
    linkedSha: link.linkedSha,
    linkedAt: Date.now(),
    source: link.source,
    relation: link.relation,
  });
}

/** Remove every link of `repoId` (worktree clone hygiene, delete-index). */
export function clearRepoLinks(db: Database.Database, repoId: string): void {
  db.prepare('DELETE FROM repo_links WHERE repo_id = ?').run(repoId);
}
