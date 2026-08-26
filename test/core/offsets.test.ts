import { describe, it, expect } from 'vitest';
import { buildOffsetConverter, lineOfByte, convertSymbolSpans } from '../../src/core/offsets.js';

describe('buildOffsetConverter', () => {
  it('pure ASCII takes the identity fast path', () => {
    const buf = Buffer.from('function foo() { return 1; }\n', 'utf8');
    const conv = buildOffsetConverter(buf);
    expect(conv.identity).toBe(true);
    expect(conv.charToByte(10)).toBe(10);
    expect(conv.byteToChar(10)).toBe(10);
  });

  it('em-dash (3 bytes, 1 unit)', () => {
    const str = '// — divider\nfn';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    expect(conv.identity).toBe(false);
    const fnChar = str.indexOf('fn');
    const fnByte = Buffer.byteLength(str.slice(0, fnChar), 'utf8');
    expect(conv.charToByte(fnChar)).toBe(fnByte);
    expect(conv.byteToChar(fnByte)).toBe(fnChar);
  });

  it('box-drawing divider (─, 3 bytes each)', () => {
    const str = '// ───\nx';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const xChar = str.indexOf('x');
    expect(conv.charToByte(xChar)).toBe(Buffer.byteLength(str.slice(0, xChar), 'utf8'));
  });

  it('CJK text', () => {
    const str = '// 日本語コメント\nconst a = 1;';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const cChar = str.indexOf('const');
    const cByte = Buffer.byteLength(str.slice(0, cChar), 'utf8');
    expect(conv.charToByte(cChar)).toBe(cByte);
    expect(conv.byteToChar(cByte)).toBe(cChar);
  });

  it('emoji surrogate pair (2 units, 4 bytes)', () => {
    const str = '// 🎉 party\nlet x';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const letChar = str.indexOf('let');
    const letByte = Buffer.byteLength(str.slice(0, letChar), 'utf8');
    expect(conv.charToByte(letChar)).toBe(letByte);
    expect(conv.byteToChar(letByte)).toBe(letChar);
    // The emoji itself: 2 UTF-16 units but 4 UTF-8 bytes
    const emojiChar = str.indexOf('🎉');
    expect(conv.charToByte(emojiChar + 2) - conv.charToByte(emojiChar)).toBe(4);
  });

  it('accented latin (é, 1 unit, 2 bytes)', () => {
    const str = 'const café = 1;\nconst next = 2;';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const nChar = str.indexOf('next');
    expect(conv.charToByte(nChar)).toBe(Buffer.byteLength(str.slice(0, nChar), 'utf8'));
  });

  it('BOM-prefixed file (1 unit, 3 bytes — toString keeps it)', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc', 'utf8')]);
    const str = buf.toString('utf8');
    expect(str.length).toBe(4); // BOM survives as U+FEFF
    const conv = buildOffsetConverter(buf);
    expect(conv.identity).toBe(false);
    // char 1 = 'a', which sits at byte 3
    expect(conv.charToByte(1)).toBe(3);
    expect(conv.byteToChar(3)).toBe(1);
  });

  it('CRLF file is identity when otherwise ASCII (\\r is 1 byte = 1 unit)', () => {
    const buf = Buffer.from('line one\r\nline two\r\n', 'utf8');
    const conv = buildOffsetConverter(buf);
    expect(conv.identity).toBe(true);
  });

  it('clamps out-of-range indices to file bounds', () => {
    const str = 'a—b';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    expect(conv.charToByte(-1)).toBe(0);
    expect(conv.charToByte(str.length)).toBe(buf.length);
    expect(conv.charToByte(buf.length)).toBe(buf.length); // byte-length input clamps too
    expect(conv.byteToChar(buf.length + 5)).toBe(str.length);
  });

  it('round-trip property: byte slice at converted offsets === string slice (code-point boundaries)', () => {
    const str = '/* 🎉 café — 日本語 ─── */\nfunction greet() {\n  return "héllo — 世界";\n}\n';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const boundaries: number[] = [];
    for (let i = 0; i <= str.length; i++) {
      const code = i < str.length ? str.charCodeAt(i) : 0;
      // skip low surrogates — mid-pair boundaries are degenerate
      if (code >= 0xdc00 && code <= 0xdfff) continue;
      boundaries.push(i);
    }
    for (const i of boundaries) {
      for (const j of boundaries) {
        if (j < i) continue;
        const bytes = buf.slice(conv.charToByte(i), conv.charToByte(j));
        expect(bytes.toString('utf8')).toBe(str.slice(i, j));
      }
    }
  });

  it('accepts a pre-decoded string to avoid double decoding', () => {
    const str = 'a — b';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf, str);
    expect(conv.charToByte(str.indexOf('b'))).toBe(Buffer.byteLength(str.slice(0, str.indexOf('b')), 'utf8'));
  });
});

describe('lineOfByte', () => {
  it('counts 1-based lines by newline bytes', () => {
    const buf = Buffer.from('a\nb\nc\n', 'utf8');
    expect(lineOfByte(buf, 0)).toBe(1);
    expect(lineOfByte(buf, 2)).toBe(2);
    expect(lineOfByte(buf, 4)).toBe(3);
    expect(lineOfByte(buf, 999)).toBe(4);
  });
});

describe('convertSymbolSpans', () => {
  it('returns the same array for identity converters (ASCII regression guard)', () => {
    const buf = Buffer.from('const a = 1;', 'utf8');
    const conv = buildOffsetConverter(buf);
    const syms = [{ startByte: 0, endByte: 12, name: 'a' }];
    expect(convertSymbolSpans(syms, conv)).toBe(syms);
  });

  it('converts spans for non-ASCII files', () => {
    const str = '// — note\nconst a = 1;';
    const buf = Buffer.from(str, 'utf8');
    const conv = buildOffsetConverter(buf);
    const start = str.indexOf('const');
    const syms = [{ startByte: start, endByte: str.length }];
    const out = convertSymbolSpans(syms, conv);
    expect(out[0]!.startByte).toBe(Buffer.byteLength(str.slice(0, start), 'utf8'));
    expect(out[0]!.endByte).toBe(buf.length);
    expect(buf.slice(out[0]!.startByte, out[0]!.endByte).toString('utf8')).toBe(str.slice(start));
  });
});
