import { b } from './b.js';

/** Function A — part of a mutual cycle with b, and a triangle with b and c. */
export function a(): string {
  return `a(${b()})`;
}

export const LABEL_A = 'a';
