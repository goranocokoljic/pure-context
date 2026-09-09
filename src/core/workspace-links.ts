/**
 * Workspace links (Phase 99, Task 614) — which OTHER indexes an index may
 * resolve imports into.
 *
 * Rule (P1 — "same checkout = one workspace"): two indexes link automatically
 * only when their roots resolve to the same `git rev-parse --show-toplevel`
 * AND are DISJOINT directories, i.e. several roots side by side inside ONE
 * clone (the reporter's three-index split of one Gradle build). Everything
 * else never links by itself:
 *   - git worktrees have different toplevels (they are alternate copies of the
 *     same code — linking them would double every edge) → `worktree`;
 *   - unrelated repositories under one parent folder (a benchmark corpus)
 *     → `different-repo`;
 *   - roots outside any git checkout → `not-git`;
 *   - a root that contains, or is contained by, this one → `overlapping`
 *     (the larger index already holds the smaller one's files; linking them
 *     would count every edge twice — the deviation from the plan's "nested
 *     or sibling", decided when the parity fixture showed the duplication).
 * Explicit `graph.linkedRepos` (root paths or repo ids) may cross repositories
 * on purpose. `graph.crossIndex: 'off'` disables all of it; `maxLinkedRepos`
 * bounds fan-out (P5) — candidates beyond the cap are reported with reason
 * `cap`, sorted by root path so the choice is deterministic.
 *
 * Candidates come from the Phase-97 sibling scan (indexed roots under / above
 * / beside this one) plus the explicit list; git is asked once per root
 * (memoized per call, fail-soft: a git failure means "no auto link").
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { computeRepoId, getIndexDir, getRepo, openDatabase } from './db/schema.js';
import type { LinkRelation, LinkSource, RepoLink } from './db/link-store.js';
import { gitCommonDir, gitHeadSha, gitRevListCount, gitTopLevel } from './git-head.js';
import { getConfig } from '../config/config-loader.js';
import { logger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SiblingIndex {
  repoId: string;
  rootPath: string;
  /** How the other index's root relates to this one. */
  relation: 'nested' | 'parent' | 'sibling';
}

export interface LinkedIndex {
  repoId: string;
  rootPath: string;
  relation: LinkRelation;
  source: LinkSource;
  /** The linked index's stored HEAD sha (its `repos.git_tree_sha`), if any. */
  sha: string | null;
}

export type UnlinkReason =
  | 'worktree'
  | 'different-repo'
  | 'not-git'
  | 'overlapping'
  | 'cap'
  | 'off';

export interface UnlinkedSibling {
  repoId: string;
  rootPath: string;
  /** Location relation (nested / parent / same-parent sibling / elsewhere in the checkout). */
  relation: 'nested' | 'parent' | 'sibling' | 'checkout';
  reason: UnlinkReason;
}

export interface LinkResolution {
  links: LinkedIndex[];
  unlinked: UnlinkedSibling[];
}

export interface ResolveLinksOptions {
  crossIndex?: 'auto' | 'off';
  linkedRepos?: string[];
  maxLinkedRepos?: number;
}

// ─── Index-root scan ──────────────────────────────────────────────────────────

export interface IndexedRoot {
  repoId: string;
  rootPath: string;
  sha: string | null;
}

const normPath = (p: string) => resolve(p).replace(/[\\/]+$/, '');
const lower = (p: string) => normPath(p).toLowerCase();

