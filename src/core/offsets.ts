/**
 * offsets.ts — char-index ↔ byte-offset conversion for symbol spans.
 *
 * web-tree-sitter is fed a decoded JS string (see parse-dispatcher.ts), so
 * `node.startIndex`/`node.endIndex` are UTF-16 CODE-UNIT indices, not byte
 * offsets. The symbols table stores TRUE UTF-8 byte offsets (`start_byte`/
 * `end_byte`), and every stored-offset consumer slices raw byte Buffers.
 * The conversion from code-unit index to byte offset happens ONCE per file
 * in the processing pipeline (file-processor.ts) using this module — never
 * inside individual handlers.
 *
 * UTF-16 code-unit subtleties handled here:
 *   - ASCII: 1 unit = 1 byte (identity fast path, zero cost)
 *   - Latin accents (é): 1 unit = 2 bytes
 *   - CJK / em-dash / arrows: 1 unit = 3 bytes
 *   - Emoji (surrogate pair): 2 units = 4 bytes
 *   - UTF-8 BOM: 1 unit = 3 bytes (Buffer#toString does NOT strip it)
 */

export interface OffsetConverter {
  /** Map a UTF-16 code-unit index into the decoded string → UTF-8 byte offset. */
  charToByte(charIndex: number): number;
  /** Map a UTF-8 byte offset → UTF-16 code-unit index into the decoded string. */
  byteToChar(byteOffset: number): number;
  /** True when the file is pure ASCII and the mapping is the identity. */
  identity: boolean;
}

const IDENTITY_CONVERTER: OffsetConverter = {
  charToByte: (i) => i,
  byteToChar: (i) => i,
  identity: true,
};

/**
 * Build a converter for one file. Pure ASCII files (byte length === decoded
 * char length) get a shared identity converter at zero cost; only non-ASCII
 * files pay the O(n) cumulative map build.
 *
 * Out-of-range indices clamp to the file bounds, so both `str.length` and
 * `buffer.length` map to `buffer.length` — whole-file spans survive either
 * convention. An index landing on the low surrogate of a pair maps to the
 * byte offset of the pair's start (degenerate input, kept deterministic).
 */
export function buildOffsetConverter(buffer: Buffer, decoded?: string): OffsetConverter {
  const str = decoded ?? buffer.toString('utf8');
  if (buffer.length === str.length) return IDENTITY_CONVERTER;

  // byteOfChar[i] = byte offset where code unit i starts. Length str.length + 1
  // so charToByte(str.length) === buffer.length.
  const byteOfChar = new Uint32Array(str.length + 1);
  let b = 0;
  let i = 0;
  while (i < str.length) {
    byteOfChar[i] = b;
    const unit = str.charCodeAt(i);
    if (unit < 0x80) {
      b += 1;
      i += 1;
    } else if (unit < 0x800) {
      b += 2;
      i += 1;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Surrogate pair: 2 code units, 4 UTF-8 bytes. The low-surrogate
        // index maps to the pair's start byte (mid-pair slices are degenerate).
        byteOfChar[i + 1] = b;
        b += 4;
        i += 2;
      } else {
        // Lone high surrogate — encoded as U+FFFD (3 bytes) by Buffer.from.
        b += 3;
        i += 1;
      }
    } else {
      // 3-byte range, including lone surrogates (encoded as replacement char).
      b += 3;
      i += 1;
    }
  }
  byteOfChar[str.length] = b;

  return {
    identity: false,
    charToByte(charIndex: number): number {
      if (charIndex <= 0) return 0;
      if (charIndex >= str.length) return buffer.length;
      return byteOfChar[charIndex]!;
    },
    byteToChar(byteOffset: number): number {
      if (byteOffset <= 0) return 0;
      if (byteOffset >= buffer.length) return str.length;
      // Binary search: largest char index whose start byte ≤ byteOffset.
      let lo = 0;
      let hi = str.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (byteOfChar[mid]! <= byteOffset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

/**
 * 1-based line number of a byte offset within a raw content Buffer.
 * Canonical implementation — line-derivation consumers share this.
 */
export function lineOfByte(content: Buffer, byteOffset: number): number {
  let line = 1;
  const cap = Math.min(byteOffset, content.length);
  for (let i = 0; i < cap; i++) {
    if (content[i] === 0x0a) line++;
  }
  return line;
}

// Memoized Buffer → decoded-string cache. Handlers slice node text out of the
// DECODED string (node indices are char-space); this avoids re-decoding the
// whole file once per symbol. WeakMap: entries die with their buffers.
const decodeCache = new WeakMap<Buffer, string>();

/** Decode a buffer to UTF-8 text, memoized per Buffer instance. */
export function decodeCached(buf: Buffer): string {
  let s = decodeCache.get(buf);
  if (s === undefined) {
    s = buf.toString('utf8');
    decodeCache.set(buf, s);
  }
  return s;
}

/**
 * 1-based line number of a UTF-16 code-unit index within a decoded string.
 * For query-time re-parse tools that operate purely in char space
 * (node.startIndex over the decoded source) — never mix with Buffers.
 */
export function lineOfChar(str: string, charIndex: number): number {
  let line = 1;
  const cap = Math.min(charIndex, str.length);
  for (let i = 0; i < cap; i++) {
    if (str.charCodeAt(i) === 0x0a) line++;
  }
  return line;
}

/**
 * Convert the char-space spans of freshly extracted symbols to true byte
 * offsets. Returns the same array when the converter is the identity (ASCII
 * fast path — byte-identical output by construction).
 */
export function convertSymbolSpans<T extends { startByte: number; endByte: number }>(
  symbols: T[],
  converter: OffsetConverter,
): T[] {
  if (converter.identity || symbols.length === 0) return symbols;
  return symbols.map((s) => ({
    ...s,
    startByte: converter.charToByte(s.startByte),
    endByte: converter.charToByte(s.endByte),
  }));
}
