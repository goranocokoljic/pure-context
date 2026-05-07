/**
 * Tests for the search_columns tool (Task 141).
 *
 * Uses an in-memory database seeded with provider_metadata rows that mimic
 * what the dbt provider writes — no file I/O required for the tool itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';
import { handler } from '../../src/server/tools/search-columns.js';
import { PureContextError } from '../../src/core/errors.js';
import type Database from 'better-sqlite3';

// ─── Mock openDatabase so the tool uses our in-memory DB ─────────────────────

let db: Database.Database;

vi.mock('../../src/core/db/schema.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/core/db/schema.js')>();
  return {
    ...orig,
    openDatabase: (_repoId: string) => db,
  };
});

// ─── Fixture data helpers ─────────────────────────────────────────────────────

const REPO_ID = 'test-repo-001';

function seedRepo(): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos
      (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, '/test', 0, 0, '[]', 0, 5)
  `).run(REPO_ID);
}

interface ColumnDef {
  name: string;
  description?: string;
  tags?: string[];
  dataType?: string;
}

function seedProviderMeta(
  modelName: string,
  columns: ColumnDef[],
  filePath?: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO provider_metadata
      (repo_id, provider_name, entity_key, metadata, updated_at)
    VALUES (?, 'dbt', ?, ?, ?)
  `).run(
    REPO_ID,
    modelName,
    JSON.stringify({ description: `Model ${modelName}`, tags: [], columns }),
    Date.now(),
  );

  // Optionally seed a symbols row so file_path JOIN returns data.
  if (filePath) {
    db.prepare(`
      INSERT OR IGNORE INTO symbols
        (id, repo_id, name, kind, file_path, start_byte, end_byte,
         signature, summary, indexed_at)
      VALUES (?, ?, ?, 'function', ?, 0, 100, '', '', ?)
    `).run(`sym-${modelName}`, REPO_ID, modelName, filePath, Date.now());
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  db = openInMemoryDatabase();
  seedRepo();
});

afterEach(() => {
  db.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

type ColumnResult = {
  modelName: string;
  modelFilePath: string | null;
  columnName: string;
  columnDescription: string;
  tags: string[];
  dataType?: string;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('search_columns — no dbt metadata', () => {
  it('throws PureContextError with a helpful hint when no dbt rows exist', () => {
    expect(() => handler({ repoId: REPO_ID, query: 'customer_id' })).toThrow(PureContextError);
  });

  it('error message mentions index_folder', () => {
    let caught: PureContextError | undefined;
    try {
      handler({ repoId: REPO_ID, query: 'customer_id' });
    } catch (err) {
      caught = err as PureContextError;
    }
    expect(caught).toBeDefined();
    expect(caught!.suggestion).toContain('index_folder');
  });
});

describe('search_columns — query matching', () => {
  beforeEach(() => {
    seedProviderMeta(
      'orders',
      [
        { name: 'order_id', description: 'Unique identifier for each order', tags: ['primary_key'] },
        { name: 'customer_id', description: 'Foreign key to customers' },
        { name: 'amount', description: 'Order amount in USD' },
      ],
      'models/marts/orders.sql',
    );
    seedProviderMeta(
      'stg_customers',
      [
        { name: 'customer_id', description: 'Unique identifier for each customer', tags: ['primary_key'] },
        { name: 'email', description: 'Customer email address', tags: ['pii'] },
        { name: 'first_name', description: "Customer's first name" },
      ],
      'models/staging/stg_customers.sql',
    );
  });

  it('matches column name substring', async () => {
    const result = handler({ repoId: REPO_ID, query: 'customer_id' });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBeGreaterThanOrEqual(2);
    expect(columns.every((c) => c.columnName.includes('customer_id'))).toBe(true);
  });

  it('matches column description substring', async () => {
    const result = handler({ repoId: REPO_ID, query: 'Foreign key' });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBe(1);
    expect(columns[0].columnName).toBe('customer_id');
    expect(columns[0].modelName).toBe('orders');
  });

  it('returns correct totalResults count', async () => {
    const result = handler({ repoId: REPO_ID, query: 'customer_id' });
    const parsed = parseResult(result);
    expect(parsed.totalResults).toBe((parsed.columns as ColumnResult[]).length);
  });

  it('returns modelFilePath when symbol row exists', async () => {
    const result = handler({ repoId: REPO_ID, query: 'order_id' });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBeGreaterThan(0);
    expect(columns[0].modelFilePath).toBe('models/marts/orders.sql');
  });

  it('includes tags in column results', async () => {
    const result = handler({ repoId: REPO_ID, query: 'order_id' });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    const pkCol = columns.find((c) => c.columnName === 'order_id');
    expect(pkCol).toBeDefined();
    expect(pkCol!.tags).toContain('primary_key');
  });
});

describe('search_columns — modelFilter', () => {
  beforeEach(() => {
    seedProviderMeta('orders', [
      { name: 'customer_id', description: 'FK to customers' },
    ]);
    seedProviderMeta('stg_customers', [
      { name: 'customer_id', description: 'PK for customers' },
    ]);
  });

  it('narrows results to the specified model', async () => {
    const result = handler({
      repoId: REPO_ID,
      query: 'customer_id',
      modelFilter: 'orders',
    });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBe(1);
    expect(columns[0].modelName).toBe('orders');
  });

  it('returns zero results for non-matching modelFilter', async () => {
    const result = handler({
      repoId: REPO_ID,
      query: 'customer_id',
      modelFilter: 'nonexistent_model',
    });
    const parsed = parseResult(result);
    expect((parsed.columns as ColumnResult[]).length).toBe(0);
  });
});

describe('search_columns — tagFilter', () => {
  beforeEach(() => {
    seedProviderMeta('stg_customers', [
      { name: 'customer_id', description: 'Unique customer ID', tags: ['primary_key'] },
      { name: 'email', description: 'Customer email', tags: ['pii'] },
      { name: 'ssn', description: 'Social security number', tags: ['pii', 'sensitive'] },
      { name: 'first_name', description: 'First name', tags: [] },
    ]);
  });

  it('returns only columns matching a single tag', async () => {
    const result = handler({
      repoId: REPO_ID,
      query: '',         // empty query matches everything
      tagFilter: ['pii'],
    });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBe(2);
    expect(columns.map((c) => c.columnName).sort()).toEqual(['email', 'ssn']);
  });

  it('returns only columns matching all tags (AND semantics)', async () => {
    const result = handler({
      repoId: REPO_ID,
      query: '',
      tagFilter: ['pii', 'sensitive'],
    });
    const parsed = parseResult(result);
    const columns = parsed.columns as ColumnResult[];

    expect(columns.length).toBe(1);
    expect(columns[0].columnName).toBe('ssn');
  });

  it('returns zero results when no columns match all tags', async () => {
    const result = handler({
      repoId: REPO_ID,
      query: '',
      tagFilter: ['pii', 'primary_key'],   // no column has BOTH
    });
    const parsed = parseResult(result);
    expect((parsed.columns as ColumnResult[]).length).toBe(0);
  });
});

describe('search_columns — limit', () => {
  beforeEach(() => {
    // Seed 10 columns across two models
    seedProviderMeta(
      'wide_model',
      Array.from({ length: 10 }, (_, i) => ({
        name: `col_${i}`,
        description: `Column ${i}`,
      })),
    );
  });

  it('respects the limit parameter', async () => {
    const result = handler({ repoId: REPO_ID, query: 'col', limit: 3 });
    const parsed = parseResult(result);
    expect((parsed.columns as ColumnResult[]).length).toBeLessThanOrEqual(3);
  });

  it('defaults to limit 20', async () => {
    // Seed more than 20 columns
    for (let m = 0; m < 5; m++) {
      seedProviderMeta(
        `model_${m}`,
        Array.from({ length: 10 }, (_, i) => ({ name: `val_${m}_${i}`, description: `val ${m} ${i}` })),
      );
    }
    const result = handler({ repoId: REPO_ID, query: 'val' });
    const parsed = parseResult(result);
    expect((parsed.columns as ColumnResult[]).length).toBeLessThanOrEqual(20);
  });
});

describe('search_columns — _meta', () => {
  beforeEach(() => {
    seedProviderMeta('orders', [
      { name: 'order_id', description: 'Unique order ID' },
    ]);
  });

  it('returns _meta with timing_ms and token savings fields', async () => {
    const result = handler({ repoId: REPO_ID, query: 'order_id' });
    const parsed = parseResult(result);
    const meta = parsed._meta as Record<string, unknown>;

    expect(typeof meta.timing_ms).toBe('number');
    expect(typeof meta.tokens_saved).toBe('number');
    expect(meta.powered_by).toBe('PureContext MCP');
  });
});
