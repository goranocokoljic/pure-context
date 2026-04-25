import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../../src/semantic/embedding-provider.js';
import type { SymbolRecord } from '../../src/core/types.js';
import { SemanticIndexer, createSemanticIndexer } from '../../src/semantic/semantic-indexer.js';
import { DEFAULT_CONFIG } from '../../src/config/config-schema.js';
import type { PureContextConfig } from '../../src/config/config-schema.js';
import { openInMemoryDatabase } from '../../src/core/db/schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIM = 16;

/** Deterministic pseudo-random unit vector. */
function seedVec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let s = seed;
  for (let i = 0; i < DIM; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    v[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

class MockProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimension = DIM;
  readonly maxTokens = 512;
  embedCallCount = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCallCount++;
    return texts.map((_, i) => seedVec(i + this.embedCallCount * 1000));
  }
}

function makeSymbol(i: number): SymbolRecord {
  return {
    id: `sym${i}`,
    name: `symbol${i}`,
    kind: 'function',
    filePath: `src/file${Math.floor(i / 10)}.ts`,
    startByte: i * 200,
    endByte: i * 200 + 100,
    signature: `function symbol${i}(): void`,
    summary: `Does thing ${i}`,
  };
}

function makeSymbols(count: number): SymbolRecord[] {
  return Array.from({ length: count }, (_, i) => makeSymbol(i));
}

function makeDb(): Database.Database {
  return openInMemoryDatabase();
}

function insertRepo(db: Database.Database, repoId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO repos (id, root_path, symbol_count, file_count, languages, indexed_at, schema_version)
    VALUES (?, ?, 0, 0, '[]', 0, 2)
  `).run(repoId, `/test/${repoId}`);
}

function seedDb(db: Database.Database, repoId: string, symbols: SymbolRecord[]): void {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO symbols
      (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 0)
  `);
  for (const s of symbols) {
    stmt.run(s.id, repoId, s.name, s.kind, s.filePath, s.startByte, s.endByte, s.signature);
  }
}

/** Config with semantic enabled, low threshold for testing. */
function makeConfig(overrides: Partial<PureContextConfig['semantic']> = {}): PureContextConfig {
  return {
    ...DEFAULT_CONFIG,
    semantic: {
      ...DEFAULT_CONFIG.semantic,
      enabled: true,
      provider: 'openai',
      threshold: 100,
      batchSize: 50,
      concurrency: 2,
      ...overrides,
    },
    ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: 'test-key' },
  };
}

/** Build an indexer with a mock provider and tmp indexDir. */
function makeIndexer(
  config: PureContextConfig,
  tmpDir: string,
  mockProvider: MockProvider,
): SemanticIndexer {
  return new SemanticIndexer(config, {
    storeOptions: { indexDir: tmpDir },
    providerFactory: () => mockProvider,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SemanticIndexer.shouldIndex', () => {
  it('returns false when semantic disabled', () => {
    const indexer = new SemanticIndexer(makeConfig({ enabled: false }));
    expect(indexer.shouldIndex('repo1', 200_000)).toBe(false);
  });

  it('returns false when provider is none', () => {
    const indexer = new SemanticIndexer(makeConfig({ provider: 'none' }));
    expect(indexer.shouldIndex('repo1', 200_000)).toBe(false);
  });

  it('returns false when symbol count below threshold', () => {
    const indexer = new SemanticIndexer(makeConfig({ threshold: 100 }));
    expect(indexer.shouldIndex('repo1', 99)).toBe(false);
  });

  it('returns true at exact threshold', () => {
    const indexer = new SemanticIndexer(makeConfig({ threshold: 100 }));
    expect(indexer.shouldIndex('repo1', 100)).toBe(true);
  });

  it('returns true above threshold', () => {
    const indexer = new SemanticIndexer(makeConfig({ threshold: 100 }));
    expect(indexer.shouldIndex('repo1', 60_000)).toBe(true);
  });
});

describe('SemanticIndexer.index', () => {
  let tmpDir: string;
  let db: Database.Database;
  let mockProvider: MockProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'semantic-indexer-'));
    db = makeDb();
    insertRepo(db, 'repo1');
    mockProvider = new MockProvider();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes symbols and returns result', async () => {
    const indexer = makeIndexer(makeConfig({ batchSize: 30, concurrency: 2 }), tmpDir, mockProvider);
    const symbols = makeSymbols(60);
    seedDb(db, 'repo1', symbols);

    const result = await indexer.index('repo1', symbols, db);

    expect(result.symbolsIndexed).toBe(60);
    expect(result.embeddingTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.indexBuildTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.indexSizeBytes).toBe(60 * DIM * 4);
  });

  it('batches calls according to batchSize (concurrency=1)', async () => {
    const indexer = makeIndexer(makeConfig({ batchSize: 25, concurrency: 1 }), tmpDir, mockProvider);
    const symbols = makeSymbols(75);
    seedDb(db, 'repo1', symbols);

    await indexer.index('repo1', symbols, db);

    // 75 / 25 = 3 batches → 3 embed() calls
    expect(mockProvider.embedCallCount).toBe(3);
  });

  it('handles empty symbol list without API calls', async () => {
    const indexer = makeIndexer(makeConfig(), tmpDir, mockProvider);

    const result = await indexer.index('repo1', [], db);
    expect(result.symbolsIndexed).toBe(0);
    expect(mockProvider.embedCallCount).toBe(0);
  });

  it('respects concurrency — all batches complete', async () => {
    const indexer = makeIndexer(makeConfig({ batchSize: 10, concurrency: 3 }), tmpDir, mockProvider);
    const symbols = makeSymbols(30);
    seedDb(db, 'repo1', symbols);

    const result = await indexer.index('repo1', symbols, db);

    expect(result.symbolsIndexed).toBe(30);
    // 30 / 10 = 3 batches, concurrency=3 → all run simultaneously
    expect(mockProvider.embedCallCount).toBe(3);
  });

  it('saves HNSW index to disk', async () => {
    const { existsSync, readdirSync } = await import('fs');
    const indexer = makeIndexer(makeConfig({ batchSize: 50 }), tmpDir, mockProvider);
    const symbols = makeSymbols(10);
    seedDb(db, 'repo1', symbols);

    await indexer.index('repo1', symbols, db);

    // The VectorStore saves the HNSW file under indexDir
    const files = readdirSync(tmpDir);
    expect(files.some((f) => f.endsWith('.idx'))).toBe(true);
  });
});

