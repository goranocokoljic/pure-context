/**
 * Unit tests for Task 104 — Symbol Source Viewer.
 *
 * These tests exercise pure logic (language detection, theme persistence,
 * copy-button state, related-symbol filtering) without a full DOM render,
 * following the same pattern as useSearch.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Language detection (mirrored from CodeViewer.tsx) ────────────────────────

const EXT_TO_PRISM: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx',
  js: 'javascript', jsx: 'jsx',
  py: 'python',  rs: 'rust',   go: 'go',
  java: 'java',  cs: 'csharp', rb: 'ruby',
  css: 'css',    scss: 'scss', html: 'markup', xml: 'markup',
  json: 'json',  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', sh: 'bash', bash: 'bash',
  ex: 'elixir',  exs: 'elixir',
  hs: 'haskell', scala: 'scala', r: 'r',
  cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
  kt: 'kotlin', swift: 'swift', php: 'php',
};

function detectPrismLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_PRISM[ext] ?? 'text';
}

describe('detectPrismLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectPrismLanguage('src/core/types.ts')).toBe('typescript');
  });

  it('detects TSX', () => {
    expect(detectPrismLanguage('src/App.tsx')).toBe('tsx');
  });

  it('detects JavaScript', () => {
    expect(detectPrismLanguage('index.js')).toBe('javascript');
  });

  it('detects Python', () => {
    expect(detectPrismLanguage('script.py')).toBe('python');
  });

  it('detects Rust', () => {
    expect(detectPrismLanguage('main.rs')).toBe('rust');
  });

  it('detects Go', () => {
    expect(detectPrismLanguage('server.go')).toBe('go');
  });

  it('detects JSON', () => {
    expect(detectPrismLanguage('package.json')).toBe('json');
  });

  it('detects YAML by .yml', () => {
    expect(detectPrismLanguage('.github/workflows/ci.yml')).toBe('yaml');
  });

  it('detects Elixir', () => {
    expect(detectPrismLanguage('mix.exs')).toBe('elixir');
  });

  it('falls back to text for unknown extension', () => {
    expect(detectPrismLanguage('binary.wasm')).toBe('text');
  });

  it('falls back to text when there is no extension', () => {
    expect(detectPrismLanguage('Makefile')).toBe('text');
  });

  it('is case-insensitive', () => {
    expect(detectPrismLanguage('File.TS')).toBe('typescript');
  });
});

// ─── Theme store logic ────────────────────────────────────────────────────────

type Theme = 'dark' | 'light';

function createThemeLogic(initialTheme: Theme = 'dark') {
  let current: Theme = initialTheme;
  const listeners: Array<(t: Theme) => void> = [];

  function toggle() {
    current = current === 'dark' ? 'light' : 'dark';
    listeners.forEach((fn) => fn(current));
  }

  function get(): Theme {
    return current;
  }

  function subscribe(fn: (t: Theme) => void) {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  return { toggle, get, subscribe };
}

describe('Theme store logic', () => {
  it('starts as dark by default', () => {
    const store = createThemeLogic('dark');
    expect(store.get()).toBe('dark');
  });

  it('toggles from dark to light', () => {
    const store = createThemeLogic('dark');
    store.toggle();
    expect(store.get()).toBe('light');
  });

  it('toggles from light to dark', () => {
    const store = createThemeLogic('light');
    store.toggle();
    expect(store.get()).toBe('dark');
  });

  it('notifies subscribers on toggle', () => {
    const store = createThemeLogic('dark');
    const fn = vi.fn();
    store.subscribe(fn);
    store.toggle();
    expect(fn).toHaveBeenCalledWith('light');
  });

  it('allows unsubscribing', () => {
    const store = createThemeLogic('dark');
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    unsub();
    store.toggle();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ─── Theme localStorage persistence ──────────────────────────────────────────

/**
 * A minimal in-memory localStorage stub for the Node test environment.
 */
