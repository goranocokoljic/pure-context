import { z } from 'zod';
import { minimatch } from 'minimatch';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllFilesWithContent } from '../../core/db/file-store.js';
import { validatePath } from '../../core/security.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'search_text';

export const description =
  'Search for a literal string or regex pattern across all cached file content in an indexed repo. ' +
  'Returns matching lines with surrounding context. ' +
  'Complements search_symbols (which searches symbol names) by finding arbitrary strings in source.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  query: z.string().describe('Literal string or regex pattern to search for'),
  isRegex: z.boolean().default(false).describe('Treat query as a regular expression (default false)'),
  filePattern: z
    .string()
    .optional()
    .describe("Glob pattern to filter which files are searched (e.g. '**/*.ts')"),
  contextLines: z
    .number()
    .int()
    .min(0)
    .default(2)
    .describe('Lines of context to show before and after each match (default 2)'),
  maxResults: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe('Maximum number of matches to return (default 50)'),
};

// ─── Match record ─────────────────────────────────────────────────────────────

interface MatchRecord {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId: string;
  query: string;
  isRegex?: boolean;
  filePattern?: string;
  contextLines?: number;
  maxResults?: number;
}): CallToolResult {
  const t0 = Date.now();
  const { repoId, query, isRegex = false, filePattern, contextLines = 2, maxResults = 50 } = args;

  const db = openDatabase(repoId);

  const repo = getRepo(db, repoId);
  if (!repo) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${repoId}" not found` }) }],
      isError: true,
    };
  }

  let pattern: RegExp;
  try {
    pattern = isRegex ? new RegExp(query, 'g') : new RegExp(escapeRegex(query), 'g');
  } catch (err) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Invalid regex: ${err}` }) }],
      isError: true,
    };
  }

  const files = getAllFilesWithContent(db, repoId);
  db.close();

  const matches: MatchRecord[] = [];
  let filesSearched = 0;
  let truncated = false;
  let rawBytes = 0;

  for (const file of files) {
    if (!file.rawContent) continue;

    if (filePattern && !minimatch(file.path, filePattern, { matchBase: false, dot: true })) {
      continue;
    }

    try {
      validatePath(file.path, repo.rootPath);
    } catch {
      continue;
    }

    filesSearched++;
    rawBytes += file.rawContent.length;

    const text = file.rawContent.toString('utf8');
    const lines = text.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      pattern.lastIndex = 0;

      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }

        const contextBefore = lines
          .slice(Math.max(0, lineIdx - contextLines), lineIdx)
          .join('\n');
        const contextAfter = lines
          .slice(lineIdx + 1, lineIdx + 1 + contextLines)
          .join('\n');

        const contextParts = [contextBefore, line, contextAfter].filter((p) => p !== '');

        matches.push({
          file: file.path,
          line: lineIdx + 1,
          column: m.index + 1,
          match: m[0],
          context: contextParts.join('\n'),
        });

        if (m[0].length === 0) {
          pattern.lastIndex++;
        }
      }

      if (truncated) break;
    }

    if (truncated) break;
  }

  const responseBytes = matches.reduce(
    (sum, m) => sum + m.context.length + m.file.length + m.match.length,
    0,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            matches,
            total_matches: matches.length,
            files_searched: filesSearched,
            truncated,
            _meta: buildMeta({ timingMs: Date.now() - t0, rawBytes, responseBytes }),
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
