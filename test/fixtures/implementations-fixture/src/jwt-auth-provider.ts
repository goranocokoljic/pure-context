import type { IAuthProvider } from './auth-provider.js';

/**
 * JwtAuthProvider implements JWT-based authentication.
 */
export class JwtAuthProvider implements IAuthProvider {
  authenticate(token: string): boolean {
    return token.startsWith('jwt.');
  }

  refresh(token: string): string {
    return 'jwt.' + token;
  }
}
