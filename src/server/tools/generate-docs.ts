/**
 * generate_docs tool — Architecture Documentation Generator.
 *
 * Produces a structured markdown (or JSON) architecture document for a repo
 * (or a directory within it) from the indexed symbols, dependency graph, and
 * AI summaries.
 *
 * Document structure:
 *   - One section per file (module) in scope
 *   - Public API: list of symbols with signatures and summaries
 *   - Depends on / Imported by: derived from dep_edges
 *   - Optional quality metrics (symbol count, avg complexity)
 *   - Optional AI-enhanced module descriptions (batched, up to 10 per call)
 */

import { z } from 'zod';
import { request as httpsRequest } from 'https';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { computeRepoId } from '../../core/index-manager.js';
import { getConfig } from '../../config/config-loader.js';
import { buildMeta } from './_meta.js';
import { logger } from '../../core/logger.js';
import type { SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

// ─── Tool exports ──────────────────────────────────────────────────────────────

export const name = 'generate_docs';

export const description =
  'Generate a structured architecture document for a repository (or a directory ' +
  'within it) from indexed symbols, the dependency graph, and AI summaries. ' +
  'Outputs markdown or JSON. Useful for onboarding, architecture reviews, and ' +
  'automated documentation pipelines.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  scope: z
    .string()
    .optional()
    .describe('Directory prefix to narrow scope, e.g. "src/core/"'),
  format: z
    .enum(['markdown', 'json'])
    .optional()
    .describe('Output format: "markdown" (default) or "json"'),
  includeSymbols: z
    .boolean()
    .optional()
    .describe('List key symbols per module (default true)'),
  includeDependencies: z
    .boolean()
    .optional()
    .describe('Show import relationships between modules (default true)'),
  includeMetrics: z
    .boolean()
    .optional()
    .describe('Append quality metrics per module: symbol count, avg complexity (default false)'),
  aiEnhance: z
    .boolean()
    .optional()
    .describe(
      'Use AI to write module descriptions for files without a docstring (default true). ' +
      'Requires a configured AI provider — skipped gracefully if none is set.',
    ),
};

// ─── Internal types ────────────────────────────────────────────────────────────

interface PublicSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string;
}

interface ModuleDoc {
  path: string;
  title: string;
  description: string;
  publicSymbols: PublicSymbol[];
  dependsOn: string[];
  importedBy: string[];
  metrics?: {
    symbolCount: number;
    avgComplexity: number;
  };
}

interface DbSymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  signature: string;
  summary: string;
  cyclomatic_complexity: number | null;
}

// ─── DB queries ────────────────────────────────────────────────────────────────

/** All distinct file paths in scope for this repo. */
function queryFiles(
  db: Database.Database,
  repoId: string,
  scope: string | undefined,
): string[] {
  if (scope) {
    const normalised = scope.replace(/\\/g, '/').replace(/\/$/, '');
    const rows = db
      .prepare<[string, string, string], { path: string }>(
        `SELECT DISTINCT path FROM files
         WHERE repo_id = ? AND (path = ? OR path LIKE ?)
         ORDER BY path`,
      )
      .all(repoId, normalised, `${normalised}/%`);
    return rows.map((r) => r.path);
  }
  const rows = db
    .prepare<[string], { path: string }>(
      'SELECT DISTINCT path FROM files WHERE repo_id = ? ORDER BY path',
    )
    .all(repoId);
  return rows.map((r) => r.path);
}

/** All symbols for a single file. */
function querySymbols(
  db: Database.Database,
  repoId: string,
  filePath: string,
): DbSymbolRow[] {
  return db
    .prepare<[string, string], DbSymbolRow>(
      `SELECT id, name, kind, file_path, signature, summary, cyclomatic_complexity
       FROM symbols WHERE repo_id = ? AND file_path = ? ORDER BY start_byte`,
    )
    .all(repoId, filePath);
}

/** Distinct target files that `filePath` imports. */
function queryDependsOn(
  db: Database.Database,
  repoId: string,
  filePath: string,
): string[] {
  const rows = db
    .prepare<[string, string], { target_file: string }>(
      `SELECT DISTINCT target_file FROM dep_edges
       WHERE repo_id = ? AND source_file = ? AND target_file != source_file`,
    )
    .all(repoId, filePath);
  return rows.map((r) => r.target_file);
}

