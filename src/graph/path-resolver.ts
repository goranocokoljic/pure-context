import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PathResolver {
  /**
   * Resolve an import specifier to a path relative to the project root.
   * @param specifier  Raw import path (e.g. './utils', '@/lib/foo', 'express')
   * @param fromFile   The importing file's path, relative to projectRoot
   * @returns Path relative to projectRoot, or null for external packages
   */
  resolve(specifier: string, fromFile: string): string | null;
  /** The project root this resolver was created for. */
  projectRoot: string;
  /**
   * Content hash of everything alias resolution depends on: the tsconfig /
   * jsconfig `extends` chain (paths + contents), the Nuxt default-alias
   * inputs, and the resolver's own rule version. A whole-tree run whose stamp
   * differs from the stored one re-resolves the whole graph — otherwise a
   * tsconfig edit (or a resolver upgrade) would never reach unchanged files.
   */
  configStamp: string;
}

interface TsConfigPaths {
  baseUrl: string;           // Absolute path
  paths: Record<string, string[]>;
}

// ─── Extension resolution order ───────────────────────────────────────────────

// When a specifier has a .js/.mjs/.cjs extension, TypeScript emits those but
// the source files have .ts/.mts/.cts — try both.
const JS_TO_TS: Record<string, string> = {
  '.js': '.ts',
  '.jsx': '.tsx',
  '.mjs': '.mts',
  '.cjs': '.cts',
};

// Extensions to probe when specifier has no extension
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];

// Index filenames to probe when specifier resolves to a directory
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

// ─── Public factory ───────────────────────────────────────────────────────────

export function createResolver(projectRoot: string): PathResolver {
  const { tsPaths, configStamp } = loadTsConfigPaths(projectRoot);

  return {
    projectRoot,
    configStamp,
    resolve(specifier: string, fromFile: string): string | null {
      const fromDir = dirname(resolve(projectRoot, fromFile));

      // Strategy 1 — relative paths
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        return resolveRelative(specifier, fromDir, projectRoot);
      }

      // Strategy 2 — tsconfig path aliases
      if (tsPaths) {
        const aliased = resolveAlias(specifier, tsPaths, projectRoot);
        if (aliased !== null) return aliased;
      }

      // Strategy 3 — bare specifier without a leading alias prefix
      // Treat as external (npm package, Node built-in, etc.)
      return null;
    },
  };
}

// ─── Resolution strategies ────────────────────────────────────────────────────

function resolveRelative(
  specifier: string,
  fromDir: string,
  projectRoot: string,
): string | null {
  const absCandidate = resolve(fromDir, specifier);
  const resolved = tryResolveFile(absCandidate);
  if (resolved === null) return null;
  return toRelative(resolved, projectRoot);
}

function resolveAlias(
  specifier: string,
  tsPaths: TsConfigPaths,
  projectRoot: string,
): string | null {
  const { baseUrl, paths } = tsPaths;

  for (const [pattern, replacements] of Object.entries(paths)) {
    const captured = matchWildcard(pattern, specifier);
    if (captured === null) continue;

    for (const replacement of replacements) {
      const expanded = replacement.includes('*')
        ? replacement.replace('*', captured)
        : replacement;
      const absCandidate = resolve(baseUrl, expanded);
      const resolved = tryResolveFile(absCandidate);
      if (resolved !== null) return toRelative(resolved, projectRoot);
    }
  }

  return null;
}

// ─── File probing ─────────────────────────────────────────────────────────────

/**
 * Given an absolute path candidate (with or without extension), find the
 * actual file on disk. Returns the absolute path of the found file or null.
 */
