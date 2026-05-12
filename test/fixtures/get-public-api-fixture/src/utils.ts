export const MAX_RETRIES = 3;

export const DEFAULT_TIMEOUT = 5000;

export function retry<T>(fn: () => Promise<T>, times = MAX_RETRIES): Promise<T> {
  return fn().catch((err) => {
    if (times <= 0) throw err;
    return retry(fn, times - 1);
  });
}

export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

function isValidEmail(email: string): boolean {
  return email.includes('@') && email.includes('.');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const INTERNAL_TIMEOUT = 30_000;
