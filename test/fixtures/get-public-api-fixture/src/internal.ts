function privateHelper(value: string): string {
  return value.trim().toLowerCase();
}

function anotherHelper(n: number): number {
  return n * 2;
}

const SECRET_KEY = 'do-not-expose';

const INTERNAL_VERSION = 42;

class InternalCache {
  private store = new Map<string, unknown>();

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  get(key: string): unknown {
    return this.store.get(key);
  }
}
