/**
 * Python import resolver (Phase 84).
 *
 * Maps Python import specifiers to files inside the repo. Without this, every
 * Python import is a "bare specifier" the path resolver treats as external,
 * and Python repos index to zero dependency edges.
 *
 * Python module identity IS the file path — no stored declaration header is
 * needed (unlike the JVM `declared_package` column). The resolver builds a
 * dotted-name → files index once per graph build:
 *   a/b.py            → a.b
 *   a/b/__init__.py   → a.b
 * Each file registers under the repo root and, when the file's first-level
 * directory is a source root rather than a package (`src/`, or any first-level
 * dir with no `__init__.py`), under that root stripped too. One file may
 * register under multiple names — over-approximation is the correct failure
 * mode for blast radius (Phase 82 principle).
 *
 * Specifier shapes handled (as emitted by the Python handler):
 *   a.b.c                    plain import — module index lookup
 *   a.b (+ importedNames)    from-import — prefer submodule a/b/<name>.py,
 *                            else the module file itself (symbol-table tiebreak)
 *   .  /  ..pkg              relative — exact directory walk, no index needed
 *
 * v1 limitations (documented): no sys.path manipulation, no editable installs,
 * no pyproject package-dir remapping — layout conventions only.
 */

import type Database from 'better-sqlite3';

// ─── Public surface ───────────────────────────────────────────────────────────

export function isPythonSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.py');
}

export interface PythonResolver {
  /**
   * Resolve a specifier to repo-relative file paths (as stored in the DB).
   * Empty array = external (stdlib, site-packages) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string, importedNames: string[]): string[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function segments(filePath: string): string[] {
  return normalize(filePath).split('/').filter((s) => s.length > 0);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPythonResolver(db: Database.Database, repoId: string): PythonResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const pyFiles = allPaths.filter(isPythonSourceFile);

  // normalized path → stored path (return values must match what the DB holds)
  const storedByNorm = new Map<string, string>();
  for (const f of pyFiles) storedByNorm.set(normalize(f), f);

  // First-level dirs that are packages (contain __init__.py): their names are
  // part of the module path, so they are NOT candidate source roots to strip.
  const firstLevelPackages = new Set<string>();
  for (const norm of storedByNorm.keys()) {
    const segs = norm.split('/');
    if (segs.length === 2 && segs[1] === '__init__.py') firstLevelPackages.add(segs[0]);
  }

  /** Module-path segments for a file (basename without .py; __init__ = the dir). */
  function moduleSegs(norm: string): string[] {
    const segs = norm.split('/');
    const base = segs[segs.length - 1];
    const stem = base.slice(0, -'.py'.length);
    return stem === '__init__' ? segs.slice(0, -1) : [...segs.slice(0, -1), stem];
  }

  // dotted module name → stored file paths
  const moduleFiles = new Map<string, string[]>();
  function register(dotted: string, stored: string) {
    if (!dotted) return;
    const list = moduleFiles.get(dotted);
    if (list) list.push(stored);
    else moduleFiles.set(dotted, [stored]);
  }
  for (const [norm, stored] of storedByNorm) {
    const segs = moduleSegs(norm);
    if (segs.length === 0) continue;
    register(segs.join('.'), stored);
    // Strip a first-level source root: `src/` always; any other first-level dir
    // only when it is not itself a package (a non-package dir is not importable,
    // so its children can only be reached with the root stripped).
    if (segs.length > 1 && (segs[0] === 'src' || !firstLevelPackages.has(segs[0]))) {
      register(segs.slice(1).join('.'), stored);
    }
  }

  // Lazy symbol table: file → declared symbol names (tiebreak for from-imports
  // when a module name maps to several files under different roots).
  let fileSymbols: Map<string, Set<string>> | null = null;
  function symbolsOf(stored: string): Set<string> {
    if (!fileSymbols) {
      fileSymbols = new Map();
      const rows = db
        .prepare<[string], { name: string; file_path: string }>(
          'SELECT name, file_path FROM symbols WHERE repo_id = ?',
        )
        .all(repoId);
      for (const { name, file_path } of rows) {
        let set = fileSymbols.get(file_path);
        if (!set) fileSymbols.set(file_path, (set = new Set()));
        set.add(name);
        const lastDot = name.lastIndexOf('.');
        if (lastDot > 0) set.add(name.slice(lastDot + 1));
      }
    }
    return fileSymbols.get(stored) ?? new Set();
  }

  /** Files that ARE the module at these path segments (mod.py or mod/__init__.py). */
  function filesAtSegs(segs: string[]): string[] {
    if (segs.length === 0) return [];
    const joined = segs.join('/');
    const hits: string[] = [];
    const asFile = storedByNorm.get(`${joined}.py`);
    if (asFile) hits.push(asFile);
    const asPkg = storedByNorm.get(`${joined}/__init__.py`);
    if (asPkg) hits.push(asPkg);
    return hits;
  }

  /** From-import member resolution against an absolute dotted module name. */
  function resolveFromAbsolute(spec: string, names: string[]): string[] {
    const results = new Set<string>();
    const modHits = moduleFiles.get(spec) ?? [];
    const realNames = names.filter((n) => n !== '*');

    for (const name of realNames) {
      // Prefer the submodule a/b/<name>.py when it exists…
      const subHits = moduleFiles.get(`${spec}.${name}`);
      if (subHits && subHits.length > 0) {
        for (const h of subHits) results.add(h);
        continue;
      }
      // …else the member lives in the module file itself. When several files
      // answer to the module name, prefer those actually declaring the symbol.
      if (modHits.length > 1) {
        const declaring = modHits.filter((f) => symbolsOf(f).has(name));
        for (const h of declaring.length > 0 ? declaring : modHits) results.add(h);
      } else {
        for (const h of modHits) results.add(h);
      }
    }

    if (names.includes('*') || realNames.length === 0) {
      for (const h of modHits) results.add(h);
    }
    return [...results];
  }

  /** Relative import: exact walk from the source file's directory. */
  function resolveRelative(spec: string, sourceFile: string, names: string[]): string[] {
    let dots = 0;
    while (dots < spec.length && spec[dots] === '.') dots++;
    const rest = spec.slice(dots);

    const srcSegs = segments(sourceFile);
    const dirSegs = srcSegs.slice(0, -1);
    // One dot = the current package dir; each extra dot ascends one level.
    const up = dots - 1;
    if (up > dirSegs.length) return [];
    const base = dirSegs.slice(0, dirSegs.length - up);
    const modSegs = rest.length > 0 ? rest.split('.').filter((s) => s.length > 0) : [];
    const pkgSegs = [...base, ...modSegs];

    const results = new Set<string>();
    const modHits = filesAtSegs(pkgSegs);
    const realNames = names.filter((n) => n !== '*');

    for (const name of realNames) {
      const subHits = filesAtSegs([...pkgSegs, name]);
      for (const h of subHits.length > 0 ? subHits : modHits) results.add(h);
    }
    if (names.includes('*') || realNames.length === 0) {
      for (const h of modHits) results.add(h);
    }
    return [...results];
  }

  return {
    resolve(specifier: string, sourceFile: string, importedNames: string[]): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];

      let hits: string[];
      if (spec.startsWith('.')) {
        hits = resolveRelative(spec, sourceFile, importedNames);
      } else if (importedNames.length > 0) {
        hits = resolveFromAbsolute(spec, importedNames);
      } else {
        hits = moduleFiles.get(spec) ?? [];
      }
      return [...new Set(hits)].filter((f) => f !== sourceFile);
    },
  };
}
