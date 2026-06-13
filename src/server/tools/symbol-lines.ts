/**
 * symbol-lines.ts
 *
 * Shared helpers for mapping a symbol's byte range to a 1-based line range,
 * using the file content cached in the index. Extracted from
 * get-churn-metrics.ts so churn and risk scoring share one implementation.
 */

import type Database from 'better-sqlite3';

/**
 * Convert a byte offset to a 1-based line number within `content`.
 */
export function byteOffsetToLine(content: Buffer, byteOffset: number): number {
  let line = 1;
  const cap = Math.min(byteOffset, content.length);
  for (let i = 0; i < cap; i++) {
    if (content[i] === 0x0a) line++;
  }
  return line;
}

export interface SymbolLineRange {
  filePath: string;
  startLine: number;
  endLine: number;
  /** endLine − startLine + 1 (number of source lines the symbol spans). */
  lineSpan: number;
}

/**
 * Load a symbol's 1-based line range by reading the cached file content and
 * converting its byte offsets. Returns null if the symbol or content is missing.
 */
export function getSymbolLineRange(
  db: Database.Database,
  repoId: string,
  symbolId: string,
): SymbolLineRange | null {
  const sym = db
    .prepare<[string, string], { file_path: string; start_byte: number; end_byte: number }>(
      'SELECT file_path, start_byte, end_byte FROM symbols WHERE repo_id = ? AND id = ?',
    )
    .get(repoId, symbolId);
  if (!sym) return null;

  const contentRow = db
    .prepare<[string, string], { raw_content: Buffer | null }>(
      'SELECT raw_content FROM files WHERE repo_id = ? AND path = ?',
    )
    .get(repoId, sym.file_path);
  if (!contentRow?.raw_content) return null;

  const content = contentRow.raw_content;
  const startLine = byteOffsetToLine(content, sym.start_byte);
  const endLine = byteOffsetToLine(content, sym.end_byte);
  return { filePath: sym.file_path, startLine, endLine, lineSpan: Math.max(1, endLine - startLine + 1) };
}
