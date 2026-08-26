/**
 * Phase 91 (Task 565) — exclusion precedence + dropped-directory honesty.
 *
 * Order is built-ins → repo .gitignore → user excludePatterns, so a user
 * negation (`!protected/`) can rescue a directory the .gitignore hides.
 * Discovery also reports top-level directories excluded entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { discoverFiles } from '../../src/core/file-discovery.js';

let root: string;

function write(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(() => {
  root = resolve(mkdtempSync(join(tmpdir(), 'pc-discovery-prec-')));
  write('.gitignore', '/protected\n/artifacts\n');
  write('src/app.ts', 'export const a = 1;\n');
  write('protected/nested/lib.ts', 'export const hidden = 2;\n');
  write('artifacts/out.ts', 'export const out = 3;\n');
  write('node_modules/pkg/index.ts', 'export const dep = 4;\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('exclusion precedence', () => {
  it('.gitignore hides a nested directory by default', () => {
    const { files } = discoverFiles(root, { extensions: ['.ts'] });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/app.ts');
    expect(paths.some((p) => p.startsWith('protected/'))).toBe(false);
  });

  it('user negation pattern rescues a .gitignore-hidden directory', () => {
    const { files } = discoverFiles(root, {
      extensions: ['.ts'],
      extraExcludePatterns: ['!protected/'],
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('protected/nested/lib.ts');
    // The other gitignored dir stays hidden
    expect(paths.some((p) => p.startsWith('artifacts/'))).toBe(false);
  });

  it('user patterns can still exclude on top of .gitignore', () => {
    const { files } = discoverFiles(root, {
      extensions: ['.ts'],
      extraExcludePatterns: ['src/'],
    });
    expect(files.map((f) => f.path)).not.toContain('src/app.ts');
  });

  it('built-ins remain excluded and user patterns can override them', () => {
    const def = discoverFiles(root, { extensions: ['.ts'] });
    expect(def.files.some((f) => f.path.startsWith('node_modules/'))).toBe(false);

    const rescued = discoverFiles(root, {
      extensions: ['.ts'],
      extraExcludePatterns: ['!node_modules/'],
    });
    expect(rescued.files.some((f) => f.path.startsWith('node_modules/'))).toBe(true);
  });
});

describe('excluded-directory honesty', () => {
  it('reports top-level dirs dropped by .gitignore with their source', () => {
    const { excludedDirs } = discoverFiles(root, { extensions: ['.ts'] });
    const gitignored = excludedDirs.filter((e) => e.source === 'gitignore').map((e) => e.dir).sort();
    expect(gitignored).toEqual(['artifacts', 'protected']);
    const builtin = excludedDirs.find((e) => e.dir === 'node_modules');
    expect(builtin?.source).toBe('builtin');
  });

  it('reports config-driven drops as source config', () => {
    const { excludedDirs } = discoverFiles(root, {
      extensions: ['.ts'],
      extraExcludePatterns: ['src/'],
    });
    expect(excludedDirs.find((e) => e.dir === 'src')?.source).toBe('config');
  });

  it('a rescued directory is not reported as excluded', () => {
    const { excludedDirs } = discoverFiles(root, {
      extensions: ['.ts'],
      extraExcludePatterns: ['!protected/'],
    });
    expect(excludedDirs.some((e) => e.dir === 'protected')).toBe(false);
  });
});
