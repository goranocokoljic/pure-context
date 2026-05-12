import { hashValue } from '../utils/hash';

export function handleRequest(input: string): string {
  return hashValue(input);
}
