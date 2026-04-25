import { funcA } from './circular-a.js';

/**
 * Function B — part of a circular dependency with circular-a.
 * Returns a greeting string using funcA.
 */
export function funcB(): string {
  return `B(${funcA()})`;
}

export const LABEL_B = 'circular-b';
