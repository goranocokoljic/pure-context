import { authenticate } from './auth';

export function checkAuth(user: string): boolean {
  return authenticate(user);
}
