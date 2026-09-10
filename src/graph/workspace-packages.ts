/**
 * npm / pnpm / yarn workspace package-name resolution (Phase 100, Task 627).
 *
 * In a workspace monorepo packages import each other by NAME (`@nuxt/kit`,
 * `@nuxt/schema`), not by path. The TS/JS path resolver knows relative paths
 * and tsconfig aliases only, so every such import was "external" and the
 * dependency graph of nuxt / novu / cal-com / infisical / excalidraw / trpc
 * was thin: ten linked nuxt roots produced FOUR cross edges (Phase 99).
 *
 * Rule: a bare specifier whose head matches a workspace package `name`
 * resolves to that package's entry —
 *   `exports` (`.` / subpath keys, `import` / `default` / `types` / … conditions,
 *   string or object, `*` patterns) → `module` / `main` / `types` →
 *   `src/index.*` → `index.*`;
 * SOURCE FIRST: an `exports` target under `dist/` (or any built output) is
 * mirrored to `src/` before the built file is accepted; and with an indexed
 * file set (Phase 98) a target that is not an indexed file is dropped.
 * Subpaths (`@nuxt/kit/dist/x`) map through `exports` or fall back to
 * `<pkg>/<subpath>` with the same probes.
 *
 * The package map comes from the root manifest's `workspaces` globs
 * (`package.json`) or `pnpm-workspace.yaml` `packages`, expanded over the
 * directory tree (bounded; `node_modules` never entered) — each candidate's
 * `package.json` is read once. A name that also exists in `node_modules` is
 * still the workspace package (workspaces symlink it there — same files).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { getConfig } from '../config/config-loader.js';
import type { IndexedFileSet } from './prefilled-targets.js';

export interface PackageManifest {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  browser?: string | Record<string, unknown>;
  exports?: unknown;
  workspaces?: string[] | { packages?: string[] };
}

export interface WorkspacePackage {
  name: string;
  /** Absolute package directory. */
  dir: string;
  /** Package directory relative to the project root (forward slashes). */
  relDir: string;
  manifest: PackageManifest;
}

export interface WorkspacePackageResolver {
  projectRoot: string;
  /** Every workspace package name (for `externalImports.looksInternal`). */
  names(): ReadonlySet<string>;
  packages(): readonly WorkspacePackage[];
  /**
   * Resolve a bare specifier to a project-relative file path (the STORED
   * path when an indexed file set was supplied), or null when the head is not
   * a workspace package or no entry file exists.
   */
  resolve(specifier: string): string | null;
}

export interface WorkspaceResolverOptions {
  /** Phase-98 validation: only indexed files become targets. */
  indexedFiles?: IndexedFileSet;
  /** Directory-walk cap for glob expansion. Default 5000. */
  maxDirs?: number;
}

// ─── Manifest discovery ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.output', '.nuxt', '.next', 'coverage']);
const OUTPUT_PREFIXES = ['dist/', 'build/', 'lib/', 'out/', 'esm/', 'cjs/', '.output/', 'types/'];
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.mts', 'index.js', 'index.mjs', 'index.cjs', 'index.jsx'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.ts'],
  '.cjs': ['.cts', '.ts'],
};

type ManifestCache = Map<string, PackageManifest | null>;

/**
 * Read `<dir>/package.json`; null when absent or malformed. Memoized per
 * resolver build (the cache is created by `discoverWorkspacePackages`), never
 * module-wide: the MCP server is long-lived and manifests change between runs.
 */
export function readManifest(dir: string, cache?: ManifestCache): PackageManifest | null {
  const p = join(dir, 'package.json');
  const cached = cache?.get(p);
  if (cached !== undefined) return cached;
  let out: PackageManifest | null = null;
  try {
    if (existsSync(p)) out = JSON.parse(readFileSync(p, 'utf8')) as PackageManifest;
  } catch {
    out = null;
  }
  cache?.set(p, out);
  return out;
}

/** Kept for tests written against the earlier module-wide memo; no-op now. */
export function _resetWorkspaceCaches(): void {
  /* nothing memoized module-wide */
}

/**
 * Workspace globs from `package.json` `workspaces` (array or `{ packages }`)
 * or `pnpm-workspace.yaml` `packages`. Empty when the root declares none.
 */