describe('SemanticIndexer.updateIncremental', () => {
  let tmpDir: string;
  let db: Database.Database;
  let mockProvider: MockProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'semantic-incr-'));
    db = makeDb();
    insertRepo(db, 'repo1');
    mockProvider = new MockProvider();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a no-op when both added and removed are empty', async () => {
    const indexer = makeIndexer(makeConfig(), tmpDir, mockProvider);
    await indexer.updateIncremental('repo1', [], [], db);
    expect(mockProvider.embedCallCount).toBe(0);
  });

  it('embeds added symbols with correct batch count', async () => {
    const indexer = makeIndexer(makeConfig({ batchSize: 10, concurrency: 1 }), tmpDir, mockProvider);
    const added = makeSymbols(15);
    seedDb(db, 'repo1', added);

    await indexer.updateIncremental('repo1', added, [], db);

    // 15 / 10 = 2 batches
    expect(mockProvider.embedCallCount).toBe(2);
  });

  it('does not embed when only removals are passed', async () => {
    const indexer = makeIndexer(makeConfig(), tmpDir, mockProvider);
    await indexer.updateIncremental('repo1', [], ['sym0', 'sym1'], db);
    expect(mockProvider.embedCallCount).toBe(0);
  });
});

describe('createSemanticIndexer', () => {
  it('returns null when semantic disabled', () => {
    expect(
      createSemanticIndexer({ ...DEFAULT_CONFIG, semantic: { ...DEFAULT_CONFIG.semantic, enabled: false } }),
    ).toBeNull();
  });

  it('returns null when provider is none', () => {
    expect(
      createSemanticIndexer({
        ...DEFAULT_CONFIG,
        semantic: { ...DEFAULT_CONFIG.semantic, enabled: true, provider: 'none' },
      }),
    ).toBeNull();
  });

  it('returns null when local provider has no endpoint (PureContextError path)', () => {
    // local provider + no endpoint → createEmbeddingProvider throws PureContextError
    expect(
      createSemanticIndexer({
        ...DEFAULT_CONFIG,
        semantic: {
          ...DEFAULT_CONFIG.semantic,
          enabled: true,
          provider: 'local',
          localEmbeddingEndpoint: null,
        },
      }),
    ).toBeNull();
  });

  it('returns SemanticIndexer when properly configured', () => {
    const indexer = createSemanticIndexer({
      ...DEFAULT_CONFIG,
      semantic: { ...DEFAULT_CONFIG.semantic, enabled: true, provider: 'openai' },
      ai: { ...DEFAULT_CONFIG.ai, openaiApiKey: 'sk-test' },
    });
    expect(indexer).toBeInstanceOf(SemanticIndexer);
  });
});

describe('config-schema: new semantic fields', () => {
  it('DEFAULT_CONFIG has correct defaults for threshold, batchSize, concurrency', () => {
    expect(DEFAULT_CONFIG.semantic.threshold).toBe(50_000);
    expect(DEFAULT_CONFIG.semantic.batchSize).toBe(500);
    expect(DEFAULT_CONFIG.semantic.concurrency).toBe(2);
  });
});
