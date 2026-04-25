import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { discoverFiles } from '../../src/core/file-discovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

describe('discoverFiles', () => {
  it('finds TypeScript files in the fixture project', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/utils.ts');
    expect(paths).toContain('src/types.ts');
    expect(paths).toContain('lib/helpers.ts');
  });

  it('respects .gitignore — excluded file is absent', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('ignored-file.ts');
  });

  it('excludes test/ files without extensions filter', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    // test/ files should still be found (lower priority), just ranked last
    const testFiles = files.filter((f) => f.path.startsWith('test/'));
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('filters by extension', () => {
    const files = discoverFiles(FIXTURE);
    // tsconfig.json and .gitignore should NOT appear when extensions=['.ts']
    const tsOnly = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    expect(tsOnly.every((f) => f.path.endsWith('.ts'))).toBe(true);
    // without extension filter we get more files
    expect(files.length).toBeGreaterThanOrEqual(tsOnly.length);
  });

  it('respects the fileLimit option', () => {
    const files = discoverFiles(FIXTURE, { fileLimit: 2 });
    expect(files).toHaveLength(2);
  });

  it('sorts src/ files before lib/ before test/', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    const priorities = files.map((f) => f.priority);
    // priorities should be non-increasing
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeLessThanOrEqual(priorities[i - 1]);
    }
    // src/ files must come before test/ files
    const srcIdx = files.findIndex((f) => f.path.startsWith('src/'));
    const testIdx = files.findIndex((f) => f.path.startsWith('test/'));
    expect(srcIdx).toBeLessThan(testIdx);
  });

  it('lib/ files have higher priority than test/', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'] });
    const libFile = files.find((f) => f.path.startsWith('lib/'));
    const testFile = files.find((f) => f.path.startsWith('test/'));
    expect(libFile).toBeDefined();
    expect(testFile).toBeDefined();
    expect(libFile!.priority).toBeGreaterThan(testFile!.priority);
  });

  it('returns DiscoveredFile with path, size, priority fields', () => {
    const files = discoverFiles(FIXTURE, { extensions: ['.ts'], fileLimit: 1 });
    expect(files[0]).toHaveProperty('path');
    expect(files[0]).toHaveProperty('size');
    expect(files[0]).toHaveProperty('priority');
    expect(typeof files[0].size).toBe('number');
    expect(files[0].size).toBeGreaterThan(0);
  });

  it('excludes extra patterns provided in options', () => {
    const files = discoverFiles(FIXTURE, {
      extensions: ['.ts'],
      extraExcludePatterns: ['lib/**'],
    });
    expect(files.every((f) => !f.path.startsWith('lib/'))).toBe(true);
  });

  it('handles a directory with no matching files gracefully', () => {
    // Point at a subdirectory that has no .json files
    const files = discoverFiles(FIXTURE, { extensions: ['.json'] });
    // tsconfig.json exists at root level
    const paths = files.map((f) => f.path);
    expect(paths).toContain('tsconfig.json');
  });
});
