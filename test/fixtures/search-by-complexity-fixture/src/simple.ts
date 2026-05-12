/**
 * Simple low-complexity utility functions.
 *
 * Expected metrics (approximate):
 *   add         — CC=1, lines=3,  params=2, nesting=1
 *   greet       — CC=1, lines=3,  params=1, nesting=1
 *   identity    — CC=1, lines=3,  params=1, nesting=1
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function identity<T>(value: T): T {
  return value;
}