export function readWorkspaceGlobs(projectRoot: string, cache?: ManifestCache): string[] {
  const globs: string[] = [];
  const pkg = readManifest(projectRoot, cache);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) globs.push(...ws.filter((g): g is string => typeof g === 'string'));
  else if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    globs.push(...ws.packages.filter((g): g is string => typeof g === 'string'));
  }
  const pnpm = join(projectRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      const doc = yaml.load(readFileSync(pnpm, 'utf8')) as { packages?: unknown } | null;
      if (doc && Array.isArray(doc.packages)) {
        globs.push(...doc.packages.filter((g): g is string => typeof g === 'string'));
      }
    } catch {
      /* malformed yaml — ignore */
    }
  }
  return [...new Set(globs.map((g) => g.trim()).filter(Boolean))];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function globSegmentToRegex(seg: string): RegExp {
  const esc = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

function globToRegex(pattern: string): RegExp {
  let re = '';
  const segs = pattern.split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '**') {
      re += i === segs.length - 1 ? '.*' : '(?:.*/)?';
      continue;
    }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    if (i < segs.length - 1) re += '/';
  }
  return new RegExp(`^${re}/?$`);
}

/** Expand one positive glob into absolute directories (bounded walk). */
function expandGlob(root: string, pattern: string, budget: { left: number }): string[] {
  const segs = pattern.split('/').filter((s) => s !== '' && s !== '.');
  const out: string[] = [];
  const walk = (dir: string, i: number, depth: number): void => {
    if (budget.left <= 0) return;
    if (i === segs.length) {
      out.push(dir);
      return;
    }
    const seg = segs[i];
    if (seg === '**') {
      // zero or more directories
      walk(dir, i + 1, depth);
      if (depth >= 6) return;
      for (const name of listDirs(dir)) {
        budget.left--;
        walk(join(dir, name), i, depth + 1);
      }
      return;
    }
    if (seg.includes('*') || seg.includes('?')) {
      const re = globSegmentToRegex(seg);
      for (const name of listDirs(dir)) {
        if (!re.test(name)) continue;
        budget.left--;
        walk(join(dir, name), i + 1, depth + 1);
      }
      return;
    }
    const next = join(dir, seg);
    if (isDir(next)) {
      budget.left--;
      walk(next, i + 1, depth + 1);
    }
  };
  walk(root, 0, 0);
  return out;
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

/**
 * The directory whose manifest declares the workspace globs that cover
 * `root`: the root itself, else the nearest ancestor (bounded) — an index
 * rooted at `packages/kit` or at `packages/` still belongs to the workspace
 * declared at the repository root. Null when no ancestor declares one.
 */
export function findWorkspaceBase(root: string, maxUp = 4, cache?: ManifestCache): { base: string; globs: string[] } | null {
  let dir = root;
  for (let i = 0; i <= maxUp; i++) {
    const globs = readWorkspaceGlobs(dir, cache);
    if (globs.length > 0) return { base: dir, globs };
    if (existsSync(join(dir, '.git'))) break; // never cross a repository boundary
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Discover the workspace packages visible from `projectRoot`: every package
 * the workspace globs name whose directory lies INSIDE the root (targets
 * outside the index can never be edges), plus the root itself when its own
 * `package.json` carries a name — a split root such as `packages/kit` IS
 * the package `@nuxt/kit`, and a linked sibling resolves it by that name.
 * Empty when neither applies.
 */
export function discoverWorkspacePackages(projectRoot: string, maxDirs = 5000): WorkspacePackage[] {
  const root = resolve(projectRoot);
  const byName = new Map<string, WorkspacePackage>();
  const cache: ManifestCache = new Map();
  const ws = findWorkspaceBase(root, 4, cache);
  if (ws) {
    const positive = ws.globs.filter((g) => !g.startsWith('!'));
    const negative = ws.globs.filter((g) => g.startsWith('!')).map((g) => globToRegex(g.slice(1)));
    const budget = { left: maxDirs };
    const dirs = new Set<string>();
    for (const g of positive) for (const d of expandGlob(ws.base, g, budget)) dirs.add(d);
    for (const dir of [...dirs].sort()) {
      const relBase = toRel(ws.base, dir);
      if (relBase === '' || relBase.startsWith('..')) continue;
      if (negative.some((re) => re.test(relBase))) continue;
      const relDir = toRel(root, dir);
      if (relDir.startsWith('..') || isAbsolute(relDir)) continue; // outside this index
      const manifest = readManifest(dir, cache);
      if (!manifest || typeof manifest.name !== 'string' || manifest.name === '') continue;
      if (byName.has(manifest.name)) continue; // first (sorted) wins
      byName.set(manifest.name, { name: manifest.name, dir, relDir, manifest });
    }
  }
  // The root itself is a package when it is NAMED and declares no workspaces
  // (a workspace root — `nuxt-framework`, private — is never imported by name).
  const own = readManifest(root, cache);
  if (
    own &&
    typeof own.name === 'string' &&
    own.name !== '' &&
    !byName.has(own.name) &&
    readWorkspaceGlobs(root, cache).length === 0
  ) {
    byName.set(own.name, { name: own.name, dir: root, relDir: '', manifest: own });
  }
  return [...byName.values()];
}

// ─── Entry resolution ─────────────────────────────────────────────────────────

const CONDITION_ORDER = ['import', 'module', 'default', 'require', 'node', 'browser', 'types', 'source', 'development'];

/** Flatten an `exports` VALUE (string / array / condition object) to targets. */
function conditionTargets(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => conditionTargets(v, depth + 1));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: string[] = [];
    const keys = Object.keys(obj);
    const ordered = [
      ...CONDITION_ORDER.filter((k) => keys.includes(k)),
      ...keys.filter((k) => !CONDITION_ORDER.includes(k)),
    ];
    for (const k of ordered) out.push(...conditionTargets(obj[k], depth + 1));
    return out;
  }
  return [];
}

/**
 * Targets the `exports` map names for `subpathKey` (`.` or `./x`), honouring
 * `*` patterns (`"./*": "./dist/*.mjs"`). Empty when `exports` is absent or
 * does not cover the key.
 */
export function exportsTargets(exportsField: unknown, subpathKey: string): string[] {
  if (exportsField === null || exportsField === undefined) return [];
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpathKey === '.' ? conditionTargets(exportsField) : [];
  }
  if (typeof exportsField !== 'object') return [];
  const map = exportsField as Record<string, unknown>;
  const keys = Object.keys(map);
  const isSubpathMap = keys.some((k) => k.startsWith('.'));
  if (!isSubpathMap) return subpathKey === '.' ? conditionTargets(map) : [];
  if (subpathKey in map) return conditionTargets(map[subpathKey]);
  // Pattern keys, longest literal prefix first.
  const patterns = keys.filter((k) => k.includes('*')).sort((a, b) => b.length - a.length);
  for (const k of patterns) {
    const star = k.indexOf('*');
    const prefix = k.slice(0, star);
    const suffix = k.slice(star + 1);
    if (!subpathKey.startsWith(prefix) || !subpathKey.endsWith(suffix)) continue;
    if (subpathKey.length < prefix.length + suffix.length) continue;
    const captured = subpathKey.slice(prefix.length, subpathKey.length - suffix.length);
    return conditionTargets(map[k]).map((t) => t.split('*').join(captured));
  }
  return [];
}

