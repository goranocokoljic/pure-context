import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { reactAdapter } from '../../src/adapters/react.js';
import { _resetForTesting } from '../../src/adapters/adapter-registry.js';
import { registerHandler, _resetForTesting as resetHandlers } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { indexFolder, deleteIndex, computeRepoId } from '../../src/core/index-manager.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { searchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `purecontext-react-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'aabbccddeeff0011',
    name: 'MyComponent',
    kind: 'function',
    filePath: 'src/Button.tsx',
    startByte: 0,
    endByte: 100,
    signature: 'export function MyComponent()',
    summary: '',
    ...overrides,
  };
}

// ─── Global setup ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  resetHandlers();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();
});

beforeEach(() => {
  _resetForTesting();
});

// ─── Metadata ─────────────────────────────────────────────────────────────────

describe('reactAdapter metadata', () => {
  it('has name "react"', () => {
    expect(reactAdapter.name).toBe('react');
  });

  it('declares no additional extensions', () => {
    expect(reactAdapter.extensions()).toEqual([]);
  });

  it('has no preProcess', () => {
    expect(reactAdapter.preProcess).toBeUndefined();
  });

  it('extractFrameworkSymbols always returns []', () => {
    expect(reactAdapter.extractFrameworkSymbols(null, Buffer.from(''), 'src/Btn.tsx')).toEqual([]);
  });
});

// ─── fileFilter ───────────────────────────────────────────────────────────────

describe('reactAdapter.fileFilter', () => {
  it.each(['src/Button.tsx', 'src/App.jsx', 'components/Modal.tsx', 'pages/Home.jsx'])(
    'matches %s',
    (filePath) => expect(reactAdapter.fileFilter(filePath)).toBe(true),
  );

  it.each(['src/utils.ts', 'src/types.ts', 'src/Button.vue', 'src/app.js', 'src/styles.css'])(
    'does not match %s',
    (filePath) => expect(reactAdapter.fileFilter(filePath)).toBe(false),
  );
});

// ─── detect ───────────────────────────────────────────────────────────────────

describe('reactAdapter.detect', () => {
  it('returns true when package.json has react in dependencies', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      expect(await reactAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when react is in devDependencies', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ devDependencies: { react: '^18.0.0' } }));
      expect(await reactAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when react is absent', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
      expect(await reactAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false when no package.json exists', async () => {
    const dir = tmpDir();
    try {
      expect(await reactAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Phase 92 (Task 571) — monorepo scan
  it('returns true when a nested package.json declares react', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ private: true }));
      writeFile(dir, 'apps/web/package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      expect(await reactAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns true when the repo contains a lone .tsx file', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'src/App.tsx', 'export const x = 1;');
      expect(await reactAdapter.detect(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a pure Vue repo (no react dep anywhere, no .tsx)', async () => {
    const dir = tmpDir();
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { vue: '^3.0.0' } }));
      writeFile(dir, 'src/App.vue', '<template><div /></template>');
      writeFile(dir, 'src/composables/useFetch.ts', 'export function useFetch() {}');
      expect(await reactAdapter.detect(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── enrichMetadata — hooks ───────────────────────────────────────────────────

describe('reactAdapter.enrichMetadata — hooks', () => {
  it('upgrades useXxx function to hook', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'useAuth', kind: 'function' }));
    expect(result.kind).toBe('hook');
  });

  it('upgrades useXxx const to hook', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'useTheme', kind: 'const' }));
    expect(result.kind).toBe('hook');
  });

  it('sets react_hook: true in frameworkMeta', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'useData', kind: 'function' }));
    expect(result.frameworkMeta?.['react_hook']).toBe(true);
  });

  it('recomputes id when upgrading to hook', () => {
    const original = sym({ name: 'useAuth', kind: 'function' });
    const result = reactAdapter.enrichMetadata!(original);
    expect(result.id).not.toBe(original.id);
  });

  it('hook id is deterministic', () => {
    const s = sym({ name: 'useAuth', kind: 'function' });
    expect(reactAdapter.enrichMetadata!(s).id).toBe(reactAdapter.enrichMetadata!(s).id);
  });

  it('hooks take priority over component detection', () => {
    // 'UseMyHook' starts with uppercase but also matches hook pattern with 'Use'
    // In practice useXxx starts with lowercase, but the hook regex is /^use[A-Z]/
    // so 'useFoo' is a hook, not a component.
    const result = reactAdapter.enrichMetadata!(sym({ name: 'useCounter', kind: 'function' }));
    expect(result.kind).toBe('hook');
  });

  it('preserves existing frameworkMeta when upgrading', () => {
    const s = sym({ name: 'useAuth', kind: 'function', frameworkMeta: { existing: 'val' } });
    const result = reactAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['existing']).toBe('val');
  });
});

