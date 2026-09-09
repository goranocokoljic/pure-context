/**
 * Validated fast path for handler-prefilled import targets (Phase 98, Task 608).
 *
 * Many regex/tree handlers (C, C++, Objective-C, Lua, SCSS/LESS/CSS, Bash, R,
 * Nix, Terraform, XML, Gleam) fill `ImportRecord.resolvedPath` with the
 * specifier as written — `"auth.h"`, `a/b.lua`, `variables`, `./modules/vpc`.
 * Before Phase 98 `buildGraph` inserted that string VERBATIM as the edge
 * target. A target that names no indexed file is a permanent dangling row:
 * every graph query still answers nothing, while the non-zero edge count
 * suppresses the honest `graphCoverage:'empty'` signal (gap-analysis-v2 H1;
 * Lua on Neovim-layout repos was 100% phantom, vismedic carried 209 dangling
 * rows out of 423 on the phase-98 baseline).
 *
 * This module turns a prefilled value into ZERO OR MORE indexed files:
 *   1. exact — the value as a repo-relative path, or relative to the source
 *      file's directory (C/C++/ObjC sibling includes, Bash/Nix/R `./x`);
 *   2. extension / stylesheet-partial probes — `x` → `x.scss`, `_x.scss`,
 *      `x/index.scss`, `x/_index.scss` (+ .less/.css/.sass);
 *   3. Lua module forms — `a/b.lua`, `a/b/init.lua`, and the Neovim `lua/`
 *      runtime root;
 *   4. directory targets (Terraform `source = "./modules/x"`) — fan out to
 *      the `.tf` files directly under the directory;
 *   5. suffix match — an indexed file that ENDS with `/<value>` (include
 *      roots, `-I include`); several matches → the ones sharing the longest
 *      directory prefix with the importer; a multi-way tie with no shared
 *      prefix at all is dropped as unresolvable rather than fanned out;
 *   6. the generic path resolver (disk-probing, `./`/`../` + tsconfig
 *      aliases) — accepted only if the file it finds is indexed.
 * Anything still unmatched yields [] — the record is dropped, never a
 * dangling row. Callers that pass no indexed-file set keep the pre-98
 * verbatim behavior (back-compat for direct `buildGraph` users).
 */

import { posix } from 'path';
import type { ImportRecord } from '../core/types.js';
import type { PathResolver } from './path-resolver.js';

const STYLESHEET_EXTS = new Set(['.scss', '.sass', '.less', '.css']);
const STYLESHEET_PROBE_EXTS = ['.scss', '.sass', '.less', '.css'];
const LUA_EXTS = new Set(['.lua']);
const TERRAFORM_EXTS = new Set(['.tf', '.tfvars', '.hcl']);

export interface IndexedFileSet {
  /** normalized (forward-slash) path → stored path (what the DB holds). */
  readonly byNorm: ReadonlyMap<string, string>;
  /** basename → normalized paths (for suffix matching). */
  readonly byBase: ReadonlyMap<string, readonly string[]>;
}

