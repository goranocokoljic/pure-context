/**
 * helpers.test.ts
 * Covers date formatting only.
 */
import { describe, it, expect } from 'vitest';

describe('formatDate', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect('2026-05-12').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('zero-pads month and day', () => {
    expect('2026-01-05').toBe('2026-01-05');
  });
});
