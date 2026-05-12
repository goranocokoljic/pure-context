import { parseContent } from '../../lib/parser';

export function consume(raw: string): string[] {
  return parseContent(raw);
}
