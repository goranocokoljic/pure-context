/**
 * Phase 93 (Task 577) — route_path FTS indexing.
 *
 * Route paths lived only in frameworkMeta, which buildFtsContent did not
 * index — so "blog slug page" could never retrieve pages/blog/[slug].vue
 * (V-2). buildFtsContent now indexes frameworkMeta.route_path (raw +
 * segment-split, param markers stripped) for route/component kinds only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols, ftsSearchSymbols } from '../../src/core/db/symbol-store.js';
import type { SymbolRecord } from '../../src/core/types.js';

const REPO_ID = 'fts-route-path-test-repo';

function makeSymbol(overrides: Partial<SymbolRecord> & { id: string; name: string }): SymbolRecord {
  return {
    kind: 'route',
    filePath: 'pages/blog/[slug].vue',
    startByte: 0,
    endByte: 100,
    signature: overrides.name,
    summary: overrides.summary ?? overrides.name,
    ...overrides,
  };
}

describe('FTS route_path indexing', () => {
  let db: ReturnType<typeof openInMemoryDatabase>;

  beforeEach(() => {
    db = openInMemoryDatabase();
    db.prepare(
      "INSERT OR IGNORE INTO repos (id, root_path, file_count, indexed_at, schema_version) VALUES (?, ?, 0, 0, 1)",
    ).run(REPO_ID, '/tmp/test');
  });

  afterEach(() => {
    db.close();
  });

  it('a Nuxt page component is retrieved by its route segments', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'cccc000000000001',
        name: 'BlogSlug',
        kind: 'component',
        summary: 'Page route /blog/:slug',
        frameworkMeta: { route_path: '/blog/:slug', nuxt_page: true },
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'blog slug');
    expect(results.map((r) => r.name)).toContain('BlogSlug');
  });

  it('param markers are stripped: ":slug" segment matches query word "slug"', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'cccc000000000002',
        name: 'UserEdit',
        kind: 'component',
        filePath: 'pages/users/[id]/edit.vue',
        summary: 'Page route /users/:id/edit',
        frameworkMeta: { route_path: '/users/:id/edit', nuxt_page: true },
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'users edit');
    expect(results.map((r) => r.name)).toContain('UserEdit');
  });

  it('a route-kind symbol (server route) is retrieved by its path segments', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'cccc000000000003',
        name: '/api/newsletter/subscribe',
        kind: 'route',
        filePath: 'server/api/newsletter/subscribe.post.ts',
        summary: 'POST /api/newsletter/subscribe server route',
        frameworkMeta: { route_path: '/api/newsletter/subscribe', http_method: 'POST', nuxt_server: true },
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'newsletter subscribe');
    expect(results.map((r) => r.name)).toContain('/api/newsletter/subscribe');
  });

  it('route_path on a non-route/component kind is NOT indexed (kind gate)', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'cccc000000000004',
        name: 'handler',
        kind: 'function',
        filePath: 'src/misc/handler.ts',
        summary: 'handler',
        frameworkMeta: { route_path: '/secret/checkout/flow' },
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'checkout flow');
    expect(results.map((r) => r.name)).not.toContain('handler');
  });

  it('a framework route without route_path keeps its existing behavior (guard)', () => {
    insertSymbols(db, REPO_ID, [
      makeSymbol({
        id: 'cccc000000000005',
        name: 'users#index',
        kind: 'route',
        filePath: 'config/routes.rb',
        summary: 'Rails route users#index',
      }),
    ]);
    const results = ftsSearchSymbols(db, REPO_ID, 'users index');
    expect(results.map((r) => r.name)).toContain('users#index');
  });
});
