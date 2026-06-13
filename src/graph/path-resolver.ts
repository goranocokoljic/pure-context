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
  const tsPaths = loadTsConfigPaths(projectRoot);

  return {
    projectRoot,
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

function loadTsConfigPaths(projectRoot: string): TsConfigPaths | null {
  for (const filename of CONFIG_FILENAMES) {
    const configPath = resolve(projectRoot, filename);
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, 'utf8');
      const tsconfig = JSON.parse(stripJsonComments(raw)) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };

      const compilerOptions = tsconfig.compilerOptions ?? {};
      const rawBaseUrl = compilerOptions.baseUrl ?? '.';
      const baseUrl = resolve(projectRoot, rawBaseUrl);
      const paths = compilerOptions.paths ?? {};

      return { baseUrl, paths };
    } catch {
      // Malformed config — fall through to the next candidate (if any).
      continue;
    }
  }

  return null;
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
