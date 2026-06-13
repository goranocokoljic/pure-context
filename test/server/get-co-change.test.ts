/**
 * get-co-change.test.ts
 *
 * End-to-end tests for the Phase 76 MCP tools that open the index on disk:
 *   - get_co_change       (temporal coupling partners)
 *   - get_symbol_risk     (composite risk verdict)
 *   - get_context_bundle  (historicalNeighbors enrichment)
 *
 * A temp PCTX_DATA_DIR points the index at a throwaway directory; we seed the
 * repo's db at the path the handlers will open.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import type { Database } from 'better-sqlite3';

const REPO = 'phase76-tool-repo';
const NOW = Math.floor(Date.now() / 1000);

let dataDir: string;

async function loadModules() {
  const schema = await import('../../src/core/db/schema.js');
  const store = await import('../../src/core/db/co-change-store.js');
  const coChangeTool = await import('../../src/server/tools/get-co-change.js');
  const riskTool = await import('../../src/server/tools/get-symbol-risk.js');
  const bundleTool = await import('../../src/server/tools/get-context-bundle.js');
  return { schema, store, coChangeTool, riskTool, bundleTool };
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('Phase 76 tools (get_co_change / get_symbol_risk / bundle)', () => {
  let mods: Awaited<ReturnType<typeof loadModules>>;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'pctx-p76-'));
    process.env['PCTX_DATA_DIR'] = dataDir;
    mods = await loadModules();

    const { openDatabase, upsertRepo, SCHEMA_VERSION } = mods.schema;
    const db: Database = openDatabase(REPO);
    upsertRepo(db, {
      id: REPO,
      rootPath: '/tmp/phase76',
      symbolCount: 0,
      fileCount: 0,
      languages: [],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
    });

    // Files + symbols (route + its test co-change without importing each other).
    db.prepare(
      `INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
       VALUES (?, 'src/route.ts', 'h', ?, ?)`,
    ).run(REPO, Buffer.from('export function handleRoute(){return 1;}'), NOW);
    db.prepare(
      `INSERT OR REPLACE INTO symbols
         (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, cyclomatic_complexity, line_count)
       VALUES ('sym-route', ?, 'handleRoute', 'function', 'src/route.ts', 0, 30, 'handleRoute()', '', ?, 8, 10)`,
    ).run(REPO, NOW);

    db.prepare(
      `INSERT OR REPLACE INTO files (repo_id, path, content_hash, raw_content, indexed_at)
       VALUES (?, 'src/flag.ts', 'h', ?, ?)`,
    ).run(REPO, Buffer.from('export const FEATURE = true;'), NOW);
    db.prepare(
      `INSERT OR REPLACE INTO symbols
         (id, repo_id, name, kind, file_path, start_byte, end_byte, signature, summary, indexed_at, cyclomatic_complexity, line_count)
       VALUES ('sym-flag', ?, 'FEATURE', 'const', 'src/flag.ts', 0, 20, 'FEATURE', '', ?, 1, 1)`,
    ).run(REPO, NOW);

    // Co-change: route.ts and flag.ts change together 5 times (focused commits),
    // plus padding so the window is not flagged low-signal.
    const commits = [];
    for (let i = 0; i < 5; i++) commits.push({ sha: `cc${i}`, date: NOW - i, files: ['src/route.ts', 'src/flag.ts'] });
    for (let i = 0; i < 20; i++) commits.push({ sha: `pad${i}`, date: NOW - 100 - i, files: [`pad${i}.ts`] });
    mods.store.insertCommitFiles(db, REPO, commits);

    db.close();
  });

  afterAll(() => {
    delete process.env['PCTX_DATA_DIR'];
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('get_co_change returns route.ts ↔ flag.ts coupling', async () => {
    const res = parse(await mods.coChangeTool.handler({ repoId: REPO, filePath: 'src/route.ts' }));
    expect(res.signalQuality).toBe('ok');
    expect(res.partners[0].filePath).toBe('src/flag.ts');
    expect(res.partners[0].support).toBe(5);
  });

  it('get_co_change resolves a symbolId to its file', async () => {
    const res = parse(await mods.coChangeTool.handler({ repoId: REPO, symbolId: 'sym-route' }));
    expect(res.targetFilePath).toBe('src/route.ts');
    expect(res.partners.map((p: { filePath: string }) => p.filePath)).toContain('src/flag.ts');
  });

  it('get_symbol_risk returns a banded score with reasons', async () => {
    const res = parse(await mods.riskTool.handler({ repoId: REPO, symbolId: 'sym-route' }));
    expect(['low', 'review', 'high']).toContain(res.band);
    expect(typeof res.riskScore).toBe('number');
    expect(Array.isArray(res.reasons)).toBe(true);
    expect(res.factors).toHaveProperty('coChange');
  });

  it('get_context_bundle surfaces historicalNeighbors not reachable via imports', async () => {
    const res = parse(await mods.bundleTool.handler({ repoId: REPO, symbolId: 'sym-route' }));
    expect(res.historicalNeighbors).toBeDefined();
    const files = res.historicalNeighbors.map((n: { filePath: string }) => n.filePath);
    expect(files).toContain('src/flag.ts');
  });
});
