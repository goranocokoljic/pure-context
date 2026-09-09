/**
 * Phase 98, Task 612 — honesty riders: discovery reports what it silently
 * dropped, by reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverFiles } from '../../src/core/file-discovery.js';

describe('discoverFiles.dropped (Phase 98)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pc-drop-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src', 'notes.xyz'), 'plain\n');
    writeFileSync(join(root, 'src', 'blob.ts'), Buffer.from([0x41, 0x00, 0x42, 0x43]));
    writeFileSync(join(root, 'src', 'big.ts'), 'x'.repeat(5000));
    writeFileSync(join(root, 'src', 'id_rsa'), 'secret\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts unsupported extensions, binaries, oversized and secret files; indexes the rest', () => {
    const res = discoverFiles(root, { extensions: ['.ts'], maxFileSizeBytes: 1000 });
    expect(res.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(res.dropped.unsupportedExt).toBeGreaterThanOrEqual(1); // notes.xyz (+ id_rsa if not secret-matched)
    expect(res.dropped.binary).toBe(1);
    expect(res.dropped.oversized).toBe(1);
    expect(res.dropped.unsupportedExt + res.dropped.secret).toBe(2);
    expect(res.dropped.unreadableDirs).toBe(0);
  });
});
