/**
 * complex-module.ts — high complexity file for get_complexity_hotspots fixture.
 * Contains functions with high cyclomatic complexity and deep nesting.
 */

// High cyclomatic: many if/else branches (CC ≈ 12)
export function parseConfig(raw: unknown): Record<string, unknown> {
  if (!raw) {
    throw new Error('config is null');
  }
  if (typeof raw !== 'object') {
    throw new Error('config must be object');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj['host']) {
    throw new Error('host required');
  }
  if (typeof obj['host'] !== 'string') {
    throw new Error('host must be string');
  }
  if (!obj['port']) {
    obj['port'] = 3000;
  } else if (typeof obj['port'] === 'string') {
    obj['port'] = parseInt(obj['port'], 10);
  } else if (typeof obj['port'] !== 'number') {
    throw new Error('port must be number or string');
  }
  if (obj['timeout'] !== undefined) {
    if (typeof obj['timeout'] !== 'number') {
      throw new Error('timeout must be number');
    }
    if (obj['timeout'] < 0) {
      throw new Error('timeout must be non-negative');
    }
    if (obj['timeout'] > 60000) {
      throw new Error('timeout too large');
    }
  }
  return obj;
}

// High nesting: deeply nested loops and conditionals (CC ≈ 10, nesting ≈ 5)
export function processMatrix(
  matrix: number[][],
  filter: (v: number) => boolean,
): number[] {
  const results: number[] = [];
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row || row.length === 0) {
      continue;
    }
    for (let j = 0; j < row.length; j++) {
      const val = row[j];
      if (filter(val)) {
        if (val > 0) {
          if (val < 100) {
            if (val % 2 === 0) {
              results.push(val * 2);
            } else {
              results.push(val);
            }
          } else {
            results.push(100);
          }
        }
      }
    }
  }
  return results;
}

// High cyclomatic + many returns (CC ≈ 15)
export function validateUserInput(
  username: string,
  password: string,
  email: string,
  age: number,
): string | null {
  if (!username) return 'Username is required';
  if (username.length < 3) return 'Username too short';
  if (username.length > 50) return 'Username too long';
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'Username invalid characters';
  if (!password) return 'Password is required';
  if (password.length < 8) return 'Password too short';
  if (!/[A-Z]/.test(password)) return 'Password needs uppercase';
  if (!/[0-9]/.test(password)) return 'Password needs digit';
  if (!/[^a-zA-Z0-9]/.test(password)) return 'Password needs special char';
  if (!email) return 'Email is required';
  if (!email.includes('@')) return 'Email invalid';
  if (!email.includes('.')) return 'Email missing domain';
  if (age < 0) return 'Age cannot be negative';
  if (age > 150) return 'Age too large';
  return null;
}

// Moderately complex (CC ≈ 7)
export function routeRequest(
  method: string,
  path: string,
  handlers: Map<string, (p: string) => unknown>,
): unknown {
  const key = `${method.toUpperCase()}:${path}`;
  if (handlers.has(key)) {
    return handlers.get(key)!(path);
  }
  const wildcard = `${method.toUpperCase()}:*`;
  if (handlers.has(wildcard)) {
    return handlers.get(wildcard)!(path);
  }
  if (method === 'HEAD') {
    const getKey = `GET:${path}`;
    if (handlers.has(getKey)) {
      return null; // HEAD has no body
    }
  }
  throw new Error(`No handler for ${method} ${path}`);
}