/** Every readable index on disk with its stored root and HEAD sha. */
export function listIndexedRoots(): IndexedRoot[] {
  const dir = getIndexDir();
  if (!existsSync(dir)) return [];
  const out: IndexedRoot[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const repoId = file.slice(0, -3);
    try {
      const db = openDatabase(repoId);
      const meta = getRepo(db, repoId);
      db.close();
      if (meta?.rootPath) out.push({ repoId, rootPath: normPath(meta.rootPath), sha: meta.gitTreeSha ?? null });
    } catch {
      /* unreadable index — skip */
    }
  }
  return out.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

/**
 * Other indexed roots that are nested under, above, or beside `rootPath` —
 * the shape of a split build tree (moved here from external-imports, Phase 97).
 */
export function findSiblingIndexes(repoId: string, rootPath: string, roots?: IndexedRoot[]): SiblingIndex[] {
  if (!rootPath) return [];
  const meLower = lower(rootPath);
  const myParent = dirname(normPath(rootPath)).toLowerCase();
  const out: SiblingIndex[] = [];
  for (const r of roots ?? listIndexedRoots()) {
    if (r.repoId === repoId) continue;
    const otherLower = r.rootPath.toLowerCase();
    let relation: SiblingIndex['relation'] | null = null;
    if (otherLower.startsWith(meLower + sep.toLowerCase()) || otherLower.startsWith(meLower + '/')) relation = 'nested';
    else if (meLower.startsWith(otherLower + sep.toLowerCase()) || meLower.startsWith(otherLower + '/')) relation = 'parent';
    else if (dirname(r.rootPath).toLowerCase() === myParent) relation = 'sibling';
    if (relation) out.push({ repoId: r.repoId, rootPath: r.rootPath, relation });
  }
  return out.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

// ─── The rule ─────────────────────────────────────────────────────────────────

const isUnder = (child: string, parent: string) =>
  child.startsWith(parent + sep.toLowerCase()) || child.startsWith(parent + '/');

/**
 * Decide which indexes `repoId` (rooted at `rootPath`) links to. Pure decision
 * over disk state — nothing is written; the graph build stores the result in
 * `repo_links` once it has built against it.
 *
 * Candidates: every indexed root UNDER my git toplevel (a root that shares my
 * toplevel is necessarily under it — one prefix test, no git call per index)
 * plus the location-related roots of the Phase-97 scan (nested / parent /
 * same-parent sibling) so the rejections an agent would wonder about are
 * reported. Roots that contain me or that I contain are never auto-linked:
 * the larger index already holds the smaller one's files, so linking them
 * would double every edge (`overlapping`). The reporter's shape — several
 * DISJOINT roots in one clone — links.
 */
export function resolveLinks(
  repoId: string,
  rootPath: string,
  opts: ResolveLinksOptions = {},
): LinkResolution {
  const cfg = getConfig().graph;
  const mode = opts.crossIndex ?? cfg.crossIndex ?? 'auto';
  const explicit = opts.linkedRepos ?? cfg.linkedRepos ?? [];
  const cap = opts.maxLinkedRepos ?? cfg.maxLinkedRepos ?? 8;

  // Off / cap 0: no links and NO index-dir scan (the scan opens every index;
  // a suite indexing hundreds of fixtures must not pay it per run).
  if (mode === 'off' || cap === 0) return { links: [], unlinked: [] };

  const roots = listIndexedRoots();
  const siblings = findSiblingIndexes(repoId, rootPath, roots);

  const topCache = new Map<string, string | null>();
  const top = (p: string): string | null => {
    const key = lower(p);
    if (!topCache.has(key)) {
      let t: string | null = null;
      try {
        t = existsSync(p) ? gitTopLevel(p) : null;
      } catch {
        t = null;
      }
      topCache.set(key, t ? lower(t) : null);
    }
    return topCache.get(key) ?? null;
  };
  const common = (p: string): string | null => {
    try {
      const c = existsSync(p) ? gitCommonDir(p) : null;
      return c ? lower(c) : null;
    } catch {
      return null;
    }
  };

  const shaOf = (id: string) => roots.find((r) => r.repoId === id)?.sha ?? null;
  const links: LinkedIndex[] = [];
  const unlinked: UnlinkedSibling[] = [];
  const linkedIds = new Set<string>();

  // 1. Explicit config first — intent beats the automatic rule and the cap
  //    counts them (they are still fan-out).
  for (const entry of explicit) {
    const byId = roots.find((r) => r.repoId === entry);
    const target = byId ?? roots.find((r) => r.repoId === computeRepoId(normPath(entry)));
    if (!target) {
      logger.warn(`graph.linkedRepos: "${entry}" is not an indexed root — ignored`);
      continue;
    }
    if (target.repoId === repoId || linkedIds.has(target.repoId)) continue;
    linkedIds.add(target.repoId);
    links.push({ repoId: target.repoId, rootPath: target.rootPath, relation: 'config', source: 'config', sha: target.sha });
  }

  // 2. Automatic rule: same git toplevel as mine, disjoint roots only.
  const mine = top(rootPath);
  const myCommon = mine ? common(rootPath) : null;
  const me = lower(rootPath);
  const locationOf = new Map(siblings.map((s) => [s.repoId, s.relation] as const));
  for (const r of roots) {
    if (r.repoId === repoId || linkedIds.has(r.repoId)) continue;
    const other = r.rootPath.toLowerCase();
    const loc = locationOf.get(r.repoId);
    const underMyTop = mine !== null && (other === mine || isUnder(other, mine));
    if (!loc && !underMyTop) continue; // unrelated index elsewhere on disk — not a candidate
    const relation: UnlinkedSibling['relation'] = loc ?? 'checkout';
    const base = { repoId: r.repoId, rootPath: r.rootPath, relation };
    if (loc === 'nested' || loc === 'parent' || isUnder(other, me) || isUnder(me, other)) {
      unlinked.push({ ...base, reason: 'overlapping' });
      continue;
    }
    if (!mine) {
      unlinked.push({ ...base, reason: 'not-git' });
      continue;
    }
    const theirs = top(r.rootPath);
    if (!theirs) {
      unlinked.push({ ...base, reason: 'not-git' });
      continue;
    }
    if (theirs !== mine) {
      const theirCommon = common(r.rootPath);
      unlinked.push({ ...base, reason: myCommon && theirCommon === myCommon ? 'worktree' : 'different-repo' });
      continue;
    }
    linkedIds.add(r.repoId);
    links.push({ repoId: r.repoId, rootPath: r.rootPath, relation: 'sibling', source: 'auto', sha: shaOf(r.repoId) });
  }
  // Deterministic order: config links first (as given), then auto links by root path.
  const configLinks = links.filter((l) => l.source === 'config');
  const autoLinks = links.filter((l) => l.source === 'auto').sort((a, b) => a.rootPath.localeCompare(b.rootPath));
  links.splice(0, links.length, ...configLinks, ...autoLinks);

  // 3. Cap (P5). Config links were pushed first, so they survive; auto links
  //    are sorted by root path, so the survivors are deterministic.
  if (links.length > cap) {
    const dropped = links.splice(cap);
    for (const d of dropped) {
      unlinked.push({
        repoId: d.repoId,
        rootPath: d.rootPath,
        relation: d.relation === 'config' ? 'checkout' : d.relation,
        reason: 'cap',
      });
    }
    logger.warn(
      `Cross-index links capped at ${cap} for ${rootPath} (${dropped.length} more candidate(s) — graph.maxLinkedRepos)`,
    );
  }

  return { links, unlinked };
}

// ─── Per-link drift (P6) ──────────────────────────────────────────────────────

export interface LinkDrift {
  repoId: string;
  rootPath: string;
  source: LinkSource;
  relation: LinkRelation;
  /** Sibling HEAD when the edges were built. */
  linkedSha: string | null;
  /** Sibling HEAD now (null: not git / root gone). */
  currentSha: string | null;
  /** Commits the sibling moved since the edges were built (null: unknown). */
  behindBy: number | null;
  status: 'fresh' | 'moved' | 'unknown' | 'missing' | 'pending';
}

/**
 * Compare a stored link with the sibling's checkout now. `missing` = the
 * sibling's index file is gone (cross edges into it dangle); `moved` = the
 * sibling's HEAD advanced — the SOURCE index must rebuild to re-resolve the
 * seam (`index_folder({ path: <source root> })`).
 */
export function describeLinkDrift(link: RepoLink): LinkDrift {
  const base = {
    repoId: link.linkedRepoId,
    rootPath: link.linkedRootPath,
    source: link.source,
    relation: link.relation,
    linkedSha: link.linkedSha,
  };
  if (!existsSync(join(getIndexDir(), `${link.linkedRepoId}.db`))) {
    return { ...base, currentSha: null, behindBy: null, status: 'missing' };
  }
  if (!existsSync(link.linkedRootPath)) {
    return { ...base, currentSha: null, behindBy: null, status: 'missing' };
  }
  const currentSha = gitHeadSha(link.linkedRootPath);
  // Recorded by the OTHER side only: this index has not built against it.
  if (!link.built) return { ...base, currentSha, behindBy: null, status: 'pending' };
  if (!currentSha || !link.linkedSha) {
    return { ...base, currentSha, behindBy: null, status: 'unknown' };
  }
  if (currentSha === link.linkedSha) return { ...base, currentSha, behindBy: 0, status: 'fresh' };
  const behindBy = gitRevListCount(link.linkedRootPath, link.linkedSha, currentSha);
  return { ...base, currentSha, behindBy, status: 'moved' };
}

/** One human line per link (list_repos / staleness / hook injections). */
export function formatLinkDriftLine(d: LinkDrift): string {
  switch (d.status) {
    case 'fresh':
      return `link ${d.rootPath}: fresh`;
    case 'moved':
      return `link ${d.rootPath}: moved ${d.behindBy ?? '?'} commit(s) since the edges were built — run index_folder on THIS root to re-resolve the seam`;
    case 'missing':
      return `link ${d.rootPath}: index missing — cross-index edges into it dangle; re-index it or run index_folder here`;
    case 'pending':
      return `link ${d.rootPath}: linked by that index — run index_folder on THIS root to resolve its imports into it`;
    default:
      return `link ${d.rootPath}: drift unknown`;
  }
}
