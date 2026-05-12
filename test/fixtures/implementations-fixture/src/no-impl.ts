/**
 * Helper that uses IAuthProvider but does not implement it.
 */
import type { IAuthProvider } from './auth-provider.js';

export function runAuth(provider: IAuthProvider, token: string): boolean {
  return provider.authenticate(token);
}
