/**
 * check-delete-safe.ts
 *
 * MCP tool: check_delete_safe
 *
 * Pre-flight check for deleting a symbol or file. Returns a binary verdict
 * and all live references that would break — so an agent can decide whether
 * deletion is safe without manually interpreting find_references output.
 *
 * Safety rules:
 *   safe: false — if any live (non-test) references exist in the repo
 *   safe: false — if symbol is exported AND includeExternalRisk: true
 *                 (exported symbols may be consumed by external npm packages)
 *   safe: false — if symbol is detected as an entry point
 *   safe: true  — zero live refs, not exported (or external risk ignored),
 *                 and not an entry point
 *
 * Modes:
 *   symbolId  — check a single named symbol
 *   filePath  — check all symbols in a file (aggregate verdict)
 *
 * Risk kinds:
 *   'live-reference'   — production code that imports or calls the symbol
 *   'exported-symbol'  — symbol is exported (potential external consumers)
 *   'entry-point'      — symbol is a route handler, main function, or framework default
 *   'test-subject'     — test file references the symbol (informational, not a hard block)
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { getAllFilesWithContent } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import type Database from 'better-sqlite3';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'check_delete_safe';

export const description =
  'Pre-flight check for deleting a symbol or file. Returns a verdict and all live ' +
  'references that would break if the symbol were removed. ' +
  'safe: false when live references exist, the symbol is exported (external consumers), ' +
  'or the symbol is an entry point (route handler, main export). ' +
  'Supports two modes: symbolId (single symbol) or filePath (all symbols in a file). ' +
  'Use search_symbols or get_file_outline to find a symbolId first.';

export const inputSchema = {
  repoId: z
    .string()
    .describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .optional()
    .describe(
      'Symbol ID of the symbol to check. Mutually exclusive with filePath. ' +
      'Use search_symbols to find the symbolId.',
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      'File path relative to the repo root — checks all symbols in the file and ' +
      'produces an aggregate verdict. Mutually exclusive with symbolId.',
    ),
  includeExternalRisk: z
    .boolean()
    .optional()
    .describe(
      'Warn when a symbol is exported but has no internal references ' +
      '(may be consumed by external npm packages). Default true. ' +
      'Set false to suppress this warning.',
    ),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeleteRisk {
  kind: 'live-reference' | 'exported-symbol' | 'entry-point' | 'test-subject';
  filePath: string;
  line?: number;
  detail: string;
}

interface CheckDeleteSafeOutput {
  safe: boolean;
  verdict: string;
  risks: DeleteRisk[];
  liveReferenceCount: number;
  isExported: boolean;
  isEntryPoint: boolean;
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

interface DbSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  signature: string;
}

interface FileEntry {
  path: string;
  rawContent: Buffer | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return true when a file path looks like a test file.
 * Matches: *.test.ts, *.spec.ts, /__tests__/, /test/, /tests/
 */
function isTestFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return (
    /\.test\.[jt]sx?$/.test(p) ||
    /\.spec\.[jt]sx?$/.test(p) ||
    /\/__tests__\//.test(p) ||
    /\/tests?\//.test(p)
  );
}

/** Return true when the signature contains the `export` keyword. */
function isExportedSignature(signature: string): boolean {
  return /\bexport\b/.test(signature);
}

/**
 * Heuristic entry-point detection.
 * A symbol is considered an entry point when:
 *   - its name is one of the well-known entry names (main, default, handler, index)
 *   - its signature contains a route/controller decorator
 *   - it is a default export from an index file
 */
function isEntryPointSymbol(name: string, signature: string, filePath: string): boolean {
  if (['main', 'default', 'handler', 'index'].includes(name)) return true;
  if (/@(Get|Post|Put|Delete|Patch|Route|Controller)\b/.test(signature)) return true;
  const fp = filePath.replace(/\\/g, '/');
  if (/\/index\.[jt]sx?$/.test(fp) && /\bdefault\b/.test(signature)) return true;
  return false;
}

/**
 * Scan all cached file contents for references to `symbolName`.
 * The definition file is excluded (deleting the symbol removes its definition too).
 * References found in test files are tagged 'test-subject'; all others 'live-reference'.
 */
function findRisksForSymbol(
  symbolName: string,
  definitionFilePath: string,
  files: FileEntry[],
): { risks: DeleteRisk[]; liveReferenceCount: number } {
  const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  const risks: DeleteRisk[] = [];
  let liveReferenceCount = 0;

  for (const { path, rawContent } of files) {
    if (!rawContent) continue;
    if (path === definitionFilePath) continue;

    const text = rawContent.toString('utf8');
    const lines = text.split('\n');
    const test = isTestFile(path);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!pattern.test(line)) continue;

      const context = line.trim().length > 120 ? line.trim().slice(0, 120) : line.trim();

      if (test) {
        risks.push({
          kind: 'test-subject',
          filePath: path,
          line: i + 1,
          detail: `Test file references "${symbolName}": ${context}`,
        });
      } else {
        liveReferenceCount++;
        risks.push({
          kind: 'live-reference',
          filePath: path,
          line: i + 1,
          detail: context,
        });
      }
    }
  }

  return { risks, liveReferenceCount };
}

/**
 * Run the full safety check for one symbol and return aggregated risk data.
 */
