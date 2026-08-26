import { z } from 'zod';
import { existsSync, readFileSync } from 'fs';
import { relative, resolve, isAbsolute, sep, join } from 'path';
import { getIndexDir, openDatabase, getRepo } from '../../core/db/schema.js';
import { getFileHash } from '../../core/db/file-store.js';
import { computeHash } from '../../core/hash-cache.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'check_index_staleness';

export const description =
  'Cheaply check whether the index is current for specific files — WITHOUT a full ' +
  'discovery pass. Pass filePaths to get a per-file fresh/stale verdict (compares the ' +
  'stored content hash against the file on disk); omit them for a lightweight repo-level ' +
  'summary (indexed? + last-indexed time + counts). Use at task start to decide whether to ' +
  'index_folder (cold) or just index_file the few changed paths, then index_file to refresh.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePaths: z
    .array(z.string())
    .optional()
    .describe(
      'Files (absolute or repo-relative) to check. Omit for a repo-level summary only.',
    ),
};

type StaleReason = 'modified' | 'not_indexed' | 'deleted';

interface FileVerdict {
  path: string;
  status: 'fresh' | 'stale';
  reason?: StaleReason;
}

function toRepoRelative(absRoot: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(absRoot, p));
  return relative(absRoot, abs).split(sep).join('/');
}

export function handler(args: { repoId: string; filePaths?: string[] }): CallToolResult {
  const start = Date.now();
  const dbPath = join(getIndexDir(), `${args.repoId}.db`);

  if (!existsSync(dbPath)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId: args.repoId,
              indexed: false,
              allFresh: false,
              hint: 'Repo is not indexed — call index_folder first.',
              _meta: buildMeta({ timingMs: Date.now() - start }),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const db = openDatabase(args.repoId);
  try {
    const repo = getRepo(db, args.repoId);
    const absRoot = repo?.rootPath ?? '';

    // Pre-v11 indexes stored char indices in start_byte/end_byte (Phase 90
    // char-vs-byte fix) — symbol source/line output from them is unreliable.
    const schemaWarning =
      repo && repo.schemaVersion < 11
        ? `Index schema v${repo.schemaVersion} predates the offset-integrity fix (v11) — ` +
          'symbol spans may be corrupted on non-ASCII files. Run index_folder to heal.'
        : undefined;

    // ── Repo-level summary (no paths) ──────────────────────────────────────
    if (!args.filePaths || args.filePaths.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                repoId: args.repoId,
                indexed: true,
                rootPath: absRoot,
                lastIndexedAt: repo?.indexedAt ?? null,
                fileCount: repo?.fileCount ?? 0,
                symbolCount: repo?.symbolCount ?? 0,
                ...(schemaWarning ? { schemaWarning } : {}),
                note:
                  'Pass filePaths for per-file fresh/stale checks. A repo-level "are there ' +
                  'new files?" check requires a discovery pass (index_folder).',
                _meta: buildMeta({ timingMs: Date.now() - start }),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // ── Per-file staleness ─────────────────────────────────────────────────
    const verdicts: FileVerdict[] = [];
    const seen = new Set<string>();
    for (const p of args.filePaths) {
      const rel = toRepoRelative(absRoot, p);
      if (seen.has(rel)) continue;
      seen.add(rel);

      const abs = isAbsolute(p) ? resolve(p) : resolve(join(absRoot, p));
      const stored = getFileHash(db, args.repoId, rel);
      const onDisk = existsSync(abs);

      if (!onDisk) {
        // In the index but gone from disk → stale (deletion). Absent both
        // places → nothing to do, treat as fresh.
        if (stored) verdicts.push({ path: rel, status: 'stale', reason: 'deleted' });
        else verdicts.push({ path: rel, status: 'fresh' });
        continue;
      }

      if (!stored) {
        verdicts.push({ path: rel, status: 'stale', reason: 'not_indexed' });
        continue;
      }

      let current: string;
      try {
        current = computeHash(readFileSync(abs));
      } catch {
        verdicts.push({ path: rel, status: 'stale', reason: 'not_indexed' });
        continue;
      }
      verdicts.push(
        current === stored
          ? { path: rel, status: 'fresh' }
          : { path: rel, status: 'stale', reason: 'modified' },
      );
    }

    const stale = verdicts.filter((v) => v.status === 'stale');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId: args.repoId,
              indexed: true,
              allFresh: stale.length === 0,
              staleCount: stale.length,
              ...(schemaWarning ? { schemaWarning } : {}),
              stalePaths: stale.map((v) => v.path),
              files: verdicts,
              _meta: buildMeta({ timingMs: Date.now() - start }),
            },
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    db.close();
  }
}
