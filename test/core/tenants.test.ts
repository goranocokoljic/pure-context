import { describe, it, expect, beforeEach } from 'vitest';
import { openInMemoryAuthDatabase } from '../../src/core/db/api-keys.js';
import { TenantStore, ensureDefaultTenant } from '../../src/core/db/tenants.js';
import { QuotaExceededError } from '../../src/core/errors.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_CONTEXT } from '../../src/core/tenant-context.js';
import {
  openInMemoryDatabase,
  upsertRepo,
  getRepo,
  SCHEMA_VERSION,
} from '../../src/core/db/schema.js';
import {
  insertSymbols,
  searchSymbols,
  getSymbolById,
  getSymbolsByFile,
  getSymbolsByRepo,
} from '../../src/core/db/symbol-store.js';
import {
  upsertFile,
  getFileContent,
  getTenantStorageBytes,
} from '../../src/core/db/file-store.js';
import {
  insertEdges,
  getAllDepEdges,
  getForwardDeps,
  getImportersOf,
} from '../../src/core/db/dep-store.js';
import type { SymbolRecord, DepEdge, RepoMetadata } from '../../src/core/types.js';
import type Database from 'better-sqlite3';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'sym-001',
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/foo.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function myFunction(): void',
    summary: 'does stuff',
    ...overrides,
  };
}

function makeRepo(tenantId?: string): RepoMetadata {
  return {
    id: 'repo-abc',
    rootPath: '/test/repo',
    symbolCount: 0,
    fileCount: 0,
    languages: ['typescript'],
    indexedAt: Date.now(),
    schemaVersion: SCHEMA_VERSION,
    clonePath: null,
    tenantId,
  };
}

// ─── TenantStore tests ────────────────────────────────────────────────────────

describe('TenantStore', () => {
  let store: TenantStore;
  let db: Database.Database;

  beforeEach(() => {
    db = openInMemoryAuthDatabase();
    store = new TenantStore(db);
  });

  it('creates a tenant with generated id', () => {
    const t = store.create('Acme Corp');
    expect(t.id).toHaveLength(8); // 4 random bytes = 8 hex chars
    expect(t.name).toBe('Acme Corp');
    expect(t.createdAt).toBeTruthy();
    expect(t.storageUsedBytes).toBe(0);
    expect(t.storageQuotaBytes).toBeNull();
    expect(t.settings).toBeNull();
  });

  it('creates a tenant with quota and settings', () => {
    const t = store.create('Corp B', {
      storageQuotaBytes: 1_000_000,
      settings: { theme: 'dark' },
    });
    expect(t.storageQuotaBytes).toBe(1_000_000);
    expect(t.settings).toEqual({ theme: 'dark' });
  });

  it('retrieves a tenant by id', () => {
    const created = store.create('Test Tenant');
    const fetched = store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Tenant');
  });

  it('returns null for unknown id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('lists all tenants', () => {
    const a = store.create('A');
    const b = store.create('B');
    const list = store.list();
    expect(list.length).toBe(2);
    const ids = new Set(list.map((t) => t.id));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);
  });

  it('updates tenant name', () => {
    const t = store.create('Old Name');
    store.update(t.id, { name: 'New Name' });
    expect(store.get(t.id)!.name).toBe('New Name');
  });

  it('updates tenant quota', () => {
    const t = store.create('Tenant');
    store.update(t.id, { storageQuotaBytes: 500_000 });
    expect(store.get(t.id)!.storageQuotaBytes).toBe(500_000);
  });

  it('updates tenant settings', () => {
    const t = store.create('Tenant');
    store.update(t.id, { settings: { key: 'value' } });
    expect(store.get(t.id)!.settings).toEqual({ key: 'value' });
  });

  it('deletes a tenant', () => {
    const t = store.create('To Delete');
    store.delete(t.id);
    expect(store.get(t.id)).toBeNull();
  });

  it('updates storage used', () => {
    const t = store.create('Tenant');
    store.updateStorageUsed(t.id, 1024);
    expect(store.get(t.id)!.storageUsedBytes).toBe(1024);
    store.updateStorageUsed(t.id, 512);
    expect(store.get(t.id)!.storageUsedBytes).toBe(1536);
  });

  it('does not let storage go below 0 on decrement', () => {
    const t = store.create('Tenant');
    store.updateStorageUsed(t.id, 100);
    store.updateStorageUsed(t.id, -500); // subtract more than exists
    expect(store.get(t.id)!.storageUsedBytes).toBe(0);
  });
});

