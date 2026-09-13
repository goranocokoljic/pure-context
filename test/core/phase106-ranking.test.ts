/**
 * Phase 106 — Regression Guard + Hold-Out Discipline + the Global One-Word Identity Rule.
 *
 *   659  the `visibility: 'private'` −20 is gated to Elixir + C/C++ files (the excalidraw
 *        bisect: TypeScript / Java / Scala / Kotlin / C# record the modifier too)
 *   660  one-word identity damp is global: kinds function / method / const / property, one
 *        name part, ≥8 queryWords → identityExact ÷3; type definitions exempt; Perl exempt
 *   662  SQL `CREATE TABLE` / OpenAPI schema rows are data definitions — only when the pool
 *        also holds code symbols (`poolHasCodeSymbols`)
 *   661  test-name packing penalty: measured and REVERTED (no test — nothing to assert)
 * Findings: dev-docs/in-progress/phase106-findings.md
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary' | 'frameworkMeta'>> = {},
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

// 8 raw words → well above the ≥8 queryWords gate once stems/synonyms are added
const LONG_QUERY = 'restore snapshot contents beneath a chosen destination directory on disk';

describe('Phase 106 Task 660 — the global one-word identity damp', () => {
  it('scales a one-word Go method named by one context word to ⅓ on a long query', () => {
    const [r] = rankSymbols(
      [sym('Snapshot', { kind: 'method', filePath: 'internal/restorer/restorer.go', signature: 'func (res *Restorer) Snapshot() *restic.Snapshot' })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(20);
  });

  it('closes most of the gap to the compound-named target (the rest is BM25 in a real pool: restic RestoreTo 12 → 3)', () => {
    const results = rankSymbols(
      [
        sym('Snapshot', { kind: 'method', filePath: 'internal/restorer/restorer.go', signature: 'func (res *Restorer) Snapshot() *restic.Snapshot' }),
        sym('RestoreTo', { kind: 'method', filePath: 'internal/restorer/restorer.go', signature: 'func (res *Restorer) RestoreTo(ctx context.Context, dst string) error', summary: 'restores the snapshot contents to the destination directory' }),
      ],
      LONG_QUERY,
      true,
    );
    const snapshot = results.find((r) => r.symbol.name === 'Snapshot')!;
    const restoreTo = results.find((r) => r.symbol.name === 'RestoreTo')!;
    // 60 − 20 = 40 points of the old margin are gone; what is left is wordOverlap parity.
    expect(snapshot.debugScore!.identityExact).toBe(20);
    expect(snapshot.score - restoreTo.score).toBeLessThan(20);
  });

  it('keeps the full identity for a one-word TYPE named by the query', () => {
    const [r] = rankSymbols(
      [sym('Snapshot', { kind: 'class', filePath: 'internal/restic/snapshot.go', signature: 'type Snapshot struct' })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('keeps the full identity for a one-word member on a short query (Phase 46 Builder/Mutex ordering)', () => {
    const [r] = rankSymbols(
      [sym('snapshot', { kind: 'method', filePath: 'internal/restorer/restorer.go' })],
      'snapshot accessor',
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('does not damp a compound name (two name parts)', () => {
    const [r] = rankSymbols(
      [sym('restoreSnapshot', { kind: 'method', filePath: 'src/restore.ts' })],
      'restoreSnapshot ' + LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('exempts Erlang functions (module:name/arity — the module carries the noun)', () => {
    const [r] = rankSymbols(
      [sym('exists', { kind: 'function', filePath: 'deps/rabbit/src/rabbit_vhost.erl', signature: 'exists(VHost) -> boolean()' })],
      'check whether a virtual host exists in the running broker cluster',
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('exempts Perl subs (a package interface is one-word subs by convention)', () => {
    const [r] = rankSymbols(
      [sym('forward', { kind: 'function', filePath: 'lib/Catalyst.pm', signature: 'sub forward' })],
      'forward execution to another Catalyst action or method in the request',
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });
});

describe('Phase 106 Task 659 — the private-visibility penalty is gated to Elixir + C/C++', () => {
  it('still penalizes an Elixir defp', () => {
    const [r] = rankSymbols(
      [sym('MyApp.User.sanitize', { filePath: 'lib/my_app/user.ex', frameworkMeta: { visibility: 'private' } })],
      'sanitize',
      true,
    );
    expect(r!.debugScore!.unexportedPenalty).toBe(-20);
  });

  it('still penalizes a C++ private member', () => {
    const [r] = rankSymbols(
      [sym('Widget::resize', { kind: 'method', filePath: 'src/widget.hpp', frameworkMeta: { visibility: 'private' } })],
      'resize',
      true,
    );
    expect(r!.debugScore!.unexportedPenalty).toBe(-20);
  });

  it('does NOT penalize a TypeScript private class member (the excalidraw drop)', () => {
    const [r] = rankSymbols(
      [sym('handleCanvasPointerMove', { kind: 'method', filePath: 'packages/excalidraw/components/App.tsx', frameworkMeta: { visibility: 'private' } })],
      'method that processes pointer move events on the canvas',
      true,
    );
    expect(r!.debugScore!.unexportedPenalty).toBe(0);
  });

  it('does NOT penalize a Java private method', () => {
    const [r] = rankSymbols(
      [sym('computeHash', { kind: 'method', filePath: 'core/src/main/java/hudson/Util.java', frameworkMeta: { visibility: 'private' } })],
      'compute hash',
      true,
    );
    expect(r!.debugScore!.unexportedPenalty).toBe(0);
  });
});

describe('Phase 106 Task 662 — SQL tables and OpenAPI schemas as data definitions', () => {
  const q = 'search subscribers using sql-like query expressions on the server';

  it('scales a one-word SQL table named by the query when code symbols share the pool', () => {
    const results = rankSymbols(
      [
        sym('subscribers', { kind: 'class', filePath: 'schema.sql', signature: 'CREATE TABLE subscribers', frameworkMeta: { sql_table: 'TABLE' } }),
        sym('QuerySubscribers', { kind: 'method', filePath: 'internal/core/subscribers.go', signature: 'func (c *Core) QuerySubscribers(query string) ([]models.Subscriber, error)' }),
      ],
      q,
      true,
    );
    const table = results.find((r) => r.symbol.name === 'subscribers')!;
    expect(table.debugScore!.identityExact).toBeLessThanOrEqual(10);
    expect(results[0]!.symbol.name).toBe('QuerySubscribers');
  });

  it('keeps the full identity for the table in a pure-SQL pool (the table IS the target)', () => {
    const results = rankSymbols(
      [
        sym('subscribers', { kind: 'class', filePath: 'schema.sql', signature: 'CREATE TABLE subscribers', frameworkMeta: { sql_table: 'TABLE' } }),
        sym('subscriber_lists', { kind: 'class', filePath: 'schema.sql', signature: 'CREATE TABLE subscriber_lists', frameworkMeta: { sql_table: 'TABLE' } }),
      ],
      q,
      true,
    );
    const table = results.find((r) => r.symbol.name === 'subscribers')!;
    expect(table.debugScore!.identityExact).toBe(60);
  });

  it('treats an OpenAPI schema the same way (scaled with code in the pool, whole without)', () => {
    const schema = sym('Pod', { kind: 'class', filePath: 'api/openapi-spec/swagger.json', frameworkMeta: { openapi_schema: true } });
    const pure = rankSymbols([schema, sym('PodList', { kind: 'class', filePath: 'api/openapi-spec/swagger.json', frameworkMeta: { openapi_schema: true } })], 'pod resource that runs one or more containers on a node', true);
    expect(pure.find((r) => r.symbol.name === 'Pod')!.debugScore!.identityExact).toBe(60);
    const mixed = rankSymbols([schema, sym('createPod', { kind: 'function', filePath: 'pkg/client/pods.go' })], 'pod resource that runs one or more containers on a node', true);
    expect(mixed.find((r) => r.symbol.name === 'Pod')!.debugScore!.identityExact).toBeLessThanOrEqual(10);
  });
});
