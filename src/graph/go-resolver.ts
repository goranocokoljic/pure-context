/**
 * Go import resolver (Phase 84).
 *
 * Maps Go module-path import specifiers to files inside the repo. Without
 * this, every Go import is a "bare specifier" the path resolver treats as
 * external, and Go repos index to zero dependency edges (the gap the Go
 * handler's own comment named: "resolution requires go.mod parsing").
 *
 * Go's language rules make this resolver SIMPLER than the JVM one:
 *   - an import path maps to exactly one DIRECTORY;
 *   - every non-ignored `.go` file in that directory is the package — edges to
 *     all of them is the true package semantic, not over-approximation;
 *   - relative imports do not exist.
 *
 * Module discovery: every `go.mod` reachable above an indexed `.go` file
 * (repo root + nested = go workspaces) contributes `module <path>` → its
 * directory. Resolution = longest matching module prefix, remainder joined to
 * the module directory, all indexed `.go` files in that exact directory.
 * No prefix match → external (stdlib, third-party) → no edge. Edges are never
 * emitted INTO `vendor/`.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';

// ─── Public surface ───────────────────────────────────────────────────────────

export function isGoSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.go');
}

export interface GoResolver {
  /**
   * Resolve an import path to repo-relative file paths (as stored in the DB).
   * Empty array = external (stdlib, third-party) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string): string[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function dirOf(normPath: string): string {
  const lastSlash = normPath.lastIndexOf('/');
  return lastSlash < 0 ? '' : normPath.slice(0, lastSlash);
}

function isVendored(normPath: string): boolean {
  return normPath.startsWith('vendor/') || normPath.includes('/vendor/');
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGoResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): GoResolver {
  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const goFiles = allPaths.filter(isGoSourceFile);

  // normalized directory → stored file paths (the package unit)
  const dirFiles = new Map<string, string[]>();
  for (const stored of goFiles) {
    const norm = normalize(stored);
    if (isVendored(norm)) continue; // never emit edges into vendor/
    const dir = dirOf(norm);
    const list = dirFiles.get(dir);
    if (list) list.push(stored);
    else dirFiles.set(dir, [stored]);
  }

  // ── go.mod discovery: ascend from every package dir, read each dir once ────
  // moduleByDir: repo-relative dir ('' = root) → module path from its go.mod
  const goModRead = new Map<string, string | null>();
  function moduleAt(dir: string): string | null {
    const cached = goModRead.get(dir);
    if (cached !== undefined) return cached;
    let modPath: string | null = null;
    try {
      const content = readFileSync(join(projectRoot, dir, 'go.mod'), 'utf8');
      const m = content.match(/^\s*module\s+(\S+)/m);
      if (m) modPath = m[1].replace(/^"|"$/g, '');
    } catch {
      // no go.mod here
    }
    goModRead.set(dir, modPath);
    return modPath;
  }

  // modules sorted longest-path-first so the longest prefix wins
  const modules: Array<{ modPath: string; dir: string }> = [];
  {
    const seenDirs = new Set<string>();
    for (const dir of dirFiles.keys()) {
      let cur = dir;
      for (;;) {
        if (!seenDirs.has(cur)) {
          seenDirs.add(cur);
          const modPath = moduleAt(cur);
          if (modPath) modules.push({ modPath, dir: cur });
        }
        if (cur === '') break;
        cur = dirOf(cur);
      }
    }
    modules.sort((a, b) => b.modPath.length - a.modPath.length);
  }

  return {
    resolve(specifier: string, sourceFile: string): string[] {
      const spec = specifier.trim();
      if (spec.length === 0) return [];

      for (const { modPath, dir } of modules) {
        if (spec !== modPath && !spec.startsWith(modPath + '/')) continue;
        const remainder = spec.slice(modPath.length).replace(/^\//, '');
        const targetDir =
          remainder.length === 0 ? dir : dir.length === 0 ? remainder : `${dir}/${remainder}`;
        const files = dirFiles.get(targetDir) ?? [];
        return files.filter((f) => f !== sourceFile);
      }
      return []; // stdlib / third-party — external
    },
  };
}
