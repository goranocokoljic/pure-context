/**
 * Parse JSDoc / TSDoc comment text and extract a clean one-line description.
 *
 * Accepts both:
 *   - raw comment text including delimiters (`/** ... *\/`)
 *   - already-stripped text (no delimiters)
 */
export function extractSummaryFromDocstring(raw: string): string | null {
  if (!raw.trim()) return null;

  // ── 1. Strip /** ... */ delimiters if present ─────────────────────────────
  let body = raw.trim();
  if (body.startsWith('/**')) {
    body = body.slice(2);
    if (body.endsWith('*/')) body = body.slice(0, -2);
  } else if (body.startsWith('/*')) {
    body = body.slice(2);
    if (body.endsWith('*/')) body = body.slice(0, -2);
  } else if (body.startsWith('//')) {
    body = body.replace(/^\/\/\s?/, '').trim();
    return cleanText(body) || null;
  }

  // ── 2. Strip leading * from each line ────────────────────────────────────
  const lines = body
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim());

  // ── 3. Check for @description tag ────────────────────────────────────────
  const descIdx = lines.findIndex((l) => /^@description\b/i.test(l));
  if (descIdx >= 0) {
    // Collect content after @description (possibly multi-line, until next @tag)
    const descLine = lines[descIdx].replace(/^@description\s*/i, '');
    const continuation: string[] = descLine ? [descLine] : [];
    for (let i = descIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('@')) break;
      if (lines[i]) continuation.push(lines[i]);
    }
    const descText = continuation.join(' ');
    if (descText) return firstSentence(cleanText(descText));
  }

  // ── 4. First paragraph: lines before the first @tag or blank+@tag ────────
  const paragraphLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@')) break;   // reached a tag
    paragraphLines.push(line);
  }

  // Collapse runs of blank lines to one, then use the first non-empty block
  const paragraphText = paragraphLines
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!paragraphText) return null;

  return firstSentence(cleanText(paragraphText)) || null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip inline markdown formatting:
 *   `code`, **bold**, *italic*, _italic_, ~~strikethrough~~, [text](url)
 */
function cleanText(text: string): string {
  return text
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1))   // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, '$1')              // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')                  // *italic* → italic
    .replace(/_([^_]+)_/g, '$1')                    // _italic_ → italic
    .replace(/~~([^~]+)~~/g, '$1')                  // ~~strike~~ → strike
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // [text](url) → text
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Return text up to (and including) the first sentence-ending punctuation,
 * or the full text if none found, capped at 120 chars.
 */
function firstSentence(text: string): string {
  const match = text.match(/^(.{1,120}?[.!?])(?:\s|$)/);
  if (match) return match[1].trim();
  return text.slice(0, 120).trim();
}