// ─── Quota enforcement ────────────────────────────────────────────────────────

describe('TenantStore.checkQuota', () => {
  let store: TenantStore;

  beforeEach(() => {
    store = new TenantStore(openInMemoryAuthDatabase());
  });

  it('allows storage when quota is null (unlimited)', () => {
    const t = store.create('Unlimited');
    expect(() => store.checkQuota(t.id, 10_000_000)).not.toThrow();
  });

  it('allows storage when within quota', () => {
    const t = store.create('Quota', { storageQuotaBytes: 1000 });
    store.updateStorageUsed(t.id, 400);
    expect(() => store.checkQuota(t.id, 500)).not.toThrow();
  });

  it('throws QuotaExceededError when quota would be exceeded', () => {
    const t = store.create('Quota', { storageQuotaBytes: 1000 });
    store.updateStorageUsed(t.id, 800);
    expect(() => store.checkQuota(t.id, 300)).toThrow(QuotaExceededError);
  });

  it('QuotaExceededError carries correct metadata', () => {
    const t = store.create('Quota', { storageQuotaBytes: 1000 });
    store.updateStorageUsed(t.id, 800);
    try {
      store.checkQuota(t.id, 300);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.tenantId).toBe(t.id);
      expect(qe.quotaBytes).toBe(1000);
      expect(qe.usedBytes).toBe(800);
      expect(qe.requestedBytes).toBe(300);
    }
  });

  it('does nothing when tenant not found', () => {
    expect(() => store.checkQuota('ghost', 9999)).not.toThrow();
  });
});

// ─── ensureDefaultTenant ─────────────────────────────────────────────────────

describe('ensureDefaultTenant', () => {
  it('creates the local tenant if it does not exist', () => {
    const db = openInMemoryAuthDatabase();
    ensureDefaultTenant(db);
    const store = new TenantStore(db);
    const t = store.get(DEFAULT_TENANT_ID);
    expect(t).not.toBeNull();
    expect(t!.id).toBe('local');
    expect(t!.name).toBe('Local');
  });

  it('is idempotent — does not throw on repeated calls', () => {
    const db = openInMemoryAuthDatabase();
    expect(() => {
      ensureDefaultTenant(db);
      ensureDefaultTenant(db);
    }).not.toThrow();
  });
});

// ─── Schema migration — tenant_id columns ────────────────────────────────────

describe('schema migration (v3 — tenant_id columns)', () => {
  it('new database has tenant_id on repos', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(repos)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
  });

  it('new database has tenant_id on symbols', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
  });

  it('new database has tenant_id on files', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
  });

  it('new database has tenant_id on dep_edges', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(dep_edges)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
  });

  it('new database has tenant_id on embeddings', () => {
    const db = openInMemoryDatabase();
    const cols = db.prepare('PRAGMA table_info(embeddings)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'tenant_id')).toBe(true);
  });
});

// ─── Tenant isolation — SymbolStore ──────────────────────────────────────────

