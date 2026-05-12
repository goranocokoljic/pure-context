import type { IAuthProvider } from './auth-provider.js';

/**
 * BaseAuthProvider is an abstract base class that partially implements IAuthProvider.
 */
export abstract class BaseAuthProvider implements IAuthProvider {
  abstract authenticate(token: string): boolean;

  refresh(token: string): string {
    return token + '_refreshed';
  }
}
