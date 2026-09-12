/**
 * Swift module import resolver (Phase 103, Task 642).
 *
 * `import NIOCore` names a MODULE; SwiftPM defines modules as targets in
 * `Package.swift` and maps each target to a source directory (`path:` or the
 * default `Sources/<name>` / `Tests/<name>` / `Plugins/<name>`). Before this
 * module the handler emitted the module name and nothing mapped it, so
 * swift-nio / vapor / swift-composable-architecture only had edges inside a
 * file's own target (gap-analysis MEDIUM).
 *
 * Mapping rule (the Go package rule, `go-resolver.ts`): every `Package.swift`
 * in the index is parsed (regex over balanced `.target(` / `.testTarget(` /
 * `.executableTarget(` / `.macro(` / `.plugin(` / `.systemLibrary(` blocks
 * — a `.target(name:)` nested inside another target's `dependencies:` is a
 * dependency reference, not a declaration, and is skipped); `import X` →
 * every indexed file under target X's directory (the module IS the
 * directory). Without a manifest, `Sources/<X>/` and `Tests/<X>/` directories
 * that hold indexed files stand in (the Xcode-with-SPM-layout case); any
 * other module (`Foundation`, `UIKit`, a dependency package) is external.
 * `@testable import` follows the same map. `.binaryTarget` has no sources.
 * Phase-98 hygiene: a production importer never resolves into a test target,
 * a first-party importer never into a foreign directory; a file never
 * imports its own module.
 */

import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isTestFilePath } from '../core/test-paths.js';
import { dropForeignCandidates, isForeignPath } from '../core/library-paths.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const SWIFT_FAMILY_EXTENSIONS = new Set(['.swift']);

export function isSwiftSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.swift');
}

export interface SwiftResolver {
  /** Resolve a module import to repo-relative file paths (DB form). */
  resolve(specifier: string, sourceFile: string): string[];
  /** module name → normalised target directory — for tests / diagnostics. */
  targets(): Map<string, string>;
}

export interface SwiftTargetDecl {
  name: string;
  /** Directory relative to the package directory (normalised, no trailing slash). */
  path: string;
  kind: 'target' | 'test' | 'plugin' | 'system';
}

// ─── Package.swift parsing ────────────────────────────────────────────────────

const TARGET_OPENERS: ReadonlyArray<[string, SwiftTargetDecl['kind'] | 'binary']> = [
  ['.target(', 'target'],
  ['.executableTarget(', 'target'],
  ['.macro(', 'target'],
  ['.testTarget(', 'test'],
  ['.plugin(', 'plugin'],
  ['.systemLibrary(', 'system'],
  ['.binaryTarget(', 'binary'],
];

function defaultDir(kind: SwiftTargetDecl['kind'], name: string): string {
  if (kind === 'test') return `Tests/${name}`;
  if (kind === 'plugin') return `Plugins/${name}`;
  return `Sources/${name}`;
}

/** Index of the `)` matching the `(` at `open`, or -1. Skips string literals. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse the target declarations of one `Package.swift`. Exported for tests.
 * Only top-level target blocks count: a `.target(name: "X")` that sits inside
 * another block (a dependency reference) is skipped.
 */
