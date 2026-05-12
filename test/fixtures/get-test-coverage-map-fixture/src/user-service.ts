/**
 * User service for get_test_coverage_map fixture.
 */

export interface User { id: string; name: string; }

/** Creates a new user. */
export function createUser(name: string, email: string): User {
  if (!name) throw new Error('name required');
  return { id: 'u1', name };
}

/** Finds a user by id. */
export function findUser(id: string): User | null {
  if (!id) return null;
  return { id, name: 'Unknown' };
}

/** Deletes a user. NOT covered. */
export function deleteUser(id: string): boolean {
  if (!id) throw new Error('id required');
  return true;
}
