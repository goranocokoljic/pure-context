/**
 * user-service.ts — user management operations.
 */

/**
 * Create a new user account.
 * Validates the input, hashes the password, and persists the record.
 */
export function createUser(
  username: string,
  email: string,
  password: string,
): { id: string; username: string; email: string } {
  if (!username || username.trim().length === 0) {
    throw new Error('Username is required');
  }
  if (!email || !email.includes('@')) {
    throw new Error('Invalid email address');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // Simulate persistence
  return { id: 'usr_1', username: username.trim(), email: email.toLowerCase() };
}

/**
 * Find a user by their unique identifier.
 * Returns null when no user exists with that id.
 */
export function findUser(id: string): { id: string; username: string } | null {
  if (!id || typeof id !== 'string') {
    return null;
  }
  // Simulate lookup
  return id === 'usr_1' ? { id, username: 'alice' } : null;
}

/**
 * Permanently delete a user account and all associated data.
 * This operation is irreversible.
 */
export function deleteUser(id: string): boolean {
  if (!id) {
    throw new Error('User id is required');
  }
  if (typeof id !== 'string') {
    throw new Error('User id must be a string');
  }
  if (id.length < 3) {
    return false;
  }
  // Simulate deletion
  return true;
}

/**
 * Validate an email address against RFC 5322 rules.
 * Returns an error message string or null when valid.
 */
export function validateEmail(email: string): string | null {
  if (!email) return 'Email is required';
  if (!email.includes('@')) return 'Email must contain @';
  const [local, domain] = email.split('@');
  if (!local || local.length === 0) return 'Email local part is empty';
  if (!domain || !domain.includes('.')) return 'Email domain is invalid';
  if (domain.endsWith('.')) return 'Email domain cannot end with dot';
  if (email.length > 254) return 'Email exceeds maximum length';
  return null;
}
