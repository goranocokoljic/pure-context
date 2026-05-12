import { authenticate } from './auth';

export function runService(user: string): boolean {
  return authenticate(user);
}
