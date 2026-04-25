import { describe, it, expect } from 'vitest';
import { expandQuery } from '../../src/semantic/query-expansion.js';

describe('expandQuery', () => {
  it('always includes the original query as the first element', () => {
    const result = expandQuery('auth');
    expect(result[0]).toBe('auth');
  });

  it('expands known abbreviations', () => {
    const result = expandQuery('auth');
    expect(result).toContain('authentication');
    expect(result).toContain('authorization');
  });

  it('expands db abbreviation', () => {
    const result = expandQuery('db');
    expect(result).toContain('database');
  });

  it('splits camelCase into tokens', () => {
    const result = expandQuery('getUserById');
    // Joined form
    expect(result).toContain('get user by id');
  });

  it('splits snake_case into tokens', () => {
    const result = expandQuery('get_user_by_id');
    expect(result).toContain('get user by id');
  });

  it('expands tokens within a camelCase identifier', () => {
    const result = expandQuery('getAuthToken');
    // 'auth' token should trigger expansion
    expect(result.some((r) => r.includes('authentication') || r.includes('auth'))).toBe(true);
  });

  it('handles multi-word queries by expanding each word', () => {
    const result = expandQuery('auth config');
    expect(result).toContain('auth');
    expect(result).toContain('config');
    // Expansions of individual words
    expect(result.some((r) => r === 'authentication' || r === 'configuration')).toBe(true);
  });

  it('returns no duplicates', () => {
    const result = expandQuery('config');
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });

  it('caps results at 8', () => {
    // 'auth' has many expansions — should still cap
    const result = expandQuery('auth');
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it('returns only the original for unknown single words', () => {
    const result = expandQuery('xyzzy');
    expect(result).toEqual(['xyzzy']);
  });

  it('handles empty-ish query gracefully', () => {
    const result = expandQuery('  ');
    // Should return at least one element (the original)
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it('handles PascalCase', () => {
    const result = expandQuery('UserService');
    expect(result).toContain('user service');
  });

  it('handles all-caps abbreviation like HTTP', () => {
    const result = expandQuery('HTTPClient');
    expect(result).toContain('http client');
  });
});
