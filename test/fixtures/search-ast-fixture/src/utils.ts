/** Utility functions — arrow functions, template strings, await expressions. */

// Multiple arrow functions
export const identity = <T>(x: T): T => x;

export const pipe = <T>(...fns: Array<(x: T) => T>) =>
  (value: T): T => fns.reduce((acc, fn) => fn(acc), value);

export const memoize = <T, R>(fn: (arg: T) => R): ((arg: T) => R) => {
  const cache = new Map<T, R>();
  return (arg: T): R => {
    if (cache.has(arg)) return cache.get(arg)!;
    const result = fn(arg);
    cache.set(arg, result);
    return result;
  };
};

// Template literals
export const formatError = (msg: string, code: number): string =>
  `[Error ${code}] ${msg}`;

export const formatPath = (base: string, path: string): string =>
  `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

// Async utilities
export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Nested arrow functions
export const compose = <A, B, C>(
  f: (b: B) => C,
  g: (a: A) => B,
): ((a: A) => C) => (a) => f(g(a));

// Another await expression
export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
