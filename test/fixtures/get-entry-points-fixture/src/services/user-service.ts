/**
 * User service — NOT an entry point.
 * This file exists to ensure the tool does not classify internal service
 * functions as entry points.
 */

export interface User {
  id: string;
  email: string;
}

/** Find a user by ID. */
export function findUser(id: string): User | undefined {
  return { id, email: `${id}@example.com` };
}

/** Create a new user. */
export function createUser(email: string): User {
  return { id: Math.random().toString(36).slice(2), email };
}

/** Internal helper — validates email format. */
function isValidEmail(email: string): boolean {
  return /^[^@]+@[^@]+\.[^@]+$/.test(email);
}
