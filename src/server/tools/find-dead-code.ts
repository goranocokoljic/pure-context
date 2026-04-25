import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { findDeadCode } from '../../graph/graph-traversal.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_dead_code';

export const description =
  'Find exported symbols in files that are never imported by any other file in the repo. ' +
  'Helps identify potentially unused code that could be removed. ' +
  'Note: entry-point files (e.g. index.ts) are expected to appear here as nothing imports them.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
};

export function handler(args: { repoId: string }): CallToolResult {
  const db = openDatabase(args.repoId);
  const dead = findDeadCode(args.repoId, db);
  db.close();

  // Group by file for readability
  const byFile = new Map<string, typeof dead>();
  for (const s of dead) {
    let arr = byFile.get(s.filePath);
    if (!arr) { arr = []; byFile.set(s.filePath, arr); }
    arr.push(s);
  }

  const files = Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, symbols]) => ({
      filePath,
      symbols: symbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        signature: s.signature,
      })),
    }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { totalDeadSymbols: dead.length, files },
          null,
          2,
        ),
      },
    ],
  };
}
