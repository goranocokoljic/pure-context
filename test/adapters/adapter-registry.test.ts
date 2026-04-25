import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAdapter,
  getRegisteredAdapters,
  discoverAdapters,
  getAdapterExtensions,
  _resetForTesting,
} from '../../src/adapters/adapter-registry.js';
import type { FrameworkAdapter } from '../../src/core/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAdapter(
  name: string,
  exts: string[] = [],
  detected = true,
): FrameworkAdapter {
  return {
    name,
    extensions: () => exts,
    detect: vi.fn().mockResolvedValue(detected),
    fileFilter: () => false,
    extractFrameworkSymbols: () => [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('adapter-registry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  // ── Registration ────────────────────────────────────────────────────────────

  it('getRegisteredAdapters returns empty array initially', () => {
    expect(getRegisteredAdapters()).toEqual([]);
  });

  it('registerAdapter makes adapter retrievable', () => {
    const a = makeAdapter('vue');
    registerAdapter(a);
    expect(getRegisteredAdapters()).toContain(a);
  });

  it('registerAdapter with same name overwrites previous', () => {
    const a1 = makeAdapter('vue');
    const a2 = makeAdapter('vue');
    registerAdapter(a1);
    registerAdapter(a2);
    const all = getRegisteredAdapters();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(a2);
  });

  it('preserves registration order for different adapters', () => {
    const a1 = makeAdapter('vue');
    const a2 = makeAdapter('nuxt');
    const a3 = makeAdapter('react');
    registerAdapter(a1);
    registerAdapter(a2);
    registerAdapter(a3);
    expect(getRegisteredAdapters()).toEqual([a1, a2, a3]);
  });

  // ── discoverAdapters — 'none' ───────────────────────────────────────────────

  it("returns [] when adapters config is 'none'", async () => {
    registerAdapter(makeAdapter('vue'));
    const result = await discoverAdapters('/project', { adapters: 'none' });
    expect(result).toEqual([]);
  });

  // ── discoverAdapters — 'auto' ───────────────────────────────────────────────

  it("auto mode activates adapters whose detect() returns true", async () => {
    const active = makeAdapter('vue', [], true);
    const inactive = makeAdapter('nuxt', [], false);
    registerAdapter(active);
    registerAdapter(inactive);
    const result = await discoverAdapters('/project', { adapters: 'auto' });
    expect(result).toEqual([active]);
  });

  it("auto mode calls detect() on all registered adapters", async () => {
    const a1 = makeAdapter('vue', [], true);
    const a2 = makeAdapter('nuxt', [], true);
    registerAdapter(a1);
    registerAdapter(a2);
    await discoverAdapters('/project', { adapters: 'auto' });
    expect(a1.detect).toHaveBeenCalledWith('/project');
    expect(a2.detect).toHaveBeenCalledWith('/project');
  });

  it('auto mode skips adapters whose detect() throws', async () => {
    const bad = makeAdapter('bad');
    (bad.detect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const good = makeAdapter('good', [], true);
    registerAdapter(bad);
    registerAdapter(good);
    const result = await discoverAdapters('/project', { adapters: 'auto' });
    expect(result).toEqual([good]);
  });

  it('auto mode returns [] when no adapters are registered', async () => {
    const result = await discoverAdapters('/project', { adapters: 'auto' });
    expect(result).toEqual([]);
  });

  // ── discoverAdapters — named list ──────────────────────────────────────────

  it('named list activates only listed adapters without calling detect()', async () => {
    const a1 = makeAdapter('vue');
    const a2 = makeAdapter('nuxt');
    registerAdapter(a1);
    registerAdapter(a2);
    const result = await discoverAdapters('/project', { adapters: ['vue'] });
    expect(result).toEqual([a1]);
    expect(a1.detect).not.toHaveBeenCalled();
    expect(a2.detect).not.toHaveBeenCalled();
  });

  it('named list skips names that are not registered (with warning)', async () => {
    const a = makeAdapter('vue');
    registerAdapter(a);
    const result = await discoverAdapters('/project', { adapters: ['vue', 'unknown'] });
    expect(result).toEqual([a]);
  });

  it('named list returns [] when none of the listed adapters are registered', async () => {
    const result = await discoverAdapters('/project', { adapters: ['nope'] });
    expect(result).toEqual([]);
  });

  // ── getAdapterExtensions ────────────────────────────────────────────────────

  it('returns empty array for no adapters', () => {
    expect(getAdapterExtensions([])).toEqual([]);
  });

  it('aggregates extensions from multiple adapters', () => {
    const a1 = makeAdapter('vue', ['.vue']);
    const a2 = makeAdapter('svelte', ['.svelte']);
    const exts = getAdapterExtensions([a1, a2]).sort();
    expect(exts).toEqual(['.svelte', '.vue']);
  });

  it('deduplicates extensions across adapters', () => {
    const a1 = makeAdapter('vue', ['.vue', '.ts']);
    const a2 = makeAdapter('nuxt', ['.vue', '.ts']);
    expect(getAdapterExtensions([a1, a2])).toHaveLength(2);
  });

  it('normalises extensions to lowercase', () => {
    const a = makeAdapter('vue', ['.VUE', '.Vue']);
    expect(getAdapterExtensions([a])).toEqual(['.vue']);
  });

  // ── _resetForTesting ────────────────────────────────────────────────────────

  it('_resetForTesting clears all registrations', () => {
    registerAdapter(makeAdapter('vue'));
    _resetForTesting();
    expect(getRegisteredAdapters()).toHaveLength(0);
  });
});