/** Distinct source files that import `filePath`. */
function queryImportedBy(
  db: Database.Database,
  repoId: string,
  filePath: string,
): string[] {
  const rows = db
    .prepare<[string, string], { source_file: string }>(
      `SELECT DISTINCT source_file FROM dep_edges
       WHERE repo_id = ? AND target_file = ? AND source_file != target_file`,
    )
    .all(repoId, filePath);
  return rows.map((r) => r.source_file);
}

// ─── Module description helpers ────────────────────────────────────────────────

/** Derive a module title from its file path (basename without extension). */
function moduleTitle(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1] ?? filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Build a fallback description from the module's symbols when AI is not used.
 * Uses the summary of the first substantive symbol (function/class/interface),
 * or generates a generic line.
 */
function fallbackDescription(symbols: DbSymbolRow[], filePath: string): string {
  const substantive = symbols.find((s) =>
    ['function', 'class', 'interface', 'method', 'component', 'composable'].includes(s.kind),
  );
  if (substantive?.summary) return substantive.summary;
  if (symbols.length > 0) {
    const kinds = [...new Set(symbols.map((s) => s.kind))];
    return `Module containing ${symbols.length} symbol(s): ${kinds.join(', ')}.`;
  }
  return `Module at ${filePath}.`;
}

// ─── AI caller ─────────────────────────────────────────────────────────────────

interface ModuleDescriptionRequest {
  filePath: string;
  symbols: PublicSymbol[];
}

interface ModuleDescriptionResponse {
  filePath: string;
  description: string;
}

/**
 * Build the batch AI prompt for module description generation.
 * Exported for testing.
 */
export function buildDescriptionPrompt(modules: ModuleDescriptionRequest[]): string {
  const moduleList = modules
    .map((m, i) => {
      const symbolLines = m.symbols
        .slice(0, 8) // cap per module to keep prompt size reasonable
        .map((s) => `  - ${s.name} (${s.kind}): ${s.signature}`)
        .join('\n');
      return (
        `${i + 1}. filePath="${m.filePath}"\n` +
        (symbolLines ? `   Exported symbols:\n${symbolLines}` : '   (no exported symbols)')
      );
    })
    .join('\n\n');

  return (
    `You are documenting a codebase. For each module below, write a 2-sentence description ` +
    `of what it does and its role in the codebase.\n\n` +
    `Modules:\n\n${moduleList}\n\n` +
    `Respond with a JSON array (no markdown, no code fences) exactly matching this shape:\n` +
    `[\n` +
    `  { "filePath": "<filePath>", "description": "<2-sentence description>" }\n` +
    `]\n\n` +
    `Rules:\n` +
    `- One entry per module, in the same order as above\n` +
    `- Keep each description concise (2 sentences max)\n` +
    `- Output ONLY the JSON array, nothing else`
  );
}

/**
 * Parse the AI response for module descriptions.
 * Exported for testing.
 */
export function parseDescriptionResponse(
  text: string,
): ModuleDescriptionResponse[] | null {
  const cleaned = text
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return null;
    const result: ModuleDescriptionResponse[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry['filePath'] !== 'string') continue;
      if (typeof entry['description'] !== 'string') continue;
      result.push({
        filePath: entry['filePath'] as string,
        description: entry['description'] as string,
      });
    }
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Call the configured AI provider with a prompt and return the raw text response.
 * Returns null on failure (caller falls back to non-AI description).
 */
async function callAI(prompt: string): Promise<string | null> {
  const config = getConfig();
  if (!config.ai.allowRemoteAI) return null;

  const provider = config.ai.provider;
  if (provider === 'none') return null;

  const model = config.ai.model;

  if (provider === 'anthropic') {
    const apiKey = config.ai.apiKey || process.env['ANTHROPIC_API_KEY'] || '';
    if (!apiKey) return null;
    const finalModel = model || 'claude-haiku-4-5-20251001';

    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: finalModel,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const req = httpsRequest(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              const parsed = JSON.parse(raw) as {
                content?: Array<{ type: string; text: string }>;
              };
              const text = (parsed.content ?? [])
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('');
              resolve(text || null);
            } catch {
              resolve(null);
            }
          });
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  if (provider === 'openai-compatible') {
    const endpoint = config.ai.endpoint;
    if (!endpoint) return null;
    const apiKey = config.ai.apiKey || '';
    const finalModel = model || 'gpt-4o-mini';
    const url = `${endpoint.replace(/\/$/, '')}/v1/chat/completions`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: finalModel,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) return null;
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }

  if (provider === 'gemini') {
    const apiKey = config.ai.apiKey || process.env['GOOGLE_API_KEY'] || '';
    if (!apiKey) return null;
    const finalModel = model || 'gemini-2.0-flash';
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${finalModel}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      });
      if (!response.ok) return null;
      const data = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

