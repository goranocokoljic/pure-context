import path from 'path';
import { z } from 'zod';
import { openDatabase } from '../../core/db/schema.js';
import { getFileContent as fetchFileContent, getFileSizeBytes } from '../../core/db/file-store.js';
import { buildMeta } from './_meta.js';
import { FileNotCachedError } from '../../core/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_file_content';

export const description =
  'Retrieve raw cached file content for any indexed file, with optional line-range slicing. ' +
  'Always serves from the SQLite cache — consistent with indexed symbol offsets. ' +
  'Supports line-number prefixing and enforces a configurable max-lines limit per call.';

const MAX_LINES_DEFAULT = 500;

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  filePath: z.string().describe('File path relative to the repo root'),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based, inclusive. Omit to start from the beginning of the file.'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based, inclusive. Omit to read to the end of the file.'),
  withLineNumbers: z
    .boolean()
    .optional()
    .describe('Prefix each line with its 1-based line number. Default true.'),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  withLineNumbers?: boolean;
}): CallToolResult {
  const t0 = Date.now();
  const { repoId, withLineNumbers = true } = args;

  // Validate path — reject anything containing '..' to prevent traversal
  const normalised = path.normalize(args.filePath);
  if (normalised.includes('..')) {
    throw new FileNotCachedError(
      args.filePath,
      'Path traversal detected — filePath must not contain ".."',
    );
  }

  const filePath = normalised.replace(/\\/g, '/');

  const db = openDatabase(repoId);

  const rawContent = fetchFileContent(db, repoId, filePath);
  if (!rawContent) {
    db.close();
    throw new FileNotCachedError(filePath);
  }

  const fullSizeBytes = getFileSizeBytes(db, repoId, filePath);
  db.close();

  const text = rawContent.toString('utf8');
  const allLines = text.split('\n');
  const totalLines = allLines.length;

  const maxLines = Number(process.env['MAX_FILE_CONTENT_LINES'] ?? MAX_LINES_DEFAULT);

  // Resolve requested range (1-based, inclusive → 0-based slice indices)
  const startIdx = Math.max(0, (args.startLine ?? 1) - 1);
  const endIdx = Math.min(totalLines - 1, (args.endLine ?? totalLines) - 1);

  // Apply max-lines cap
  const cappedEndIdx = Math.min(endIdx, startIdx + maxLines - 1);
  const truncated = cappedEndIdx < endIdx;

  const selectedLines = allLines.slice(startIdx, cappedEndIdx + 1);
  const returnedLines = selectedLines.length;

  // Format lines
  const digits = String(startIdx + returnedLines).length;
  const formattedLines = selectedLines.map((line, i) => {
    if (!withLineNumbers) return line;
    const lineNum = String(startIdx + i + 1).padStart(digits, ' ');
    return `${lineNum} │ ${line}`;
  });

  const content = formattedLines.join('\n');

  const responseBytes = Buffer.byteLength(content, 'utf8');

  const meta = buildMeta({ timingMs: Date.now() - t0, rawBytes: fullSizeBytes, responseBytes });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metaOut: any = meta;
  if (truncated) {
    metaOut['truncated'] = true;
    metaOut['truncated_at_line'] = cappedEndIdx + 1;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            filePath,
            totalLines,
            returnedLines,
            content,
            _meta: metaOut,
          },
          null,
          2,
        ),
      },
    ],
  };
}
