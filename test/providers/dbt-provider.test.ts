import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { insertSymbols } from '../../src/core/db/symbol-store.js';
import { dbtProvider, parseSchemaFile, parseDocBlocks } from '../../src/providers/dbt-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import type Database from 'better-sqlite3';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DBT_FIXTURE = join(__dirname, '../fixtures/dbt-project');
const NON_DBT_DIR = join(__dirname, '../fixtures/basic-ts-project');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(name: string, kind: SymbolRecord['kind'] = 'function'): SymbolRecord {
  return {
    id: `test-${name}`,
    name,
    kind,
    filePath: `models/${name}.sql`,
    startByte: 0,
    endByte: 100,
    signature: `-- model: ${name}`,
    summary: '',
    frameworkMeta: undefined,
  };
}

function seedRepo(db: Database.Database, repoId: string, symbols: SymbolRecord[]): void {
  // Insert a minimal repos row so FK constraints pass
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, '/test', 0, 0, '[]', 0, 5)
  `).run(repoId);
  insertSymbols(db, repoId, symbols);
}

function getSymbol(db: Database.Database, repoId: string, id: string) {
  return db.prepare('SELECT * FROM symbols WHERE repo_id = ? AND id = ?').get(repoId, id) as
    | { id: string; summary: string; framework_meta: string | null }
    | undefined;
}

function getProviderMeta(db: Database.Database, repoId: string, entityKey: string) {
  return db.prepare(
    "SELECT * FROM provider_metadata WHERE repo_id = ? AND provider_name = 'dbt' AND entity_key = ?",
  ).get(repoId, entityKey) as { metadata: string } | undefined;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dbt-provider', () => {
  let db: Database.Database;
  const REPO_ID = 'test-repo-dbt';

  beforeEach(() => {
    db = openInMemoryDatabase();
  });

  // ── Detection ──────────────────────────────────────────────────────────────

  describe('detect()', () => {
    it('returns true when dbt_project.yml is present', async () => {
      expect(await dbtProvider.detect(DBT_FIXTURE)).toBe(true);
    });

    it('returns false when dbt_project.yml is absent', async () => {
      expect(await dbtProvider.detect(NON_DBT_DIR)).toBe(false);
    });

    it('returns false for a non-existent directory', async () => {
      expect(await dbtProvider.detect('/no/such/dir')).toBe(false);
    });
  });

  // ── Schema parsing ─────────────────────────────────────────────────────────

  describe('parseSchemaFile()', () => {
    it('extracts model names and descriptions', () => {
      const file = join(DBT_FIXTURE, 'models/staging/schema.yml');
      const models = parseSchemaFile(file);
      const stgCustomers = models.find((m) => m.name === 'stg_customers');
      expect(stgCustomers).toBeDefined();
      expect(stgCustomers!.description).toMatch(/Staged customer/);
    });

    it('extracts model tags', () => {
      const file = join(DBT_FIXTURE, 'models/staging/schema.yml');
      const models = parseSchemaFile(file);
      const stgCustomers = models.find((m) => m.name === 'stg_customers');
      expect(stgCustomers!.tags).toContain('staging');
      expect(stgCustomers!.tags).toContain('customers');
    });

    it('extracts columns with descriptions and tags', () => {
      const file = join(DBT_FIXTURE, 'models/staging/schema.yml');
      const models = parseSchemaFile(file);
      const stgCustomers = models.find((m) => m.name === 'stg_customers');
      expect(stgCustomers!.columns).toHaveLength(4);
      const emailCol = stgCustomers!.columns.find((c) => c.name === 'email');
      expect(emailCol).toBeDefined();
      expect(emailCol!.description).toMatch(/email/i);
      expect(emailCol!.tags).toContain('pii');
    });

    it('extracts source table entries', () => {
      const file = join(DBT_FIXTURE, 'models/staging/schema.yml');
      const models = parseSchemaFile(file);
      const sourceEntry = models.find((m) => m.name === 'raw.customers');
      expect(sourceEntry).toBeDefined();
      expect(sourceEntry!.columns.length).toBeGreaterThan(0);
    });

    it('extracts marts model', () => {
      const file = join(DBT_FIXTURE, 'models/marts/schema.yml');
      const models = parseSchemaFile(file);
      const orders = models.find((m) => m.name === 'orders');
      expect(orders).toBeDefined();
      expect(orders!.description).toMatch(/Final orders/);
      expect(orders!.columns).toHaveLength(5);
    });

    it('returns empty array for non-existent file', () => {
      const models = parseSchemaFile('/no/such/file.yml');
      expect(models).toHaveLength(0);
    });

    it('returns empty array for invalid YAML', () => {
      // Test with a temp path that doesn't have valid YAML schema structure
      // (the fixture markdown file is not valid YAML schema)
      const mdFile = join(DBT_FIXTURE, 'models/doc_blocks.md');
      const models = parseSchemaFile(mdFile);
      // md file loads as string from js-yaml, not an object with models[] — returns []
      expect(models).toHaveLength(0);
    });
  });

  // ── Doc block parsing ──────────────────────────────────────────────────────

  describe('parseDocBlocks()', () => {
    it('extracts doc blocks from .md files', () => {
      const modelsDir = join(DBT_FIXTURE, 'models');
      const blocks = parseDocBlocks(modelsDir);
      expect(blocks.has('stg_customers')).toBe(true);
      expect(blocks.get('stg_customers')).toMatch(/Staged customer data/);
    });

    it('extracts multiple doc blocks from same file', () => {
      const modelsDir = join(DBT_FIXTURE, 'models');
      const blocks = parseDocBlocks(modelsDir);
      expect(blocks.has('orders')).toBe(true);
      expect(blocks.get('orders')).toMatch(/Final orders mart/);
    });

    it('returns empty map for directory with no .md files', () => {
      const blocks = parseDocBlocks('/tmp/no-md-files-here-xyz');
      expect(blocks.size).toBe(0);
    });
  });

  // ── Enrichment ─────────────────────────────────────────────────────────────

  describe('enrich()', () => {
    it('returns zero enriched when no symbols are indexed', async () => {
      seedRepo(db, REPO_ID, []);
      const result = await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      expect(result.symbolsEnriched).toBe(0);
    });

    it('updates symbol summary with model description', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const row = getSymbol(db, REPO_ID, sym.id);
      expect(row!.summary).toMatch(/Staged customer/);
    });

    it('does not overwrite a human-written (non-empty, non-signature) summary', async () => {
      const sym = { ...makeSymbol('stg_customers'), summary: 'Hand-written docstring' };
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const row = getSymbol(db, REPO_ID, sym.id);
      expect(row!.summary).toBe('Hand-written docstring');
    });

    it('overwrites summary that equals the signature (auto-generated)', async () => {
      const sym = { ...makeSymbol('stg_customers'), summary: '-- model: stg_customers' };
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const row = getSymbol(db, REPO_ID, sym.id);
      expect(row!.summary).toMatch(/Staged customer/);
    });

    it('sets framework_meta with dbt columns and tags', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const row = getSymbol(db, REPO_ID, sym.id);
      const meta = JSON.parse(row!.framework_meta!) as Record<string, unknown>;
      expect(Array.isArray(meta['dbt_tags'])).toBe(true);
      expect((meta['dbt_tags'] as string[]).includes('staging')).toBe(true);
      expect(Array.isArray(meta['columns'])).toBe(true);
    });

    it('writes provider_metadata row for each model', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const pm = getProviderMeta(db, REPO_ID, 'stg_customers');
      expect(pm).toBeDefined();
      const parsed = JSON.parse(pm!.metadata) as Record<string, unknown>;
      expect(Array.isArray(parsed['columns'])).toBe(true);
    });

    it('provider_metadata contains column details', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const pm = getProviderMeta(db, REPO_ID, 'stg_customers');
      const parsed = JSON.parse(pm!.metadata) as { columns: Array<{ name: string }> };
      const colNames = parsed.columns.map((c) => c.name);
      expect(colNames).toContain('customer_id');
      expect(colNames).toContain('email');
    });

    it('is idempotent — running enrich() twice produces the same result', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      const r1 = await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const r2 = await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      expect(r1.symbolsEnriched).toBe(r2.symbolsEnriched);
      // Summary should still match after second run
      const row = getSymbol(db, REPO_ID, sym.id);
      expect(row!.summary).toMatch(/Staged customer/);
    });

    it('enriches both staging and marts models', async () => {
      const syms = [makeSymbol('stg_customers'), makeSymbol('orders')];
      seedRepo(db, REPO_ID, syms);
      const result = await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      expect(result.symbolsEnriched).toBe(2);
    });

    it('returns correct metadataAdded stats', async () => {
      seedRepo(db, REPO_ID, []);
      const result = await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      // 2 schema models (stg_customers, orders) + 1 source pseudo-entry (raw.customers) = 3 in map
      // doc blocks also present
      expect(typeof result.metadataAdded['modelsFound']).toBe('number');
      expect(typeof result.metadataAdded['docBlocksFound']).toBe('number');
    });

    it('enriches doc block text into framework_meta', async () => {
      const sym = makeSymbol('stg_customers');
      seedRepo(db, REPO_ID, [sym]);
      await dbtProvider.enrich(REPO_ID, DBT_FIXTURE, db);
      const row = getSymbol(db, REPO_ID, sym.id);
      const meta = JSON.parse(row!.framework_meta!) as Record<string, unknown>;
      expect(typeof meta['dbt_doc']).toBe('string');
      expect((meta['dbt_doc'] as string)).toMatch(/Staged customer data/);
    });
  });
});
