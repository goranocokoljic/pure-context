import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerProvider,
  discoverProviders,
  getRegisteredProviders,
  _resetForTesting,
} from '../../src/providers/provider-registry.js';
import type { ContextProvider, EnrichmentResult } from '../../src/core/types.js';
import type Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(
  name: string,
  detects: boolean,
  enriched = 0,
): ContextProvider & { enrichCallCount: number } {
  const provider = {
    name,
    description: `Test provider: ${name}`,
    enrichCallCount: 0,
    async detect(_root: string): Promise<boolean> {
      return detects;
    },
    async enrich(_repoId: string, _root: string, _db: Database): Promise<EnrichmentResult> {
      provider.enrichCallCount++;
      return { symbolsEnriched: enriched, metadataAdded: {} };
    },
  };
  return provider;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('provider-registry', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe('registerProvider / getRegisteredProviders', () => {
    it('starts empty', () => {
      expect(getRegisteredProviders()).toHaveLength(0);
    });

    it('registers and retrieves providers', () => {
      registerProvider(makeProvider('dbt', true));
      registerProvider(makeProvider('terraform', false));
      expect(getRegisteredProviders()).toHaveLength(2);
      expect(getRegisteredProviders().map((p) => p.name)).toEqual(['dbt', 'terraform']);
    });

    it('overwrites on re-register with the same name', () => {
      registerProvider(makeProvider('dbt', true));
      registerProvider(makeProvider('dbt', false));
      expect(getRegisteredProviders()).toHaveLength(1);
    });
  });

  describe('discoverProviders', () => {
    it('returns empty array when registry is empty', async () => {
      const result = await discoverProviders('/some/project');
      expect(result).toHaveLength(0);
    });

    it('includes providers whose detect() returns true', async () => {
      registerProvider(makeProvider('dbt', true));
      registerProvider(makeProvider('terraform', false));
      const active = await discoverProviders('/some/project');
      expect(active.map((p) => p.name)).toEqual(['dbt']);
    });

    it('excludes providers whose detect() returns false', async () => {
      registerProvider(makeProvider('no-match', false));
      const active = await discoverProviders('/some/project');
      expect(active).toHaveLength(0);
    });

    it('skips providers when enabled is false in config', async () => {
      registerProvider(makeProvider('dbt', true));
      const active = await discoverProviders('/some/project', { dbt: { enabled: false } });
      expect(active).toHaveLength(0);
    });

    it('force-enables providers when enabled is true in config (skips detect())', async () => {
      const provider = makeProvider('terraform', false); // detect() returns false
      const detectSpy = vi.spyOn(provider, 'detect');
      registerProvider(provider);
      const active = await discoverProviders('/some/project', { terraform: { enabled: true } });
      expect(active).toHaveLength(1);
      expect(detectSpy).not.toHaveBeenCalled();
    });

    it('does not abort when detect() throws — logs warn and continues', async () => {
      const broken: ContextProvider = {
        name: 'broken',
        description: 'throws on detect',
        async detect() { throw new Error('detect failed'); },
        async enrich() { return { symbolsEnriched: 0, metadataAdded: {} }; },
      };
      const good = makeProvider('good', true);
      registerProvider(broken);
      registerProvider(good);
      const active = await discoverProviders('/some/project');
      expect(active.map((p) => p.name)).toEqual(['good']);
    });
  });

  describe('provider idempotency', () => {
    it('calling enrich() twice on the same provider returns consistent results', async () => {
      const provider = makeProvider('dbt', true, 5);
      registerProvider(provider);

      const db = {} as Database;
      const r1 = await provider.enrich('repo1', '/root', db);
      const r2 = await provider.enrich('repo1', '/root', db);

      expect(r1.symbolsEnriched).toBe(5);
      expect(r2.symbolsEnriched).toBe(5);
      expect(provider.enrichCallCount).toBe(2);
    });
  });

  describe('provider failure isolation', () => {
    it('a throwing enrich() does not break the provider contract', async () => {
      const bad: ContextProvider = {
        name: 'bad-enrich',
        description: 'throws on enrich',
        async detect() { return true; },
        async enrich() { throw new Error('enrich failed'); },
      };
      registerProvider(bad);
      const active = await discoverProviders('/some/project');
      expect(active).toHaveLength(1);
      // enrich() throws — caller (index-manager) should catch this
      await expect(active[0]!.enrich('r', '/p', {} as Database)).rejects.toThrow('enrich failed');
    });
  });
});
