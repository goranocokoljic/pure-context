import { describe, it, expect } from 'vitest';
import { prepareSymbolText, prepareBatch } from '../../src/semantic/text-preparation.js';
import type { SymbolRecord } from '../../src/core/types.js';
import type { EmbeddingProvider } from '../../src/semantic/embedding-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sym(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: 'aabbccddeeff0011',
    name: 'myFunction',
    kind: 'function',
    filePath: 'src/utils.ts',
    startByte: 0,
    endByte: 100,
    signature: 'function myFunction(x: number): string',
    summary: 'Converts a number to its string representation.',
    ...overrides,
  };
}

function fakeProvider(maxTokens: number): Pick<EmbeddingProvider, 'maxTokens'> {
  return { maxTokens };
}

// ─── prepareSymbolText ────────────────────────────────────────────────────────

describe('prepareSymbolText', () => {
  it('includes name, signature, and summary', () => {
    const text = prepareSymbolText(sym());
    expect(text).toContain('myFunction');
    expect(text).toContain('function myFunction(x: number): string');
    expect(text).toContain('Converts a number to its string representation.');
  });

  it('formats first line as "{name}: {signature}"', () => {
    const text = prepareSymbolText(sym());
    const firstLine = text.split('\n')[0];
    expect(firstLine).toBe('myFunction: function myFunction(x: number): string');
  });

  it('omits summary when it is empty', () => {
    const text = prepareSymbolText(sym({ summary: '' }));
    expect(text.split('\n')).toHaveLength(1);
  });

  it('omits summary when it equals the signature', () => {
    const sig = 'function myFunction(x: number): string';
    const text = prepareSymbolText(sym({ summary: sig }));
    const lines = text.split('\n');
    expect(lines).toHaveLength(1);
  });

  it('appends docstring from frameworkMeta when present', () => {
    const s = sym({
      frameworkMeta: { docstring: 'Detailed docs here.' },
    });
    const text = prepareSymbolText(s);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('Detailed docs here.');
  });

  it('does not duplicate summary if docstring equals summary', () => {
    const s = sym({
      summary: 'Does something.',
      frameworkMeta: { docstring: 'Does something.' },
    });
    const text = prepareSymbolText(s);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2); // name+sig, summary (docstring skipped as duplicate)
  });

  it('ignores non-string frameworkMeta.docstring', () => {
    const s = sym({ frameworkMeta: { docstring: 42 } });
    const text = prepareSymbolText(s);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2); // no docstring line
  });

  it('truncates text to maxTokens (≈ 4 chars per token)', () => {
    const longSummary = 'x'.repeat(10_000);
    const text = prepareSymbolText(sym({ summary: longSummary }), 100);
    // 100 tokens × 4 chars = 400 chars max
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('does not truncate text within limit', () => {
    const s = sym({ summary: 'Short.' });
    const full = prepareSymbolText(s, 4096);
    const capped = prepareSymbolText(s, 10);
    // With 10 tokens = 40 chars, the full text should exceed that
    expect(full.length).toBeGreaterThan(capped.length);
  });

  it('falls back gracefully when signature is empty', () => {
    const text = prepareSymbolText(sym({ signature: '' }));
    const firstLine = text.split('\n')[0];
    expect(firstLine).toBe('myFunction');
  });
});

// ─── prepareBatch ─────────────────────────────────────────────────────────────

describe('prepareBatch', () => {
  it('returns one string per symbol', () => {
    const symbols = [sym({ name: 'a' }), sym({ name: 'b' }), sym({ name: 'c' })];
    const texts = prepareBatch(symbols, fakeProvider(4096));
    expect(texts).toHaveLength(3);
  });

  it('each text is the result of prepareSymbolText', () => {
    const s = sym();
    const [text] = prepareBatch([s], fakeProvider(4096));
    expect(text).toBe(prepareSymbolText(s, 4096));
  });

  it('truncates each text independently to provider maxTokens', () => {
    const s1 = sym({ summary: 'a'.repeat(5000) });
    const s2 = sym({ summary: 'b'.repeat(5000) });
    const maxTokens = 50; // 200 chars
    const [t1, t2] = prepareBatch([s1, s2], fakeProvider(maxTokens));
    expect(t1.length).toBeLessThanOrEqual(200);
    expect(t2.length).toBeLessThanOrEqual(200);
  });

  it('returns empty array for empty input', () => {
    expect(prepareBatch([], fakeProvider(4096))).toEqual([]);
  });
});