export function parsePackageTargets(manifest: string): SwiftTargetDecl[] {
  // Every opener occurrence, in document order — an outer block is always
  // seen before the dependency references nested inside it.
  const hits: Array<{ at: number; opener: string; kind: SwiftTargetDecl['kind'] | 'binary' }> = [];
  for (const [opener, kind] of TARGET_OPENERS) {
    for (let at = manifest.indexOf(opener); at >= 0; at = manifest.indexOf(opener, at + opener.length)) {
      // `.target(` must not be the tail of `.testTarget(` etc.
      const prev = manifest[at - 1] ?? '';
      if (/[A-Za-z0-9_]/.test(prev)) continue;
      hits.push({ at, opener, kind });
    }
  }
  hits.sort((x, y) => x.at - y.at);

  const out: SwiftTargetDecl[] = [];
  let blockEnd = -1; // end of the current top-level block; nested hits are skipped
  for (const { at, opener, kind } of hits) {
    if (at < blockEnd) continue; // a dependency reference inside a declaration
    const open = at + opener.length - 1;
    const close = matchParen(manifest, open);
    if (close < 0) continue;
    blockEnd = close;
    if (kind === 'binary') continue;
    const body = manifest.slice(open + 1, close);
    const name = body.match(/\bname\s*:\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const pathMatch = body.match(/\bpath\s*:\s*"([^"]+)"/)?.[1];
    const path = (pathMatch ?? defaultDir(kind, name))
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    out.push({ name, path, kind });
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function dirOf(norm: string): string {
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : norm.slice(0, i);
}

function joinNorm(dir: string, rel: string): string {
  return dir === '' ? rel : `${dir}/${rel}`;
}

function hygiene(candidates: string[], sourceFile: string): string[] {
  const foreignFiltered = dropForeignCandidates(candidates, sourceFile);
  if (isTestFilePath(sourceFile)) return foreignFiltered;
  return foreignFiltered.filter((f) => !isTestFilePath(f));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSwiftResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): SwiftResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);

  const storedByNorm = new Map<string, string>();
  const manifests: string[] = [];
  for (const stored of allPaths) {
    const n = normalize(stored);
    storedByNorm.set(n, stored);
    if (n === 'Package.swift' || n.endsWith('/Package.swift')) manifests.push(n);
  }

  // module → declaring entries (target directory + owning package directory,
  // both normalised, repo-relative). Two packages may declare the same module
  // name (nested example packages): the importer's OWN package wins.
  interface ModuleEntry {
    dir: string;
    pkgDir: string;
  }
  const byModule = new Map<string, ModuleEntry[]>();
  const addModule = (name: string, dir: string, pkgDir: string) => {
    const list = byModule.get(name);
    if (list) {
      if (!list.some((e) => e.dir === dir)) list.push({ dir, pkgDir });
    } else byModule.set(name, [{ dir, pkgDir }]);
  };
  for (const manifest of manifests) {
    if (isForeignPath(manifest)) continue;
    let text: string;
    try {
      text = readFileSync(join(projectRoot, manifest), 'utf8');
    } catch {
      continue;
    }
    const pkgDir = dirOf(manifest);
    for (const t of parsePackageTargets(text)) addModule(t.name, joinNorm(pkgDir, t.path), pkgDir);
  }
  // Manifest-less fallback: Sources/<X>/ and Tests/<X>/ directories with files.
  for (const n of storedByNorm.keys()) {
    if (isForeignPath(n)) continue;
    const m = n.match(/^(?:(.*)\/)?(Sources|Tests)\/([^/]+)\/.+/);
    if (!m) continue;
    const pkgDir = m[1] ?? '';
    const dir = joinNorm(pkgDir, `${m[2]}/${m[3]}`);
    if (!byModule.has(m[3])) addModule(m[3], dir, pkgDir);
  }

  // directory → indexed files under it (built lazily per directory)
  const filesUnder = new Map<string, string[]>();
  const listUnder = (dir: string): string[] => {
    const cached = filesUnder.get(dir);
    if (cached) return cached;
    const prefix = `${dir}/`;
    const list: string[] = [];
    for (const n of storedByNorm.keys()) if (n.startsWith(prefix)) list.push(n);
    filesUnder.set(dir, list);
    return list;
  };

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];
      // `import struct Foundation.URL` → module `Foundation`
      const module = spec.split('.')[0];
      const entries = byModule.get(module);
      if (!entries || entries.length === 0) return [];
      const src = normalize(sourceFile);
      const srcDir = dirOf(src);
      // The importer's own package (deepest package dir that contains it);
      // an importer outside every package takes the root-most declaration.
      const owns = (pkgDir: string) => pkgDir === '' || srcDir === pkgDir || srcDir.startsWith(`${pkgDir}/`);
      const owning = entries.filter((e) => owns(e.pkgDir));
      let chosen: ModuleEntry[];
      if (owning.length > 0) {
        const deepest = Math.max(...owning.map((e) => e.pkgDir.length));
        chosen = owning.filter((e) => e.pkgDir.length === deepest);
      } else {
        const shallowest = Math.min(...entries.map((e) => e.pkgDir.length));
        chosen = entries.filter((e) => e.pkgDir.length === shallowest);
      }
      const out: string[] = [];
      for (const { dir } of chosen) {
        if (src === dir || src.startsWith(`${dir}/`)) continue; // own module
        for (const f of listUnder(dir)) out.push(f);
      }
      return hygiene(out, sourceFile).map((n) => storedByNorm.get(n) ?? n);
    },
    targets: () => {
      const m = new Map<string, string>();
      for (const [k, v] of byModule) m.set(k, v[0].dir);
      return m;
    },
  };
}
