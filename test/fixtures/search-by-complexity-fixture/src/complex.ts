/**
 * High-complexity functions used to test complexity threshold filters.
 *
 * Expected metrics (approximate, based on heuristic calculator):
 *   processData     — CC>=6 (for+5 if), nesting>=4, params=5, lines>=25
 *   parseAndValidate — CC>=6 (multiple if/else if), nesting>=3, params=3, lines>=25
 */

export function processData(
  items: string[],
  config: Record<string, unknown>,
  validate: boolean,
  transform: boolean,
  limit: number,
): string[] {
  const results: string[] = [];
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (validate) {
      if (item.length > 10) {
        continue;
      }
    }
    if (transform) {
      if (typeof config['prefix'] === 'string') {
        results.push(config['prefix'] + item.toUpperCase());
      } else {
        results.push(item.toUpperCase());
      }
    } else {
      results.push(item);
    }
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

export function parseAndValidate(
  input: string,
  strict: boolean,
  allowEmpty: boolean,
): { valid: boolean; value: string | null; error: string | null } {
  if (!input && !allowEmpty) {
    return { valid: false, value: null, error: 'Input is empty' };
  }
  if (!input && allowEmpty) {
    return { valid: true, value: '', error: null };
  }
  const trimmed = input.trim();
  if (strict) {
    if (trimmed.length < 3) {
      return { valid: false, value: null, error: 'Too short' };
    }
    if (trimmed.length > 100) {
      return { valid: false, value: null, error: 'Too long' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      return { valid: false, value: null, error: 'Invalid characters' };
    }
  }
  return { valid: true, value: trimmed, error: null };
}
