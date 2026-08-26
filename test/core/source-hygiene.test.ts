/**
 * Task 552 — source-tree hygiene guards.
 *
 * (1) No raw NUL bytes in src/**: two NULs in di-edges.ts made git show the
 *     file as binary (no diff, no blame), hid it from grep, and — because
 *     isBinaryFile scans for NULs — made PureContext unable to index its own
 *     source. The bug class is "easy to introduce and almost invisible"
 *     (the reporter hit it twice; so did we, writing the phase plan).
 * (2) src/version.ts must match package.json — a stale committed value ships
 *     the wrong version in _meta and telemetry on dev-mode runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

const TEXT_EXTENSIONS = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|css|html)$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (TEXT_EXTENSIONS.test(entry)) acc.push(full);
  }
  return acc;
}

describe('source hygiene', () => {
  it('no file under src/ contains a raw NUL byte', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const buf = readFileSync(file);
      const idx = buf.indexOf(0);
      if (idx !== -1) offenders.push(`${file} (offset ${idx})`);
    }
    expect(offenders).toEqual([]);
  });

  it('src/version.ts matches package.json', async () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const { VERSION } = await import('../../src/version.js');
    expect(VERSION).toBe(pkg.version);
  });
});