function norm(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function extOf(p: string): string {
  const base = posix.basename(p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Build the lookup structure once per graph build from the stored file paths. */
export function buildIndexedFileSet(storedPaths: Iterable<string>): IndexedFileSet {
  const byNorm = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const stored of storedPaths) {
    const n = norm(stored);
    byNorm.set(n, stored);
    const base = posix.basename(n);
    const list = byBase.get(base);
    if (list) list.push(n);
    else byBase.set(base, [n]);
  }
  return { byNorm, byBase };
}

function sharedPrefixSegments(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  let n = 0;
  while (n < as.length - 1 && n < bs.length - 1 && as[n] === bs[n]) n++;
  return n;
}

/**
 * Resolve a prefilled target to indexed files. Returns STORED paths (DB form).
 */
export function resolvePrefilledTarget(
  rec: ImportRecord,
  indexed: IndexedFileSet,
  resolver: PathResolver,
): string[] {
  const value = rec.resolvedPath;
  if (value === null || value === undefined) return [];
  const target = norm(value);
  if (target.length === 0) return [];
  const source = norm(rec.sourceFile);
  const sourceDir = posix.dirname(source);
  const sourceExt = extOf(source);

  const hit = (n: string): string | undefined => indexed.byNorm.get(n);
  const found = (n: string): string[] => {
    const s = hit(n);
    return s === undefined ? [] : [s];
  };

  // 1. exact — repo-relative, then relative to the importer's directory
  const relToSource = posix.normalize(posix.join(sourceDir, target));
  for (const cand of [target, relToSource]) {
    if (cand.startsWith('../')) continue;
    const r = found(cand);
    if (r.length > 0) return r;
  }

  // 2. stylesheet partials / extension probes
  if (STYLESHEET_EXTS.has(sourceExt)) {
    for (const base of [relToSource, target]) {
      if (base.startsWith('../')) continue;
      const dir = posix.dirname(base);
      const name = posix.basename(base);
      const stem = name.replace(/\.(scss|sass|less|css)$/i, '');
      const probes: string[] = [];
      for (const ext of STYLESHEET_PROBE_EXTS) {
        probes.push(posix.join(dir, `${stem}${ext}`));
        probes.push(posix.join(dir, `_${stem}${ext}`));
        probes.push(posix.join(dir, stem, `index${ext}`));
        probes.push(posix.join(dir, stem, `_index${ext}`));
      }
      for (const p of probes) {
        const r = found(p);
        if (r.length > 0) return r;
      }
    }
  }

  // 3. Lua module forms
  if (LUA_EXTS.has(sourceExt)) {
    const stem = target.replace(/\.lua$/i, '');
    const probes = [
      `${stem}.lua`,
      `${stem}/init.lua`,
      `lua/${stem}.lua`,
      `lua/${stem}/init.lua`,
      posix.join(sourceDir, `${stem}.lua`),
      posix.join(sourceDir, `${stem}/init.lua`),
    ];
    for (const p of probes) {
      if (p.startsWith('../')) continue;
      const r = found(p);
      if (r.length > 0) return r;
    }
  }

  // 4. directory targets (Terraform module sources) — fan out to direct children
  if (TERRAFORM_EXTS.has(sourceExt)) {
    for (const dir of [relToSource, target]) {
      if (dir.startsWith('../')) continue;
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const children: string[] = [];
      for (const [n, stored] of indexed.byNorm) {
        if (n.startsWith(prefix) && !n.slice(prefix.length).includes('/') && /\.tf$/i.test(n)) {
          children.push(stored);
        }
      }
      if (children.length > 0) return children.sort();
    }
  }

  // 5. suffix match (include roots, Lua package paths, `-I` dirs)
  {
    const base = posix.basename(target);
    const cands = (indexed.byBase.get(base) ?? []).filter(
      (n) => n === target || n.endsWith(`/${target}`),
    );
    if (cands.length === 1) return found(cands[0]!);
    if (cands.length > 1) {
      let best = -1;
      let bestList: string[] = [];
      for (const n of cands) {
        const k = sharedPrefixSegments(n, source);
        if (k > best) {
          best = k;
          bestList = [n];
        } else if (k === best) bestList.push(n);
      }
      // A multi-way tie with no shared directory at all is unresolvable
      // ambiguity (`utils.h` in thirty places) — drop rather than fan out.
      if (best === 0 && bestList.length > 1) return [];
      return bestList.flatMap(found);
    }
  }

  // 6. the generic disk-probing resolver, accepted only when indexed
  for (const spec of [rec.specifier, target.startsWith('.') ? target : `./${target}`]) {
    let resolved: string | null = null;
    try {
      resolved = resolver.resolve(spec, rec.sourceFile);
    } catch {
      resolved = null;
    }
    if (resolved !== null) {
      const r = found(norm(resolved));
      if (r.length > 0) return r;
    }
  }

  return [];
}
