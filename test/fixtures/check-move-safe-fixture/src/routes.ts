import { hashValue } from './utils/hash';

export function routeHash(path: string): string {
  return hashValue(path);
}
