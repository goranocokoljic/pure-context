/**
 * Shared helpers for symbol source retrieval: context-line expansion and
 * content-hash drift detection.  Used by get_symbol_source and get_symbols.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_CONTEXT_LINES = 50;

// ─── Context expansion ────────────────────────────────────────────────────────

/**
 * Given a file's Buffer and a symbol's byte range [startByte, endByte),
 * expand the extracted source by `contextLines` lines on each side.
 *
 * When contextLines === 0 the raw symbol bytes are returned unchanged.
 * The return value is always a UTF-8 string.
 */
export function expandWithContextLines(
  fileContent: Buffer,
  startByte: number,
  endByte: number,
  contextLines: number,
): string {
  if (contextLines === 0) {
    return fileContent.slice(startByte, endByte).toString('utf8');
  }

  // Build an index of byte offsets where each line starts.
  const lineStarts: number[] = [0];
  for (let i = 0; i < fileContent.length; i++) {
    if (fileContent[i] === 0x0a /* '\n' */) {
      lineStarts.push(i + 1);
    }
  }

  // Binary search: find which 0-indexed line a byte offset falls on.
  const findLine = (byte: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= byte) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const startLine = findLine(startByte);
  const endLine = findLine(Math.max(endByte - 1, startByte));

  const expandedStart = Math.max(0, startLine - contextLines);
  const expandedEnd = Math.min(lineStarts.length - 1, endLine + contextLines);

  const byteStart = lineStarts[expandedStart];
  const byteEnd =
    expandedEnd + 1 < lineStarts.length
      ? lineStarts[expandedEnd + 1]
      : fileContent.length;

  return fileContent.slice(byteStart, byteEnd).toString('utf8');
}

// ─── Hash drift detection ─────────────────────────────────────────────────────

export interface VerifyResult {
  drift: boolean;
  diskHash: string | null;
}

/**
 * Read `filePath` from disk, SHA-256 hash it, and compare with `cachedHash`.
 * Returns `{ drift: false, diskHash }` when the hashes match,
 * `{ drift: true,  diskHash }` when they differ,
 * `{ drift: false, diskHash: null }` when the file cannot be read (not found).
 *
 * Hash drift does NOT auto-trigger re-indexing — the caller decides what to do.
 */
export function verifyContentHash(
  filePath: string,
  cachedHash: string | null,
): VerifyResult {
  let diskHash: string | null = null;
  try {
    const content = readFileSync(filePath);
    diskHash = createHash('sha256').update(content).digest('hex');
  } catch {
    // File unreadable (deleted, permissions) — treat as no drift so we don't
    // report false positives; caller can handle the missing file separately.
    return { drift: false, diskHash: null };
  }

  const drift = cachedHash !== null && diskHash !== cachedHash;
  return { drift, diskHash };
}
