/**
 * Boundary honesty (Phase 97, Task 604): `externalImports`.
 *
 * Dependency edges never cross an index boundary. When a build tree is split
 * into several indexes (the reporter's three-index setup), a blast radius or
 * importer list stops silently at the seam and reads as "nothing depends on
 * this". This module surfaces the seam: import records of the queried file(s)
 * that resolved to NO edge yet look INTERNAL to the code base (relative /
 * alias specifiers, a package prefix the repo itself declares, a top-level
 * directory name, the go.mod module path, `crate::`), plus the other indexed
 * roots that live under / above / beside this one (`siblingIndexes`).
 *
 * Attached only when there is something to say (count > 0) — responses stay
 * byte-identical on a fully-resolved repo. Extends the Phase-82
 * `graphCoverage` note from "the graph is empty" to "the graph stops here".
 */
import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRepo } from '../../core/db/schema.js';
import { getConfig } from '../../config/config-loader.js';
import { packageHead, workspaceResolverFor } from '../../graph/workspace-packages.js';
import { getRepoLinks } from '../../core/db/link-store.js';
import {
  findSiblingIndexes,
  resolveLinks,
  type SiblingIndex,
  type UnlinkedSibling,
} from '../../core/workspace-links.js';

export { findSiblingIndexes, type SiblingIndex };

export interface ExternalImportSample {
  sourceFile: string;
  specifier: string;
}

export interface LinkedIndexRef {
  repoId: string;
  rootPath: string;
  relation: string;
  source: 'auto' | 'config';
}

export interface ExternalImports {
  /** Unresolved, internal-looking import records across the queried files (after linking). */
  count: number;
  sample: ExternalImportSample[];
  /** Phase 99: indexes this index resolves across (edges already follow them). */
  links: LinkedIndexRef[];
  /** Related indexes the workspace rule did NOT link, with the reason. */
  unlinkedSiblings: UnlinkedSibling[];
  /** @deprecated since 1.32.0 — `links` ∪ `unlinkedSiblings` (kept one release for consumers). */
  siblingIndexes: SiblingIndex[];
  note: string;
  nextAction: string;
}

const SAMPLE_LIMIT = 8;

interface RepoContext {
  rootPath: string;
  /** Every path the index holds — an edge whose target is not here left the index. */
  files: Set<string>;
  topDirs: Set<string>;
  topPyModules: Set<string>;
  goModule: string | null;
  reservedNamespaces: string[];
  /** Phase 100 (Task 627): workspace package names of this root. */
  workspaceNames: ReadonlySet<string>;
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot < 0 ? '' : p.slice(dot).toLowerCase();
}

function buildRepoContext(db: Database.Database, repoId: string): RepoContext {
  const rootPath = getRepo(db, repoId)?.rootPath ?? '';
  const paths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const topDirs = new Set<string>();
  const topPyModules = new Set<string>();
  for (const p of paths) {
    const slash = p.indexOf('/');
    if (slash > 0) topDirs.add(p.slice(0, slash));
    else if (p.endsWith('.py')) topPyModules.add(p.slice(0, -3));
  }
  let goModule: string | null = null;
  try {
    const gm = join(rootPath, 'go.mod');
    if (rootPath && existsSync(gm)) {
      const m = /^module\s+(\S+)/m.exec(readFileSync(gm, 'utf8'));
      goModule = m ? m[1] : null;
    }
  } catch {
    goModule = null;
  }
  return {
    rootPath,
    files: new Set(paths),
    topDirs,
    topPyModules,
    goModule,
    reservedNamespaces: getConfig().graph?.reservedNamespaces ?? [],
    workspaceNames: rootPath ? (workspaceResolverFor(rootPath)?.names() ?? new Set<string>()) : new Set<string>(),
  };
}

function firstSegments(dotted: string, n: number): string {
  return dotted.split('.').slice(0, n).join('.');
}

function isReserved(specifier: string, reserved: string[]): boolean {
  return reserved.some((ns) => specifier === ns || specifier.startsWith(ns + '.'));
}

/**
 * Does an UNRESOLVED specifier look like it points inside the code base?
 * Conservative on purpose: third-party packages must never be flagged.
 */
