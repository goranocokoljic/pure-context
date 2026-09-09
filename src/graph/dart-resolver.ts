/**
 * Dart `package:` import resolver (Phase 98, Task 610).
 *
 * `import 'package:myapp/src/x.dart'` is the DOMINANT intra-repo import form
 * in Dart/Flutter code (relative imports are discouraged by the style guide),
 * yet the handler treated every `package:` URI as external — Dart repos
 * indexed to near-zero dependency edges (gap-analysis-v2 MEDIUM #1).
 *
 * Mapping rule (the go.mod ascent shape, `go-resolver.ts`): for every
 * directory holding an indexed `.dart` file, ascend to the nearest
 * `pubspec.yaml`, read its `name:`, and map package name → that directory.
 * `package:<name>/<path>` then resolves to `<dir>/lib/<path>` when that file
 * is indexed; any other package (flutter, a pub dependency) is external.
 * Monorepos with several pubspecs (flutter, AppFlowy) map each package to
 * its own directory. Relative imports keep their handler-prefilled path
 * (validated by the graph builder); `dart:` URIs are external.
 */

import type Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export const DART_FAMILY_EXTENSIONS = new Set(['.dart']);

export function isDartSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.dart');
}

export interface DartResolver {
  /** Resolve a `package:` specifier to repo-relative file paths (DB form). */
  resolve(specifier: string, sourceFile: string): string[];
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function dirOf(norm: string): string {
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : norm.slice(0, i);
}

function parentOf(dir: string): string | null {
  if (dir === '') return null;
  const i = dir.lastIndexOf('/');
  return i < 0 ? '' : dir.slice(0, i);
}

export function createDartResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): DartResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);

  const storedByNorm = new Map<string, string>();
  const dartDirs = new Set<string>();
  for (const stored of allPaths) {
    const n = normalize(stored);
    storedByNorm.set(n, stored);
    if (isDartSourceFile(n)) dartDirs.add(dirOf(n));
  }

  // pubspec discovery: read each directory's pubspec.yaml at most once
  const pubspecName = new Map<string, string | null>();
  function nameAt(dir: string): string | null {
    const cached = pubspecName.get(dir);
    if (cached !== undefined) return cached;
    let name: string | null = null;
    try {
      const text = readFileSync(join(projectRoot, dir, 'pubspec.yaml'), 'utf8');
      const m = text.match(/^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/m);
      if (m) name = m[1]!;
    } catch {
      // no pubspec here
    }
    pubspecName.set(dir, name);
    return name;
  }

  // package name → directory (first pubspec found ascending from each dart dir)
  const packageDir = new Map<string, string>();
  const seen = new Set<string>();
  for (const dir of dartDirs) {
    let cur: string | null = dir;
    while (cur !== null) {
      if (!seen.has(cur)) {
        seen.add(cur);
        const name = nameAt(cur);
        if (name && !packageDir.has(name)) packageDir.set(name, cur);
      }
      cur = parentOf(cur);
    }
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (!spec.startsWith('package:')) return [];
      const rest = spec.slice('package:'.length);
      const slash = rest.indexOf('/');
      if (slash <= 0) return [];
      const pkg = rest.slice(0, slash);
      const path = rest.slice(slash + 1);
      const dir = packageDir.get(pkg);
      if (dir === undefined || path.length === 0) return [];
      const candidate = normalize(dir === '' ? `lib/${path}` : `${dir}/lib/${path}`);
      const stored = storedByNorm.get(candidate);
      if (stored === undefined || normalize(stored) === normalize(sourceFile)) return [];
      return [stored];
    },
  };
}
