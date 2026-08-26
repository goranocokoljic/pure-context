/**
 * JVM import resolver (Phase 82).
 *
 * Maps package-qualified import specifiers (Kotlin / Java / Scala / Groovy) to
 * files inside the repo. Without this, every JVM import is a "bare specifier"
 * that the path resolver treats as external, and JVM repos index to zero
 * dependency edges.
 *
 * Resolution is driven by the `declared_package` column captured at index time
 * (handler `extractPackage`); files indexed before schema v9 fall back to a
 * source-root path convention (`src/main/kotlin/com/example/Foo.kt` → "com.example").
 *
 * Specifier shapes handled (as emitted by the four handlers):
 *   com.example.Foo            plain class import (Kotlin/Java/Groovy/Scala)
 *   com.example.foo            Kotlin/Java wildcard (the star is not in the specifier)
 *   com.example.*  /  a.b._    Groovy / Scala wildcard
 *   a.b.{Map, Set => MSet}     Scala selector clause
 *   a.b.Outer.Inner            nested class — longest package prefix wins
 *   a.b.Class (+ member)       static/member import, pre-stripped by the handlers
 *   a.b.topLevelFun            Kotlin member import — resolved via the symbol table
 *
 * Ambiguity (same package + name in several Gradle/Maven modules): candidates in
 * the importing file's own module win; otherwise edges go to ALL candidates.
 * Over-approximating is the correct failure mode for blast radius — silently
 * picking one candidate is not.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getDeclaredPackages } from '../core/db/file-store.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const JVM_EXTENSIONS = new Set(['.kt', '.kts', '.java', '.scala', '.sc', '.groovy', '.gradle']);

export function isJvmSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return JVM_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

export interface JvmResolver {
  /**
   * Resolve a specifier to repo-relative file paths (as stored in the DB).
   * Empty array = external (JDK, third-party) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Forward-slash segments of a path's directory part. */
function dirSegments(filePath: string): string[] {
  const norm = filePath.replace(/\\/g, '/');
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash < 0) return [];
  return norm.slice(0, lastSlash).split('/').filter((s) => s.length > 0);
}

