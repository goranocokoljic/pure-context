import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { resolveRepoScope } from '../../core/db/repo-scope.js';
import { getAllFilesWithContent } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import { PureContextError } from '../../core/errors.js';
import type { SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_cross_repo_usages';

export const description =
  'Detect when source files in other indexed repos reference an identifier defined in a given repo. ' +
  'Useful for finding which downstream packages or services consume a symbol from a shared library. ' +
  'Uses word-boundary text search — results are heuristic, not type-resolved. ' +
  'For generic identifiers (e.g. "init", "handler") provide symbolKind to reduce false positives.';

export const inputSchema = {
  sourceRepoId: z.string().describe('Repo ID of the repo that defines the symbol'),
  symbolName: z.string().min(1).describe('Symbol name to search for in other repos'),
  symbolKind: z
    .enum([
      'function', 'class', 'method', 'const', 'type', 'interface', 'enum',
      'component', 'composable', 'hook', 'route', 'decorator', 'middleware',
      'model', 'view', 'struct', 'macro', 'signal', 'namespace', 'widget',
    ])
    .optional()
    .describe('Optional: filter symbol lookup in the source repo by kind (reduces false positives for generic names)'),
  targetRepoIds: z
    .array(z.string())
    .optional()
    .describe('Repos to search in. Omit to search all indexed repos except the source repo.'),
  limit: z.number().int().min(1).max(500).optional().describe('Max usages to return. Default 50.'),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CrossRepoUsage {
  targetRepoId: string;
  targetRepoName: string;
  filePath: string;
  lineNumber: number;
  lineContent: string;
  importPath?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a file's text for lines that contain a word-boundary match of `identifier`.
 * Returns the 1-based line number, trimmed line content, and (if detectable) an
 * import specifier from lines that start with import/require.
 */
function scanFileForUsages(
  filePath: string,
  rawContent: Buffer,
  pattern: RegExp,
  limit: number,
  collected: number,
  targetRepoId: string,
  targetRepoName: string,
  usages: CrossRepoUsage[],
): void {
  const text = rawContent.toString('utf8');
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (collected + usages.length >= limit) break;
    const line = lines[i];
    if (!pattern.test(line)) continue;

    const usage: CrossRepoUsage = {
      targetRepoId,
      targetRepoName,
      filePath,
      lineNumber: i + 1,
      lineContent: line.trim(),
    };

    // Heuristic: extract import specifier from import/require statements
    const importMatch = line.match(/from\s+['"]([^'"]+)['"]/);
    const requireMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    const specifier = importMatch?.[1] ?? requireMatch?.[1];
    if (specifier) {
      usage.importPath = specifier;
    }

    usages.push(usage);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  sourceRepoId: string;
  symbolName: string;
  symbolKind?: SymbolKind;
  targetRepoIds?: string[];
  limit?: number;
}): CallToolResult {
  const t0 = Date.now();
  const { sourceRepoId, symbolName, symbolKind, targetRepoIds, limit = 50 } = args;

  // 1. Confirm the symbol exists in the source repo
  const sourceDb = openDatabase(sourceRepoId);
  const symbolSql = symbolKind
    ? 'SELECT COUNT(*) as cnt FROM symbols WHERE repo_id = ? AND name = ? AND kind = ?'
    : 'SELECT COUNT(*) as cnt FROM symbols WHERE repo_id = ? AND name = ?';
  const symbolRow = (
    symbolKind
      ? sourceDb.prepare<[string, string, string], { cnt: number }>(symbolSql).get(sourceRepoId, symbolName, symbolKind)
      : sourceDb.prepare<[string, string], { cnt: number }>(symbolSql).get(sourceRepoId, symbolName)
  );
  sourceDb.close();

  if (!symbolRow || symbolRow.cnt === 0) {
    const kindNote = symbolKind ? ` (kind: ${symbolKind})` : '';
    const err = new PureContextError(
      `Symbol "${symbolName}"${kindNote} not found in source repo "${sourceRepoId}". ` +
      `Verify the symbol name and repoId with search_symbols first.`,
    );
    err.userMessage = err.message;
    throw err;
  }

  // 2. Resolve target repos — exclude source repo
  const candidates = resolveRepoScope(
    targetRepoIds && targetRepoIds.length > 0
      ? { repoIds: targetRepoIds }
      : {},
  ).filter((r) => r.id !== sourceRepoId);

  // 3. Word-boundary search across all target repos
  const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  const usages: CrossRepoUsage[] = [];
  let rawBytes = 0;

  for (const repo of candidates) {
    if (usages.length >= limit) break;

    const db = openDatabase(repo.id);
    const files = getAllFilesWithContent(db, repo.id);
    db.close();

    for (const { path, rawContent } of files) {
      if (usages.length >= limit) break;
      if (!rawContent) continue;

      rawBytes += rawContent.length;
      scanFileForUsages(path, rawContent, pattern, limit, usages.length, repo.id, repo.name, usages);
    }
  }

  // 4. Compute summary metrics
  const reposWithUsages = new Set(usages.map((u) => u.targetRepoId)).size;
  const responseBytes = usages.reduce(
    (sum, u) => sum + u.filePath.length + u.lineContent.length + (u.importPath?.length ?? 0),
    0,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            symbol: symbolName,
            sourceRepo: sourceRepoId,
            usageCount: usages.length,
            reposWithUsages,
            usages,
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
