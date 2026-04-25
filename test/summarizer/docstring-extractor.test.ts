import { describe, it, expect } from 'vitest';
import { extractSummaryFromDocstring } from '../../src/summarizer/docstring-extractor.js';

// ─── Basic extraction ─────────────────────────────────────────────────────────

describe('extractSummaryFromDocstring — basic extraction', () => {
  it('returns null for empty input', () => {
    expect(extractSummaryFromDocstring('')).toBeNull();
    expect(extractSummaryFromDocstring('   ')).toBeNull();
  });

  it('extracts single-line /** comment */', () => {
    expect(extractSummaryFromDocstring('/** Format a diagnostic. */')).toBe(
      'Format a diagnostic.',
    );
  });

  it('extracts first sentence from multi-line comment', () => {
    const raw = `/**
 * Format a diagnostic message for display.
 * Returns a human-readable string with severity and location.
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Format a diagnostic message for display.',
    );
  });

  it('handles already-stripped text (no delimiters)', () => {
    expect(extractSummaryFromDocstring('Format a diagnostic message.')).toBe(
      'Format a diagnostic message.',
    );
  });

  it('returns text up to 120 chars when no sentence-ending punctuation', () => {
    const long = 'A'.repeat(200);
    const result = extractSummaryFromDocstring(long)!;
    expect(result.length).toBeLessThanOrEqual(120);
  });
});

// ─── @description tag ────────────────────────────────────────────────────────

describe('extractSummaryFromDocstring — @description tag', () => {
  it('uses @description content in preference to first paragraph', () => {
    const raw = `/**
 * Short title.
 * @description Full description of the function.
 * @param x - the argument
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Full description of the function.',
    );
  });

  it('handles multi-line @description', () => {
    const raw = `/**
 * @description Runs the batch job and waits
 * for completion.
 * @returns void
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Runs the batch job and waits for completion.',
    );
  });
});

// ─── Tag stripping ────────────────────────────────────────────────────────────

describe('extractSummaryFromDocstring — tag stripping', () => {
  it('stops collecting at @param tag', () => {
    const raw = `/**
 * Compute the sum of two numbers.
 * @param a - first operand
 * @param b - second operand
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Compute the sum of two numbers.',
    );
  });

  it('stops collecting at @returns tag', () => {
    const raw = `/**
 * Get the current user session.
 * @returns The user session or null.
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Get the current user session.',
    );
  });

  it('stops collecting at @throws tag', () => {
    const raw = `/**
 * Opens the database connection.
 * @throws {ConnectionError} when credentials are invalid
 */`;
    expect(extractSummaryFromDocstring(raw)).toBe(
      'Opens the database connection.',
    );
  });
});

// ─── Inline markdown stripping ───────────────────────────────────────────────

describe('extractSummaryFromDocstring — inline markdown', () => {
  it('strips backtick code spans', () => {
    expect(extractSummaryFromDocstring('/** Calls `readFile` internally. */')).toBe(
      'Calls readFile internally.',
    );
  });

  it('strips **bold** markers', () => {
    expect(extractSummaryFromDocstring('/** **Important**: use sparingly. */')).toBe(
      'Important: use sparingly.',
    );
  });

  it('strips *italic* markers', () => {
    expect(extractSummaryFromDocstring('/** Returns the *first* matching item. */')).toBe(
      'Returns the first matching item.',
    );
  });

  it('strips _italic_ markers', () => {
    expect(extractSummaryFromDocstring('/** Returns the _first_ matching item. */')).toBe(
      'Returns the first matching item.',
    );
  });

  it('strips [text](url) links, keeping text', () => {
    expect(
      extractSummaryFromDocstring('/** See [MDN docs](https://mdn.io) for details. */'),
    ).toBe('See MDN docs for details.');
  });
});

// ─── Line comment ─────────────────────────────────────────────────────────────

describe('extractSummaryFromDocstring — // line comment', () => {
  it('extracts content from // comment', () => {
    expect(extractSummaryFromDocstring('// Filter diagnostics by minimum severity.')).toBe(
      'Filter diagnostics by minimum severity.',
    );
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('extractSummaryFromDocstring — edge cases', () => {
  it('returns null when comment has only @tags and no description', () => {
    const raw = `/**
 * @param x - value
 * @returns number
 */`;
    expect(extractSummaryFromDocstring(raw)).toBeNull();
  });

  it('handles single * comment (non-JSDoc)', () => {
    const raw = `/* Simple comment */`;
    expect(extractSummaryFromDocstring(raw)).toBe('Simple comment');
  });
});
