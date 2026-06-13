/**
 * symbol-risk.test.ts
 *
 * Tests computeSymbolRisk (Phase 76 composite risk): a synthetic high-risk
 * symbol (many dependents, high churn, untested, complex) scores `high` with
 * populated reasons[]; a leaf/tested/low-churn symbol scores `low`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openInMemoryDatabase, upsertRepo, SCHEMA_VERSION } from '../../src/core/db/schema.js';
import {
  computeSymbolRisk,
  buildRiskContext,
  computeSymbolRiskWithContext,
} from '../../src/server/tools/symbol-risk.js';

const REPO = 'symbol-risk-repo';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function insertFile(db: Database, path: string, content: string) {
  db.prepare(
    `INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
     VALUES (?, ?, 'h', ?, ?)`,
  ).run(REPO, path, Buffer.from(content), NOW);
}

function insertSymbol(
  db: Database,
  id: string,
  name: string,
  file: string,
  cc: number,
  startByte = 0,
  endByte = 50,
) {
  db.prepare(
    `INSERT OR REPLACE INTO symbols
       (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, cyclomatic_complexity, line_count)
     VALUES (?, ?, ?, 'function', ?, ?, ?, '', '', ?, ?, ?)`,
  ).run(id, REPO, name, file, startByte, endByte, NOW, cc, 20);
}

function insertEdge(db: Database, sourceFile: string, targetFile: string) {
  db.prepare(
    `INSERT INTO dep_edges (repo_id, source_file, source_symbol_id, target_file, target_symbol_id, edge_type, specifier, tenant_id)
     VALUES (?, ?, NULL, ?, NULL, 'import', '${targetFile}', 'local')`,
  ).run(REPO, sourceFile, targetFile);
}

function insertCommit(db: Database, file: string, sha: string, daysAgo: number) {
  db.prepare(
    `INSERT OR REPLACE INTO git_metadata
       (repo_id, file_path, commit_sha, author_name, author_email, commit_date, message)
     VALUES (?, ?, ?, 'a', 'a@x', ?, 'm')`,
  ).run(REPO, file, sha, NOW - daysAgo * DAY);
}

describe('computeSymbolRisk', () => {
  let db: Database;

  beforeEach(() => {
    db = openInMemoryDatabase();
    upsertRepo(db, {
      id: REPO,
      rootPath: '/tmp/symbol-risk',
      symbolCount: 0,
      fileCount: 0,
      languages: [],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });

    // ── High-risk symbol: hub.ts is imported by 8 files, churns a lot,
    //    complex (cc=25), and is NOT referenced by any test file. ──────────
    insertFile(db, 'src/hub.ts', 'export function criticalHandler() { return 1; }');
    insertSymbol(db, 'sym-hub', 'criticalHandler', 'src/hub.ts', 25);
    for (let i = 0; i < 8; i++) {
      insertFile(db, `src/imp${i}.ts`, `import { criticalHandler } from './hub';`);
      insertSymbol(db, `sym-imp${i}`, `consumer${i}`, `src/imp${i}.ts`, 1);
      insertEdge(db, `src/imp${i}.ts`, 'src/hub.ts');
    }
    for (let i = 0; i < 12; i++) insertCommit(db, 'src/hub.ts', `hub${i}`, i % 80);

    // ── Low-risk symbol: leaf.ts imported by nobody, no churn, simple,
    //    and referenced by a test file. ──────────────────────────────────
    insertFile(db, 'src/leaf.ts', 'export function trivialHelper() { return 2; }');
    insertSymbol(db, 'sym-leaf', 'trivialHelper', 'src/leaf.ts', 1);
    insertFile(db, 'test/leaf.test.ts', 'import { trivialHelper } from "../src/leaf"; trivialHelper();');
  });

  afterEach(() => db.close());

  it('scores a hub/churning/untested/complex symbol as high', () => {
    const risk = computeSymbolRisk(db, REPO, 'sym-hub');
    expect(risk).not.toBeNull();
    expect(risk!.band).toBe('high');
    expect(risk!.riskScore).toBeGreaterThan(66);
    expect(risk!.reasons.length).toBeGreaterThan(0);
    expect(risk!.factors.testGap.value).toBe(1); // untested
    expect(risk!.factors.centrality.raw).toBe(8); // 8 importers
    expect(risk!.factors.churn.raw).toBeGreaterThan(0);
  });

  it('scores a leaf/tested/low-churn/simple symbol as low', () => {
    const risk = computeSymbolRisk(db, REPO, 'sym-leaf');
    expect(risk).not.toBeNull();
    expect(risk!.band).toBe('low');
    expect(risk!.factors.testGap.value).toBe(0); // tested
    expect(risk!.factors.centrality.raw).toBe(0); // no importers
  });

  it('returns null for an unknown symbol', () => {
    expect(computeSymbolRisk(db, REPO, 'does-not-exist')).toBeNull();
  });

  it('context path produces byte-identical output to the single-call path', () => {
    const ctx = buildRiskContext(db, REPO);
    for (const id of ['sym-hub', 'sym-leaf']) {
      const single = computeSymbolRisk(db, REPO, id);
      const viaCtx = computeSymbolRiskWithContext(db, REPO, id, ctx);
      expect(viaCtx).toEqual(single);
    }
  });

  it('builds repo distributions exactly once when scoring N symbols with one context', () => {
    const prepareSpy = vi.spyOn(db, 'prepare');
    const ctx = buildRiskContext(db, REPO);
    // The repo-wide complexity distribution query must run during the single
    // context build...
    const complexityQueries = prepareSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('cyclomatic_complexity IS NOT NULL'),
    ).length;
    expect(complexityQueries).toBe(1);

    // ...and NOT again while scoring symbols against the prebuilt context.
    prepareSpy.mockClear();
    computeSymbolRiskWithContext(db, REPO, 'sym-hub', ctx);
    computeSymbolRiskWithContext(db, REPO, 'sym-leaf', ctx);
    const reQueries = prepareSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('cyclomatic_complexity IS NOT NULL'),
    ).length;
    expect(reQueries).toBe(0);
    prepareSpy.mockRestore();
  });
});
