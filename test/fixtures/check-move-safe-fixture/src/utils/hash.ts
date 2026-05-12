/**
 * Hash utility — imported by main.ts, routes.ts, and api/handler.ts.
 * Used in check-move-safe tests as the "file to be moved".
 */

export function hashValue(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

export function shortHash(input: string): string {
  return hashValue(input).slice(0, 8);
}
