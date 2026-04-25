/**
 * Vue Single-File Component (SFC) pre-processor.
 *
 * Splits a raw .vue file buffer into typed ProcessedBlock[] so the TypeScript/
 * JavaScript language handlers can parse each script block independently.
 * Template and style blocks are intentionally omitted — they don't contain
 * symbols we want to index.
 *
 * Byte-offset correctness:
 *   offsetInOriginal is always computed from Buffer.byteLength(), never from
 *   string character indices. This ensures symbols inside multi-byte content
 *   that precedes the script block are positioned correctly.
 */

import type { ProcessedBlock } from '../core/types.js';
import { ParseError } from '../core/errors.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Split a Vue SFC buffer into its typed script blocks.
 *
 * Returns one ProcessedBlock per <script> / <script setup> block found,
 * with language set to 'typescript' when lang="ts" or lang="tsx" is present,
 * and 'javascript' otherwise.
 *
 * Returns [] for files with no script block (template/style-only SFCs).
 * Throws ParseError for files with mismatched <script> open/close tags.
 */
export function splitVueSFC(source: Buffer, filePath: string): ProcessedBlock[] {
  const str = source.toString('utf8');

  // ── Validate tag balance ──────────────────────────────────────────────────
  const openCount = countMatches(str, /<script\b/gi);
  const closeCount = countMatches(str, /<\/script>/gi);
  if (openCount !== closeCount) {
    throw new ParseError(
      `Malformed Vue SFC: ${openCount} <script> open tags but ${closeCount} </script> close tags`,
      filePath,
    );
  }

  if (openCount === 0) {
    return [];
  }

  // ── Extract script blocks ─────────────────────────────────────────────────
  // Captures: group 1 = attributes (everything between <script and >)
  //           group 2 = inner content
  const SCRIPT_RE = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  const blocks: ProcessedBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = SCRIPT_RE.exec(str)) !== null) {
    const attrs = match[1] ?? '';
    const innerContent = match[2] ?? '';

    // Byte offset of the first character of inner content within the original
    // file.  We reconstruct the open tag length in characters and then convert
    // the prefix to bytes so multi-byte characters before this point are
    // accounted for correctly.
    //
    //   match.index          → char index of '<'
    //   7                    → length of '<script'
    //   attrs.length         → attribute string length in chars
    //   1                    → the '>' character
    const contentCharStart = match.index + 7 + attrs.length + 1;
    const offsetInOriginal = Buffer.byteLength(str.slice(0, contentCharStart), 'utf8');

    const language = detectLanguage(attrs);

    blocks.push({
      content: Buffer.from(innerContent, 'utf8'),
      language,
      offsetInOriginal,
    });
  }

  return blocks;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Determine the block language from the <script> tag attributes string.
 *   lang="ts" | lang="tsx"  → 'typescript'
 *   lang="js" | (no lang)   → 'javascript'
 */
function detectLanguage(attrs: string): string {
  const langMatch = attrs.match(/\blang=["']([^"']+)["']/i);
  if (!langMatch) return 'javascript';
  const lang = langMatch[1]!.toLowerCase();
  return lang === 'ts' || lang === 'tsx' ? 'typescript' : 'javascript';
}

function countMatches(str: string, re: RegExp): number {
  return (str.match(re) ?? []).length;
}