function tryResolveFile(candidate: string): string | null {
  // 1. Exact match
  if (existsSync(candidate) && !isDirectory(candidate)) return candidate;

  // 2. If specifier ends with a JS extension, try the TS equivalent first
  const ext = extname(candidate);
  const tsExt = JS_TO_TS[ext];
  if (tsExt) {
    const tsCandidate = candidate.slice(0, -ext.length) + tsExt;
    if (existsSync(tsCandidate)) return tsCandidate;
  }

  // 3. Probe each extension (for extensionless specifiers)
  if (!ext || tsExt) {
    const base = ext ? candidate.slice(0, -ext.length) : candidate;
    for (const probe of PROBE_EXTENSIONS) {
      const probed = base + probe;
      if (existsSync(probed)) return probed;
    }
  }

  // 4. Index file (treat candidate as a directory)
  const dirCandidate = ext ? candidate.slice(0, -ext.length) : candidate;
  for (const idx of INDEX_FILES) {
    const indexed = join(dirCandidate, idx);
    if (existsSync(indexed)) return indexed;
  }
  // Also try the original path as a directory
  if (isDirectory(candidate)) {
    for (const idx of INDEX_FILES) {
      const indexed = join(candidate, idx);
      if (existsSync(indexed)) return indexed;
    }
  }

  return null;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── tsconfig loading ─────────────────────────────────────────────────────────

// Config files that may carry compilerOptions.paths, in precedence order.
// Mirrors editor behaviour: tsconfig.json wins, jsconfig.json is the JS-project
// fallback (common in Vue/Nuxt/plain-JS repos with no TypeScript).
const CONFIG_FILENAMES = ['tsconfig.json', 'jsconfig.json'];

interface RawTsConfig {
  /** Absolute path of the config file. */
  path: string;
  /** Raw file text — hashed into the resolver's config stamp. */
  raw: string;
  /** Directory the config file lives in — `paths` / `baseUrl` are relative to it. */
  dir: string;
  compilerOptions: { baseUrl?: string; paths?: Record<string, string[]> };
  extends?: string | string[];
}

/** Longest `extends` chain followed before giving up (cycle guard is separate). */
const MAX_EXTENDS_DEPTH = 16;

/**
 * Bump when alias-resolution RULES change (not config contents — those are
 * hashed): every index then re-resolves its whole graph once on its next
 * whole-tree run, so the new rules reach files that did not change.
 */
const RESOLVER_RULES_VERSION = 'phase108-extends-nuxt-defaults';

function loadTsConfigPaths(projectRoot: string): { tsPaths: TsConfigPaths | null; configStamp: string } {
  let loaded: TsConfigPaths | null = null;
  const stamp = createHash('sha256').update(RESOLVER_RULES_VERSION).update('\0');

  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(projectRoot, filename);
    if (!existsSync(configPath)) continue;

    // Child first, then its `extends` targets (Phase 108). TypeScript merges
    // compilerOptions shallowly: the nearest config declaring `paths` wins the
    // whole map; `baseUrl` likewise. A `paths` map without any `baseUrl` is
    // relative to the config file that declares it — so a Nuxt root tsconfig
    // that is only `{ "extends": "./.nuxt/tsconfig.json" }` yields aliases
    // rooted in `.nuxt/` (`"~/*": ["../app/*"]`).
    const chain = loadConfigChain(configPath, new Set(), 0);
    if (chain.length === 0) continue; // malformed — try the next candidate
    for (const c of chain) stamp.update(relative(projectRoot, c.path)).update('\0').update(c.raw).update('\0');

    const pathsOwner = chain.find((c) => c.compilerOptions.paths !== undefined);
    const baseOwner = chain.find((c) => c.compilerOptions.baseUrl !== undefined);
    const baseUrl = baseOwner
      ? resolve(baseOwner.dir, baseOwner.compilerOptions.baseUrl!)
      : pathsOwner?.dir ?? projectRoot;
    loaded = { baseUrl, paths: pathsOwner?.compilerOptions.paths ?? {} };
    break;
  }

  const tsPaths = withNuxtDefaults(loaded, projectRoot, stamp);
  return { tsPaths, configStamp: stamp.digest('hex').slice(0, 16) };
}

/**
 * Read one config and, recursively, everything it extends. Returns the chain in
 * precedence order (child first; for an array `extends`, the last entry
 * outranks the earlier ones, as in TypeScript 5). Unreadable or cyclic targets
 * are skipped silently — a missing `.nuxt/tsconfig.json` (repo never ran
 * `nuxt prepare`) must not take the root config down with it.
 */
function loadConfigChain(configPath: string, visited: Set<string>, depth: number): RawTsConfig[] {
  const key = resolve(configPath);
  if (visited.has(key) || depth > MAX_EXTENDS_DEPTH) return [];
  visited.add(key);

  const own = readTsConfig(key);
  if (own === null) return [];

  const chain: RawTsConfig[] = [own];
  const targets = own.extends === undefined
    ? []
    : Array.isArray(own.extends) ? [...own.extends].reverse() : [own.extends];
  for (const target of targets) {
    const resolvedTarget = resolveExtendsTarget(target, own.dir);
    if (resolvedTarget === null) continue;
    chain.push(...loadConfigChain(resolvedTarget, visited, depth + 1));
  }
  return chain;
}

function readTsConfig(configPath: string): RawTsConfig | null {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      extends?: string | string[];
    };
    if (parsed === null || typeof parsed !== 'object') return null;
    return {
      path: configPath,
      raw,
      dir: dirname(configPath),
      compilerOptions: parsed.compilerOptions ?? {},
      extends: parsed.extends,
    };
  } catch {
    return null;
  }
}

/**
 * Locate an `extends` target on disk. Relative / absolute specifiers resolve
 * against the extending config's directory, `.json` optional. Bare specifiers
 * are node packages (`@nuxt/tsconfig`, `@tsconfig/node18/tsconfig.json`):
 * walk `node_modules` upward and accept a file, a file + `.json`, or a package
 * directory holding `tsconfig.json`.
 */
