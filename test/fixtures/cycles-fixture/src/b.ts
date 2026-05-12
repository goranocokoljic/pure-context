import { a } from './a.js';
import { c } from './c.js';

/** Function B — imports both a (mutual cycle) and c (triangle). */
export function b(): string {
  return `b(${a()})(${c()})`;
}

export const LABEL_B = 'b';
