import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vueAdapter } from '../../src/adapters/vue.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buf(str: string): Buffer {
  return Buffer.from(str, 'utf8');
}

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-vue-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetForTesting();
});

// ── Metadata ─────────────────────────────────────────────────────────────────

describe('vueAdapter metadata', () => {
  it('has name "vue"', () => {
    expect(vueAdapter.name).toBe('vue');
  });

  it('declares .vue extension', () => {
    expect(vueAdapter.extensions()).toContain('.vue');
  });
});

// ── fileFilter ────────────────────────────────────────────────────────────────

describe('vueAdapter.fileFilter', () => {
  it('matches .vue files', () => {
    expect(vueAdapter.fileFilter('src/MyComp.vue')).toBe(true);
    expect(vueAdapter.fileFilter('components/Button.vue')).toBe(true);
  });

  it('does not match non-.vue files', () => {
    expect(vueAdapter.fileFilter('src/utils.ts')).toBe(false);
    expect(vueAdapter.fileFilter('src/App.tsx')).toBe(false);
    expect(vueAdapter.fileFilter('styles.css')).toBe(false);
  });
});

// ── detect ────────────────────────────────────────────────────────────────────

describe('vueAdapter.detect', () => {
  it('returns true when package.json has vue in dependencies', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when package.json has vue in devDependencies', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ devDependencies: { vue: '^3.0.0' } }));
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true for @vue/* packages', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { '@vue/runtime-core': '^3.0.0' } }));
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when no vue dependency and no .vue files', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      expect(await vueAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when .vue files exist in project root (no package.json)', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'App.vue', '<template><div>hello</div></template>');
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when .vue files exist in src/ (no package.json)', async () => {
    const dir = tmpDir();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFile(join(dir, 'src'), 'App.vue', '<template><div>hello</div></template>');
      expect(await vueAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for an empty directory', async () => {
    const dir = tmpDir();
    try {
      expect(await vueAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── preProcess ────────────────────────────────────────────────────────────────

describe('vueAdapter.preProcess', () => {
  it('delegates to splitVueSFC — returns script blocks', () => {
    const sfc = buf('<script lang="ts">\nconst x = 1\n</script>');
    const blocks = vueAdapter.preProcess!(sfc, 'Foo.vue');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('typescript');
  });

  it('returns [] for template-only SFC', () => {
    const sfc = buf('<template><p>hello</p></template>');
    expect(vueAdapter.preProcess!(sfc, 'Foo.vue')).toEqual([]);
  });
});

// ── extractFrameworkSymbols ───────────────────────────────────────────────────

describe('vueAdapter.extractFrameworkSymbols', () => {
  it('emits a component symbol for every .vue file', () => {
    const source = buf('<template><p>hi</p></template>');
    const symbols = vueAdapter.extractFrameworkSymbols(null, source, 'src/MyComp.vue');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.kind).toBe('component');
  });

  it('derives component name in PascalCase from filename', () => {
    const source = buf('<template></template>');
    const cases: [string, string][] = [
      ['src/UserCard.vue',    'UserCard'],
      ['src/user-card.vue',  'UserCard'],
      ['src/my_widget.vue',  'MyWidget'],
      ['components/app.vue', 'App'],
    ];
    for (const [filePath, expectedName] of cases) {
      const [sym] = vueAdapter.extractFrameworkSymbols(null, source, filePath);
      expect(sym!.name).toBe(expectedName);
    }
  });

  it('uses explicit name from defineOptions({ name: ... })', () => {
    const source = buf(`
      <script setup>
      defineOptions({ name: 'ExplicitName' })
      </script>
    `);
    const [sym] = vueAdapter.extractFrameworkSymbols(null, source, 'src/SomeName.vue');
    expect(sym!.name).toBe('ExplicitName');
  });

  it('component signature uses <ComponentName> format', () => {
    const source = buf('<template></template>');
    const [sym] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Button.vue');
    expect(sym!.signature).toBe('<Button>');
  });

  it('component summary mentions Vue component', () => {
    const source = buf('<template></template>');
    const [sym] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Button.vue');
    expect(sym!.summary).toContain('Vue component');
    expect(sym!.summary).toContain('Button');
  });

  it('component frameworkMeta has vue_component: true', () => {
    const source = buf('<template></template>');
    const [sym] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Foo.vue');
    expect(sym!.frameworkMeta?.['vue_component']).toBe(true);
  });

  it('component startByte is 0 and endByte is source.length', () => {
    const source = buf('<template><p>hello</p></template>');
    const [sym] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Foo.vue');
    expect(sym!.startByte).toBe(0);
    expect(sym!.endByte).toBe(source.length);
  });

  it('component id is deterministic (same input → same id)', () => {
    const source = buf('<template></template>');
    const [a] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Foo.vue');
    const [b] = vueAdapter.extractFrameworkSymbols(null, source, 'src/Foo.vue');
    expect(a!.id).toBe(b!.id);
  });

  it('component id differs for different file paths', () => {
    const source = buf('<template></template>');
    const [a] = vueAdapter.extractFrameworkSymbols(null, source, 'src/A.vue');
    const [b] = vueAdapter.extractFrameworkSymbols(null, source, 'src/B.vue');
    expect(a!.id).not.toBe(b!.id);
  });
});

// ── enrichMetadata ────────────────────────────────────────────────────────────

describe('vueAdapter.enrichMetadata', () => {
  function sym(overrides: Partial<SymbolRecord>): SymbolRecord {
    return {
      id: 'aaaa0000bbbb1111',
      name: 'useAuth',
      kind: 'function',
      filePath: 'src/composables/useAuth.ts',
      startByte: 0,
      endByte: 100,
      signature: 'export const useAuth = () => ...',
      summary: '',
      ...overrides,
    };
  }

  it('upgrades useXxx function to composable', () => {
    const result = vueAdapter.enrichMetadata!(sym({ name: 'useAuth', kind: 'function' }));
    expect(result.kind).toBe('composable');
  });

  it('upgrades useXxx const to composable', () => {
    const result = vueAdapter.enrichMetadata!(sym({ name: 'useTheme', kind: 'const' }));
    expect(result.kind).toBe('composable');
  });

  it('sets vue_composable: true in frameworkMeta', () => {
    const result = vueAdapter.enrichMetadata!(sym({ name: 'useAuth', kind: 'function' }));
    expect(result.frameworkMeta?.['vue_composable']).toBe(true);
  });

  it('recomputes id when kind changes to composable', () => {
    const original = sym({ name: 'useAuth', kind: 'function' });
    const result = vueAdapter.enrichMetadata!(original);
    expect(result.id).not.toBe(original.id);
    // New id must be deterministic
    const result2 = vueAdapter.enrichMetadata!(original);
    expect(result.id).toBe(result2.id);
  });

  it('does not upgrade functions that do not start with use + uppercase', () => {
    const notComposable = sym({ name: 'usefoo', kind: 'function' }); // lowercase after 'use'
    const result = vueAdapter.enrichMetadata!(notComposable);
    expect(result.kind).toBe('function');

    const alsoNot = sym({ name: 'useState_helper', kind: 'function' }); // has underscore
    // 'useState_helper' starts with 'use' + uppercase 'S', so it SHOULD upgrade
    const result2 = vueAdapter.enrichMetadata!(alsoNot);
    expect(result2.kind).toBe('composable');
  });

  it('does not modify unrelated symbols', () => {
    const helper = sym({ name: 'formatDate', kind: 'function' });
    const result = vueAdapter.enrichMetadata!(helper);
    expect(result.kind).toBe('function');
    expect(result.id).toBe(helper.id);
  });

  it('adds vue_component to component symbols', () => {
    const comp = sym({ name: 'MyCard', kind: 'component' });
    const result = vueAdapter.enrichMetadata!(comp);
    expect(result.frameworkMeta?.['vue_component']).toBe(true);
    expect(result.kind).toBe('component');
  });

  it('preserves existing frameworkMeta fields when enriching', () => {
    const comp = sym({ kind: 'composable', frameworkMeta: { existing: 'value' }, name: 'useX' });
    const result = vueAdapter.enrichMetadata!(comp);
    expect(result.frameworkMeta?.['existing']).toBe('value');
  });
});
