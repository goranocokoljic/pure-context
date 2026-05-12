/**
 * IAuthProvider defines the authentication contract for all providers.
 */
export interface IAuthProvider {
  authenticate(token: string): boolean;
  refresh(token: string): string;
}
