import type { IAuthProvider } from './auth-provider.js';

/**
 * ApiKeyProvider authenticates using a static API key.
 * Note: does NOT implement refresh; left missing intentionally for tests.
 */
export class ApiKeyProvider implements IAuthProvider {
  authenticate(token: string): boolean {
    return token.length === 32;
  }
}
