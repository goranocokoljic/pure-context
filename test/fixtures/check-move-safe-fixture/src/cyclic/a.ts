import { bFunc } from './b';

export function aFunc(x: number): number {
  return bFunc(x) + 1;
}
