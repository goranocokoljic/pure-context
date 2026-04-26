/**
 * Package contents test — Task 121
 *
 * Reads package.json directly to assert all required metadata fields are
 * present. Also parses the output of `npm pack --dry-run` to assert the
 * published file set is correct (required files present, dev-only files
 * excluded).
 *
 * These tests act as a pre-publish gate alongside `prepublishOnly`.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readPackageJson(): Record<string, unknown> {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf8');
  return JSON.parse(raw);
}

/**
 * Run `npm pack --dry-run` and return the list of files that would be packed.
 * npm prints them to stderr; we capture both streams and filter lines that
 * look like file paths inside the tarball.
 */
function getPackedFiles(): string[] {
  // npm 9+ writes the file list to stderr; older versions use stdout.
  // spawnSync lets us capture both streams reliably.
  const result = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true, // required on Windows where npm is npm.cmd
  });

  if (result.status !== 0) {
    throw new Error(`npm pack --dry-run exited ${result.status}: ${result.stderr}`);
  }

  const combined = (result.stdout ?? '') + (result.stderr ?? '');

  // Each line of the packed file list looks like:
  //   npm notice 1.2kB  dist/index.js
  // or just the bare path depending on npm version. Normalise to paths only.
  return combined
    .split('\n')
    .map((line) => line.replace(/^.*npm notice\s+[\d.]+\w+\s+/, '').trim())
    // Keep lines that look like file paths: have an extension OR a path separator.
    // Lines that didn't match the prefix regex (headers, summaries) still start
    // with 'npm' and are excluded by the first condition.
    .filter((line) => line.length > 0 && !line.startsWith('npm') && /[./]/.test(line));
}

// ---------------------------------------------------------------------------
// package.json metadata
// ---------------------------------------------------------------------------

describe('package.json required fields', () => {
  const pkg = readPackageJson();

  it('has a name', () => {
    expect(pkg.name).toBe('purecontext-mcp');
  });

  it('has a version', () => {
    expect(typeof pkg.version).toBe('string');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('has bin pointing to dist/index.js', () => {
    const bin = pkg.bin as Record<string, string>;
    expect(bin['purecontext-mcp']).toBe('./dist/index.js');
  });

  it('has engines.node >= 18', () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines.node).toContain('18');
  });

  it('has license', () => {
    expect(pkg.license).toBe('MIT');
  });

  it('has repository.url', () => {
    const repo = pkg.repository as Record<string, string>;
    expect(repo.url).toContain('github.com');
  });

  it('has bugs.url', () => {
    const bugs = pkg.bugs as Record<string, string>;
    expect(bugs.url).toContain('issues');
  });

  it('has homepage', () => {
    expect(typeof pkg.homepage).toBe('string');
  });

  it('has keywords array', () => {
    const kw = pkg.keywords as string[];
    expect(Array.isArray(kw)).toBe(true);
    expect(kw).toContain('mcp');
  });

  it('has exports field', () => {
    expect(pkg.exports).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Published file set
// ---------------------------------------------------------------------------

describe('npm pack --dry-run file set', () => {
  // Skip if dist/ has not been built (e.g. fresh clone without a build step).
  // The CI pipeline runs `npm run build` before `npm test` so this is safe there.
  let files: string[];

  try {
    files = getPackedFiles();
  } catch {
    // If npm pack itself fails (e.g. no dist/), report a clear message.
    it('npm pack must succeed', () => {
      expect.fail(
        'npm pack --dry-run failed. Run `npm run build` first, then re-run tests.'
      );
    });
    files = [];
  }

  it('includes dist/index.js', () => {
    expect(files.some((f) => f.includes('dist/index.js'))).toBe(true);
  });

  it('includes scripts/check-sqlite.js', () => {
    expect(files.some((f) => f.includes('scripts/check-sqlite.js'))).toBe(true);
  });

  it('includes package.json', () => {
    expect(files.some((f) => f.includes('package.json'))).toBe(true);
  });

  it('excludes test/ directory', () => {
    const testFiles = files.filter((f) => /\btest\//.test(f));
    expect(testFiles).toHaveLength(0);
  });

  it('excludes benchmarks/ directory', () => {
    const benchFiles = files.filter((f) => /\bbenchmarks\//.test(f));
    expect(benchFiles).toHaveLength(0);
  });

  it('excludes raw .ts source files (not .d.ts)', () => {
    const tsSource = files.filter((f) => /\.ts$/.test(f) && !f.endsWith('.d.ts'));
    expect(tsSource).toHaveLength(0);
  });

  it('excludes node_modules', () => {
    const nmFiles = files.filter((f) => f.includes('node_modules'));
    expect(nmFiles).toHaveLength(0);
  });
});
