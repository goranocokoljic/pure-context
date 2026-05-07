import { z } from 'zod';
import { writeFile } from 'fs/promises';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { openDatabase, getRepo, SCHEMA_VERSION } from '../../core/db/schema.js';
import { buildMeta } from './_meta.js';
import { PureContextError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const gzipAsync = promisify(gzip);

export const name = 'export_index';

export const description =
  'Serialize a repo\'s index (symbols, files, dep edges, and optionally HNSW embeddings) into ' +
  'a portable .pcx bundle that can be shared between team members, stored in CI artifacts, or ' +
  'loaded on a new machine with import_index. One bundle per repo — repo-scoped, not full-DB.';

export const inputSchema = {
  repoId: z.string().describe('ID of the repo to export (from list_repos)'),
  outputPath: z.string().describe('Absolute path where the .pcx bundle will be written'),
  includeSource: z
    .boolean()
    .optional()
    .describe('Include cached file source content in the bundle (default: true)'),
  includeVectors: z
    .boolean()
    .optional()
    .describe('Include HNSW embedding vectors in the bundle (default: true)'),
  compress: z
    .boolean()
    .optional()
    .describe('Gzip-compress the bundle (default: true). Set false for debugging.'),
};

// ─── Internal bundle types ────────────────────────────────────────────────────

interface BundleHeader {
  version: number;
  repoId: string;
  repoPath: string;
  exportedAt: string;
  symbolCount: number;
  fileCount: number;
  vectorCount: number;
}

interface BundleSymbol {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startByte: number;
  endByte: number;
  signature: string;
  summary: string;
  frameworkMeta?: Record<string, unknown>;
  tenantId: string;
  metrics?: {
    lineCount: number;
    cyclomaticComplexity: number;
    cognitiveComplexity: number;
    paramCount: number;
    returnCount: number;
    nestingDepth: number;
  };
}

interface BundleFile {
  path: string;
  contentHash: string;
  rawContent: string | null; // base64-encoded if includeSource, else null
  indexedAt: number;
  tenantId: string;
  remoteSha: string | null;
  lastCommitSha: string | null;
  lastCommitAuthor: string | null;
  lastCommitDate: number | null;
  lastCommitMessage: string | null;
  commitCount: number | null;
}

interface BundleDepEdge {
  sourceFile: string;
  sourceSymbolId: string | null;
  targetFile: string;
  targetSymbolId: string | null;
  edgeType: string;
  specifier: string;
  tenantId: string;
}

interface BundleVector {
  symbolId: string;
  embedding: string; // base64-encoded Float32Array bytes
  dimension: number;
  provider: string;
}

export interface PcxBundle {
  header: BundleHeader;
  symbols: BundleSymbol[];
  files: BundleFile[];
  depEdges: BundleDepEdge[];
  vectors: BundleVector[];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  outputPath: string;
  includeSource?: boolean;
  includeVectors?: boolean;
  compress?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, outputPath } = args;
  const includeSource = args.includeSource ?? true;
  const includeVectors = args.includeVectors ?? true;
  const compress = args.compress ?? true;

  const db = openDatabase(repoId);
  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      throw new PureContextError(
        `Repo not found: ${repoId}. Run list_repos to see indexed repos.`,
        'export_index',
      );
    }

    // ── Query raw rows ────────────────────────────────────────────────────────

    const symbolRows = db
      .prepare<[string], DbSymbolRow>('SELECT * FROM symbols WHERE repo_id = ?')
      .all(repoId);

    const fileRows = db
      .prepare<[string], DbFileRow>('SELECT * FROM files WHERE repo_id = ?')
      .all(repoId);

    const edgeRows = db
      .prepare<[string], DbEdgeRow>('SELECT * FROM dep_edges WHERE repo_id = ?')
      .all(repoId);

    let embeddingRows: DbEmbeddingRow[] = [];
    if (includeVectors) {
      embeddingRows = db
        .prepare<[string], DbEmbeddingRow>(
          'SELECT symbol_id, embedding, dimension, provider FROM embeddings WHERE repo_id = ?',
        )
        .all(repoId);
    }

    // ── Serialize ─────────────────────────────────────────────────────────────

    const symbols: BundleSymbol[] = symbolRows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      startByte: row.start_byte,
      endByte: row.end_byte,
      signature: row.signature,
      summary: row.summary,
      frameworkMeta: row.framework_meta
        ? (JSON.parse(row.framework_meta) as Record<string, unknown>)
        : undefined,
      tenantId: row.tenant_id,
      metrics: row.line_count !== null && row.line_count !== undefined
        ? {
            lineCount: row.line_count,
            cyclomaticComplexity: row.cyclomatic_complexity ?? 1,
            cognitiveComplexity: row.cognitive_complexity ?? 0,
            paramCount: row.param_count ?? 0,
            returnCount: row.return_count ?? 0,
            nestingDepth: row.nesting_depth ?? 0,
          }
        : undefined,
    }));

    const files: BundleFile[] = fileRows.map((row) => ({
      path: row.path,
      contentHash: row.content_hash,
      rawContent:
        includeSource && row.raw_content
          ? (row.raw_content as Buffer).toString('base64')
          : null,
      indexedAt: row.indexed_at,
      tenantId: row.tenant_id,
      remoteSha: row.remote_sha ?? null,
      lastCommitSha: row.last_commit_sha ?? null,
      lastCommitAuthor: row.last_commit_author ?? null,
      lastCommitDate: row.last_commit_date ?? null,
      lastCommitMessage: row.last_commit_message ?? null,
      commitCount: row.commit_count ?? null,
    }));

    const depEdges: BundleDepEdge[] = edgeRows.map((row) => ({
      sourceFile: row.source_file,
      sourceSymbolId: row.source_symbol_id ?? null,
      targetFile: row.target_file,
      targetSymbolId: row.target_symbol_id ?? null,
      edgeType: row.edge_type,
      specifier: row.specifier,
      tenantId: row.tenant_id,
    }));

    const vectors: BundleVector[] = embeddingRows.map((row) => ({
      symbolId: row.symbol_id,
      embedding: (row.embedding as Buffer).toString('base64'),
      dimension: row.dimension,
      provider: row.provider,
    }));

    const bundle: PcxBundle = {
      header: {
        version: SCHEMA_VERSION,
        repoId,
        repoPath: repo.rootPath,
        exportedAt: new Date().toISOString(),
        symbolCount: symbols.length,
        fileCount: files.length,
        vectorCount: vectors.length,
      },
      symbols,
      files,
      depEdges,
      vectors,
    };

    // ── Write bundle ──────────────────────────────────────────────────────────

    const json = JSON.stringify(bundle);
    const output = compress
      ? await gzipAsync(Buffer.from(json, 'utf8'))
      : Buffer.from(json, 'utf8');

    mkdirSync(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output);

    logger.info('export_index: bundle written', {
      repoId,
      outputPath,
      symbolCount: symbols.length,
      fileCount: files.length,
      vectorCount: vectors.length,
      bundleSize: output.length,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              outputPath,
              bundleSize: output.length,
              symbolCount: symbols.length,
              fileCount: files.length,
              vectorCount: vectors.length,
              repoId,
              exportedAt: bundle.header.exportedAt,
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

// ─── Internal DB row types ────────────────────────────────────────────────────

interface DbSymbolRow {
  id: string;
  repo_id: string;
  name: string;
  kind: string;
  file_path: string;
  start_byte: number;
  end_byte: number;
  signature: string;
  summary: string;
  framework_meta: string | null;
  indexed_at: number;
  tenant_id: string;
  line_count: number | null;
  cyclomatic_complexity: number | null;
  cognitive_complexity: number | null;
  param_count: number | null;
  return_count: number | null;
  nesting_depth: number | null;
}

interface DbFileRow {
  repo_id: string;
  path: string;
  content_hash: string;
  raw_content: Buffer | null;
  indexed_at: number;
  tenant_id: string;
  remote_sha: string | null;
  last_commit_sha: string | null;
  last_commit_author: string | null;
  last_commit_date: number | null;
  last_commit_message: string | null;
  commit_count: number | null;
}

interface DbEdgeRow {
  id: number;
  repo_id: string;
  source_file: string;
  source_symbol_id: string | null;
  target_file: string;
  target_symbol_id: string | null;
  edge_type: string;
  specifier: string;
  tenant_id: string;
}

interface DbEmbeddingRow {
  symbol_id: string;
  embedding: Buffer;
  dimension: number;
  provider: string;
}
