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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getIndexDir, openDatabase, getRepo } from '../../core/db/schema.js';
import { getConfig } from '../../config/config-loader.js';

export interface ExternalImportSample {
  sourceFile: string;
  specifier: string;
}

export interface SiblingIndex {
  repoId: string;
  rootPath: string;
  /** How the other index's root relates to this one. */
  relation: 'nested' | 'parent' | 'sibling';
}

export interface ExternalImports {
  /** Unresolved, internal-looking import records across the queried files. */
  count: number;
  sample: ExternalImportSample[];
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
 * Other indexed roots that are nested under, above, or beside `rootPath` —
 * the shape of a split build tree. Reads each index's repo row (cheap; a
 * handful of DBs).
 */
export function findSiblingIndexes(repoId: string, rootPath: string): SiblingIndex[] {
  const dir = getIndexDir();
  if (!existsSync(dir) || !rootPath) return [];
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  const me = norm(rootPath);
  const meLower = me.toLowerCase();
  const myParent = dirname(me).toLowerCase();
  const out: SiblingIndex[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.db')) continue;
    const otherId = file.slice(0, -3);
    if (otherId === repoId) continue;
    try {
      const db = openDatabase(otherId);
      const meta = getRepo(db, otherId);
      db.close();
      if (!meta?.rootPath) continue;
      const other = norm(meta.rootPath);
      const otherLower = other.toLowerCase();
      let relation: SiblingIndex['relation'] | null = null;
      if (otherLower.startsWith(meLower + sep.toLowerCase()) || otherLower.startsWith(meLower + '/')) relation = 'nested';
      else if (meLower.startsWith(otherLower + sep.toLowerCase()) || meLower.startsWith(otherLower + '/')) relation = 'parent';
      else if (dirname(other).toLowerCase() === myParent) relation = 'sibling';
      if (relation) out.push({ repoId: otherId, rootPath: other, relation });
    } catch {
      /* unreadable index — skip */
    }
  }
  return out.sort((a, b) => a.rootPath.localeCompare(b.rootPath));
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
  const edgeStmt = db.prepare<[string, string], { specifier: string; target_file: string }>(
    'SELECT specifier, target_file FROM dep_edges WHERE repo_id = ? AND source_file = ?',
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
    // A specifier counts as resolved only when an edge lands on a file THIS
    // index holds. The path resolver happily follows `../../other-module/x`
    // to a file on disk outside the root — that edge is the seam itself.
    const resolved = new Set(
      edgeStmt
        .all(repoId, file)
        .filter((e) => ctx!.files.has(e.target_file))
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
  const siblingIndexes = findSiblingIndexes(repoId, rootPath);
  return {
    count,
    sample,
    siblingIndexes,
    note:
      `${count} import(s) of the queried file(s) look internal to the code base but resolved to ` +
      'nothing in THIS index — dependency edges stop at an index boundary (a module indexed ' +
      'separately, or not at all). Results here are a LOWER bound; an empty radius is not proof.' +
      (siblingIndexes.length > 0
        ? ` ${siblingIndexes.length} related index(es) found (siblingIndexes).`
        : ''),
    nextAction:
      'For cross-index callers use find_cross_repo_usages (text search across all indexes) ' +
      'and git grep for absence proofs; for a complete graph index the whole build tree as ONE ' +
      'root (since 1.24.0 large trees index durably in batches — see docs/28-operations.md).',
  };
}
