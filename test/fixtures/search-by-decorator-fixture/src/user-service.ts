/**
 * Fixture: service classes with Injectable and custom decorators.
 * Used by search_by_decorator tests (Task 193).
 */

// ─── Stub decorators ──────────────────────────────────────────────────────────

export function Injectable(): ClassDecorator {
  return () => {};
}

export function Singleton(): ClassDecorator {
  return () => {};
}

export function Memoize(): MethodDecorator {
  return () => {};
}

export function Deprecated(message?: string): MethodDecorator & ClassDecorator {
  return () => {};
}

export function Log(level?: string): MethodDecorator {
  return () => {};
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
}

// ─── Service classes ──────────────────────────────────────────────────────────

@Injectable()
export class UserService {
  @Memoize()
  getUser(id: string): User | null {
    return null;
  }

  @Deprecated('Use getUserById instead')
  @Memoize()
  findUser(id: string): User | null {
    return null;
  }

  @Log('info')
  createUser(name: string): User {
    return { id: '1', name };
  }

  @Log('warn')
  deleteUser(id: string): void {
    // noop
  }
}

@Injectable()
@Singleton()
export class CacheService {
  @Memoize()
  get(key: string): unknown {
    return null;
  }

  @Memoize()
  set(key: string, value: unknown): void {
    // noop
  }
}

@Deprecated('Use UserService instead')
export class LegacyUserService {
  @Deprecated()
  getAll(): User[] {
    return [];
  }
}