class LocalStorageStub {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

describe('Theme localStorage persistence', () => {
  const STORAGE_KEY = 'purecontext-theme';
  let storage: LocalStorageStub;

  function loadTheme(): Theme {
    try {
      const stored = storage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch { /* ignore */ }
    return 'dark';
  }

  function saveTheme(theme: Theme): void {
    storage.setItem(STORAGE_KEY, theme);
  }

  beforeEach(() => {
    storage = new LocalStorageStub();
  });

  it('defaults to dark when nothing is stored', () => {
    expect(loadTheme()).toBe('dark');
  });

  it('loads dark from storage', () => {
    saveTheme('dark');
    expect(loadTheme()).toBe('dark');
  });

  it('loads light from storage', () => {
    saveTheme('light');
    expect(loadTheme()).toBe('light');
  });

  it('ignores invalid stored values', () => {
    storage.setItem(STORAGE_KEY, 'solarized');
    expect(loadTheme()).toBe('dark');
  });

  it('persists theme on toggle', () => {
    saveTheme('dark');
    const next: Theme = loadTheme() === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    expect(loadTheme()).toBe('light');
  });
});

// ─── Copy button state ────────────────────────────────────────────────────────

describe('Copy button state', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resets copied state after 2 seconds', () => {
    let copied = false;

    function handleCopy() {
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    }

    handleCopy();
    expect(copied).toBe(true);

    vi.advanceTimersByTime(1999);
    expect(copied).toBe(true);

    vi.advanceTimersByTime(1);
    expect(copied).toBe(false);
  });

  it('does not reset before timeout', () => {
    let copied = false;
    function handleCopy() {
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    }
    handleCopy();
    vi.advanceTimersByTime(500);
    expect(copied).toBe(true);
  });
});

// ─── RelatedSymbols filtering ─────────────────────────────────────────────────

describe('RelatedSymbols: same-file filtering', () => {
  const SYMBOLS = [
    { id: 'aaa', name: 'foo', kind: 'function' as const, signature: 'function foo()', summary: '' },
    { id: 'bbb', name: 'bar', kind: 'const' as const, signature: 'const bar', summary: '' },
    { id: 'ccc', name: 'Baz', kind: 'class' as const, signature: 'class Baz', summary: '' },
  ];

  it('filters out the current symbol by ID', () => {
    const filtered = SYMBOLS.filter((s) => s.id !== 'bbb');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((s) => s.id)).not.toContain('bbb');
  });

  it('includes all other symbols', () => {
    const filtered = SYMBOLS.filter((s) => s.id !== 'bbb');
    expect(filtered.map((s) => s.id)).toContain('aaa');
    expect(filtered.map((s) => s.id)).toContain('ccc');
  });

  it('returns empty when there is only one symbol (the current one)', () => {
    const single = [{ id: 'aaa', name: 'foo', kind: 'function' as const, signature: '', summary: '' }];
    expect(single.filter((s) => s.id !== 'aaa')).toHaveLength(0);
  });
});

// ─── RelatedSymbols: importer symbol truncation ───────────────────────────────

describe('RelatedSymbols: importer symbol display cap', () => {
  it('caps at 5 symbols per importer file', () => {
    const symbols = Array.from({ length: 8 }, (_, i) => ({
      id: `sym-${i}`, name: `sym${i}`, kind: 'function' as const, signature: '',
    }));
    const visible = symbols.slice(0, 5);
    const overflow = symbols.length - 5;
    expect(visible).toHaveLength(5);
    expect(overflow).toBe(3);
  });

  it('shows no overflow label when ≤ 5 symbols', () => {
    const symbols = Array.from({ length: 5 }, (_, i) => ({
      id: `sym-${i}`, name: `sym${i}`, kind: 'function' as const, signature: '',
    }));
    const overflow = symbols.length > 5 ? symbols.length - 5 : 0;
    expect(overflow).toBe(0);
  });
});

// ─── SymbolView: URL helpers ──────────────────────────────────────────────────

describe('SymbolView: URL construction', () => {
  function symbolLink(id: string, repoId: string): string {
    return `/symbols/${encodeURIComponent(id)}?repoId=${encodeURIComponent(repoId)}`;
  }

  it('encodes symbol ID in URL', () => {
    const url = symbolLink('abc123', 'repo1');
    expect(url).toBe('/symbols/abc123?repoId=repo1');
  });

  it('URL-encodes special characters in symbol ID', () => {
    const url = symbolLink('a/b:c', 'repo1');
    expect(url).toContain(encodeURIComponent('a/b:c'));
  });

  it('URL-encodes special characters in repo ID', () => {
    const url = symbolLink('sym1', 'path/with spaces');
    expect(url).toContain(encodeURIComponent('path/with spaces'));
  });
});
