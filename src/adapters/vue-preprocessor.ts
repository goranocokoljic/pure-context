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
import { logger } from '../core/logger.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Split a Vue SFC buffer into its typed script blocks.
 *
 * Returns one ProcessedBlock per <script> / <script setup> block found, with
 * language 'typescript' for lang="ts", 'tsx' for lang="tsx" (JSX-capable
 * grammar), and 'javascript' otherwise.
 *
 * Returns [] for files with no script block (template/style-only SFCs).
 *
 * Resilience (Phase 93, Task 578 — P2 "never lose a whole file"): an
 * open/close COUNT mismatch no longer throws — a plain `</script>` inside
 * `<template>` (e.g. a JSON-LD `<script type="application/ld+json">` block, a
 * real pattern) previously killed the entire file to zero symbols. The
 * column-0-anchored blocks that DO match are extracted and a warning is
 * logged. Only a truly unterminated column-0 `<script>` open (no matching
 * close at all) still throws ParseError — that file would break Vue's own
 * compiler too (Phase-75 contract).
 */
export function splitVueSFC(source: Buffer, filePath: string): ProcessedBlock[] {
  const str = source.toString('utf8');

  // A real SFC top-level <script> block always starts at column 0. Anchoring
  // the OPEN match to the start of a line (multiline ^) ignores the many ways
  // "<script" legitimately appears *inside* a block without being a tag:
  //   • a regex literal in the script:   const re = /<script\b...<\/script>/g
  //   • an HTML string in script/template: '        <script src="...">'
  //     (whose closing tag is conventionally escaped as <\/script> to survive
  //      Vue's own compiler, so it never matches the plain close below).
  // The CLOSE match stays unanchored so single-line blocks
  // (`<script>…</script>`) still balance and parse correctly.
  const openCount = countMatches(str, /^<script\b/gim);
  const closeCount = countMatches(str, /<\/script>/gi);

  if (openCount === 0) {
    // No column-0 open — template/style-only SFC. Stray closes inside the
    // template are template content, not script boundaries.
    return [];
  }

  // ── Extract script blocks ─────────────────────────────────────────────────
  // Captures: group 1 = attributes (everything between <script and >)
  //           group 2 = inner content
  // Open anchored to column 0 (see above); non-greedy content stops at the
  // first plain </script>. The attribute run is quote-aware so a `>` inside a
  // quoted attribute value — `generic="T extends Record<string, any>"` — does
  // not terminate the tag early (V-6).
  const SCRIPT_RE = /^<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script>/gim;
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

  if (blocks.length < openCount) {
    // A column-0 <script> open never found a close — genuinely malformed.
    throw new ParseError(
      `Malformed Vue SFC: unterminated <script> open tag (${openCount} column-0 opens, ${blocks.length} complete blocks)`,
      filePath,
    );
  }

  if (openCount !== closeCount) {
    // Count mismatch but every column-0 open matched — the extra close lives
    // inside <template> (JSON-LD script etc.). Degrade to the blocks we have.
    logger.warn(
      `Vue SFC ${filePath}: ${openCount} column-0 <script> open tag(s) but ${closeCount} </script> close tag(s); extracted ${blocks.length} matching block(s)`,
    );
  }

  return blocks;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/**
 * Determine the block language from the <script> tag attributes string.
 *   lang="ts"              → 'typescript'
 *   lang="tsx"             → 'tsx'   (JSX-capable grammar; the plain TS
 *                                     grammar fails on literal JSX)
 *   lang="js" | (no lang)  → 'javascript' (the JS grammar handles JSX natively)
 */
function detectLanguage(attrs: string): string {
  const langMatch = attrs.match(/\blang=["']([^"']+)["']/i);
  if (!langMatch) return 'javascript';
  const lang = langMatch[1]!.toLowerCase();
  if (lang === 'tsx') return 'tsx';
  return lang === 'ts' ? 'typescript' : 'javascript';
}

function countMatches(str: string, re: RegExp): number {
  return (str.match(re) ?? []).length;
}