export function looksInternal(
  specifier: string,
  sourceFile: string,
  declaredPackage: string | null,
  ctx: RepoContext,
): boolean {
  const ext = extOf(sourceFile);
  const first = specifier.split(/[/\\]/)[0] ?? '';

  switch (ext) {
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.mts': case '.cts':
    case '.mjs': case '.cjs': case '.vue': case '.svelte': case '.astro':
      if (specifier.startsWith('.')) return true; // relative — resolver could not find the file
      if (/^(@|~~?|#)\//.test(specifier)) return true; // path aliases (@/, ~/, ~~/, #/)
      // Phase 100: a workspace package of this root that still did not resolve
      // (no entry file indexed) is internal, not a third-party dependency.
      if (ctx.workspaceNames?.has(packageHead(specifier))) return true;
      return ctx.topDirs.has(first) && first !== 'node_modules';

    case '.kt': case '.kts': case '.java': case '.scala': case '.groovy': {
      if (isReserved(specifier, ctx.reservedNamespaces)) return false;
      if (!declaredPackage) return false;
      const prefix = firstSegments(declaredPackage, 2);
      return prefix.includes('.') && specifier.startsWith(prefix + '.');
    }

    case '.cs': {
      if (!declaredPackage) return false;
      const root = firstSegments(declaredPackage, 1);
      return specifier === root || specifier.startsWith(root + '.');
    }

    case '.py': {
      if (specifier.startsWith('.')) return true;
      const head = specifier.split('.')[0] ?? '';
      return ctx.topDirs.has(head) || ctx.topPyModules.has(head);
    }

    case '.go':
      return ctx.goModule !== null && (specifier === ctx.goModule || specifier.startsWith(ctx.goModule + '/'));

    case '.rs':
      return /^(crate|self|super)(::|$)/.test(specifier);

    case '.php': {
      const ns = specifier.replace(/^\\/, '');
      if (!declaredPackage) return false;
      const root = declaredPackage.replace(/^\\/, '').split('\\')[0] ?? '';
      return root !== '' && (ns === root || ns.startsWith(root + '\\'));
    }

    case '.rb':
      return specifier.startsWith('.') || ctx.topDirs.has(first);

    default:
      return specifier.startsWith('.');
  }
}

/**
 * The seam signal for `files` (repo-relative). Null when every internal-
 * looking import of those files resolved — the common case.
 */
export function computeExternalImports(
  db: Database.Database,
  repoId: string,
  files: string[],
): ExternalImports | null {
  const uniq = [...new Set(files)].filter((f) => f.length > 0);
  if (uniq.length === 0) return null;

  const recStmt = db.prepare<[string, string], { specifier: string; resolved_path: string | null }>(
    'SELECT specifier, resolved_path FROM import_records WHERE repo_id = ? AND source_file = ?',
  );
  const edgeStmt = db.prepare<[string, string], { specifier: string; target_file: string; target_repo_id: string | null }>(
    'SELECT specifier, target_file, target_repo_id FROM dep_edges WHERE repo_id = ? AND source_file = ?',
  );
  const pkgStmt = db.prepare<[string, string], { declared_package: string | null }>(
    'SELECT declared_package FROM files WHERE repo_id = ? AND path = ?',
  );

  let ctx: RepoContext | null = null;
  const sample: ExternalImportSample[] = [];
  let count = 0;

  for (const file of uniq) {
    const records = recStmt.all(repoId, file);
    if (records.length === 0) continue;
    ctx ??= buildRepoContext(db, repoId);
    // A specifier counts as resolved when an edge lands on a file THIS index
    // holds, or (Phase 99) on a file in a LINKED index (target_repo_id set).
    // The path resolver happily follows `../../other-module/x` to a file on
    // disk outside the root — an unlinked such edge is the seam itself.
    const resolved = new Set(
      edgeStmt
        .all(repoId, file)
        .filter((e) => e.target_repo_id !== null || ctx!.files.has(e.target_file))
        .map((e) => e.specifier),
    );
    const declared = pkgStmt.get(repoId, file)?.declared_package ?? null;
    for (const r of records) {
      if (resolved.has(r.specifier)) continue;
      if (!looksInternal(r.specifier, file, declared, ctx)) continue;
      count++;
      if (sample.length < SAMPLE_LIMIT) sample.push({ sourceFile: file, specifier: r.specifier });
    }
  }

  if (count === 0) return null;
  const rootPath = ctx?.rootPath ?? getRepo(db, repoId)?.rootPath ?? '';
  // Phase 99: what the last build linked (stored) vs what the rule rejects now.
  const stored = getRepoLinks(db, repoId);
  const links: LinkedIndexRef[] = stored.map((l) => ({
    repoId: l.linkedRepoId,
    rootPath: l.linkedRootPath,
    relation: l.relation,
    source: l.source,
  }));
  const linkedIds = new Set(links.map((l) => l.repoId));
  // The rule NOW vs the links the last build stored: a sibling indexed after
  // that build is linkable but unlinked — the fix is a rebuild of this root.
  let ruleNow: ReturnType<typeof resolveLinks> = { links: [], unlinked: [] };
  try {
    ruleNow = resolveLinks(repoId, rootPath);
  } catch {
    /* fail-soft: no hints */
  }
  const unlinkedSiblings: UnlinkedSibling[] = ruleNow.unlinked.filter((u) => !linkedIds.has(u.repoId));
  const linkableNow = ruleNow.links.filter((l) => !linkedIds.has(l.repoId));
  const siblingIndexes = findSiblingIndexes(repoId, rootPath);
  const hints: string[] = [];
  if (links.length > 0) hints.push(`${links.length} linked index(es) already searched (links).`);
  if (linkableNow.length > 0) {
    hints.push(
      `${linkableNow.length} index(es) in the same checkout are NOT yet linked — run index_folder ` +
        'on this root to link them: ' + linkableNow.map((l) => l.rootPath).join(', ') + '.',
    );
  }
  if (unlinkedSiblings.length > 0) {
    hints.push(
      `${unlinkedSiblings.length} related index(es) never link automatically (unlinkedSiblings: ` +
        [...new Set(unlinkedSiblings.map((u) => u.reason))].join('/') +
        ') — graph.linkedRepos links across repositories on purpose.',
    );
  }
  return {
    count,
    sample,
    links,
    unlinkedSiblings,
    siblingIndexes,
    note:
      `${count} import(s) of the queried file(s) look internal to the code base but resolved to ` +
      'nothing in THIS index or its linked indexes — dependency edges stop at an index boundary ' +
      '(a module indexed separately without a link, or not at all). Results here are a LOWER ' +
      'bound; an empty radius is not proof.' +
      (hints.length > 0 ? ' ' + hints.join(' ') : ''),
    nextAction:
      (linkableNow.length > 0
        ? 'Run index_folder on this root so the same-checkout indexes link (since 1.32.0 edges ' +
          'cross linked indexes). '
        : '') +
      'For callers in UNLINKED indexes use find_cross_repo_usages (text search across all indexes) ' +
      'and git grep for absence proofs; for a complete graph index the whole build tree as ONE ' +
      'root (since 1.24.0 large trees index durably in batches — see docs/28-operations.md).',
  };
}
