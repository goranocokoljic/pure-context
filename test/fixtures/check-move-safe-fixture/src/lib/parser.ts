/**
 * Parser utility — imported by src/deep/nested/consumer.ts.
 * Used to test deep relative path computation (../../lib/parser → ../parser).
 */

export function parseContent(raw: string): string[] {
  return raw.split('\n').filter(Boolean);
}
