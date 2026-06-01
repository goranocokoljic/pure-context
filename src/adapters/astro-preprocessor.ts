/**
 * Astro component pre-processor.
 *
 * An .astro file begins with an optional "frontmatter" block fenced by `---`
 * lines at the very top of the file; its contents are TypeScript. The remainder
 * is HTML-like template with JSX-style expressions and component usage, which we
 * do not index for symbols.
 *
 * This extracts the leading frontmatter as a single TypeScript ProcessedBlock.
 *
 * Byte-offset correctness:
 *   offsetInOriginal is computed from Buffer.byteLength() of the prefix up to and
 *   including the opening fence, never from string character indices.
 */

import type { ProcessedBlock } from '../core/types.js';
import { ParseError } from '../core/errors.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract the leading `---`-fenced frontmatter of an Astro component as a single
 * TypeScript block. The fence must be the first non-whitespace content in the
 * file (`---` appearing later in markup is ignored).
 *
 * Returns [] when there is no leading frontmatter.
 * Throws ParseError when a leading fence is opened but never closed.
 */
export function splitAstroSFC(source: Buffer, filePath: string): ProcessedBlock[] {
  const str = source.toString('utf8');

  // The opening fence must be the first non-whitespace content. A line of
  // exactly `---` (optionally with trailing spaces) starting the file.
  const openMatch = str.match(/^\s*---[ \t]*\r?\n/);
  if (!openMatch) {
    return []; // no frontmatter
  }

  const openLen = openMatch[0].length; // chars consumed by leading ws + `---` + newline
  const rest = str.slice(openLen);

  // Closing fence: a line that is exactly `---` (optionally trailing spaces).
  const closeMatch = rest.match(/\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/);
  if (!closeMatch) {
    throw new ParseError(`Malformed Astro component: unterminated frontmatter fence`, filePath);
  }

  const innerContent = rest.slice(0, closeMatch.index);
  const offsetInOriginal = Buffer.byteLength(str.slice(0, openLen), 'utf8');

  return [
    {
      content: Buffer.from(innerContent, 'utf8'),
      language: 'typescript',
      offsetInOriginal,
    },
  ];
}
