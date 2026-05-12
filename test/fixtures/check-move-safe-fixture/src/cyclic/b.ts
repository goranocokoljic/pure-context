import { aFunc } from './a';

export function bFunc(x: number): number {
  return aFunc(x) - 1;
}
