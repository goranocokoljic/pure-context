/**
 * Phase 90 (Task 559) — end-to-end offset-integrity invariant.
 *
 * Indexes a mixed-encoding fixture repo through the full indexFolder pipeline
 * and asserts, for EVERY stored symbol, that byte-slicing the raw file content
 * with the stored start_byte/end_byte reproduces the exact source substring —
 * i.e. what get_symbol_source returns is byte-exact on any encoding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { pythonHandler } from '../../src/handlers/python.js';
import { goHandler } from '../../src/handlers/go.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { openDatabase } from '../../src/core/db/schema.js';
import { expandWithContextLines } from '../../src/core/symbol-source-helper.js';

let root: string;
let repoId: string;

function write(relPath: string, content: string | Buffer) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(pythonHandler);
  registerHandler(goHandler);
  await initParser();

  root = resolve(mkdtempSync(join(tmpdir(), 'pc-offsets-e2e-')));

  // ASCII control file
  write('src/plain.ts', 'export function plain(): number {\n  return 1;\n}\n');

  // Em-dash + box-drawing + arrows in comments (the PureContext self-corpus case)
  write(
    'src/decorated.ts',
    '// ─── Section — with arrows → and dashes ─────\n' +
      'export function decorated(): string {\n  return "x";\n}\n' +
      '// — another divider —\n' +
      'export const AFTER = 42;\n',
  );

  // Emoji + CJK
  write(
    'src/emoji.ts',
    '/* 🎉🎉 日本語のコメント 🎉🎉 */\nexport function party(): void {}\nexport class 後 {}\nexport const tail = 9;\n',
  );

  // BOM-prefixed file
  write(
    'src/bom.ts',
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('export function bommed(): number {\n  return 3;\n}\n', 'utf8'),
    ]),
  );

  // CRLF file (ASCII — must stay identity)
  write('src/crlf.ts', 'export function crlf(): number {\r\n  return 4;\r\n}\r\n');

  // Python with a non-ASCII docstring
  write(
    'pkg/mod.py',
    '# — café —\ndef greet():\n    """Grüße 🎉"""\n    return "hé"\n\nCONST_X = 1\n',
  );

  // Go with non-ASCII comment
  write(
    'gosrc/main.go',
    'package main\n\n// — Läuft 🎉 —\nfunc Run() int {\n\treturn 1\n}\n\nconst Answer = 42\n',
  );

  const result = await indexFolder(root, {});
  repoId = result.repoId;
});

afterAll(() => {
  try {
    deleteIndex(repoId);
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('offset integrity end-to-end', () => {
  it('every stored symbol byte-slices to text that re-encodes losslessly', () => {
    const db = openDatabase(repoId);
    try {
      const symbols = db
        .prepare<[string], { id: string; name: string; file_path: string; start_byte: number; end_byte: number }>(
          'SELECT id, name, file_path, start_byte, end_byte FROM symbols WHERE repo_id = ?',
        )
        .all(repoId);
      expect(symbols.length).toBeGreaterThan(8);

      for (const sym of symbols) {
        const raw = readFileSync(join(root, sym.file_path));
        const slice = raw.slice(sym.start_byte, sym.end_byte);
        const text = slice.toString('utf8');
        // Lossless round trip: a slice that cuts a multi-byte sequence (the
        // char-vs-byte bug) re-encodes to DIFFERENT bytes (U+FFFD expansion).
        expect(Buffer.from(text, 'utf8').equals(slice)).toBe(true);
        // A symbol's source never starts mid-comment garbage: it must not
        // begin with a replacement character.
        expect(text.startsWith('�')).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it('spot checks: exact declarations at exact byte spans', () => {
    const db = openDatabase(repoId);
    try {
      const get = (name: string) =>
        db
          .prepare<[string, string], { file_path: string; start_byte: number; end_byte: number }>(
            'SELECT file_path, start_byte, end_byte FROM symbols WHERE repo_id = ? AND name = ?',
          )
          .get(repoId, name);

      const cases: Array<[string, string]> = [
        ['decorated', 'export function decorated(): string {\n  return "x";\n}'],
        ['AFTER', 'export const AFTER = 42;'],
        ['party', 'export function party(): void {}'],
        ['tail', 'export const tail = 9;'],
        ['bommed', 'export function bommed(): number {\n  return 3;\n}'],
        ['crlf', 'export function crlf(): number {\r\n  return 4;\r\n}'],
      ];
      for (const [name, expected] of cases) {
        const sym = get(name);
        expect(sym, `symbol ${name} missing`).toBeDefined();
        const raw = readFileSync(join(root, sym!.file_path));
        const text = raw.slice(sym!.start_byte, sym!.end_byte).toString('utf8');
        expect(text, `span of ${name}`).toBe(expected);
      }
    } finally {
      db.close();
    }
  });

  it('expandWithContextLines returns byte-exact source for a symbol after non-ASCII text', () => {
    const db = openDatabase(repoId);
    try {
      const sym = db
        .prepare<[string, string], { file_path: string; start_byte: number; end_byte: number }>(
          'SELECT file_path, start_byte, end_byte FROM symbols WHERE repo_id = ? AND name = ?',
        )
        .get(repoId, 'AFTER');
      expect(sym).toBeDefined();
      const raw = readFileSync(join(root, sym!.file_path));
      const out = expandWithContextLines(raw, sym!.start_byte, sym!.end_byte, 0);
      expect(out).toBe('export const AFTER = 42;');
      // With context lines, the preceding divider line comes through intact
      const withCtx = expandWithContextLines(raw, sym!.start_byte, sym!.end_byte, 1);
      expect(withCtx).toContain('— another divider —');
    } finally {
      db.close();
    }
  });
});
