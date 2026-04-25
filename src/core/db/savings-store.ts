import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { StorageError } from '../errors.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavingsData {
  total_tokens_saved: number;
  anon_id: string;
  last_updated: string;
}

// ─── Path override (for testing) ─────────────────────────────────────────────

let _pathOverride: string | null = null;

export function _setSavingsPathForTesting(path: string | null): void {
  _pathOverride = path;
}

function getSavingsPath(): string {
  if (_pathOverride !== null) return _pathOverride;
  return join(homedir(), '.purecontext', '_savings.json');
}

function getSavingsDir(): string {
  if (_pathOverride !== null) return join(_pathOverride, '..');
  return join(homedir(), '.purecontext');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function loadSavings(): SavingsData {
  const path = getSavingsPath();

  if (!existsSync(path)) {
    return {
      total_tokens_saved: 0,
      anon_id: randomUUID(),
      last_updated: new Date().toISOString(),
    };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SavingsData>;
    return {
      total_tokens_saved: typeof parsed.total_tokens_saved === 'number' ? parsed.total_tokens_saved : 0,
      anon_id: parsed.anon_id ?? randomUUID(),
      last_updated: parsed.last_updated ?? new Date().toISOString(),
    };
  } catch (err) {
    throw new StorageError('Failed to load savings data', 'loadSavings', err);
  }
}

export function saveSavings(data: SavingsData): void {
  const dir = getSavingsDir();
  const path = getSavingsPath();
  const tmpPath = `${path}.tmp`;

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    throw new StorageError('Failed to save savings data', 'saveSavings', err);
  }
}
