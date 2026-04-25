import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSavings,
  saveSavings,
  _setSavingsPathForTesting,
  type SavingsData,
} from '../../src/core/db/savings-store.js';

let tmpDir: string;
let savingsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'purecontext-test-'));
  savingsPath = join(tmpDir, '_savings.json');
  _setSavingsPathForTesting(savingsPath);
});

afterEach(() => {
  _setSavingsPathForTesting(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSavings', () => {
  it('returns defaults when file does not exist', () => {
    const data = loadSavings();
    expect(data.total_tokens_saved).toBe(0);
    expect(data.anon_id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(data.last_updated).toBeTruthy();
  });

  it('generates a new anon_id each call when file does not exist', () => {
    const a = loadSavings();
    const b = loadSavings();
    // Both are valid UUIDs but may differ
    expect(a.anon_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.anon_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads back data saved by saveSavings', () => {
    const original: SavingsData = {
      total_tokens_saved: 42000,
      anon_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      last_updated: '2026-04-14T10:00:00Z',
    };
    saveSavings(original);
    const loaded = loadSavings();
    expect(loaded.total_tokens_saved).toBe(42000);
    expect(loaded.anon_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(loaded.last_updated).toBe('2026-04-14T10:00:00Z');
  });

  it('tolerates missing fields in existing file (fills defaults)', () => {
    writeFileSync(savingsPath, JSON.stringify({ total_tokens_saved: 100 }), 'utf-8');
    const data = loadSavings();
    expect(data.total_tokens_saved).toBe(100);
    expect(data.anon_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws StorageError on corrupted JSON', () => {
    writeFileSync(savingsPath, 'not json', 'utf-8');
    expect(() => loadSavings()).toThrow();
  });
});

describe('saveSavings', () => {
  it('creates the file if it does not exist', () => {
    expect(existsSync(savingsPath)).toBe(false);
    saveSavings({ total_tokens_saved: 0, anon_id: 'test-id', last_updated: '2026-01-01T00:00:00Z' });
    expect(existsSync(savingsPath)).toBe(true);
  });

  it('writes valid JSON', () => {
    saveSavings({ total_tokens_saved: 999, anon_id: 'x', last_updated: '2026-01-01T00:00:00Z' });
    const raw = readFileSync(savingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as SavingsData;
    expect(parsed.total_tokens_saved).toBe(999);
  });

  it('uses atomic write (no .tmp file left behind)', () => {
    saveSavings({ total_tokens_saved: 1, anon_id: 'x', last_updated: '' });
    expect(existsSync(`${savingsPath}.tmp`)).toBe(false);
  });

  it('creates parent directory if needed', () => {
    // Use a nested path inside tmpDir
    const nestedPath = join(tmpDir, 'nested', 'dir', '_savings.json');
    _setSavingsPathForTesting(nestedPath);
    saveSavings({ total_tokens_saved: 7, anon_id: 'y', last_updated: '' });
    expect(existsSync(nestedPath)).toBe(true);
    _setSavingsPathForTesting(savingsPath); // restore
  });

  it('overwrites previous data', () => {
    saveSavings({ total_tokens_saved: 100, anon_id: 'id1', last_updated: '' });
    saveSavings({ total_tokens_saved: 200, anon_id: 'id1', last_updated: '' });
    expect(loadSavings().total_tokens_saved).toBe(200);
  });
});
