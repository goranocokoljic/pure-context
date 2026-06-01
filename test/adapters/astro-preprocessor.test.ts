import { describe, it, expect } from 'vitest';
import { splitAstroSFC } from '../../src/adapters/astro-preprocessor.js';
import { ParseError } from '../../src/core/errors.js';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

describe('splitAstroSFC', () => {
  it('extracts leading frontmatter as a typescript block', () => {
    const src = '---\nconst title: string = "Hi";\nimport Card from "./Card.astro";\n---\n<h1>{title}</h1>';
    const blocks = splitAstroSFC(buf(src), 'Page.astro');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.language).toBe('typescript');
    expect(blocks[0]!.content.toString('utf8')).toContain('const title');
    expect(blocks[0]!.content.toString('utf8')).toContain('import Card');
  });

  it('returns [] when there is no frontmatter', () => {
    expect(splitAstroSFC(buf('<h1>no frontmatter</h1>'), 'Page.astro')).toEqual([]);
  });

  it('does not treat a --- inside markup as frontmatter', () => {
    expect(splitAstroSFC(buf('<p>a</p>\n---\n<p>b</p>'), 'Page.astro')).toEqual([]);
  });

  it('computes byte offset correctly (multi-byte inside frontmatter)', () => {
    const src = '---\nconst café = "résumé";\n---\n<p>x</p>';
    const [block] = splitAstroSFC(buf(src), 'Page.astro');
    const slice = buf(src)
      .slice(block!.offsetInOriginal, block!.offsetInOriginal + block!.content.length)
      .toString('utf8');
    expect(slice).toContain('const café = "résumé";');
  });

  it('throws ParseError on unterminated frontmatter', () => {
    expect(() => splitAstroSFC(buf('---\nconst x = 1;\n<h1>no close</h1>'), 'Page.astro')).toThrow(ParseError);
  });
});
