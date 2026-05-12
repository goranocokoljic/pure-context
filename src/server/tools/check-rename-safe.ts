/**
 * check-rename-safe.ts
 *
 * MCP tool: check_rename_safe
 *
 * Pre-flight check for renaming a symbol. Returns a binary verdict, all
 * affected files, and the specific lines that will need updating — so an
 * agent can decide whether to proceed without manually inspecting raw
 * reference lists.
 *
 * Safety rules:
 *   safe: false  — if conflicts exist (newName already present in the same file)
 *   safe: false  — if any reference is a string-literal (runtime string that
 *                  won't be fixed by a text rename, requires human judgment)
 *   safe: true   — all other cases (comment references are included but not
 *                  blockers)
 *
 * changeType detection (in priority order):
 *   'comment'        — line starts with // or * (JSDoc)
 *   'import'         — line contains the `import` keyword
 *   'string-literal' — symbol name appears inside quote characters
 *   'type-reference' — line contains `type` or `interface` keyword
 *   'call'           — default
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getAllFilesWithContent } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'check_rename_safe';

export const description =
  'Pre-flight check for renaming a symbol. Returns a verdict, all affected files, ' +
  'and the specific lines that will need updating. ' +
  'safe: false when the new name conflicts with an existing symbol or when string-literal ' +
  'references exist that require manual updates. ' +
  'Use search_symbols to find the symbolId first.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z.string().describe('Symbol ID of the symbol to rename'),
  newName: z.string().min(1).describe('Proposed new name for the symbol'),
  checkConflicts: z
    .boolean()
    .optional()
    .describe(
      'Check if newName already exists in the same file (default true). ' +
      'Set false to skip conflict detection for speed.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AffectedSite {
  filePath: string;
  line: number;
  column: number;
  context: string;
  changeType: 'call' | 'import' | 'type-reference' | 'string-literal' | 'comment';
}

interface CheckRenameSafeOutput {
  safe: boolean;
  verdict: string;
  symbolName: string;
  newName: string;
  conflicts: string[];
  affectedSites: AffectedSite[];
  affectedFileCount: number;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classify a reference line into a change type.
 * Checked in priority order so that the most specific match wins.
 */
function detectChangeType(
  lineContent: string,
  symbolName: string,
): AffectedSite['changeType'] {
  const trimmed = lineContent.trim();

  // Comment: line starts with // or * (JSDoc block) or /*
  if (/^(\/\/|\*|\/\*)/.test(trimmed)) {
    return 'comment';
  }

  // Import statement
  if (/\bimport\b/.test(trimmed)) {
    return 'import';
  }

  // String literal: symbol name appears inside quote characters
  const escaped = escapeRegex(symbolName);
  if (new RegExp(`['"\`][^'"\`]*\\b${escaped}\\b[^'"\`]*['"\`]`).test(trimmed)) {
    return 'string-literal';
  }

  // Type reference: `type` or `interface` keyword on this line
  if (/\btype\b/.test(trimmed) || /\binterface\b/.test(trimmed)) {
    return 'type-reference';
  }

  // Default: call / variable usage
  return 'call';
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId: string;
  newName: string;
  checkConflicts?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, newName, checkConflicts = true } = args;

  const db = openDatabase(repoId);

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const symbol = getSymbolById(db, repoId, symbolId);
    if (!symbol) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Symbol "${symbolId}" not found in repo "${repoId}".`,
            }),
          },
        ],
        isError: true,
      };
    }

    // No-op: renaming to the same name is always safe
    if (symbol.name === newName) {
      const output: CheckRenameSafeOutput = {
        safe: true,
        verdict: `Safe to rename: new name is the same as the current name (no-op).`,
        symbolName: symbol.name,
        newName,
        conflicts: [],
        affectedSites: [],
        affectedFileCount: 0,
        _tokenEstimate: 0,
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    // ── 1. Find all references ────────────────────────────────────────────────

    const affectedSites: AffectedSite[] = [];
    const pattern = new RegExp(`\\b${escapeRegex(symbol.name)}\\b`);

    // Definition file is excluded from reference scan (we don't list the
    // declaration itself as an affected site — only call/import sites)
    const definitionFile = symbol.filePath;

    const files = getAllFilesWithContent(db, repoId);

    for (const { path, rawContent } of files) {
      if (!rawContent) continue;
      if (path === definitionFile) continue;

      const text = rawContent.toString('utf8');
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!pattern.test(line)) continue;

        const match = pattern.exec(line);
        const column = match ? match.index + 1 : 1; // 1-based

        affectedSites.push({
          filePath: path,
          line: i + 1,
          column,
          context: line.length > 120 ? line.slice(0, 120) : line,
          changeType: detectChangeType(line, symbol.name),
        });
      }
    }

    // ── 2. Conflict detection ─────────────────────────────────────────────────

    const conflicts: string[] = [];

    if (checkConflicts) {
      // Look for any symbol with newName in the same file as the declaration
      const conflictRows = db
        .prepare<[string, string, string], { name: string; file_path: string; kind: string }>(
          `SELECT name, file_path, kind FROM symbols
           WHERE repo_id = ? AND name = ? AND file_path = ?`,
        )
        .all(repoId, newName, definitionFile);

      for (const row of conflictRows) {
        conflicts.push(`${row.name} (${row.kind}) in ${row.file_path}`);
      }
    }

    // ── 3. Compute verdict ────────────────────────────────────────────────────

    const hasStringLiterals = affectedSites.some((s) => s.changeType === 'string-literal');
    const safe = conflicts.length === 0 && !hasStringLiterals;

    const uniqueFiles = new Set(affectedSites.map((s) => s.filePath));
    const affectedFileCount = uniqueFiles.size;

    const callCount = affectedSites.filter((s) => s.changeType === 'call').length;
    const importCount = affectedSites.filter((s) => s.changeType === 'import').length;
    const stringLitCount = affectedSites.filter((s) => s.changeType === 'string-literal').length;
    const commentCount = affectedSites.filter((s) => s.changeType === 'comment').length;
    const typeRefCount = affectedSites.filter((s) => s.changeType === 'type-reference').length;

    let verdict: string;
    if (!safe) {
      const reasons: string[] = [];
      if (conflicts.length > 0) {
        reasons.push(`"${newName}" conflicts with an existing symbol`);
      }
      if (hasStringLiterals) {
        reasons.push(`${stringLitCount} string-literal reference(s) require manual update`);
      }
      verdict = `Not safe to rename: ${reasons.join('; ')}. ${affectedFileCount} file(s) affected.`;
    } else {
      const breakdown: string[] = [];
      if (callCount > 0) breakdown.push(`${callCount} call site${callCount > 1 ? 's' : ''}`);
      if (importCount > 0) breakdown.push(`${importCount} import${importCount > 1 ? 's' : ''}`);
      if (typeRefCount > 0) breakdown.push(`${typeRefCount} type reference${typeRefCount > 1 ? 's' : ''}`);
      if (commentCount > 0) breakdown.push(`${commentCount} comment${commentCount > 1 ? 's' : ''}`);
      const detail = breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '';
      verdict = `Safe to rename: ${affectedFileCount} file${affectedFileCount !== 1 ? 's' : ''} affected${detail}. No conflicts.`;
    }

    const responseText = JSON.stringify(affectedSites);
    const output: CheckRenameSafeOutput = {
      safe,
      verdict,
      symbolName: symbol.name,
      newName,
      conflicts,
      affectedSites,
      affectedFileCount,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  } finally {
    db.close();
  }
}