// ─── enrichMetadata — components ─────────────────────────────────────────────

describe('reactAdapter.enrichMetadata — components', () => {
  it('upgrades PascalCase function to component', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'Button', kind: 'function' }));
    expect(result.kind).toBe('component');
  });

  it('upgrades PascalCase const to component', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'Modal', kind: 'const' }));
    expect(result.kind).toBe('component');
  });

  it('sets react_component: true in frameworkMeta', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'Card', kind: 'function' }));
    expect(result.frameworkMeta?.['react_component']).toBe(true);
  });

  it('recomputes id when upgrading to component', () => {
    const original = sym({ name: 'Button', kind: 'function' });
    const result = reactAdapter.enrichMetadata!(original);
    expect(result.id).not.toBe(original.id);
  });

  it('component id is deterministic', () => {
    const s = sym({ name: 'Button', kind: 'function' });
    expect(reactAdapter.enrichMetadata!(s).id).toBe(reactAdapter.enrichMetadata!(s).id);
  });

  it('preserves existing frameworkMeta when upgrading to component', () => {
    const s = sym({ name: 'Button', kind: 'function', frameworkMeta: { extra: true } });
    const result = reactAdapter.enrichMetadata!(s);
    expect(result.frameworkMeta?.['extra']).toBe(true);
  });
});

// ─── enrichMetadata — no-op cases ────────────────────────────────────────────

describe('reactAdapter.enrichMetadata — no upgrade', () => {
  it('does not upgrade lowercase function names', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'formatDate', kind: 'function' }));
    expect(result.kind).toBe('function');
  });

  it('does not upgrade class symbols', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'MyClass', kind: 'class' as const }));
    expect(result.kind).toBe('class');
  });

  it('does not upgrade type symbols', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'MyType', kind: 'type' as const }));
    expect(result.kind).toBe('type');
  });

  it('does not upgrade interface symbols', () => {
    const result = reactAdapter.enrichMetadata!(sym({ name: 'MyInterface', kind: 'interface' as const }));
    expect(result.kind).toBe('interface');
  });

  it('does not upgrade already-component symbols', () => {
    const s = sym({ name: 'Button', kind: 'component' as const });
    const result = reactAdapter.enrichMetadata!(s);
    expect(result.kind).toBe('component');
    expect(result.id).toBe(s.id); // id unchanged
  });

  it('does not upgrade already-hook symbols', () => {
    const s = sym({ name: 'useAuth', kind: 'hook' as const });
    const result = reactAdapter.enrichMetadata!(s);
    expect(result.kind).toBe('hook');
    expect(result.id).toBe(s.id);
  });
});

// ─── enrichMetadata — Phase 92 path gates ────────────────────────────────────