function resolveExtendsTarget(spec: string, fromDir: string): string | null {
  const probe = (base: string): string | null => {
    if (existsSync(base) && !isDirectory(base)) return base;
    if (existsSync(base + '.json') && !isDirectory(base + '.json')) return base + '.json';
    const nested = join(base, 'tsconfig.json');
    if (isDirectory(base) && existsSync(nested)) return nested;
    return null;
  };

  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec)) {
    return probe(resolve(fromDir, spec));
  }

  let dir = fromDir;
  for (;;) {
    const hit = probe(join(dir, 'node_modules', spec));
    if (hit !== null) return hit;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ─── Nuxt default aliases ─────────────────────────────────────────────────────

const NUXT_CONFIG_FILENAMES = ['nuxt.config.ts', 'nuxt.config.mts', 'nuxt.config.js', 'nuxt.config.mjs'];

/**
 * Nuxt ships its aliases through the generated `.nuxt/tsconfig.json`, which is
 * gitignored and only exists after `nuxt prepare` / `nuxt dev`. On a fresh
 * checkout the chain above finds nothing, so fill in Nuxt's documented defaults
 * for any alias the config did not declare: `~` / `@` → srcDir (`app/` when
 * that directory exists — the Nuxt 4 layout — else the root), `~~` / `@@` →
 * rootDir, `#shared` → `shared/`. Replacements are absolute so `baseUrl` (which
 * may point into `.nuxt/`) cannot bend them. Each candidate is still probed on
 * disk, so a default that does not match the repo yields no edge, never a wrong
 * one. Virtual aliases (`#imports`, `#app`, `#components`) stay external.
 */
function withNuxtDefaults(
  loaded: TsConfigPaths | null,
  projectRoot: string,
  stamp: ReturnType<typeof createHash>,
): TsConfigPaths | null {
  const isNuxt = NUXT_CONFIG_FILENAMES.some((f) => existsSync(resolve(projectRoot, f)));
  stamp.update(isNuxt ? 'nuxt' : 'plain').update('\0');
  if (!isNuxt) return loaded;

  const root = resolve(projectRoot);
  const appDir = join(root, 'app');
  const srcDirs = isDirectory(appDir) ? [appDir, root] : [root];
  const sharedDir = join(root, 'shared');
  stamp.update(srcDirs.length === 2 ? 'app' : 'root').update('\0');

  const defaults: Record<string, string[]> = {
    '~/*': srcDirs.map((d) => join(d, '*')),
    '@/*': srcDirs.map((d) => join(d, '*')),
    '~': srcDirs,
    '@': srcDirs,
    '~~/*': [join(root, '*')],
    '@@/*': [join(root, '*')],
    '~~': [root],
    '@@': [root],
    '#shared/*': [join(sharedDir, '*')],
    '#shared': [sharedDir],
  };

  const paths: Record<string, string[]> = { ...(loaded?.paths ?? {}) };
  for (const [pattern, replacements] of Object.entries(defaults)) {
    if (!(pattern in paths)) paths[pattern] = replacements;
  }
  return { baseUrl: loaded?.baseUrl ?? root, paths };
}

/**
 * Strip `//` line comments and `/* … *​/` block comments from JSONC text
 * (tsconfig/jsconfig commonly contain them), while leaving comment-like
 * sequences *inside string literals* untouched.
 *
 * A naive regex approach is unsafe here: a `paths` key such as `"~/*"` opens a
 * comment and an `include` glob such as `"**​/*"` closes one, so a whole-text
 * regex would delete everything between them and corrupt otherwise-valid JSON.
 * This walks the text character by character and only treats `//` / `/*` as
 * comment starts when outside a double-quoted string.
 */
function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch; // keep the newline so line numbers are preserved
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++; // consume the closing '/'
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Copy the escaped character verbatim so an escaped quote (\") does
        // not prematurely close the string.
        out += input[i + 1] ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Outside any string or comment.
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      out += ch;
    }
  }

  return out;
}

// ─── Wildcard matching ────────────────────────────────────────────────────────

/**
 * Returns the captured `*` text if `specifier` matches `pattern`, or null.
 * Patterns without `*` must match exactly (returns empty string on match).
 */
function matchWildcard(pattern: string, specifier: string): string | null {
  if (!pattern.includes('*')) {
    return pattern === specifier ? '' : null;
  }
  const starIdx = pattern.indexOf('*');
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);

  if (!specifier.startsWith(prefix)) return null;
  if (suffix && !specifier.endsWith(suffix)) return null;

  const captured = specifier.slice(
    prefix.length,
    suffix ? specifier.length - suffix.length : undefined,
  );
  return captured;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toRelative(absPath: string, projectRoot: string): string {
  return relative(projectRoot, absPath).split('\\').join('/');
}