describe('tenant isolation — symbols', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openInMemoryDatabase();
    upsertRepo(db, makeRepo('tenant-a'));
  });

  it('insertSymbols stores tenant_id', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const row = db
      .prepare('SELECT tenant_id FROM symbols WHERE id = ?')
      .get('sym-001') as { tenant_id: string } | undefined;
    expect(row?.tenant_id).toBe('tenant-a');
  });

  it('searchSymbols with tenantId returns owned symbols', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const results = searchSymbols(db, 'repo-abc', 'myFunction', { tenantId: 'tenant-a' });
    expect(results).toHaveLength(1);
  });

  it('searchSymbols with wrong tenantId returns nothing', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const results = searchSymbols(db, 'repo-abc', 'myFunction', { tenantId: 'tenant-b' });
    expect(results).toHaveLength(0);
  });

  it('getSymbolById with correct tenantId returns symbol', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const sym = getSymbolById(db, 'repo-abc', 'sym-001', 'tenant-a');
    expect(sym).not.toBeNull();
    expect(sym!.name).toBe('myFunction');
  });

  it('getSymbolById with wrong tenantId returns null', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const sym = getSymbolById(db, 'repo-abc', 'sym-001', 'tenant-b');
    expect(sym).toBeNull();
  });

  it('getSymbolsByFile with correct tenantId returns symbols', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const syms = getSymbolsByFile(db, 'repo-abc', 'src/foo.ts', 'tenant-a');
    expect(syms).toHaveLength(1);
  });

  it('getSymbolsByFile with wrong tenantId returns nothing', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const syms = getSymbolsByFile(db, 'repo-abc', 'src/foo.ts', 'tenant-b');
    expect(syms).toHaveLength(0);
  });

  it('getSymbolsByRepo with correct tenantId returns symbols', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const syms = getSymbolsByRepo(db, 'repo-abc', 1000, 'tenant-a');
    expect(syms).toHaveLength(1);
  });

  it('getSymbolsByRepo with wrong tenantId returns nothing', () => {
    insertSymbols(db, 'repo-abc', [makeSymbol()], 'tenant-a');
    const syms = getSymbolsByRepo(db, 'repo-abc', 1000, 'tenant-b');
    expect(syms).toHaveLength(0);
  });

  it('two tenants do not see each other symbols in same repo', () => {
    const symA = makeSymbol({ id: 'sym-a', name: 'funcA' });
    const symB = makeSymbol({ id: 'sym-b', name: 'funcB', filePath: 'src/bar.ts' });
    insertSymbols(db, 'repo-abc', [symA], 'tenant-a');
    insertSymbols(db, 'repo-abc', [symB], 'tenant-b');

    const resultsA = searchSymbols(db, 'repo-abc', 'func', { tenantId: 'tenant-a' });
    const resultsB = searchSymbols(db, 'repo-abc', 'func', { tenantId: 'tenant-b' });

    expect(resultsA.map((s) => s.id)).toEqual(['sym-a']);
    expect(resultsB.map((s) => s.id)).toEqual(['sym-b']);
  });

  it('omitting tenantId returns all symbols (backward compat)', () => {
    const symA = makeSymbol({ id: 'sym-a', name: 'funcA' });
    const symB = makeSymbol({ id: 'sym-b', name: 'funcB', filePath: 'src/bar.ts' });
    insertSymbols(db, 'repo-abc', [symA], 'tenant-a');
    insertSymbols(db, 'repo-abc', [symB], 'tenant-b');

    const all = searchSymbols(db, 'repo-abc', 'func');
    expect(all).toHaveLength(2);
  });
});

// ─── Tenant isolation — FileStore ────────────────────────────────────────────

describe('tenant isolation — files', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openInMemoryDatabase();
    upsertRepo(db, makeRepo('tenant-a'));
  });

  it('upsertFile stores tenant_id', () => {
    upsertFile(db, 'repo-abc', 'src/foo.ts', 'hash123', Buffer.from('content'), 'tenant-a');
    const row = db
      .prepare('SELECT tenant_id FROM files WHERE repo_id = ? AND path = ?')
      .get('repo-abc', 'src/foo.ts') as { tenant_id: string } | undefined;
    expect(row?.tenant_id).toBe('tenant-a');
  });

  it('getFileContent with correct tenantId returns content', () => {
    upsertFile(db, 'repo-abc', 'src/foo.ts', 'hash123', Buffer.from('hello'), 'tenant-a');
    const content = getFileContent(db, 'repo-abc', 'src/foo.ts', 'tenant-a');
    expect(content?.toString()).toBe('hello');
  });

  it('getFileContent with wrong tenantId returns null', () => {
    upsertFile(db, 'repo-abc', 'src/foo.ts', 'hash123', Buffer.from('hello'), 'tenant-a');
    const content = getFileContent(db, 'repo-abc', 'src/foo.ts', 'tenant-b');
    expect(content).toBeNull();
  });

  it('getTenantStorageBytes sums bytes for a tenant', () => {
    upsertFile(db, 'repo-abc', 'src/a.ts', 'h1', Buffer.alloc(1000), 'tenant-a');
    upsertFile(db, 'repo-abc', 'src/b.ts', 'h2', Buffer.alloc(500), 'tenant-a');
    upsertFile(db, 'repo-abc', 'src/c.ts', 'h3', Buffer.alloc(200), 'tenant-b');
    expect(getTenantStorageBytes(db, 'tenant-a')).toBe(1500);
    expect(getTenantStorageBytes(db, 'tenant-b')).toBe(200);
  });
});

