import { a } from './a.js';

/** Function C — imports a, completing the triangle a → b → c → a. */
export function c(): string {
  return `c(${a()})`;
}

export const LABEL_C = 'c';