function baseNameNoExt(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

const SOURCE_LANG_DIRS = new Set(['java', 'kotlin', 'scala', 'groovy']);
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Convention fallback for files without a stored declared_package (pre-v9 rows):
 * take the directory segments after the last `src/<set>/<lang>` triple
 * (e.g. `src/main/kotlin`) or, failing that, after the last bare language dir.
 * Returns null when no convention root is recognizable — guessing a wrong
 * package would create wrong edges, so no root means no fallback.
 */
export function derivePackageFromPath(filePath: string): string | null {
  const segs = dirSegments(filePath);
  let start = -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (SOURCE_LANG_DIRS.has(segs[i]!) && i >= 2 && segs[i - 2] === 'src') {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    for (let i = segs.length - 1; i >= 0; i--) {
      if (SOURCE_LANG_DIRS.has(segs[i]!)) {
        start = i + 1;
        break;
      }
    }
  }
  if (start < 0) return null;
  const pkgSegs = segs.slice(start);
  if (pkgSegs.length === 0 || !pkgSegs.every((s) => IDENT_RE.test(s))) return null;
  return pkgSegs.join('.');
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const MODULE_MARKERS = ['build.gradle', 'build.gradle.kts', 'pom.xml'];

export function createJvmResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): JvmResolver {
  // ── Build the package maps once ────────────────────────────────────────────
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const jvmFiles = allPaths.filter(isJvmSourceFile);

  const declared = getDeclaredPackages(db, repoId);

  // file → package
  const filePkg = new Map<string, string>();
  for (const f of jvmFiles) {
    const pkg = declared.get(f) ?? derivePackageFromPath(f);
    if (pkg) filePkg.set(f, pkg);
  }

  // package → files
  const pkgFiles = new Map<string, string[]>();
  for (const [f, pkg] of filePkg) {
    const list = pkgFiles.get(pkg);
    if (list) list.push(f);
    else pkgFiles.set(pkg, [f]);
  }

  // package → symbol name → declaring files (member imports: the imported
  // identifier need not match any file basename)
  const pkgSymbols = new Map<string, Map<string, Set<string>>>();
  if (jvmFiles.length > 0) {
    const symRows = db
      .prepare<[string], { name: string; file_path: string }>(
        'SELECT name, file_path FROM symbols WHERE repo_id = ?',
      )
      .all(repoId);
    const addSym = (pkg: string, name: string, file: string) => {
      let byName = pkgSymbols.get(pkg);
      if (!byName) pkgSymbols.set(pkg, (byName = new Map()));
      let files = byName.get(name);
      if (!files) byName.set(name, (files = new Set()));
      files.add(file);
    };
    for (const { name, file_path } of symRows) {
      const pkg = filePkg.get(file_path);
      if (!pkg) continue;
      addSym(pkg, name, file_path);
      // Qualified symbol names (`Outer.method`) are also reachable by their
      // bare last segment; package scoping bounds the over-match.
      const lastDot = name.lastIndexOf('.');
      if (lastDot > 0) {
        const bare = name.slice(lastDot + 1);
        if (bare.length > 0) addSym(pkg, bare, file_path);
      }
    }
  }

  // ── Gradle/Maven module lookup (memoized disk walk) ───────────────────────
  const moduleRootByDir = new Map<string, string>();

  function moduleRootOfDir(dir: string): string {
    const cached = moduleRootByDir.get(dir);
    if (cached !== undefined) return cached;
    let root = '';
    if (dir !== '') {
      const abs = join(projectRoot, dir);
      if (MODULE_MARKERS.some((m) => existsSync(join(abs, m)))) {
        root = dir;
      } else {
        const lastSlash = dir.lastIndexOf('/');
        root = moduleRootOfDir(lastSlash < 0 ? '' : dir.slice(0, lastSlash));
      }
    }
    moduleRootByDir.set(dir, root);
    return root;
  }

  function moduleRootOf(filePath: string): string {
    return moduleRootOfDir(dirSegments(filePath).join('/'));
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  function preferSameModule(candidates: string[], sourceFile: string): string[] {
    if (candidates.length <= 1) return candidates;
    const srcModule = moduleRootOf(sourceFile);
    const sameModule = candidates.filter((c) => moduleRootOf(c) === srcModule);
    return sameModule.length > 0 ? sameModule : candidates;
  }

  function packageFiles(pkg: string, sourceFile: string): string[] {
    return (pkgFiles.get(pkg) ?? []).filter((f) => f !== sourceFile);
  }

  function resolveInPackage(pkg: string, name: string, sourceFile: string): string[] {
    const files = pkgFiles.get(pkg);
    if (!files) return [];
    // A file named after the imported identifier is the strongest signal…
    let candidates = files.filter((f) => baseNameNoExt(f) === name);
    // …otherwise fall back to "which file in this package declares that symbol"
    // (Kotlin top-level members, objects in shared files, etc.).
    if (candidates.length === 0) {
      candidates = [...(pkgSymbols.get(pkg)?.get(name) ?? [])];
    }
    candidates = candidates.filter((f) => f !== sourceFile);
    return preferSameModule(candidates, sourceFile);
  }

  function resolveQualified(specifier: string, sourceFile: string): string[] {
    const parts = specifier.split('.').filter((p) => p.length > 0);
    if (parts.length === 0) return [];

    // Longest package prefix wins: for a.b.Outer.Inner the prefix a.b resolves
    // Outer; for a.b.Class.MEMBER it resolves Class.
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (!pkgFiles.has(prefix)) continue;
      const hits = resolveInPackage(prefix, parts[i]!, sourceFile);
      if (hits.length > 0) return hits;
      break; // prefix exists but the name doesn't — shorter prefixes would be wrong
    }

    // Kotlin/Java wildcard imports reach the resolver as a bare package name.
    if (pkgFiles.has(specifier)) {
      return preferSameModule(packageFiles(specifier, sourceFile), sourceFile);
    }
    return [];
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      let spec = specifier.trim().replace(/;$/, '').trim();
      if (spec.length === 0) return [];

      // Scala selector clause: a.b.{Map, Set => MSet, _}
      const braceIdx = spec.indexOf('{');
      if (braceIdx >= 0) {
        const prefix = spec.slice(0, braceIdx).replace(/[.\s]+$/, '');
        const inner = spec.slice(braceIdx + 1, spec.indexOf('}') >= 0 ? spec.indexOf('}') : spec.length);
        const names = inner
          .split(',')
          .map((t) => t.trim().split(/\s*=>\s*/)[0]!.trim())
          .filter((n) => n.length > 0);
        const results = new Set<string>();
        for (const name of names) {
          const hits =
            name === '_' || name === '*'
              ? preferSameModule(packageFiles(prefix, sourceFile), sourceFile)
              : resolveQualified(`${prefix}.${name}`, sourceFile);
          for (const h of hits) results.add(h);
        }
        return [...results];
      }

      // Groovy `.*` / Scala `._` wildcard suffix
      if (spec.endsWith('.*') || spec.endsWith('._')) {
        const pkg = spec.slice(0, -2);
        return preferSameModule(packageFiles(pkg, sourceFile), sourceFile);
      }

      return resolveQualified(spec, sourceFile);
    },
  };
}
