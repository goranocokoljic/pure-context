/**
 * Phase 92 (Task 572) — hook/component kind hints, frontend-vocab fix, and
 * broadened mixed-monorepo detection.
 */

import { describe, it, expect } from 'vitest';
import {
  rankSymbols,
  hasFrontendVocabQuery,
  isFrontendAppPath,
} from '../../src/core/search/relevance-ranker.js';
import { hasReactHookQuery, detectMixedMonorepo } from '../../src/server/tools/search-symbols.js';
import type { SymbolRecord } from '../../src/core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary'>> = {},
): SymbolRecord {
  return {
    id: `id-${name}-${opts.kind ?? 'function'}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `function ${name}()`,
    summary: opts.summary ?? `Does ${name}`,
  };
}

// ─── 572a — hook / component kind hints ──────────────────────────────────────

describe('Phase 92 — hook/component kind hints', () => {
  it('"hook" query prefers a hook-kind symbol over a same-word method', () => {
    const results = rankSymbols(
      [
        sym('WorkflowService.createWorkflow', {
          kind: 'method',
          summary: 'Creates a workflow',
        }),
        sym('useCreateWorkflow', {
          kind: 'hook',
          filePath: 'apps/dashboard/src/hooks/useCreateWorkflow.ts',
          summary: 'Hook to create a workflow',
        }),
      ],
      'hook that creates a workflow',
    );
    expect(results[0]!.symbol.name).toBe('useCreateWorkflow');
  });

  it('"composable" query gets the same treatment (alias symmetry)', () => {
    const results = rankSymbols(
      [
        sym('FetchService.fetchUser', { kind: 'method', summary: 'Fetches user data' }),
        sym('useFetchUser', {
          kind: 'composable',
          filePath: 'composables/useFetchUser.ts',
          summary: 'Composable that fetches user data',
        }),
      ],
      'composable that fetches user data',
    );
    expect(results[0]!.symbol.name).toBe('useFetchUser');
  });

  it('"component" query gets NO kind hint (reverted in-phase: Vue factory-function queries)', () => {
    // A query like "factory function that imports the Vue component" targets a
    // FUNCTION — a +35 component hint pushed real components above it
    // (kurirfe gt-23/gt-24). The component hint was measured and reverted.
    const results = rankSymbols(
      [
        sym('LazyArticleElement', { kind: 'component', summary: 'Lazy article component' }),
        sym('factoryComponent', { kind: 'function', summary: 'Loads the correct layout component' }),
      ],
      'factory component',
      true,
    );
    for (const r of results) {
      expect(r.debugScore?.kindHintBoost).toBe(0);
    }
  });

  it('negative side is pool-gated: no penalty when the pool has no hook kinds', () => {
    // Backend repo where "hook" means webhook — methods must not be penalized.
    const withHookWord = rankSymbols(
      [sym('WebhookService.processHook', { kind: 'method', summary: 'Processes a webhook' })],
      'process incoming hook payload',
      true,
    );
    expect(withHookWord[0]!.debugScore?.kindHintBoost).toBe(0);
  });

  it('negative side fires when the pool DOES contain hook kinds', () => {
    const results = rankSymbols(
      [
        sym('HookService.runHook', { kind: 'method', summary: 'Runs a hook' }),
        sym('useRunHook', { kind: 'hook', summary: 'Hook to run hooks' }),
      ],
      'hook that runs',
      true,
    );
    const method = results.find((r) => r.symbol.kind === 'method');
    expect(method?.debugScore?.kindHintBoost).toBe(-20);
  });

  it('component identityExact is scaled on multi-word queries (infisical gt-22 shape)', () => {
    // 'Organization' components must not displace the asked-for fetch function
    // just because one query word matches their name.
    const results = rankSymbols(
      [
        sym('Organization', {
          kind: 'component',
          filePath: 'frontend/src/pages/Organization.tsx',
          summary: 'Organization page component',
        }),
        sym('fetchOrganizationsWithSubOrgs', {
          kind: 'function',
          filePath: 'frontend/src/hooks/api/organization/queries.ts',
          summary: 'Fetch all user organizations and sub-organizations',
        }),
      ],
      'fetch all user organizations and sub-organizations',
      true,
    );
    expect(results[0]!.symbol.name).toBe('fetchOrganizationsWithSubOrgs');
    const comp = results.find((r) => r.symbol.kind === 'component');
    expect(comp?.debugScore?.identityExact).toBeLessThanOrEqual(10);
  });

  it('existing kind hints still win (a "class" query is untouched)', () => {
    const results = rankSymbols(
      [sym('Parser', { kind: 'class' }), sym('parse', { kind: 'function' })],
      'parser class',
      true,
    );
    const cls = results.find((r) => r.symbol.kind === 'class');
    expect(cls?.debugScore?.kindHintBoost).toBe(35);
  });
});

// ─── 572b — frontend vocab false positives ───────────────────────────────────

describe('Phase 92 — hasFrontendVocabQuery', () => {
  it.each(['useAuth login state', 'component for settings', 'vue composable for fetch', 'react hook'])(
    'fires on %s',
    (q) => expect(hasFrontendVocabQuery(q)).toBe(true),
  );

  it.each(['find the user record', 'disk usage report', 'useful helper for parsing', 'update user profile'])(
    'does NOT fire on %s',
    (q) => expect(hasFrontendVocabQuery(q)).toBe(false),
  );
});

// ─── 572c — broadened frontend/mixed-monorepo detection ──────────────────────

describe('Phase 92 — isFrontendAppPath / detectMixedMonorepo', () => {
  it.each([
    'apps/dashboard/src/hooks/useX.ts',   // novu
    'apps/web/pages/index.tsx',           // cal.com
    'frontend/src/hooks/useX.ts',         // infisical
    'client/src/App.tsx',
  ])('frontend path: %s', (p) => expect(isFrontendAppPath(p)).toBe(true));

  it.each([
    'src/api/client.ts',        // deep incidental api folder — not frontend
    'packages/core/src/web.ts', // 'web' as a filename, not a leading segment
    'apps/api/src/main.ts',
  ])('not a frontend path: %s', (p) => expect(isFrontendAppPath(p)).toBe(false));

  it('detects infisical shape (frontend/ + backend/)', () => {
    expect(
      detectMixedMonorepo([
        sym('useX', { filePath: 'frontend/src/hooks/useX.ts' }),
        sym('createUser', { filePath: 'backend/src/services/user.ts' }),
      ]),
    ).toBe(true);
  });

  it('detects cal.com shape (apps/web/ + packages/trpc/)', () => {
    expect(
      detectMixedMonorepo([
        sym('useX', { filePath: 'apps/web/hooks/useX.ts' }),
        sym('router', { filePath: 'packages/trpc/server/routers/user.ts' }),
      ]),
    ).toBe(true);
  });

  it('still detects the original novu shape (apps/dashboard/ + apps/api/)', () => {
    expect(
      detectMixedMonorepo([
        sym('useX', { filePath: 'apps/dashboard/src/hooks/useX.ts' }),
        sym('svc', { filePath: 'apps/api/src/app.service.ts' }),
      ]),
    ).toBe(true);
  });

  it('a pure frontend repo with a deep src/api folder is NOT mixed', () => {
    expect(
      detectMixedMonorepo([
        sym('useX', { filePath: 'client/src/hooks/useX.ts' }),
        sym('api', { filePath: 'client/src/api/http.ts' }),
      ]),
    ).toBe(false);
  });
});

// ─── V-11 — composable in hasReactHookQuery ──────────────────────────────────

describe('Phase 92 — hasReactHookQuery composable extension', () => {
  it('fires on "composable that fetches user data"', () => {
    expect(hasReactHookQuery('composable that fetches user data')).toBe(true);
  });

  it('fires on "composables"', () => {
    expect(hasReactHookQuery('list all composables')).toBe(true);
  });

  it('still fires on hook queries', () => {
    expect(hasReactHookQuery('hook for auth state')).toBe(true);
  });

  it('does not fire on unrelated queries', () => {
    expect(hasReactHookQuery('parse the config file')).toBe(false);
  });
});
