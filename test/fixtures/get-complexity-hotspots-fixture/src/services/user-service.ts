/**
 * user-service.ts — moderate complexity service.
 */

export interface User {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
  active: boolean;
}

// Moderate complexity (CC ≈ 6)
export function authorizeAction(
  user: User,
  action: string,
  resource: string,
): boolean {
  if (!user.active) return false;
  if (user.role === 'admin') return true;
  if (action === 'read') return true;
  if (action === 'write' && user.role === 'editor') {
    if (resource.startsWith('public/')) return true;
    return false;
  }
  return false;
}

// Low complexity (CC ≈ 2)
export function getUserDisplayName(user: User): string {
  return user.active ? user.name : `${user.name} (inactive)`;
}
