/**
 * Fixture: standalone functions and multiple stacked decorators.
 * Used by search_by_decorator tests (Task 193).
 */

// ─── Stub decorators ──────────────────────────────────────────────────────────

export function Deprecated(message?: string): MethodDecorator & ClassDecorator & FunctionDecorator {
  return () => {};
}

export function Memoize(): FunctionDecorator {
  return () => {};
}

export function Retry(times: number): FunctionDecorator & MethodDecorator {
  return () => {};
}

export function Throttle(ms: number): FunctionDecorator & MethodDecorator {
  return () => {};
}

// TypeScript doesn't actually support function decorators at runtime,
// but for AST parsing purposes the decorator syntax is recognised.
type FunctionDecorator = (target: unknown, ...args: unknown[]) => unknown;

// ─── Functions with decorators ────────────────────────────────────────────────

export function computeHash(input: string): string {
  return input;
}

export function processData(data: unknown[]): unknown[] {
  return data;
}

// ─── Class with multiple stacked decorators on methods ───────────────────────

export class TaskRunner {
  @Retry(3)
  @Throttle(1000)
  runTask(id: string): Promise<void> {
    return Promise.resolve();
  }

  @Retry(5)
  @Deprecated('Use runTask instead')
  executeTask(id: string): Promise<void> {
    return Promise.resolve();
  }

  @Throttle(500)
  pollStatus(id: string): boolean {
    return false;
  }
}
