/**
 * Phase 95 — generic-verb identity, global.
 *
 * Task 592: the Phase-88 generic-verb identityExact ×⅓ scaling loses its
 * isJavaGroovyMixed gate and becomes global (trigger evidence: nestjs gt-03,
 * nuxt gt-03/09/24, origamicms gt-08/16/18/22 — see
 * dev-docs/in-progress/phase95-margins.md).
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(
  name: string,
  opts: Partial<
    Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary' | 'frameworkMeta'>
  > = {},
): SymbolRecord {
  return {
    id: `id-${name}-${opts.filePath ?? 'x'}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `${name}`,
    summary: opts.summary ?? '',
    ...(opts.frameworkMeta ? { frameworkMeta: opts.frameworkMeta } : {}),
  };
}

describe('Phase 95 Task 592 — un-gated generic-verb identity scaling', () => {
  it('scales a bare generic name to ⅓ identity in a TS pool (no Java gate needed)', () => {
    const results = rankSymbols(
      [sym('build', { filePath: 'packages/nuxt/src/core/builder.ts' })],
      'trigger the complete build pipeline programmatically',
      true,
    );
    expect(results[0]!.debugScore!.identityExact).toBe(20);
  });

  it('scales the Phase-95 set additions: handler in a Go pool', () => {
    const results = rankSymbols(
      [sym('handler', { filePath: 'internal/http/handler.go' })],
      'register a server event handler for a route',
      true,
    );
    expect(results[0]!.debugScore!.identityExact).toBe(20);
  });

  it('scales save in a PHP pool', () => {
    const results = rankSymbols(
      [sym('save', { filePath: 'application/models/Article.php' })],
      'save the updated article configuration record',
      true,
    );
    expect(results[0]!.debugScore!.identityExact).toBe(20);
  });

  it('does NOT scale on short queries (1–2 words) that genuinely target the name', () => {
    const results = rankSymbols(
      [sym('build', { filePath: 'src/core/builder.ts' })],
      'build pipeline',
      true,
    );
    expect(results[0]!.debugScore!.identityExact).toBe(60);
  });

  it('⅓ not zero: a generic name still wins when competitors carry no identity', () => {
    const results = rankSymbols(
      [
        sym('run', { filePath: 'src/task/runner.ts' }),
        sym('unrelatedHelper', { filePath: 'src/util/misc.ts' }),
      ],
      'run the scheduled task worker now',
    );
    expect(results[0]!.symbol.name).toBe('run');
  });

  it('R1: no double application under an explicit Java/Groovy gate', () => {
    const results = rankSymbols(
      [sym('run', { kind: 'method', filePath: 'core/src/main/java/hudson/model/Run.java' })],
      'set the result status of a build run',
      true,
      undefined,
      { isJavaGroovyMixed: true },
    );
    // Exactly one ÷3: 60 → 20, never 60 → 20 → 7.
    expect(results[0]!.debugScore!.identityExact).toBe(20);
  });

  it('593: the compound-named target outranks the bare generic when all its parts are in the query', () => {
    const results = rankSymbols(
      [
        sym('handler', { filePath: 'packages/nitro/src/runtime/middleware/no-ssr.ts' }),
        sym('addServerHandler', {
          filePath: 'packages/kit/src/nitro.ts',
          signature: 'function addServerHandler(handler: ServerHandler): void',
        }),
      ],
      'add a server handler for incoming route requests',
      true,
    );
    expect(results[0]!.symbol.name).toBe('addServerHandler');
    expect(results[0]!.debugScore!.camelCompoundBoost).toBe(30);
  });

  it('593: no boost when the pool has no bare generic competitor (listmonk/kurirfe shape)', () => {
    // "delete subscribers that have no list memberships" — DeleteSubscribers
    // is a subset-compound of the query; without a bare generic in the pool
    // it must NOT collect the +30 counterweight that displaced the more
    // specific DeleteOrphanSubscribers in the first 593 measurement.
    const results = rankSymbols(
      [
        sym('DeleteSubscribers', { filePath: 'cmd/subscribers.go' }),
        sym('DeleteOrphanSubscribers', { filePath: 'cmd/subscribers.go' }),
      ],
      'delete subscribers that have no list memberships',
      true,
    );
    for (const r of results) {
      expect(r.debugScore!.camelCompoundBoost).toBe(0);
    }
  });

  it('593: methods never get the global counterweight even with a scaled generic in pool', () => {
    // listmonk gt-22 shape: bare generic `delete` present and scaled; the
    // Go bare-named METHOD DeleteSubscriber must not collect +30 (methods
    // carry their own layer boosts) — only function/const compounds qualify.
    const results = rankSymbols(
      [
        sym('delete', { filePath: 'internal/core/helpers.go' }),
        sym('DeleteSubscriber', { kind: 'method', filePath: 'internal/manager/manager.go' }),
        sym('deleteRecord', { filePath: 'internal/core/records.go' }),
      ],
      'delete all stored data for a subscriber record',
      true,
    );
    const method = results.find((r) => r.symbol.name === 'DeleteSubscriber')!;
    expect(method.debugScore!.camelCompoundBoost).toBe(0);
    const fn = results.find((r) => r.symbol.name === 'deleteRecord')!;
    expect(fn.debugScore!.camelCompoundBoost).toBe(30);
  });

  it('594: a framework member matching only via a generic word is damped', () => {
    // origamicms gt-18 shape: the vue lifecycle member's only member-segment
    // match is "updated" (generic family). Compare word overlap with and
    // without the framework meta — the qualifier damp contributes nothing
    // here (document/type are not query words), so the delta is pure 594.
    const query = 'persist updated headbox configuration back to the server';
    const withMeta = rankSymbols(
      [
        sym('documentType.updated', {
          kind: 'method',
          filePath: 'vue/src/pages/categoryLock/category-lock.vue',
          frameworkMeta: { vue_options: 'lifecycle' },
        }),
      ],
      query,
      true,
    )[0]!.debugScore!.wordOverlap;
    const withoutMeta = rankSymbols(
      [
        sym('documentType.updated', {
          kind: 'method',
          filePath: 'vue/src/pages/categoryLock/category-lock.vue',
        }),
      ],
      query,
      true,
    )[0]!.debugScore!.wordOverlap;
    expect(withMeta).toBeLessThan(withoutMeta);
  });

  it('594: a member with a non-generic member match is untouched (kurirfe R4 case)', () => {
    const query = 'set the theme color for the site';
    const mk = (frameworkMeta?: Record<string, unknown>) =>
      rankSymbols(
        [
          sym('useThemeStore.setThemeColor', {
            kind: 'method',
            filePath: 'src/stores/theme.js',
            ...(frameworkMeta ? { frameworkMeta } : {}),
          }),
        ],
        query,
        true,
      )[0]!.debugScore!.wordOverlap;
    expect(mk({ pinia_entry: 'action' })).toBe(mk());
  });

  it('594: the compound function wins the origamicms gt-18 pool shape end-to-end', () => {
    const query = 'persist updated headbox configuration back to the server';
    const results = rankSymbols(
      [
        sym('save', { filePath: 'vue/src/pages/headbox/headbox-editor.vue' }),
        sym('documentType.updated', {
          kind: 'method',
          filePath: 'vue/src/pages/categoryLock/category-lock.vue',
          frameworkMeta: { vue_options: 'lifecycle' },
        }),
        sym('saveHeadbox', { filePath: 'vue/src/api/headbox/save-headbox.js' }),
      ],
      query,
    );
    expect(results[0]!.symbol.name).toBe('saveHeadbox');
  });

  it('593: camelCompoundBoost never stacks with compoundUnderscoreBoost or identityExact', () => {
    const underscore = rankSymbols(
      [sym('save_headbox', { filePath: 'vue/src/api/save-headbox.js' })],
      'save the headbox configuration record now',
      true,
    )[0]!.debugScore!;
    expect(underscore.compoundUnderscoreBoost).toBe(30);
    expect(underscore.camelCompoundBoost).toBe(0);

    const generic = rankSymbols(
      [sym('save', { filePath: 'vue/src/pages/editor.vue' })],
      'save the headbox configuration record now',
      true,
    )[0]!.debugScore!;
    expect(generic.identityExact).toBeGreaterThan(0);
    expect(generic.camelCompoundBoost).toBe(0);
  });
});
