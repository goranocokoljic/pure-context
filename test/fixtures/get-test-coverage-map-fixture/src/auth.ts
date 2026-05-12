/**
 * Auth helpers for get_test_coverage_map fixture.
 */

/** Hashes a password. Covered. */
export function hashPassword(password: string): string {
  return `hash:${password}`;
}

/** Generates a token. NOT covered. */
export function generateToken(length = 32): string {
  return Math.random().toString(36).slice(0, length);
}
