import { authenticate } from './auth';

export function handleLogin(user: string): boolean {
  return authenticate(user);
}
