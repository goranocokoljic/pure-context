import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { svelteAdapter } from '../../src/adapters/svelte.js';
import type { SymbolRecord } from '../../src/core/types.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-svelte-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content, 'utf8');
}

describe('svelteAdapter metadata', () => {
  it('has name "svelte" and declares .svelte', () => {
    expect(svelteAdapter.name).toBe('svelte');
    expect(svelteAdapter.extensions()).toContain('.svelte');
  });
});

describe('svelteAdapter.fileFilter', () => {
  it('matches .svelte, rejects others', () => {
    expect(svelteAdapter.fileFilter('src/App.svelte')).toBe(true);
    expect(svelteAdapter.fileFilter('src/app.ts')).toBe(false);
  });
});

describe('svelteAdapter.detect', () => {
  it('true when package.json declares svelte', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ devDependencies: { svelte: '^5.0.0' } }));
      expect(await svelteAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true for @sveltejs/* packages', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0' } }));
      expect(await svelteAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true when svelte.config.js exists', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'svelte.config.js', 'export default {};');
      expect(await svelteAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('true for a .svelte file in a nested sub-app (monorepo)', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { lerna: '^8.0.0' } }));
      const sub = join(dir, 'apps', 'web', 'src');
      mkdirSync(sub, { recursive: true });
      writeFile(sub, 'App.svelte', '<h1>hi</h1>');
      expect(await svelteAdapter.detect(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('false with no svelte signal', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      expect(await svelteAdapter.detect(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores .svelte inside node_modules', async () => {
    const dir = tmpDir();
    try {
      const sub = join(dir, 'node_modules', 'pkg');
      mkdirSync(sub, { recursive: true });
      writeFile(sub, 'Bundled.svelte', '<h1/>');
      expect(await svelteAdapter.detect(dir)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('svelteAdapter.extractFrameworkSymbols', () => {
  it('emits a component symbol with PascalCase name', () => {
    const [s] = svelteAdapter.extractFrameworkSymbols(null, buf('<h1/>'), 'src/user-card.svelte');
    expect(s!.kind).toBe('component');
    expect(s!.name).toBe('UserCard');
    expect(s!.frameworkMeta?.['svelte_component']).toBe(true);
    expect(s!.signature).toBe('<UserCard>');
  });

  it('id is deterministic and path-sensitive', () => {
    const [a] = svelteAdapter.extractFrameworkSymbols(null, buf('<h1/>'), 'src/A.svelte');
    const [a2] = svelteAdapter.extractFrameworkSymbols(null, buf('<h1/>'), 'src/A.svelte');
    const [b] = svelteAdapter.extractFrameworkSymbols(null, buf('<h1/>'), 'src/B.svelte');
    expect(a!.id).toBe(a2!.id);
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('svelteAdapter.enrichMetadata', () => {
  function sym(o: Partial<SymbolRecord>): SymbolRecord {
    return { id: 'x', name: 'useThing', kind: 'function', filePath: 'src/lib/useThing.ts', startByte: 0, endByte: 1, signature: '', summary: '', ...o };
  }
  it('upgrades useXxx to composable', () => {
    expect(svelteAdapter.enrichMetadata!(sym({ name: 'useStore', kind: 'function' })).kind).toBe('composable');
  });
  it('leaves unrelated symbols unchanged', () => {
    const r = svelteAdapter.enrichMetadata!(sym({ name: 'helper', kind: 'function' }));
    expect(r.kind).toBe('function');
  });
});
