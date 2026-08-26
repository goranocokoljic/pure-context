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
 * Phase 83 extends the same machinery to C#: `using X.Y` is a namespace import
 * (every using is a wildcard), `using static X.Y.T` and alias `using F = X.Y.T`
 * arrive as class-path specifiers — both shapes were already handled. The
 * declared-namespace column is fed by the C# handler's extractPackage.
 *
 * Specifier shapes handled (as emitted by the handlers):
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

import { readdirSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getDeclaredPackages } from '../core/db/file-store.js';
import { getConfig } from '../config/config-loader.js';
import { logger } from '../core/logger.js';
import { isTestFilePath } from '../core/test-paths.js';

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Languages whose imports name a DECLARED MODULE (package/namespace header)
 * rather than a file path. Phase 82 covered the JVM family; Phase 83 adds C#
 * (`using` directives resolve against `namespace` declarations the same way).
 */
export const DECLARED_MODULE_EXTENSIONS = new Set([
  '.kt', '.kts', '.java', '.scala', '.sc', '.groovy', '.gradle', '.cs',
]);

export function isDeclaredModuleSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return false;
  return DECLARED_MODULE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

/** @deprecated Renamed in Phase 83 — use DECLARED_MODULE_EXTENSIONS. */
export const JVM_EXTENSIONS = DECLARED_MODULE_EXTENSIONS;

/** @deprecated Renamed in Phase 83 — use isDeclaredModuleSourceFile. */
export const isJvmSourceFile = isDeclaredModuleSourceFile;

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

const MODULE_MARKER_NAMES = new Set(['build.gradle', 'build.gradle.kts', 'pom.xml']);
const MODULE_MARKER_SUFFIXES = ['.csproj', '.sln'];

/**
 * Does this directory contain a module marker? Gradle/Maven markers are exact
 * filenames; .NET project files have arbitrary basenames (`Foo.csproj`), so the
 * check needs one directory listing (memoized by the caller), not existsSync of
 * fixed names.
 */
function dirHasModuleMarker(absDir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return false;
  }
  return entries.some((e) => {
    const lower = e.toLowerCase();
    return (
      MODULE_MARKER_NAMES.has(lower) || MODULE_MARKER_SUFFIXES.some((s) => lower.endsWith(s))
    );
  });
}

export interface JvmResolverOptions {
  /**
   * Cap on files a single wildcard/namespace import expands to (C# `using X.Y`
   * imports a whole namespace, so a popular namespace in a large repo would
   * explode dep_edges). 0 = uncapped. Default: config `graph.maxWildcardFanout`.
   */
  maxWildcardFanout?: number;
  /**
   * Namespace prefixes that never resolve locally (Task 548). Default:
   * config `graph.reservedNamespaces`; [] disables the check.
   */
  reservedNamespaces?: string[];
}

export function createJvmResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
  options?: JvmResolverOptions,
): JvmResolver {
  const maxWildcardFanout =
    options?.maxWildcardFanout ?? getConfig().graph.maxWildcardFanout;
  const reservedNamespaces =
    options?.reservedNamespaces ?? getConfig().graph.reservedNamespaces;
  let fanoutWarned = false;

  /**
   * Reserved-namespace check (Task 548): `android.util.Log` means the
   * platform SDK even when a repo file declares `package android.util`
   * (vendored AOSP shims, unit-test stubs). Prefix `p` matches `p` and
   * everything under `p.`. Empty list = disabled (AOSP-fork opt-out).
   */
  function isReserved(name: string): boolean {
    for (const ns of reservedNamespaces) {
      if (name === ns || name.startsWith(ns + '.')) return true;
    }
    return false;
  }

  /**
   * Deterministically cap a package-wide expansion. Logged once per
   * resolver (= once per repo graph build).
   */
  function capFanout(files: string[], pkg: string): string[] {
    if (maxWildcardFanout <= 0 || files.length <= maxWildcardFanout) return files;
    if (!fanoutWarned) {
      fanoutWarned = true;
      logger.warn(
        `Wildcard/namespace import fanout capped at ${maxWildcardFanout} files ` +
          `(package "${pkg}" has ${files.length}; graph.maxWildcardFanout, 0 = uncapped)`,
      );
    }
    return [...files].sort().slice(0, maxWildcardFanout);
  }
  // ── Build the package maps once ────────────────────────────────────────────
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const jvmFiles = allPaths.filter(isDeclaredModuleSourceFile);

  const declared = getDeclaredPackages(db, repoId);

  // file → package. Files DECLARING a reserved package are never registered
  // as resolution targets (mirrors go-resolver's vendor/ skip: filter at
  // registration, so no candidate set ever contains them — this also keeps
  // them out of the basename/symbol-table fallbacks).
  const filePkg = new Map<string, string>();
  for (const f of jvmFiles) {
    const pkg = declared.get(f) ?? derivePackageFromPath(f);
    if (pkg && !isReserved(pkg)) filePkg.set(f, pkg);
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
      if (dirHasModuleMarker(abs)) {
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

  /**
   * Production → test-source-set edges do not exist (Task 549, report Issue
   * B): a file under src/main/ cannot depend on src/test/ — the dependency
   * only runs the other way. When the IMPORTER is not itself a test file,
   * test-source-set candidates are dropped BEFORE the same-module preference
   * and the all-candidates fallback, so a genuine main-source candidate is
   * never displaced by a stub. Empty after filtering ⇒ no edge (the target
   * was a shadow/stub, not a dependency).
   */
  function dropTestCandidates(candidates: string[], sourceFile: string): string[] {
    if (candidates.length === 0 || isTestFilePath(sourceFile)) return candidates;
    return candidates.filter((f) => !isTestFilePath(f));
  }

  function packageFiles(pkg: string, sourceFile: string): string[] {
    return dropTestCandidates(
      (pkgFiles.get(pkg) ?? []).filter((f) => f !== sourceFile),
      sourceFile,
    );
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
    candidates = dropTestCandidates(
      candidates.filter((f) => f !== sourceFile),
      sourceFile,
    );
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

    // Kotlin/Java wildcard imports and C# namespace usings reach the resolver
    // as a bare package/namespace name.
    if (pkgFiles.has(specifier)) {
      return capFanout(
        preferSameModule(packageFiles(specifier, sourceFile), sourceFile),
        specifier,
      );
    }
    return [];
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      let spec = specifier.trim().replace(/;$/, '').trim();
      if (spec.length === 0) return [];

      // Reserved namespace → external, no edge — and no fallthrough to the
      // basename/symbol-table fallbacks, which could otherwise match a
      // same-named local symbol.
      if (isReserved(spec)) return [];

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
              ? capFanout(preferSameModule(packageFiles(prefix, sourceFile), sourceFile), prefix)
              : resolveQualified(`${prefix}.${name}`, sourceFile);
          for (const h of hits) results.add(h);
        }
        return [...results];
      }

      // Groovy `.*` / Scala `._` wildcard suffix
      if (spec.endsWith('.*') || spec.endsWith('._')) {
        const pkg = spec.slice(0, -2);
        return capFanout(preferSameModule(packageFiles(pkg, sourceFile), sourceFile), pkg);
      }

      return resolveQualified(spec, sourceFile);
    },
  };
}
