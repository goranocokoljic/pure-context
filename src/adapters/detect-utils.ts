/**
 * Shared bounded-recursive project detection for framework adapters.
 *
 * Adapters detect their framework by scanning the indexed root for marker files
 * (e.g. a `.svelte`/`.astro` file or a package.json declaring the framework).
 * In monorepos the framework app often lives in a subdirectory, so a root-only
 * check misses it. `scanForFramework` walks the tree with hard bounds (depth +
 * total directories) and skips heavy/irrelevant directories, so it stays cheap
 * even on large repos. Symlinked directories are not followed (Dirent.isDirectory()
 * is false for symlinks), avoiding cycles.
 *
 * Vue/Nuxt predate this helper and keep their own inline copies; new adapters use
 * this shared version.
 */

import { readdirSync, readFileSync, type Dirent } from 'fs';

/** Directory names that never contain first-party framework source. */
export const DETECT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.nuxt',
  '.output',
  '.next',
  '.svelte-kit',
  '.astro',
  'coverage',
  'vendor',
  'target',
  '.cache',
  '.turbo',
]);

/** Max directory depth and total directories visited by a detection scan. */
export const DETECT_MAX_DEPTH = 6;
export const DETECT_MAX_DIRS = 2000;

export interface FrameworkScanOptions {
  /** Returns true if a file name marks the framework (e.g. ends with `.svelte`). */
  matchesFile: (name: string) => boolean;
  /** Returns true if a package.json's raw text declares the framework dependency. */
  pkgDeclares: (raw: string) => boolean;
}

/**
 * Returns true on the first sign of the framework — a matching file or a
 * (possibly nested) package.json declaring it. Bounded in depth and total
 * directories visited.
 */
export function scanForFramework(
  dir: string,
  opts: FrameworkScanOptions,
  depth = 0,
  budget: { dirs: number } = { dirs: 0 },
): boolean {
  if (depth > DETECT_MAX_DEPTH || budget.dirs >= DETECT_MAX_DIRS) return false;
  budget.dirs++;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false; // unreadable directory — skip
  }

  const subDirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) {
      if (opts.matchesFile(e.name)) return true;
      if (e.name === 'package.json') {
        try {
          if (opts.pkgDeclares(readFileSync(`${dir}/${e.name}`, 'utf8'))) return true;
        } catch {
          // unreadable package.json — ignore
        }
      }
    } else if (e.isDirectory() && !DETECT_IGNORE_DIRS.has(e.name)) {
      subDirs.push(e.name);
    }
  }

  for (const name of subDirs) {
    if (scanForFramework(`${dir}/${name}`, opts, depth + 1, budget)) return true;
  }

  return false;
}

/** Parse a package.json's raw text and test its merged deps against a predicate. */
export function pkgDepMatches(raw: string, pred: (depName: string) => boolean): boolean {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = Object.assign(
      {},
      pkg['dependencies'] as Record<string, string> | undefined,
      pkg['devDependencies'] as Record<string, string> | undefined,
    );
    return Object.keys(deps).some(pred);
  } catch {
    return false;
  }
}

/** Convert a kebab/camel/snake filename stem to PascalCase ('user-card' → 'UserCard'). */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}