describe('reactAdapter.enrichMetadata — Phase 92 path gates', () => {
  it('SCREAMING_CASE const in .tsx stays const (API_URL is not a component)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'API_URL', kind: 'const', filePath: 'src/config.tsx' }),
    );
    expect(result.kind).toBe('const');
  });

  it('all-caps name without lowercase stays untouched (HTTP)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'HTTP', kind: 'const', filePath: 'src/api.tsx' }),
    );
    expect(result.kind).toBe('const');
  });

  it('UIButton (leading acronym, has lowercase) in .tsx → component', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'UIButton', kind: 'function', filePath: 'src/UIButton.tsx' }),
    );
    expect(result.kind).toBe('component');
  });

  it('PascalCase function in a .ts file stays function (no repo-wide leak)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'Button', kind: 'function', filePath: 'src/Button.ts' }),
    );
    expect(result.kind).toBe('function');
  });

  it('PascalCase Go function stays function (cross-language guard)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'PushCampaignMessage', kind: 'function', filePath: 'internal/push.go' }),
    );
    expect(result.kind).toBe('function');
  });

  it('useXxx in src/hooks/*.ts → hook (hooks/ segment re-claim path)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'useAuth', kind: 'function', filePath: 'src/hooks/useAuth.ts' }),
    );
    expect(result.kind).toBe('hook');
    expect(result.frameworkMeta?.['react_hook']).toBe(true);
  });

  it('useXxx in src/utils/*.ts (no hooks/ segment) stays function', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'useAuth', kind: 'function', filePath: 'src/utils/useAuth.ts' }),
    );
    expect(result.kind).toBe('function');
  });

  it('re-claims a composable in a hooks/ .ts file and drops the vue marker', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({
        name: 'useCreateWorkflow',
        kind: 'composable' as const,
        filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts',
        frameworkMeta: { vue_composable: true },
      }),
    );
    expect(result.kind).toBe('hook');
    expect(result.frameworkMeta?.['react_hook']).toBe(true);
    expect(result.frameworkMeta?.['vue_composable']).toBeUndefined();
  });

  it('re-claims a composable in a .tsx file', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({
        name: 'useWidget',
        kind: 'composable' as const,
        filePath: 'src/components/Widget.tsx',
        frameworkMeta: { svelte_composable: true },
      }),
    );
    expect(result.kind).toBe('hook');
    expect(result.frameworkMeta?.['svelte_composable']).toBeUndefined();
  });

  it('does NOT re-claim a composable in a composables/ .ts file (Vue territory)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({
        name: 'useFetch',
        kind: 'composable' as const,
        filePath: 'apps/web/composables/useFetch.ts',
        frameworkMeta: { vue_composable: true },
      }),
    );
    expect(result.kind).toBe('composable');
    expect(result.frameworkMeta?.['vue_composable']).toBe(true);
  });

  it('useCase in a .kt file stays function (cross-language guard)', () => {
    const result = reactAdapter.enrichMetadata!(
      sym({ name: 'useCase', kind: 'function', filePath: 'app/src/main/UseCases.kt' }),
    );
    expect(result.kind).toBe('function');
  });
});

// ─── Integration — full indexing ──────────────────────────────────────────────

describe('reactAdapter — full index integration', () => {
  afterEach(() => {
    // Cleanup is done per-test with deleteIndex
  });

  it('indexes .tsx file and upgrades component/hook kinds', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      writeFile(dir, 'src/Button.tsx', `
export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}

export const useCounter = () => {
  return { count: 0 };
};

export function formatLabel(s: string) {
  return s.trim();
}
      `.trim());

      await indexFolder(dir, { adapters: [reactAdapter] });

      const db = openDatabase(repoId);
      const all = searchSymbols(db, repoId, '');
      db.close();

      const byName = Object.fromEntries(all.map((s) => [s.name, s]));

      // Button (PascalCase function) → component
      expect(byName['Button']?.kind).toBe('component');
      expect(byName['Button']?.frameworkMeta?.['react_component']).toBe(true);

      // useCounter (useXxx) → hook
      expect(byName['useCounter']?.kind).toBe('hook');
      expect(byName['useCounter']?.frameworkMeta?.['react_hook']).toBe(true);

      // formatLabel (lowercase) → stays function
      expect(byName['formatLabel']?.kind).toBe('function');
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves .ts files untouched when React adapter is active', async () => {
    const dir = tmpDir();
    const repoId = computeRepoId(dir);
    try {
      writeFile(dir, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
      // A .ts file — NOT matched by React adapter's fileFilter
      writeFile(dir, 'src/Button.ts', 'export function Button() {}');

      await indexFolder(dir, { adapters: [reactAdapter] });

      const db = openDatabase(repoId);
      const symbols = searchSymbols(db, repoId, 'Button');
      db.close();

      // Phase 92 contract: cross-adapter enrichMetadata still runs for every
      // file, but the react component upgrade is gated to .tsx/.jsx — a
      // PascalCase function in a plain .ts file stays a function. (Pre-92 the
      // enrichment was repo-wide and this test locked the bug in.)
      expect(symbols).toHaveLength(1);
      expect(symbols[0]!.kind).toBe('function');
    } finally {
      deleteIndex(repoId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
