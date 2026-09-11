import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getImportersOf } from '../../core/db/dep-store.js';
import { getSymbolsByFile } from '../../core/db/symbol-store.js';
import { findDeadCode } from '../../graph/graph-traversal.js';
import { crossReferencedLocalFiles, openWorkspace } from '../../graph/workspace-graph.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'find_dead_code';

export const description =
  'Find exported symbols in files that are never imported by any other file in the repo. ' +
  'Helps identify potentially unused code that could be removed. ' +
  'Note: entry-point files (e.g. index.ts) are expected to appear here as nothing imports them. ' +
  'Files imported from a LINKED index (since 1.32.0) are not reported as dead; since 1.35.0 ' +
  '`keptAliveByLinks` lists them (files with NO local importer that a linked root imports) ' +
  'with, per symbol, the linked files that name it (`referencedBy`, from symbol refs or the ' +
  'import names) — a symbol with an empty `referencedBy` is kept alive by the file import only.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
};

interface CrossRefOut {
  repoId: string;
  file: string;
}

interface KeptAliveFile {
  filePath: string;
  referencedBy: CrossRefOut[];
  symbols: Array<{ id: string; name: string; kind: string; referencedBy: CrossRefOut[] }>;
}

export function handler(args: { repoId: string }): CallToolResult {
  const db = openDatabase(args.repoId);
  const ws = openWorkspace(db, args.repoId);
  let dead: ReturnType<typeof findDeadCode>;
  let links: Array<{ repoId: string; rootPath: string }> = [];
  const keptAliveByLinks: KeptAliveFile[] = [];
  try {
    dead = findDeadCode(args.repoId, db, ws);
    // Phase 102 (Task 636): symbol-level evidence for the files a link keeps
    // alive. Only files with NO local importer qualify — those are exactly
    // the symbols "exported for the other root".
    if (ws.links.length > 0) {
      links = ws.links.map((m) => ({ repoId: m.repoId, rootPath: m.rootPath }));
      const cross = crossReferencedLocalFiles(ws);
      const ref = (r: { repoId: string; file: string }): CrossRefOut => ({ repoId: r.repoId, file: r.file });
      for (const filePath of [...cross.keys()].sort((a, b) => a.localeCompare(b))) {
        if (getImportersOf(db, args.repoId, filePath).length > 0) continue;
        const info = cross.get(filePath)!;
        keptAliveByLinks.push({
          filePath,
          referencedBy: info.referencedBy.map(ref),
          symbols: getSymbolsByFile(db, args.repoId, filePath).map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            referencedBy: (info.symbolRefs.get(s.id) ?? []).map(ref),
          })),
        });
      }
    }
  } finally {
    ws.close();
  }
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
          {
            totalDeadSymbols: dead.length,
            files,
            ...(links.length > 0 ? { links, keptAliveByLinks } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}
