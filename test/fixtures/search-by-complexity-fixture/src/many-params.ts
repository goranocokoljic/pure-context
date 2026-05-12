/**
 * Functions with varying parameter counts, used to test param-count filters.
 *
 * Expected metrics (approximate):
 *   noParams        — CC=1, params=0, lines=3
 *   oneParam        — CC=1, params=1, lines=3
 *   fiveParams      — CC=1, params=5, lines=3
 *   sevenParams     — CC=1, params=7, lines=3
 *   multiReturn     — CC=3, params=2, return_count>=4, lines>=12
 */

export function noParams(): string {
  return 'hello';
}

export function oneParam(x: number): number {
  return x * 2;
}

export function fiveParams(
  a: string,
  b: string,
  c: string,
  d: string,
  e: string,
): string {
  return a + b + c + d + e;
}

export function sevenParams(
  p1: number,
  p2: number,
  p3: number,
  p4: number,
  p5: number,
  p6: number,
  p7: number,
): number {
  return p1 + p2 + p3 + p4 + p5 + p6 + p7;
}

export function multiReturn(value: unknown, fallback: string): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value;
  }
  return fallback;
}
