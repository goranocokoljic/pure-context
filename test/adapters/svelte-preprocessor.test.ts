import { describe, it, expect } from 'vitest';
import { splitSvelteSFC } from '../../src/adapters/svelte-preprocessor.js';
import { ParseError } from '../../src/core/errors.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('splitSvelteSFC', () => {
  it('extracts a plain <script> block as javascript', () => {
    const blocks = splitSvelteSFC(buf('<script>\nlet count = 0;\n</script>\n<p>{count}</p>'), 'C.svelte');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('javascript');
    expect(blocks[0]!.content.toString('utf8')).toContain('let count = 0;');
  });

  it('detects lang="ts" as typescript', () => {
    const blocks = splitSvelteSFC(buf('<script lang="ts">const x: number = 1;</script>'), 'C.svelte');
    expect(blocks[0]!.language).toBe('typescript');
  });

  it('extracts both instance and module scripts', () => {
    const sfc = '<script context="module">export const load = () => {};</script>\n<script>let a = 1;</script>';
    const blocks = splitSvelteSFC(buf(sfc), 'C.svelte');
    expect(blocks).toHaveLength(2);
  });

  it('returns [] for markup-only components', () => {
    expect(splitSvelteSFC(buf('<h1>hello</h1>'), 'C.svelte')).toEqual([]);
  });

  it('computes byte offsets correctly after multi-byte content', () => {
    // Comment with multi-byte chars before the script block
    const sfc = '<!-- café résumé 日本語 -->\n<script>const z = 1;</script>';
    const [block] = splitSvelteSFC(buf(sfc), 'C.svelte');
    const slice = buf(sfc).slice(block!.offsetInOriginal, block!.offsetInOriginal + block!.content.length).toString('utf8');
    expect(slice).toBe('const z = 1;');
  });

  it('throws ParseError on mismatched script tags', () => {
    expect(() => splitSvelteSFC(buf('<script>oops'), 'C.svelte')).toThrow(ParseError);
  });
});