// ─── Tenant isolation — DepStore ─────────────────────────────────────────────

describe('tenant isolation — dep edges', () => {
  let db: Database.Database;

  const edgeA: DepEdge = {
    repoId: 'repo-abc',
    sourceFile: 'src/a.ts',
    targetFile: 'src/b.ts',
    edgeType: 'import',
    specifier: './b',
    sourceSymbolId: null,
    targetSymbolId: null,
  };

  const edgeB: DepEdge = {
    repoId: 'repo-abc',
    sourceFile: 'src/c.ts',
    targetFile: 'src/d.ts',
    edgeType: 'import',
    specifier: './d',
    sourceSymbolId: null,
    targetSymbolId: null,
  };

  beforeEach(() => {
    db = openInMemoryDatabase();
    upsertRepo(db, makeRepo('tenant-a'));
  });

  it('insertEdges stores tenant_id', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    const row = db
      .prepare('SELECT tenant_id FROM dep_edges WHERE repo_id = ?')
      .get('repo-abc') as { tenant_id: string } | undefined;
    expect(row?.tenant_id).toBe('tenant-a');
  });

  it('getAllDepEdges with correct tenantId returns edges', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    const edges = getAllDepEdges(db, 'repo-abc', 'tenant-a');
    expect(edges).toHaveLength(1);
  });

  it('getAllDepEdges with wrong tenantId returns nothing', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    const edges = getAllDepEdges(db, 'repo-abc', 'tenant-b');
    expect(edges).toHaveLength(0);
  });

  it('two tenants cannot see each other dep edges', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    insertEdges(db, [edgeB], 'tenant-b');

    const a = getAllDepEdges(db, 'repo-abc', 'tenant-a');
    const b = getAllDepEdges(db, 'repo-abc', 'tenant-b');

    expect(a.map((e) => e.sourceFile)).toEqual(['src/a.ts']);
    expect(b.map((e) => e.sourceFile)).toEqual(['src/c.ts']);
  });

  it('getForwardDeps filters by tenantId', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    expect(getForwardDeps(db, 'repo-abc', 'src/a.ts', 'tenant-a')).toHaveLength(1);
    expect(getForwardDeps(db, 'repo-abc', 'src/a.ts', 'tenant-b')).toHaveLength(0);
  });

  it('getImportersOf filters by tenantId', () => {
    insertEdges(db, [edgeA], 'tenant-a');
    expect(getImportersOf(db, 'repo-abc', 'src/b.ts', 'tenant-a')).toEqual(['src/a.ts']);
    expect(getImportersOf(db, 'repo-abc', 'src/b.ts', 'tenant-b')).toHaveLength(0);
  });
});

// ─── Repo metadata — tenantId ─────────────────────────────────────────────────

describe('repo metadata with tenantId', () => {
  it('upsertRepo stores tenantId and getRepo returns it', () => {
    const db = openInMemoryDatabase();
    upsertRepo(db, makeRepo('tenant-xyz'));
    const repo = getRepo(db, 'repo-abc');
    expect(repo?.tenantId).toBe('tenant-xyz');
  });

  it('upsertRepo defaults to local when tenantId is omitted', () => {
    const db = openInMemoryDatabase();
    upsertRepo(db, makeRepo()); // no tenantId
    const repo = getRepo(db, 'repo-abc');
    expect(repo?.tenantId).toBe('local');
  });
});

// ─── TenantContext ────────────────────────────────────────────────────────────

describe('TenantContext', () => {
  it('DEFAULT_TENANT_ID is "local"', () => {
    expect(DEFAULT_TENANT_ID).toBe('local');
  });

  it('DEFAULT_TENANT_CONTEXT has tenantId local', () => {
    expect(DEFAULT_TENANT_CONTEXT.tenantId).toBe('local');
  });
});
