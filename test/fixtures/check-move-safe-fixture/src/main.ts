import { hashValue } from './utils/hash';

export function processMain(input: string): string {
  return hashValue(input);
}
