import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getAllFilesWithContent, getFileSizesBatch } from '../../core/db/file-store.js';
import { getSymbolsByFile } from '../../core/db/symbol-store.js';
import { buildMeta } from './_meta.js';
import type { SymbolKind, SymbolRecord } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_references';

export const description =
  'Find every file that uses (calls, references) a given identifier across the indexed repo. ' +
  'Distinct from find_importers, which works at the import-statement level — this scans ' +
  'actual file content for word-boundary matches of the identifier. ' +
  'Useful for finding all call sites, type usages, and variable accesses.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  identifier: z.string().min(1).describe('Symbol name to search for'),
  kind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
      'model', 'view', 'struct', 'macro', 'signal', 'namespace', 'widget',
    ])
    .optional()
    .describe('Optional: narrow definition exclusion to a specific symbol kind'),
  includeDefinition: z
    .boolean()
    .optional()
    .describe('When true, include the file(s) that define the identifier. Default false.'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReferenceLocation {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  symbolContext?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the innermost symbol whose byte range contains the given line's byte range.
 * Symbols must be sorted by start_byte (ascending) for deterministic results.
 */
function findEnclosingSymbol(
  symbols: SymbolRecord[],
  lineStartByte: number,
  lineEndByte: number,
): string | undefined {
  let best: SymbolRecord | undefined;
  for (const sym of symbols) {
    if (sym.startByte <= lineStartByte && sym.endByte >= lineEndByte) {
      // Prefer the innermost (smallest) enclosing range
      if (!best || sym.endByte - sym.startByte < best.endByte - best.startByte) {
        best = sym;
      }
    }
  }
  return best?.name;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId: string;
  identifier: string;
  kind?: SymbolKind;
  includeDefinition?: boolean;
}): CallToolResult {
  const t0 = Date.now();
  const { repoId, identifier, kind, includeDefinition = false } = args;

  const db = openDatabase(repoId);

  // Collect definition files so they can be optionally excluded
  const definitionFiles = new Set<string>();
  if (!includeDefinition) {
    const sql = kind
      ? 'SELECT DISTINCT file_path FROM symbols WHERE repo_id = ? AND name = ? AND kind = ?'
      : 'SELECT DISTINCT file_path FROM symbols WHERE repo_id = ? AND name = ?';
    const rows = (
      kind
        ? db.prepare<[string, string, string], { file_path: string }>(sql).all(repoId, identifier, kind)
        : db.prepare<[string, string], { file_path: string }>(sql).all(repoId, identifier)
    );
    for (const row of rows) {
      definitionFiles.add(row.file_path);
    }
  }

  const pattern = new RegExp(`\\b${escapeRegex(identifier)}\\b`);
  const references: ReferenceLocation[] = [];

  const files = getAllFilesWithContent(db, repoId);
  const allFilePaths = files.map((f) => f.path);

  for (const { path, rawContent } of files) {
    if (!rawContent) continue;
    if (!includeDefinition && definitionFiles.has(path)) continue;

    const text = rawContent.toString('utf8');
    const lines = text.split('\n');

    // Only load symbols for symbolContext when the file actually has matches
    let fileSymbols: SymbolRecord[] | null = null;

    let byteOffset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineByteLen = Buffer.byteLength(line, 'utf8');

      if (pattern.test(line)) {
        if (!fileSymbols) {
          fileSymbols = getSymbolsByFile(db, repoId, path);
        }
        const symCtx = findEnclosingSymbol(fileSymbols, byteOffset, byteOffset + lineByteLen);

        const ref: ReferenceLocation = {
          filePath: path,
          lineNumber: i + 1,
          lineContent: line.trim(),
        };
        if (symCtx !== undefined) {
          ref.symbolContext = symCtx;
        }
        references.push(ref);
      }

      byteOffset += lineByteLen + 1; // +1 for '\n'
    }
  }

  const fileSizes = getFileSizesBatch(db, repoId, allFilePaths);
  db.close();

  const rawBytes = allFilePaths.reduce((sum, fp) => sum + (fileSizes.get(fp) ?? 0), 0);
  const responseBytes = references.reduce(
    (sum, r) => sum + r.filePath.length + r.lineContent.length + (r.symbolContext?.length ?? 0),
    0,
  );

  const uniqueFiles = new Set(references.map((r) => r.filePath));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            identifier,
            totalFiles: uniqueFiles.size,
            references,
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
