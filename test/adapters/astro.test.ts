import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { astroAdapter } from '../../src/adapters/astro.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-astro-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

describe('astroAdapter metadata', () => {
  it('has name "astro" and declares .astro', () => {
    expect(astroAdapter.name).toBe('astro');
    expect(astroAdapter.extensions()).toContain('.astro');
  });
});

describe('astroAdapter.fileFilter', () => {
  it('matches .astro, rejects others', () => {
    expect(astroAdapter.fileFilter('src/pages/index.astro')).toBe(true);
    expect(astroAdapter.fileFilter('src/index.ts')).toBe(false);
  });
});

describe('astroAdapter.detect', () => {
  it('true when package.json declares astro', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { astro: '^4.0.0' } }));
      expect(await astroAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true for @astrojs/* packages', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ devDependencies: { '@astrojs/react': '^3.0.0' } }));
      expect(await astroAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true when astro.config.mjs exists', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'astro.config.mjs', 'export default {};');
      expect(await astroAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true for a nested .astro file (monorepo)', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { turbo: '^2.0.0' } }));
      const sub = join(dir, 'apps', 'site', 'src', 'pages');
      mkdirSync(sub, { recursive: true });
      writeFile(sub, 'index.astro', '---\n---\n<h1/>');
      expect(await astroAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('false with no astro signal', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
      expect(await astroAdapter.detect(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('astroAdapter.extractFrameworkSymbols', () => {
  it('emits a component symbol with PascalCase name', () => {
    const [s] = astroAdapter.extractFrameworkSymbols(null, buf('---\n---\n<h1/>'), 'src/pages/blog-post.astro');
    expect(s!.kind).toBe('component');
    expect(s!.name).toBe('BlogPost');
    expect(s!.frameworkMeta?.['astro_component']).toBe(true);
  });
});
