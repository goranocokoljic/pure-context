import { funcB } from './circular-b.js';

/**
 * Function A — part of a circular dependency with circular-b.
 * Returns a greeting string using funcB.
 */
export function funcA(): string {
  return `A(${funcB()})`;
}

export const LABEL_A = 'circular-a';