function checkOneSymbol(
  symbolName: string,
  symbolFilePath: string,
  symbolSignature: string,
  includeExternalRisk: boolean,
  files: FileEntry[],
): {
  risks: DeleteRisk[];
  liveReferenceCount: number;
  isExported: boolean;
  isEntryPoint: boolean;
} {
  const { risks, liveReferenceCount } = findRisksForSymbol(symbolName, symbolFilePath, files);

  const exported = isExportedSignature(symbolSignature);
  const entryPoint = isEntryPointSymbol(symbolName, symbolSignature, symbolFilePath);

  if (exported && includeExternalRisk) {
    risks.push({
      kind: 'exported-symbol',
      filePath: symbolFilePath,
      detail:
        `"${symbolName}" is exported and may be consumed by external packages. ` +
        `No internal references were found.`,
    });
  }

  if (entryPoint) {
    risks.push({
      kind: 'entry-point',
      filePath: symbolFilePath,
      detail: `"${symbolName}" appears to be an entry point (route handler, main export, or framework default).`,
    });
  }

  return { risks, liveReferenceCount, isExported: exported, isEntryPoint: entryPoint };
}

/**
 * Build a human-readable verdict sentence from aggregated risk data.
 */
function buildVerdict(
  safe: boolean,
  liveReferenceCount: number,
  isExported: boolean,
  isEntryPoint: boolean,
  risks: DeleteRisk[],
): string {
  if (safe) {
    const testCount = risks.filter((r) => r.kind === 'test-subject').length;
    const testNote = testCount > 0 ? ` (${testCount} test reference${testCount > 1 ? 's' : ''} will also break).` : '.';
    return `Safe to delete: no live references found${testNote}`;
  }

  const parts: string[] = [];

  if (liveReferenceCount > 0) {
    const fileSet = new Set(
      risks.filter((r) => r.kind === 'live-reference').map((r) => r.filePath),
    );
    parts.push(
      `${liveReferenceCount} live reference${liveReferenceCount > 1 ? 's' : ''} in ${fileSet.size} file${fileSet.size > 1 ? 's' : ''}`,
    );
  }

  if (isExported) {
    parts.push('symbol is exported (external consumers possible)');
  }

  if (isEntryPoint) {
    parts.push('symbol is an entry point');
  }

  return `Unsafe to delete: ${parts.join('; ')}.`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId?: string;
  filePath?: string;
  includeExternalRisk?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, filePath, includeExternalRisk = true } = args;

  if (!symbolId && !filePath) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Provide either symbolId or filePath.',
          }),
        },
      ],
      isError: true,
    };
  }

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

    const files = getAllFilesWithContent(db, repoId);

    // ── symbolId mode ──────────────────────────────────────────────────────────

    if (symbolId) {
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

      const { risks, liveReferenceCount, isExported, isEntryPoint } = checkOneSymbol(
        symbol.name,
        symbol.filePath,
        symbol.signature,
        includeExternalRisk,
        files,
      );

      const safe =
        liveReferenceCount === 0 &&
        (!isExported || !includeExternalRisk) &&
        !isEntryPoint;

      const verdict = buildVerdict(safe, liveReferenceCount, isExported, isEntryPoint, risks);

      const responseText = JSON.stringify(risks);
      const output: CheckDeleteSafeOutput = {
        safe,
        verdict,
        risks,
        liveReferenceCount,
        isExported,
        isEntryPoint,
        _tokenEstimate: Math.ceil(responseText.length / 4),
        _meta: buildMeta({ timingMs: Date.now() - t0 }),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    }

    // ── filePath mode ──────────────────────────────────────────────────────────

    const targetFilePath = filePath!;

    const symbolRows = db
      .prepare<[string, string], DbSymbolRow>(
        'SELECT id, name, kind, file_path, signature FROM symbols WHERE repo_id = ? AND file_path = ?',
      )
      .all(repoId, targetFilePath);

    if (symbolRows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `No symbols found for file "${targetFilePath}" in repo "${repoId}". ` +
                'Check the file path is relative to the repo root and the file is indexed.',
            }),
          },
        ],
        isError: true,
      };
    }

    // Aggregate results across all symbols in the file
    const allRisks: DeleteRisk[] = [];
    let totalLiveRefCount = 0;
    let anyExported = false;
    let anyEntryPoint = false;

    for (const row of symbolRows) {
      const { risks, liveReferenceCount, isExported, isEntryPoint } = checkOneSymbol(
        row.name,
        row.file_path,
        row.signature,
        includeExternalRisk,
        files,
      );
      allRisks.push(...risks);
      totalLiveRefCount += liveReferenceCount;
      if (isExported) anyExported = true;
      if (isEntryPoint) anyEntryPoint = true;
    }

    const safe =
      totalLiveRefCount === 0 &&
      (!anyExported || !includeExternalRisk) &&
      !anyEntryPoint;

    const verdict = buildVerdict(safe, totalLiveRefCount, anyExported, anyEntryPoint, allRisks);

    const responseText = JSON.stringify(allRisks);
    const output: CheckDeleteSafeOutput = {
      safe,
      verdict,
      risks: allRisks,
      liveReferenceCount: totalLiveRefCount,
      isExported: anyExported,
      isEntryPoint: anyEntryPoint,
      _tokenEstimate: Math.ceil(responseText.length / 4),
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
  } finally {
    db.close();
  }
}
