/**
 * Phase 90 — pipeline offset conversion tests.
 *
 * Stored startByte/endByte must be TRUE byte offsets: slicing the raw file
 * Buffer with them must reproduce the exact source text, on any encoding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { registerHandler } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { processFile } from '../../src/core/file-processor.js';
import type { FrameworkAdapter } from '../../src/core/types.js';

beforeAll(async () => {
  _resetForTesting();
  await initParser();
  registerHandler(typescriptHandler);
});

describe('processFile — char→byte conversion at the storage boundary', () => {
  it('non-ASCII header comment: stored spans are true byte offsets', async () => {
    const src = '/* — café 🎉 日本語 ─── */\nexport function greet(): number {\n  return 1;\n}\n';
    const buf = Buffer.from(src, 'utf8');
    const { symbols } = await processFile('src/a.ts', buf, []);
    const greet = symbols.find((s) => s.name === 'greet');
    expect(greet).toBeDefined();

    const expectedText = 'export function greet(): number {\n  return 1;\n}';
    const charStart = src.indexOf(expectedText);
    const trueByteStart = Buffer.byteLength(src.slice(0, charStart), 'utf8');
    expect(greet!.startByte).toBe(trueByteStart);
    // Round-trip: byte-slicing the raw buffer reproduces the exact source
    expect(buf.slice(greet!.startByte, greet!.endByte).toString('utf8')).toBe(expectedText);
  });

  it('BOM-prefixed file: spans account for the 3-byte BOM', async () => {
    const body = 'export const x = 1;\n';
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
    const { symbols } = await processFile('src/b.ts', buf, []);
    const x = symbols.find((s) => s.name === 'x');
    expect(x).toBeDefined();
    const sliced = buf.slice(x!.startByte, x!.endByte).toString('utf8');
    expect(sliced).toContain('x = 1');
    expect(sliced).not.toContain('﻿');
  });

  it('pure ASCII file: spans byte-identical to the pre-fix values (identity path)', async () => {
    const src = 'export function plain(): void {}\nexport const n = 2;\n';
    const buf = Buffer.from(src, 'utf8');
    const { symbols } = await processFile('src/c.ts', buf, []);
    for (const s of symbols) {
      // identity: char index === byte offset, and slices are exact
      expect(buf.slice(s.startByte, s.endByte).toString('utf8')).toBe(
        src.slice(s.startByte, s.endByte),
      );
    }
    const plain = symbols.find((s) => s.name === 'plain');
    expect(plain!.startByte).toBe(0);
  });

  it('adapter preProcess block after a non-ASCII prefix: byte shift + char conversion compose', async () => {
    const prefix = '<template>\n  <p>— café 🎉 —</p>\n</template>\n<script>\n';
    const script = 'export function inBlock(): number { return 42; }\n';
    const suffix = '</script>\n';
    const full = prefix + script + suffix;
    const fullBuf = Buffer.from(full, 'utf8');

    const fakeAdapter: FrameworkAdapter = {
      name: 'fake-sfc',
      extensions: () => ['.fake'],
      detect: async () => true,
      fileFilter: (p) => p.endsWith('.fake'),
      preProcess: () => [
        {
          content: Buffer.from(script, 'utf8'),
          language: 'typescript',
          offsetInOriginal: Buffer.byteLength(prefix, 'utf8'), // TRUE bytes, like real preprocessors
        },
      ],
      extractFrameworkSymbols: () => [],
    };

    const { symbols } = await processFile('src/comp.fake', fullBuf, [fakeAdapter]);
    const sym = symbols.find((s) => s.name === 'inBlock');
    expect(sym).toBeDefined();
    const expectedText = 'export function inBlock(): number { return 42; }';
    expect(fullBuf.slice(sym!.startByte, sym!.endByte).toString('utf8')).toBe(expectedText);
  });

  it('adapter framework symbols emitted in char space are converted', async () => {
    const src = '// — marker —\nexport const real = 1;\n';
    const buf = Buffer.from(src, 'utf8');
    const markerChar = src.indexOf('marker');
    const fakeAdapter: FrameworkAdapter = {
      name: 'fake-fw',
      extensions: () => [],
      detect: async () => true,
      fileFilter: (p) => p.endsWith('.ts'),
      extractFrameworkSymbols: () => [
        {
          id: 'deadbeefdeadbeef',
          name: 'marker',
          kind: 'route',
          filePath: 'src/d.ts',
          startByte: markerChar, // CHAR index, as adapters emit
          endByte: markerChar + 'marker'.length,
          signature: 'marker',
          summary: 'fake framework symbol',
        },
      ],
    };
    const { symbols } = await processFile('src/d.ts', buf, [fakeAdapter]);
    const marker = symbols.find((s) => s.name === 'marker');
    expect(marker).toBeDefined();
    expect(buf.slice(marker!.startByte, marker!.endByte).toString('utf8')).toBe('marker');
  });

  it('complexity metrics slice the correct byte range on non-ASCII files', async () => {
    const src = '/* 🎉🎉🎉 */\nexport function withBody(): number {\n  if (true) { return 1; }\n  return 0;\n}\n';
    const buf = Buffer.from(src, 'utf8');
    const { symbols } = await processFile('src/e.ts', buf, []);
    const fn = symbols.find((s) => s.name === 'withBody');
    expect(fn).toBeDefined();
    // Metrics are computed from the byte slice — a corrupted slice would start
    // mid-comment and change the token stream. Just assert it exists and the
    // slice is the function body.
    expect(buf.slice(fn!.startByte, fn!.endByte).toString('utf8').startsWith('export function withBody')).toBe(true);
  });
});
