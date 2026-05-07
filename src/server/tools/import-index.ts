import { z } from 'zod';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import {
  openDatabase,
  getRepo,
  upsertRepo,
  SCHEMA_VERSION,
} from '../../core/db/schema.js';
import { insertSymbols } from '../../core/db/symbol-store.js';
import { upsertFile } from '../../core/db/file-store.js';
import { saveEmbeddings } from '../../core/db/embedding-store.js';
import { insertEdges } from '../../core/db/dep-store.js';
import { buildMeta } from './_meta.js';
import { PureContextError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PcxBundle } from './export-index.js';
import type { SymbolRecord, DepEdge } from '../../core/types.js';

const gunzipAsync = promisify(gunzip);

export const name = 'import_index';

export const description =
  'Import a .pcx bundle created by export_index into the local index store. ' +
  'Restores all symbols, files, dependency edges, and optionally embedding vectors. ' +
  'Use repoPath to override the stored root path (needed on a different machine). ' +
  'Set merge: false (default) to skip the import if the repo is already indexed.';

export const inputSchema = {
  bundlePath: z.string().describe('Absolute path to the .pcx bundle file to import'),
  repoPath: z
    .string()
    .optional()
    .describe(
      'Override the repo root path stored in the bundle. Required when importing on a ' +
      'machine where the repo lives at a different absolute path.',
    ),
  merge: z
    .boolean()
    .optional()
    .describe('When false (default), skip import if the repo is already indexed.'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  bundlePath: string;
  repoPath?: string;
  merge?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { bundlePath } = args;
  const merge = args.merge ?? false;
  // Use repoPath as-is — callers (CLI, MCP) are responsible for resolving
  // relative paths before passing them here.
  const repoPathOverride = args.repoPath ?? undefined;

  // ── Read and decompress bundle ────────────────────────────────────────────

  if (!existsSync(bundlePath)) {
    throw new PureContextError(
      `Bundle file not found: ${bundlePath}`,
      'import_index',
    );
  }

  const raw = await readFile(bundlePath);
  let json: string;

  try {
    // Try gzip first (default), fall back to plain JSON
    const decompressed = await gunzipAsync(raw);
    json = decompressed.toString('utf8');
  } catch {
    // Not gzipped — treat as plain JSON
    json = raw.toString('utf8');
  }

  let bundle: PcxBundle;
  try {
    bundle = JSON.parse(json) as PcxBundle;
  } catch {
    throw new PureContextError(
      `Failed to parse bundle: ${bundlePath} does not contain valid JSON.`,
      'import_index',
    );
  }

  // ── Validate bundle ───────────────────────────────────────────────────────

  if (!bundle.header || typeof bundle.header.version !== 'number') {
    throw new PureContextError(
      'Invalid bundle: missing or malformed header.',
      'import_index',
    );
  }

  if (bundle.header.version !== SCHEMA_VERSION) {
    throw new PureContextError(
      `Bundle schema version mismatch: bundle is v${bundle.header.version}, ` +
      `current is v${SCHEMA_VERSION}. Re-export the bundle with the current version of PureContext.`,
      'import_index',
    );
  }

  const { repoId } = bundle.header;
  const repoPath = repoPathOverride ?? bundle.header.repoPath;

  // ── Check if already indexed ──────────────────────────────────────────────

  const db = openDatabase(repoId);
  try {
    const existing = getRepo(db, repoId);
    if (existing && !merge) {
      logger.info('import_index: repo already indexed, skipping (merge=false)', { repoId });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                repoId,
                repoPath: existing.rootPath,
                symbolCount: existing.symbolCount,
                fileCount: existing.fileCount,
                alreadyExisted: true,
                _meta: buildMeta({ timingMs: Date.now() - t0 }),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // ── Upsert repo metadata ──────────────────────────────────────────────────

    upsertRepo(db, {
      id: repoId,
      rootPath: repoPath,
      symbolCount: bundle.header.symbolCount,
      fileCount: bundle.header.fileCount,
      languages: [],
      indexedAt: Date.now(),
      schemaVersion: SCHEMA_VERSION,
      clonePath: null,
      tenantId: 'local',
    });

    // ── Upsert symbols ────────────────────────────────────────────────────────

    if (bundle.symbols && bundle.symbols.length > 0) {
      const symbols: SymbolRecord[] = bundle.symbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind as SymbolRecord['kind'],
        filePath: s.filePath,
        startByte: s.startByte,
        endByte: s.endByte,
        signature: s.signature,
        summary: s.summary,
        frameworkMeta: s.frameworkMeta,
        metrics: s.metrics,
      }));
      insertSymbols(db, repoId, symbols, 'local');
    }

    // ── Upsert files ──────────────────────────────────────────────────────────

    if (bundle.files && bundle.files.length > 0) {
      const upsertStmt = db.prepare(`
        INSERT INTO files
          (repo_id, path, content_hash, raw_content, indexed_at, tenant_id,
           remote_sha, last_commit_sha, last_commit_author, last_commit_date,
           last_commit_message, commit_count)
        VALUES
          (@repoId, @path, @contentHash, @rawContent, @indexedAt, @tenantId,
           @remoteSha, @lastCommitSha, @lastCommitAuthor, @lastCommitDate,
           @lastCommitMessage, @commitCount)
        ON CONFLICT(repo_id, path) DO UPDATE SET
          content_hash        = excluded.content_hash,
          raw_content         = excluded.raw_content,
          indexed_at          = excluded.indexed_at,
          tenant_id           = excluded.tenant_id,
          remote_sha          = excluded.remote_sha,
          last_commit_sha     = excluded.last_commit_sha,
          last_commit_author  = excluded.last_commit_author,
          last_commit_date    = excluded.last_commit_date,
          last_commit_message = excluded.last_commit_message,
          commit_count        = excluded.commit_count
      `);

      const upsertAll = db.transaction(() => {
        for (const f of bundle.files) {
          upsertStmt.run({
            repoId,
            path: f.path,
            contentHash: f.contentHash,
            rawContent: f.rawContent ? Buffer.from(f.rawContent, 'base64') : null,
            indexedAt: f.indexedAt,
            tenantId: f.tenantId ?? 'local',
            remoteSha: f.remoteSha,
            lastCommitSha: f.lastCommitSha,
            lastCommitAuthor: f.lastCommitAuthor,
            lastCommitDate: f.lastCommitDate,
            lastCommitMessage: f.lastCommitMessage,
            commitCount: f.commitCount,
          });
        }
      });
      upsertAll();
    }

    // ── Upsert dep edges ──────────────────────────────────────────────────────

    if (bundle.depEdges && bundle.depEdges.length > 0) {
      const edges: DepEdge[] = bundle.depEdges.map((e) => ({
        repoId,
        sourceFile: e.sourceFile,
        sourceSymbolId: e.sourceSymbolId,
        targetFile: e.targetFile,
        targetSymbolId: e.targetSymbolId,
        edgeType: e.edgeType,
        specifier: e.specifier,
      }));
      insertEdges(db, edges, 'local');
    }

    // ── Restore embeddings ────────────────────────────────────────────────────

    if (bundle.vectors && bundle.vectors.length > 0) {
      // Group by provider (usually all the same)
      const byProvider = new Map<string, Map<string, Float32Array>>();
      for (const v of bundle.vectors) {
        let m = byProvider.get(v.provider);
        if (!m) {
          m = new Map();
          byProvider.set(v.provider, m);
        }
        const buf = Buffer.from(v.embedding, 'base64');
        const ab = new ArrayBuffer(buf.length);
        buf.copy(Buffer.from(ab));
        m.set(v.symbolId, new Float32Array(ab));
      }
      for (const [provider, embeddings] of byProvider) {
        saveEmbeddings(db, repoId, provider, embeddings, 'local');
      }
    }

    logger.info('import_index: bundle imported successfully', {
      repoId,
      repoPath,
      symbolCount: bundle.header.symbolCount,
      fileCount: bundle.header.fileCount,
      vectorCount: bundle.vectors?.length ?? 0,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId,
              repoPath,
              symbolCount: bundle.header.symbolCount,
              fileCount: bundle.header.fileCount,
              alreadyExisted: false,
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
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
