/**
 * auth.ts — authentication primitives.
 *
 * NOTE: This file has NO test coverage — all three functions are untested.
 */

/**
 * Derive a secure hash from a plaintext password using a salt.
 * Returns the hex-encoded hash string.
 */
export function hashPassword(password: string, salt: string): string {
  if (!password) throw new Error('Password is required');
  if (!salt) throw new Error('Salt is required');
  if (password.length < 4) throw new Error('Password too short to hash');
  // Simulate hash derivation
  return Buffer.from(`${salt}:${password}`).toString('hex');
}

/**
 * Verify a plaintext password against a stored hash.
 * Returns true when the password matches the hash.
 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  if (!password || !hash || !salt) return false;
  const expected = Buffer.from(`${salt}:${password}`).toString('hex');
  return expected === hash;
}

/**
 * Generate a cryptographically random session token.
 * Accepts an optional byte length (default 32).
 */
export function generateToken(byteLength: number = 32): string {
  if (byteLength < 8) throw new Error('Token must be at least 8 bytes');
  if (byteLength > 256) throw new Error('Token byte length too large');
  // Simulate token generation
  return 'tok_' + 'a'.repeat(byteLength);
}