// ─── AI enhancement ────────────────────────────────────────────────────────────

const AI_BATCH_SIZE = 10;

/**
 * Generate AI descriptions for modules that lack one.
 * Returns a map of filePath → description.
 * Skips gracefully on any error.
 */
async function generateAIDescriptions(
  modules: ModuleDescriptionRequest[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (modules.length === 0) return result;

  // Process in batches of AI_BATCH_SIZE
  for (let i = 0; i < modules.length; i += AI_BATCH_SIZE) {
    const batch = modules.slice(i, i + AI_BATCH_SIZE);
    const prompt = buildDescriptionPrompt(batch);

    try {
      const aiText = await callAI(prompt);
      if (!aiText) continue;

      const parsed = parseDescriptionResponse(aiText);
      if (!parsed) {
        logger.warn('generate_docs: AI description response parse failed for batch', {
          batchStart: i,
        });
        continue;
      }

      for (const entry of parsed) {
        result.set(entry.filePath, entry.description);
      }
    } catch (err) {
      logger.warn(`generate_docs: AI batch ${i} failed: ${err}`);
    }
  }

  return result;
}

// ─── Document rendering ────────────────────────────────────────────────────────

function renderMarkdown(
  repoName: string,
  modules: ModuleDoc[],
  generatedAt: string,
): string {
  const lines: string[] = [
    `# ${repoName} — Architecture Overview`,
    `_Generated by PureContext on ${generatedAt}_`,
    '',
    '## Modules',
    '',
  ];

  for (const mod of modules) {
    lines.push(`### ${mod.path}`);
    lines.push('');
    lines.push(mod.description);
    lines.push('');

    if (mod.publicSymbols.length > 0) {
      lines.push('**Public API:**');
      for (const sym of mod.publicSymbols) {
        const summary = sym.summary ? ` — ${sym.summary}` : '';
        lines.push(`- \`${sym.name}\` _(${sym.kind})_ ${sym.signature}${summary}`);
      }
      lines.push('');
    }

    if (mod.dependsOn.length > 0) {
      const names = mod.dependsOn.map((p) => `\`${moduleTitle(p)}\``).join(', ');
      lines.push(`**Depends on:** ${names}`);
    }
    if (mod.importedBy.length > 0) {
      const names = mod.importedBy.map((p) => `\`${moduleTitle(p)}\``).join(', ');
      lines.push(`**Imported by:** ${names}`);
    }

    if (mod.metrics) {
      lines.push('');
      lines.push(
        `**Metrics:** ${mod.metrics.symbolCount} symbol(s)` +
        (mod.metrics.avgComplexity > 0
          ? `, avg complexity ${mod.metrics.avgComplexity.toFixed(1)}`
          : ''),
      );
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Handler ───────────────────────────────────────────────────────────────────

interface GenerateDocsArgs {
  repoId: string;
  scope?: string;
  format?: 'markdown' | 'json';
  includeSymbols?: boolean;
  includeDependencies?: boolean;
  includeMetrics?: boolean;
  aiEnhance?: boolean;
}

export async function handler(args: GenerateDocsArgs): Promise<CallToolResult> {
  const t0 = Date.now();

  const repoId =
    args.repoId.length === 16 && /^[0-9a-f]+$/.test(args.repoId)
      ? args.repoId
      : computeRepoId(args.repoId);

  const format = args.format ?? 'markdown';
  const includeSymbols = args.includeSymbols ?? true;
  const includeDependencies = args.includeDependencies ?? true;
  const includeMetrics = args.includeMetrics ?? false;
  const aiEnhance = args.aiEnhance ?? true;

  const db = openDatabase(repoId);

  try {
    const repoMeta = getRepo(db, repoId);
    if (!repoMeta) {
      db.close();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repo not found: ${args.repoId}` }),
        }],
        isError: true,
      };
    }

    // Derive a human-readable repo name from the root path
    const rootParts = repoMeta.rootPath.replace(/\\/g, '/').split('/');
    const repoName = rootParts[rootParts.length - 1] ?? repoMeta.rootPath;

    // ── Step 1: Enumerate files in scope ─────────────────────────────────────

    const filePaths = queryFiles(db, repoId, args.scope);

    if (filePaths.length === 0) {
      db.close();
      const generatedAt = new Date().toISOString();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            repoId,
            title: `${repoName} — Architecture Overview`,
            generatedAt,
            moduleCount: 0,
            document: format === 'markdown'
              ? `# ${repoName} — Architecture Overview\n_Generated by PureContext on ${generatedAt}_\n\nNo modules found in scope.\n`
              : '[]',
            _meta: buildMeta({ timingMs: Date.now() - t0 }),
          }),
        }],
      };
    }

    // ── Step 2: Build module docs ─────────────────────────────────────────────

    const modules: ModuleDoc[] = [];
    const aiEnhanceRequests: ModuleDescriptionRequest[] = [];

    for (const filePath of filePaths) {
      const symbols = querySymbols(db, repoId, filePath);

      const publicSymbols: PublicSymbol[] = includeSymbols
        ? symbols.map((s) => ({
            name: s.name,
            kind: s.kind as SymbolKind,
            signature: s.signature,
            summary: s.summary,
          }))
        : [];

      const dependsOn = includeDependencies
        ? queryDependsOn(db, repoId, filePath)
        : [];
      const importedBy = includeDependencies
        ? queryImportedBy(db, repoId, filePath)
        : [];

      // Metrics
      let metrics: ModuleDoc['metrics'] | undefined;
      if (includeMetrics) {
        const complexities = symbols
          .map((s) => s.cyclomatic_complexity)
          .filter((c): c is number => c !== null && c !== undefined);
        const avgComplexity =
          complexities.length > 0
            ? complexities.reduce((a, b) => a + b, 0) / complexities.length
            : 0;
        metrics = { symbolCount: symbols.length, avgComplexity };
      }

      // Placeholder description (will be replaced if AI is used)
      const fallback = fallbackDescription(symbols, filePath);

      modules.push({
        path: filePath,
        title: moduleTitle(filePath),
        description: fallback,
        publicSymbols,
        dependsOn,
        importedBy,
        metrics,
      });

      // Queue for AI enhancement if enabled and description is generic
      if (aiEnhance && publicSymbols.length > 0) {
        aiEnhanceRequests.push({ filePath, symbols: publicSymbols });
      }
    }

    // ── Step 3: AI enhancement ────────────────────────────────────────────────

    let aiWarning: string | undefined;

    if (aiEnhance) {
      const config = getConfig();
      if (!config.ai.allowRemoteAI || config.ai.provider === 'none') {
        aiWarning =
          'aiEnhance requested but no AI provider is configured. ' +
          'Set ai.provider in config and enable ai.allowRemoteAI to use this feature.';
        logger.warn('generate_docs: ' + aiWarning);
      } else if (aiEnhanceRequests.length > 0) {
        const descriptions = await generateAIDescriptions(aiEnhanceRequests);
        for (const mod of modules) {
          const aiDesc = descriptions.get(mod.path);
          if (aiDesc) {
            mod.description = aiDesc;
          }
        }
        logger.debug('generate_docs: AI descriptions applied', {
          total: aiEnhanceRequests.length,
          resolved: descriptions.size,
        });
      }
    }

    db.close();

    // ── Step 4: Render document ───────────────────────────────────────────────

    const generatedAt = new Date().toISOString();
    const title = `${repoName} — Architecture Overview`;

    let document: string;
    if (format === 'json') {
      document = JSON.stringify(modules, null, 2);
    } else {
      document = renderMarkdown(repoName, modules, generatedAt);
    }

    const response: Record<string, unknown> = {
      repoId,
      title,
      generatedAt,
      moduleCount: modules.length,
      document,
      _meta: buildMeta({ timingMs: Date.now() - t0 }),
    };

    if (aiWarning) {
      response['warning'] = aiWarning;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2),
      }],
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
