/**
 * Svelte component pre-processor.
 *
 * Splits a raw .svelte file buffer into typed ProcessedBlock[] so the TypeScript/
 * JavaScript language handlers can parse each <script> block independently.
 * Markup and <style> blocks are intentionally omitted — they don't contain
 * symbols we want to index.
 *
 * Svelte components may contain an instance <script> and an optional module
 * script (`<script context="module">` or `<script module>` in Svelte 5). Both
 * are extracted.
 *
 * Byte-offset correctness:
 *   offsetInOriginal is always computed from Buffer.byteLength(), never from
 *   string character indices, so symbols inside multi-byte content that precedes
 *   a script block are positioned correctly.
 */

import type { ProcessedBlock } from '../core/types.js';
import { ParseError } from '../core/errors.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Split a Svelte component buffer into its typed script blocks.
 *
 * Returns one ProcessedBlock per <script> block found, with language set to
 * 'typescript' when lang="ts"/lang="tsx" is present and 'javascript' otherwise.
 *
 * Returns [] for markup-only components (no <script>).
 * Throws ParseError for mismatched <script> open/close tags.
 */
export function splitSvelteSFC(source: Buffer, filePath: string): ProcessedBlock[] {
  const str = source.toString('utf8');

  // ── Validate tag balance ──────────────────────────────────────────────────
  const openCount = countMatches(str, /<script\b/gi);
  const closeCount = countMatches(str, /<\/script>/gi);
  if (openCount !== closeCount) {
    throw new ParseError(
      `Malformed Svelte component: ${openCount} <script> open tags but ${closeCount} </script> close tags`,
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
    // file. Reconstruct the open tag length in chars then convert the prefix to
    // bytes so multi-byte characters before this point are accounted for.
    //
    //   match.index   → char index of '<'
    //   7             → length of '<script'
    //   attrs.length  → attribute string length in chars
    //   1             → the '>' character
    const contentCharStart = match.index + 7 + attrs.length + 1;
    const offsetInOriginal = Buffer.byteLength(str.slice(0, contentCharStart), 'utf8');

    blocks.push({
      content: Buffer.from(innerContent, 'utf8'),
      language: detectLanguage(attrs),
      offsetInOriginal,
    });
  }

  return blocks;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Determine block language from the <script> tag attributes string.
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