/** `dist/foo/bar.mjs` → `src/foo/bar` (extension stripped); null when not an output path. */
function sourceMirror(target: string): string | null {
  let t = target.replace(/^\.\//, '');
  const prefix = OUTPUT_PREFIXES.find((p) => t.startsWith(p));
  if (!prefix) return null;
  t = t.slice(prefix.length);
  t = t.replace(/\.d\.(ts|mts|cts)$/, '').replace(/\.(m|c)?[jt]sx?$/, '');
  return t === '' ? 'src' : `src/${t}`;
}

function stripExt(p: string): string {
  const ext = extname(p);
  return ext && (ext in JS_TO_TS || PROBE_EXTENSIONS.includes(ext) || ext === '.ts') ? p.slice(0, -ext.length) : p;
}

/**
 * Find the file a (possibly extensionless, possibly `.js`-suffixed) candidate
 * names: exact → TS twin of a JS extension → extension probes → index file.
 */
function probeFile(candidate: string): string | null {
  if (existsSync(candidate) && !isDir(candidate)) return candidate;
  const ext = extname(candidate);
  const tsAlts = JS_TO_TS[ext];
  const base = tsAlts ? candidate.slice(0, -ext.length) : candidate;
  if (tsAlts) {
    for (const alt of tsAlts) {
      const c = base + alt;
      if (existsSync(c) && !isDir(c)) return c;
    }
  }
  if (!ext || tsAlts) {
    for (const p of PROBE_EXTENSIONS) {
      const c = base + p;
      if (existsSync(c) && !isDir(c)) return c;
    }
    for (const idx of INDEX_FILES) {
      const c = join(base, idx);
      if (existsSync(c)) return c;
    }
  }
  if (isDir(candidate)) {
    for (const idx of INDEX_FILES) {
      const c = join(candidate, idx);
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/** Ordered probe candidates (relative to the package dir) for a subpath. */
function candidateTargets(pkg: WorkspacePackage, subpath: string): string[] {
  const m = pkg.manifest;
  const out: string[] = [];
  const add = (t: unknown) => {
    if (typeof t === 'string' && t !== '') out.push(t);
  };
  if (subpath === '') {
    for (const t of exportsTargets(m.exports, '.')) add(t);
    add(m.module);
    add(m.main);
    add(m.types);
    add(m.typings);
    if (typeof m.browser === 'string') add(m.browser);
    add('src/index');
    add('index');
  } else {
    for (const t of exportsTargets(m.exports, `./${subpath}`)) add(t);
    add(subpath);
    add(`src/${subpath}`);
  }
  // Source-first: every output-path target is preceded by its src/ mirror.
  const expanded: string[] = [];
  for (const t of out) {
    const mirror = sourceMirror(t);
    if (mirror) expanded.push(mirror);
    expanded.push(t);
  }
  return [...new Set(expanded)];
}

export function createWorkspacePackageResolver(
  projectRoot: string,
  options: WorkspaceResolverOptions = {},
): WorkspacePackageResolver | null {
  const root = resolve(projectRoot);
  const pkgs = discoverWorkspacePackages(root, options.maxDirs);
  if (pkgs.length === 0) return null;
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const nameSet = new Set(byName.keys());
  // Longest name first so `@scope/pkg-extra` beats `@scope/pkg`.
  const ordered = [...nameSet].sort((a, b) => b.length - a.length);
  const memo = new Map<string, string | null>();
  const indexed = options.indexedFiles;

  const accept = (abs: string, pkg: WorkspacePackage): string | null => {
    const relPkg = relative(pkg.dir, abs);
    if (relPkg.startsWith('..') || isAbsolute(relPkg)) return null; // escaped the package
    const rel = toRel(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    if (!indexed) return rel;
    const stored = indexed.byNorm.get(rel);
    return stored ?? null;
  };

  return {
    projectRoot: root,
    names: () => nameSet,
    packages: () => pkgs,
    resolve(specifier: string): string | null {
      if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || isAbsolute(specifier)) return null;
      if (specifier.startsWith('node:')) return null;
      const cached = memo.get(specifier);
      if (cached !== undefined) return cached;
      let result: string | null = null;
      const name = ordered.find((n) => specifier === n || specifier.startsWith(n + '/'));
      if (name) {
        const pkg = byName.get(name)!;
        const subpath = specifier === name ? '' : specifier.slice(name.length + 1);
        for (const target of candidateTargets(pkg, subpath)) {
          const abs = resolve(pkg.dir, target);
          const hit = probeFile(abs) ?? probeFile(stripExt(abs));
          if (!hit) continue;
          const ok = accept(hit, pkg);
          if (ok) {
            result = ok;
            break;
          }
        }
      }
      memo.set(specifier, result);
      return result;
    },
  };
}

/** The importer's file lives in the TS/JS family (path-resolver territory). */
export function isJsFamilyFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.vue', '.svelte', '.astro'].includes(ext);
}

/** The head a workspace name would match: `@scope/name` or `name`. */
export function packageHead(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@') && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? '';
}

/**
 * Config gate: `graph.workspacePackages` ('auto' | 'off'), env override
 * `PCTX_WORKSPACE_PACKAGES=off|auto`.
 */
export function workspacePackagesEnabled(): boolean {
  const env = process.env['PCTX_WORKSPACE_PACKAGES'];
  if (env === 'off') return false;
  if (env === 'auto') return true;
  try {
    return getConfig().graph?.workspacePackages !== 'off';
  } catch {
    return true;
  }
}

/**
 * Build the resolver for a root when the feature is on; null otherwise or
 * when the root declares no workspaces (two file reads, memoized).
 */
export function workspaceResolverFor(
  projectRoot: string,
  indexedFiles?: IndexedFileSet,
): WorkspacePackageResolver | null {
  if (!workspacePackagesEnabled()) return null;
  try {
    return createWorkspacePackageResolver(projectRoot, { indexedFiles });
  } catch {
    return null;
  }
}
