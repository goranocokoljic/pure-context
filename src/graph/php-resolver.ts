/**
 * PHP import resolver (Phase 86).
 *
 * Maps PHP `use` specifiers (`App\Http\Controllers\UserController`) to files
 * inside the repo. Without this, every PHP use-clause is a "bare specifier"
 * the path resolver treats as external, and PHP repos index to zero
 * dependency edges.
 *
 * PHP namespaces are BACKSLASH-separated — never confuse them with file
 * paths. Resolution order:
 *   1. exact fully-qualified symbol match (the PHP handler stores qualified
 *      names like `App\Http\UserController`, so most classes hit here);
 *   2. declared-namespace map (`files.declared_package`, fed by the handler's
 *      extractPackage) + basename / symbol lookup — longest prefix wins;
 *   3. whole-namespace import (`use App\Models;`) → all files of the
 *      namespace, capped by graph.maxWildcardFanout (shared with JVM/C#);
 *   4. composer.json PSR-4 map as the fallback for files without a namespace
 *      row (autoload.psr-4 + autoload-dev.psr-4, root + nested, memoized).
 *
 * Ambiguity across composer packages: candidates in the importing file's own
 * composer.json root win; otherwise edges go to ALL candidates (Phase 82
 * rule — over-approximating is the correct failure mode for blast radius).
 * Unmatched specifiers (`Symfony\...`, PHP built-ins) are external → no edge.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getDeclaredPackages } from '../core/db/file-store.js';
import { getConfig } from '../config/config-loader.js';
import { logger } from '../core/logger.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const PHP_FAMILY_EXTENSIONS = new Set(['.php']);

export function isPhpSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.php');
}

export interface PhpResolver {
  /**
   * Resolve a specifier to repo-relative file paths (as stored in the DB).
   * Empty array = external (vendor package, built-in) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Path helpers (file paths only — specifiers keep their backslashes) ──────

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function dirOfNorm(normPath: string): string {
  const lastSlash = normPath.lastIndexOf('/');
  return lastSlash < 0 ? '' : normPath.slice(0, lastSlash);
}

function baseNameNoExt(filePath: string): string {
  const norm = normalizePath(filePath);
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

interface Psr4Entry {
  prefix: string; // namespace prefix as written ("App\\" — trailing backslash)
  base: string; // repo-relative base dir, forward slashes, no trailing slash
}

export function createPhpResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): PhpResolver {
  const maxWildcardFanout = getConfig().graph.maxWildcardFanout;
  let fanoutWarned = false;

  function capFanout(files: string[], ns: string): string[] {
    if (maxWildcardFanout <= 0 || files.length <= maxWildcardFanout) return files;
    if (!fanoutWarned) {
      fanoutWarned = true;
      logger.warn(
        `PHP namespace import fanout capped at ${maxWildcardFanout} files ` +
          `(namespace "${ns}" has ${files.length}; graph.maxWildcardFanout, 0 = uncapped)`,
      );
    }
    return [...files].sort().slice(0, maxWildcardFanout);
  }

  // ── Build the maps once ────────────────────────────────────────────────────
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const phpFiles = allPaths.filter(isPhpSourceFile);
  const phpSet = new Set(phpFiles);

  // normalized path → stored path (PSR-4 lookups return DB-stored paths)
  const storedByNorm = new Map<string, string>();
  for (const f of phpFiles) storedByNorm.set(normalizePath(f), f);

  // declared namespace → files
  const declared = getDeclaredPackages(db, repoId);
  const nsFiles = new Map<string, string[]>();
  for (const f of phpFiles) {
    const ns = declared.get(f);
    if (!ns) continue;
    const list = nsFiles.get(ns);
    if (list) list.push(f);
    else nsFiles.set(ns, [f]);
  }

  // fully-qualified symbol name → declaring files (the handler stores
  // namespace-qualified names, so `use App\Foo\Bar` matches directly)
  const symFiles = new Map<string, Set<string>>();
  if (phpFiles.length > 0) {
    const rows = db
      .prepare<[string], { name: string; file_path: string }>(
        'SELECT name, file_path FROM symbols WHERE repo_id = ?',
      )
      .all(repoId);
    for (const { name, file_path } of rows) {
      if (!phpSet.has(file_path)) continue;
      let files = symFiles.get(name);
      if (!files) symFiles.set(name, (files = new Set()));
      files.add(file_path);
    }
  }

  // ── composer.json discovery: ascend from every PHP dir, read once per dir ──
  const composerRead = new Map<string, Psr4Entry[] | null>();

  function composerAt(dir: string): Psr4Entry[] | null {
    const cached = composerRead.get(dir);
    if (cached !== undefined) return cached;
    let entries: Psr4Entry[] | null = null;
    try {
      const content = readFileSync(join(projectRoot, dir, 'composer.json'), 'utf8');
      const json = JSON.parse(content) as {
        autoload?: { 'psr-4'?: Record<string, string | string[]> };
        'autoload-dev'?: { 'psr-4'?: Record<string, string | string[]> };
      };
      entries = [];
      for (const map of [json.autoload?.['psr-4'], json['autoload-dev']?.['psr-4']]) {
        if (!map) continue;
        for (const [prefix, dirs] of Object.entries(map)) {
          for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
            if (typeof d !== 'string') continue;
            const rel = normalizePath(d).replace(/^\.\//, '').replace(/\/+$/, '');
            const base = dir.length === 0 ? rel : rel.length === 0 ? dir : `${dir}/${rel}`;
            entries.push({ prefix, base });
          }
        }
      }
    } catch {
      // no composer.json here, or unparseable — either way not a root
    }
    composerRead.set(dir, entries);
    return entries;
  }

  // PSR-4 entries across all discovered composer.json files, longest prefix
  // first; composerDirs doubles as the module-root set for ambiguity preference.
  const psr4: Psr4Entry[] = [];
  const composerDirs = new Set<string>();
  {
    const seenDirs = new Set<string>();
    for (const f of phpFiles) {
      let cur = dirOfNorm(normalizePath(f));
      for (;;) {
        if (!seenDirs.has(cur)) {
          seenDirs.add(cur);
          const entries = composerAt(cur);
          if (entries) {
            composerDirs.add(cur);
            psr4.push(...entries);
          }
        }
        if (cur === '') break;
        cur = dirOfNorm(cur);
      }
    }
    psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  // ── Composer module preference (mirror of the JVM Gradle/Maven rule) ───────
  const moduleRootByDir = new Map<string, string>();

  function moduleRootOfDir(dir: string): string {
    const cached = moduleRootByDir.get(dir);
    if (cached !== undefined) return cached;
    let root = '';
    if (dir !== '') {
      root = composerDirs.has(dir)
        ? dir
        : moduleRootOfDir(dirOfNorm(dir));
    } else if (composerDirs.has('')) {
      root = '';
    }
    moduleRootByDir.set(dir, root);
    return root;
  }

  function preferSameModule(candidates: string[], sourceFile: string): string[] {
    if (candidates.length <= 1) return candidates;
    const srcModule = moduleRootOfDir(dirOfNorm(normalizePath(sourceFile)));
    const sameModule = candidates.filter(
      (c) => moduleRootOfDir(dirOfNorm(normalizePath(c))) === srcModule,
    );
    return sameModule.length > 0 ? sameModule : candidates;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  function nsCandidates(ns: string, name: string): string[] {
    const files = nsFiles.get(ns);
    if (!files) return [];
    // A file named after the imported identifier is the strongest signal
    // (PSR-4 convention: one class per file, file named after the class)…
    let candidates = files.filter((f) => baseNameNoExt(f) === name);
    // …otherwise "which file in this namespace declares that symbol"
    // (use function / use const, multiple classes per file).
    if (candidates.length === 0) {
      candidates = [...(symFiles.get(`${ns}\\${name}`) ?? [])];
    }
    return candidates;
  }

  function psr4Lookup(spec: string): string[] {
    for (const { prefix, base } of psr4) {
      if (!spec.startsWith(prefix)) continue;
      const remainder = spec.slice(prefix.length).replace(/^\\/, '');
      if (remainder.length === 0) continue;
      const rel = `${remainder.replace(/\\/g, '/')}.php`;
      const stored = storedByNorm.get(base.length === 0 ? rel : `${base}/${rel}`);
      if (stored) return [stored];
    }
    return [];
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim().replace(/^\\+/, '').replace(/;$/, '').trim();
      if (spec.length === 0) return [];

      // 1. Exact fully-qualified symbol match
      const exact = [...(symFiles.get(spec) ?? [])].filter((f) => f !== sourceFile);
      if (exact.length > 0) return preferSameModule(exact, sourceFile);

      // 2. Declared namespace + basename/symbol — longest prefix wins
      const parts = spec.split('\\').filter((p) => p.length > 0);
      for (let i = parts.length - 1; i >= 1; i--) {
        const ns = parts.slice(0, i).join('\\');
        if (!nsFiles.has(ns)) continue;
        const hits = nsCandidates(ns, parts[i]!).filter((f) => f !== sourceFile);
        if (hits.length > 0) return preferSameModule(hits, sourceFile);
        break; // namespace exists but the name doesn't — shorter prefixes would be wrong
      }

      // 3. Whole-namespace import: `use App\Models;`
      if (nsFiles.has(spec)) {
        const files = (nsFiles.get(spec) ?? []).filter((f) => f !== sourceFile);
        return capFanout(preferSameModule(files, sourceFile), spec);
      }

      // 4. PSR-4 fallback (files without a namespace row / pre-v9 indexes)
      return psr4Lookup(spec).filter((f) => f !== sourceFile);
    },
  };
}
