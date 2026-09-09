/**
 * Phase 97, Task 603 — local usage ledger.
 * Write / rotate / off-switch, aggregation, the "this task" cursor and the
 * TaskCompleted line format (0-call and n-call).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _setLedgerPathForTesting,
  recordToolCall,
  readLedger,
  getSessionCalls,
  getLast24hCalls,
  takeTaskCalls,
  formatCallsLine,
  aggregate,
  LEDGER_ROTATE_BYTES,
} from '../../src/core/db/usage-ledger.js';

let dir: string;
let ledger: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pc-ledger-'));
  ledger = join(dir, 'usage.jsonl');
  _setLedgerPathForTesting(ledger);
});

afterAll(() => {
  _setLedgerPathForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('usage ledger', () => {
  it('appends one JSON line per call with names/ids/timestamps only', () => {
    recordToolCall({ tool: 'search_symbols', repoId: 'abc', ms: 12.6 });
    recordToolCall({ tool: 'get_symbol_source', ms: 3 });
    const lines = readFileSync(ledger, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(Object.keys(first).sort()).toEqual(['ms', 'repoId', 'sessionId', 'tool', 'ts']);
    expect(first.tool).toBe('search_symbols');
    expect(first.ms).toBe(13);
    expect(JSON.parse(lines[1]).repoId).toBeUndefined();
    expect(getSessionCalls()).toEqual({ total: 2, byTool: { search_symbols: 1, get_symbol_source: 1 } });
    expect(getLast24hCalls().total).toBe(2);
  });

  it('off switch → zero writes, session counters still count', () => {
    recordToolCall({ tool: 'list_repos', ms: 1 }, false);
    expect(existsSync(ledger)).toBe(false);
    expect(getSessionCalls().total).toBe(1);
  });

  it('rotates at 5 MB keeping one generation, and reads both', () => {
    writeFileSync(ledger, 'x'.repeat(LEDGER_ROTATE_BYTES));
    recordToolCall({ tool: 'health_radar', ms: 1 });
    expect(existsSync(`${ledger}.1`)).toBe(true);
    expect(statSync(ledger).size).toBeLessThan(1000);
    expect(readLedger().map((e) => e.tool)).toEqual(['health_radar']);
  });

  it('"this task" cursor: counts since the previous TaskCompleted, then advances', () => {
    recordToolCall({ tool: 'search_symbols', ms: 1 });
    recordToolCall({ tool: 'search_symbols', ms: 1 });
    recordToolCall({ tool: 'find_references', ms: 1 });
    const first = takeTaskCalls(Date.now() + 1);
    expect(first).toEqual({ total: 3, byTool: { search_symbols: 2, find_references: 1 } });
    const second = takeTaskCalls(Date.now() + 2);
    expect(second.total).toBe(0);
  });

  it('formats the calls line for humans', () => {
    expect(formatCallsLine({ total: 0, byTool: {} })).toBe('PureContext this task: 0 calls');
    expect(formatCallsLine(aggregate([
      { ts: 1, tool: 'search_symbols', sessionId: 's', ms: 1 },
      { ts: 1, tool: 'search_symbols', sessionId: 's', ms: 1 },
      { ts: 1, tool: 'get_symbol_source', sessionId: 's', ms: 1 },
    ]))).toBe('PureContext this task: 3 calls (search_symbols 2, get_symbol_source 1)');
    expect(formatCallsLine({ total: 1, byTool: { list_repos: 1 } })).toBe('PureContext this task: 1 call (list_repos 1)');
    const many: Record<string, number> = {};
    for (let i = 0; i < 8; i++) many[`t${i}`] = 1;
    expect(formatCallsLine({ total: 8, byTool: many })).toContain('+2 more');
  });
});
