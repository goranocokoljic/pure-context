/**
 * diff-parser.ts
 *
 * Parses unified diff format (output of `git diff`) into structured data:
 * per-file changed line ranges, added/removed line content, and metadata
 * needed for symbol-level impact analysis.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiffHunk {
  /** 1-based start line in the old file. */
  oldStart: number;
  /** Number of lines in the old file covered by this hunk. */
  oldCount: number;
  /** 1-based start line in the new file. */
  newStart: number;
  /** Number of lines in the new file covered by this hunk. */
  newCount: number;
  /** 1-based old-file line numbers that were removed. */
  removedOldLines: number[];
  /** 1-based new-file line numbers that were added. */
  addedNewLines: number[];
  /** Content of removed lines, without the leading `-`. */
  removedContent: string[];
  /** Content of added lines, without the leading `+`. */
  addedContent: string[];
}

export interface FileDiff {
  /** File path in the old version (`null` for newly created files). */
  oldPath: string | null;
  /** File path in the new version (`null` for deleted files). */
  newPath: string | null;
  /** True when the file was created in this diff. */
  isNew: boolean;
  /** True when the file was deleted in this diff. */
  isDeleted: boolean;
  hunks: DiffHunk[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
// Strip `a/` / `b/` git prefixes; keep `/dev/null` for detection.
const OLD_PATH_RE = /^--- (?:a\/)?(.+)$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/)?(.+)$/;
const DEV_NULL = '/dev/null';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a unified-format diff string (e.g. the output of `git diff`) into an
 * array of `FileDiff` objects, one per changed file.
 */
export function parseDiff(text: string): FileDiff[] {
  const results: FileDiff[] = [];
  // Split on CRLF or LF. `git diff` emits LF, but a diff saved to a file (or
  // produced by tooling) on Windows can carry `\r`. Leaving the trailing `\r`
  // on each line breaks the `$`-anchored path regexes below (`.` does not match
  // `\r`, and `$` without the `m` flag does not match the position before it),
  // which would make a CRLF diff parse as zero files.
  const lines = text.split(/\r?\n/);

  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  // Line cursors that advance as we walk through a hunk.
  let oldLine = 0;
  let newLine = 0;

  function flushHunk() {
    if (currentHunk && current) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  }

  for (const line of lines) {
    // ── New file header ──────────────────────────────────────────────────────
    const oldMatch = OLD_PATH_RE.exec(line);
    if (oldMatch) {
      flushHunk();
      const rawPath = oldMatch[1]!.trim();
      // Start a new FileDiff when we see `---`. The `+++` line that follows
      // will set newPath and complete the header.
      current = {
        oldPath: rawPath === DEV_NULL ? null : rawPath,
        newPath: null,
        isNew: rawPath === DEV_NULL,
        isDeleted: false,
        hunks: [],
      };
      results.push(current);
      continue;
    }

    const newMatch = NEW_PATH_RE.exec(line);
    if (newMatch && current) {
      const rawPath = newMatch[1]!.trim();
      current.newPath = rawPath === DEV_NULL ? null : rawPath;
      current.isDeleted = rawPath === DEV_NULL;
      continue;
    }

    // ── Hunk header ──────────────────────────────────────────────────────────
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch && current) {
      flushHunk();
      oldLine = parseInt(hunkMatch[1]!, 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2]!, 10) : 1;
      newLine = parseInt(hunkMatch[3]!, 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4]!, 10) : 1;
      currentHunk = {
        oldStart: oldLine,
        oldCount,
        newStart: newLine,
        newCount,
        removedOldLines: [],
        addedNewLines: [],
        removedContent: [],
        addedContent: [],
      };
      continue;
    }

    // ── Hunk body lines ──────────────────────────────────────────────────────
    if (currentHunk) {
      if (line.startsWith('-')) {
        currentHunk.removedOldLines.push(oldLine);
        currentHunk.removedContent.push(line.slice(1));
        oldLine++;
      } else if (line.startsWith('+')) {
        currentHunk.addedNewLines.push(newLine);
        currentHunk.addedContent.push(line.slice(1));
        newLine++;
      } else if (line.startsWith(' ') || line === '') {
        // Context line — both sides advance.
        oldLine++;
        newLine++;
      }
      // Lines starting with `\` (e.g. `\ No newline at end of file`) are ignored.
    }
  }

  flushHunk();

  return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return the set of 1-based new-file line numbers that were changed
 * (i.e. are the destination of any addition in any hunk of this diff).
 */
export function getAddedNewLines(hunks: DiffHunk[]): Set<number> {
  const added = new Set<number>();
  for (const hunk of hunks) {
    for (const ln of hunk.addedNewLines) added.add(ln);
  }
  return added;
}

/**
 * Return the ranges [start, end] of the new file that are covered by each
 * hunk. Used to find which symbols overlap with any change.
 */
export function getChangedNewRanges(
  hunks: DiffHunk[],
): Array<{ start: number; end: number }> {
  return hunks.map((h) => ({
    start: h.newStart,
    end: h.newStart + Math.max(h.newCount - 1, 0),
  }));
}

/**
 * Extract candidate symbol names from the removed (`-`) lines of a diff,
 * using language-agnostic heuristics for common declaration patterns.
 * Returns a deduplicated array of names.
 */
export function parseDeletedSymbolNames(hunks: DiffHunk[]): string[] {
  const PATTERNS = [
    // TypeScript / JavaScript
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/,
    /(?:export\s+)?class\s+(\w+)[\s{<(]/,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?:=|:)/,
    /(?:export\s+)?(?:interface|type|enum)\s+(\w+)[\s{<]/,
    /(?:export\s+default\s+(?:async\s+)?function\s+(\w+))/,
    // Python
    /def\s+(\w+)\s*\(/,
    // Go
    /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,
    // Ruby
    /def\s+self\.(\w+)/,
    /def\s+(\w+)/,
    // Rust
    /(?:pub\s+)?fn\s+(\w+)\s*[(<]/,
    /(?:pub\s+)?struct\s+(\w+)[\s{<]/,
    /(?:pub\s+)?enum\s+(\w+)[\s{<]/,
    /(?:pub\s+)?trait\s+(\w+)[\s{<]/,
    // Java / Kotlin
    /(?:public|private|protected)?\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(/,
  ];

  const names = new Set<string>();
  for (const hunk of hunks) {
    for (const content of hunk.removedContent) {
      const trimmed = content.trim();
      for (const pattern of PATTERNS) {
        const m = pattern.exec(trimmed);
        if (m && m[1]) {
          names.add(m[1]);
          break;
        }
      }
    }
  }
  return [...names];
}
