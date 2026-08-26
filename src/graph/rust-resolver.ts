/**
 * Rust import resolver (Phase 87).
 *
 * Maps `use` specifiers to files inside the repo. Without this, every Rust
 * `use` is a "bare specifier" the path resolver treats as external, and Rust
 * repos index to zero dependency edges.
 *
 * Rust is the only family that needs a real MODULE TREE, not a flat map:
 *   - crate roots are `src/lib.rs` / `src/main.rs` (and `src/bin/*.rs`) under
 *     a directory containing `Cargo.toml` (nearest ancestor wins — that is
 *     the workspace rule); crate names come from `[package] name`,
 *     dash→underscore normalized;
 *   - the module map is derived from FILE LAYOUT under `src/` (v1
 *     simplification — layout and `mod` declarations agree in almost all real
 *     code; `#[path]` overrides are a documented limitation): `src/a/b.rs` and
 *     `src/a/b/mod.rs` both answer to `a::b`;
 *   - `crate::a::b::Item` → longest module-path prefix → file(s), then `Item`
 *     via a symbol-table check scoped to those files (falling back to the
 *     module files themselves — inline `mod` blocks and macro-generated items
 *     live there; over-approximation is the safe direction for blast radius);
 *   - `self::` / `super::` resolve relative to the source file's own module
 *     position; a bare leading segment resolves as a top-level module of the
 *     own crate (2018 uniform paths) or as another indexed workspace crate's
 *     name; anything else (`std`, `serde`, `tokio`) is external → no edge;
 *   - glob imports (`use crate::a::*`) expand to the module and everything
 *     under it, capped by `graph.maxWildcardFanout` (shared with JVM/C#/PHP).
 *
 * A repo with no `Cargo.toml` at all falls back to treating the repo root as
 * the crate dir, so a plain `src/` layout still resolves.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { getConfig } from '../config/config-loader.js';
import { logger } from '../core/logger.js';

// ─── Public surface ───────────────────────────────────────────────────────────

export const RUST_FAMILY_EXTENSIONS = new Set(['.rs']);

export function isRustSourceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.rs');
}

export interface RustResolver {
  /**
   * Resolve a `use` specifier to repo-relative file paths (as stored in the
   * DB). `importedNames` containing `'*'` marks a glob import. Empty array =
   * external (std, crates.io) or unresolvable.
   */
  resolve(specifier: string, sourceFile: string, importedNames?: string[]): string[];
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function dirOf(normPath: string): string {
  const lastSlash = normPath.lastIndexOf('/');
  return lastSlash < 0 ? '' : normPath.slice(0, lastSlash);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

interface CrateInfo {
  dir: string; // repo-relative crate dir ('' = repo root)
  /** '::'-joined module path ('' = crate root) → stored file paths */
  moduleFiles: Map<string, string[]>;
  /** first segments of every known module path (2018 uniform-path check) */
  topLevelModules: Set<string>;
}

export function createRustResolver(
  db: Database.Database,
  repoId: string,
  projectRoot: string,
): RustResolver {
  const maxWildcardFanout = getConfig().graph.maxWildcardFanout;
  let fanoutWarned = false;

  function capFanout(files: string[], what: string): string[] {
    if (maxWildcardFanout <= 0 || files.length <= maxWildcardFanout) return files;
    if (!fanoutWarned) {
      fanoutWarned = true;
      logger.warn(
        `Rust glob import fanout capped at ${maxWildcardFanout} files ` +
          `("${what}" has ${files.length}; graph.maxWildcardFanout, 0 = uncapped)`,
      );
    }
    return [...files].sort().slice(0, maxWildcardFanout);
  }

  const allPaths = db
    .prepare<[string], { path: string }>('SELECT path FROM files WHERE repo_id = ?')
    .all(repoId)
    .map((r) => r.path);
  const rsFiles = allPaths.filter(isRustSourceFile);
  const rsSet = new Set(rsFiles);

  // ── Cargo.toml discovery: ascend from every .rs dir, read each dir once ────
  // dir → normalized crate name ('' when Cargo.toml exists without [package]),
  // or null when there is no Cargo.toml in that dir.
  const cargoRead = new Map<string, string | null>();
  function cargoAt(dir: string): string | null {
    const cached = cargoRead.get(dir);
    if (cached !== undefined) return cached;
    let result: string | null = null;
    try {
      const content = readFileSync(join(projectRoot, dir, 'Cargo.toml'), 'utf8');
      result = ''; // Cargo.toml exists — crate boundary even without [package]
      let inPackage = false;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          inPackage = trimmed === '[package]';
          continue;
        }
        if (!inPackage) continue;
        const m = trimmed.match(/^name\s*=\s*"([^"]+)"/);
        if (m) {
          result = m[1].replace(/-/g, '_');
          break;
        }
      }
    } catch {
      // no Cargo.toml here
    }
    cargoRead.set(dir, result);
    return result;
  }

  // Nearest ancestor dir with a Cargo.toml; repo root '' as the fallback so
  // Cargo-less repos with a plain src/ layout still resolve.
  const crateDirCache = new Map<string, string>();
  function crateDirOfDir(dir: string): string {
    const cached = crateDirCache.get(dir);
    if (cached !== undefined) return cached;
    let result: string;
    if (cargoAt(dir) !== null) result = dir;
    else if (dir === '') result = '';
    else result = crateDirOfDir(dirOf(dir));
    crateDirCache.set(dir, result);
    return result;
  }

  // ── Module map per crate, from file layout under src/ ──────────────────────
  /** module path segments of a file within its crate, or null if not a src/ module */
  function modulePathOf(norm: string, crateDir: string): string[] | null {
    const rel = crateDir === '' ? norm : norm.slice(crateDir.length + 1);
    if (rel !== 'src' && !rel.startsWith('src/')) return null; // tests/, examples/, benches/, build.rs
    let stem = rel.slice(4);
    if (!stem.toLowerCase().endsWith('.rs')) return null;
    stem = stem.slice(0, -3);
    const segs = stem.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) return null;
    const last = segs[segs.length - 1]!;
    if (last === 'mod') segs.pop();
    else if (segs.length === 1 && (last === 'lib' || last === 'main')) segs.pop();
    if (segs[0] === 'bin') return []; // src/bin/*.rs — its own crate root
    return segs;
  }

  const crates = new Map<string, CrateInfo>();
  const crateDirByName = new Map<string, string>();
  /** stored file path → its crate dir + module position ('' segs = crate root) */
  const filePosition = new Map<string, { crateDir: string; position: string[] }>();

  for (const stored of rsFiles) {
    const norm = normalize(stored);
    const crateDir = crateDirOfDir(dirOf(norm));
    let info = crates.get(crateDir);
    if (!info) {
      info = { dir: crateDir, moduleFiles: new Map(), topLevelModules: new Set() };
      crates.set(crateDir, info);
      const name = cargoAt(crateDir);
      if (name) crateDirByName.set(name, crateDir);
    }
    const mp = modulePathOf(norm, crateDir);
    filePosition.set(stored, { crateDir, position: mp ?? [] });
    if (mp === null) continue;
    const key = mp.join('::');
    const list = info.moduleFiles.get(key);
    if (list) list.push(stored);
    else info.moduleFiles.set(key, [stored]);
    if (mp.length > 0) info.topLevelModules.add(mp[0]!);
  }

  // ── Symbol table: bare name → declaring .rs files ──────────────────────────
  const symFiles = new Map<string, Set<string>>();
  if (rsFiles.length > 0) {
    const rows = db
      .prepare<[string], { name: string; file_path: string }>(
        'SELECT name, file_path FROM symbols WHERE repo_id = ?',
      )
      .all(repoId);
    for (const { name, file_path } of rows) {
      if (!rsSet.has(file_path)) continue;
      let files = symFiles.get(name);
      if (!files) symFiles.set(name, (files = new Set()));
      files.add(file_path);
    }
  }

  // ── Resolution within one crate ────────────────────────────────────────────

  function resolveInCrate(
    crate: CrateInfo,
    segs: string[],
    glob: boolean,
    sourceFile: string,
  ): string[] {
    if (glob) {
      const key = segs.join('::');
      const out = new Set<string>();
      for (const [k, files] of crate.moduleFiles) {
        if (k === key || key === '' || k.startsWith(key + '::')) {
          for (const f of files) out.add(f);
        }
      }
      return capFanout([...out].filter((f) => f !== sourceFile), key || 'crate::*');
    }

    // Longest module-path prefix wins; once a prefix matches, shorter prefixes
    // are never tried (a miss there means inline mod / unindexed, not a
    // different module — the Go rule).
    for (let i = segs.length; i >= 0; i--) {
      const key = segs.slice(0, i).join('::');
      const files = crate.moduleFiles.get(key);
      if (!files) continue;
      const remainder = segs.slice(i);
      if (remainder.length === 1) {
        // Leaf item — prefer the module file(s) actually declaring the symbol
        const declaring = symFiles.get(remainder[0]!);
        if (declaring) {
          const hits = files.filter((f) => declaring.has(f));
          if (hits.length > 0) return hits.filter((f) => f !== sourceFile);
        }
      }
      // Whole-module import, inline mod, or unindexed item — the module
      // file(s) own it (over-approximation is the safe direction).
      return files.filter((f) => f !== sourceFile);
    }
    return [];
  }

  return {
    resolve(specifier: string, sourceFile: string, importedNames: string[] = []): string[] {
      const spec = specifier.trim().replace(/;$/, '').trim();
      if (spec.length === 0) return [];
      const glob = importedNames.includes('*');
      const segs = spec
        .split('::')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (segs.length === 0) return [];

      const pos = filePosition.get(sourceFile);
      const head = segs[0]!;

      if (head === 'crate') {
        if (!pos) return [];
        const crate = crates.get(pos.crateDir);
        return crate ? resolveInCrate(crate, segs.slice(1), glob, sourceFile) : [];
      }

      if (head === 'self' || head === 'super') {
        if (!pos) return [];
        const crate = crates.get(pos.crateDir);
        if (!crate) return [];
        const base = [...pos.position];
        let i = 0;
        if (head === 'self') {
          i = 1;
        } else {
          while (segs[i] === 'super') {
            if (base.length > 0) base.pop();
            i++;
          }
        }
        return resolveInCrate(crate, [...base, ...segs.slice(i)], glob, sourceFile);
      }

      // 2018 uniform paths: a bare head can be a top-level module of the own crate
      if (pos) {
        const own = crates.get(pos.crateDir);
        if (own && (own.moduleFiles.has(head) || own.topLevelModules.has(head))) {
          return resolveInCrate(own, segs, glob, sourceFile);
        }
      }

      // Same-workspace crate by name (dash→underscore normalized)
      const targetDir = crateDirByName.get(head.replace(/-/g, '_'));
      if (targetDir !== undefined) {
        const crate = crates.get(targetDir);
        if (crate) return resolveInCrate(crate, segs.slice(1), glob, sourceFile);
      }

      return []; // std / crates.io — external
    },
  };
}
