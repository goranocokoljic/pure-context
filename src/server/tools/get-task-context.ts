/**
 * get_task_context tool — smart context bundling.
 *
 * Given a natural language task description, determines and returns the minimal
 * but complete set of symbols an agent needs to complete that task.
 *
 * Two-stage pipeline:
 *   1. Discovery: hybrid semantic+keyword search with the task description (top 30 candidates)
 *   2. Ranking: AI selects the most relevant symbols, assigns roles and relevance reasons
 *
 * Falls back to pure semantic/keyword ranking when no AI provider is configured.
 */

import { z } from 'zod';
import { request as httpsRequest } from 'https';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getFileContent } from '../../core/db/file-store.js';
import { countEmbeddings } from '../../core/db/embedding-store.js';
import { ftsSearchSymbols } from '../../core/db/symbol-store.js';
import { computeRepoId } from '../../core/index-manager.js';
import { getConfig } from '../../config/config-loader.js';
import { createEmbeddingProvider } from '../../semantic/embedding-provider.js';
import { VectorStore } from '../../semantic/vector-store.js';
import { HybridSearcher } from '../../semantic/hybrid-search.js';
import { expandWithContextLines } from '../../core/symbol-source-helper.js';
import { buildMeta } from './_meta.js';
import { logger } from '../../core/logger.js';
import type { SymbolRecord, SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';

// ─── Tool exports ──────────────────────────────────────────────────────────────

export const name = 'get_task_context';

export const description =
  'Given a natural language task description, returns the minimal but complete set of ' +
  'symbols and files an agent needs to complete that task. ' +
  'Uses two-stage pipeline: semantic search discovers top 30 candidates, then an AI ' +
  'selects the most relevant symbols and explains each one\'s role. ' +
  'Eliminates the need for iterative search-and-read discovery loops. ' +
  'Falls back to semantic ranking when no AI provider is configured.';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  task: z
    .string()
    .min(1)
    .describe('Natural language task description, e.g. "add OAuth login to the user service"'),
  maxSymbols: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of symbols to return (default 15, max 50)'),
  includeSource: z
    .boolean()
    .optional()
    .describe('Return full source code for each symbol (default false — metadata only)'),
  model: z
    .string()
    .optional()
    .describe('AI model for context planning (default: configured summarizer model)'),
};

// ─── Types ─────────────────────────────────────────────────────────────────────

type ContextRole = 'primary' | 'dependency' | 'test' | 'config';

interface ContextItem {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string;
  summary: string;
  relevanceReason: string;
  source?: string;
  role: ContextRole;
}

interface AiSelection {
  id: string;
  relevanceReason: string;
  role: ContextRole;
}

interface AiPlanResponse {
  selected: AiSelection[];
  plan: string;
  estimatedFiles: string[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const DISCOVERY_CANDIDATES = 30;
const DEFAULT_MAX_SYMBOLS = 15;

// ─── AI caller ─────────────────────────────────────────────────────────────────

/**
 * Build the AI prompt for context planning.
 * Exported for testing.
 */
export function buildPlanningPrompt(task: string, candidates: SymbolRecord[]): string {
  const candidateList = candidates
    .map((s, i) =>
      `${i + 1}. id=${s.id}  name=${s.name}  kind=${s.kind}  file=${s.filePath}\n   ${s.summary}`,
    )
    .join('\n\n');

  return (
    `Task: ${task}\n\n` +
    `Available symbols (name, kind, file, summary):\n\n${candidateList}\n\n` +
    `Select the most relevant symbols for completing this task. ` +
    `Respond with a JSON object (no markdown, no code fences) exactly matching this shape:\n` +
    `{\n` +
    `  "selected": [\n` +
    `    { "id": "<symbol id>", "relevanceReason": "<why needed>", "role": "<primary|dependency|test|config>" }\n` +
    `  ],\n` +
    `  "plan": "<2-3 sentence implementation plan>",\n` +
    `  "estimatedFiles": ["<file path>", ...]\n` +
    `}\n\n` +
    `Rules:\n` +
    `- Include only the symbols actually needed — do not pad with unrelated symbols\n` +
    `- role must be one of: primary, dependency, test, config\n` +
    `- estimatedFiles should list the files the agent will likely need to modify\n` +
    `- Output ONLY the JSON object, nothing else`
  );
}

/**
 * Call the configured AI provider with a prompt and return the raw text response.
 * Returns null on failure (caller falls back to semantic ranking).
 */
async function callAI(
  prompt: string,
  modelOverride?: string,
): Promise<string | null> {
  const config = getConfig();
  if (!config.ai.allowRemoteAI) return null;

  const provider = config.ai.provider;
  if (provider === 'none') return null;

  const model = modelOverride ?? config.ai.model;

  if (provider === 'anthropic') {
    const apiKey = config.ai.apiKey || process.env['ANTHROPIC_API_KEY'] || '';
    if (!apiKey) return null;
    const finalModel = model || 'claude-haiku-4-5-20251001';

    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: finalModel,
        max_tokens: 2048,
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
          max_tokens: 2048,
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

/**
 * Parse and validate the AI JSON response for context planning.
 * Exported for testing.
 */
export function parsePlanResponse(text: string): AiPlanResponse | null {
  // Strip markdown code fences if present
  const cleaned = text
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (!Array.isArray(obj['selected'])) return null;
    if (typeof obj['plan'] !== 'string') return null;
    if (!Array.isArray(obj['estimatedFiles'])) return null;

    const selected: AiSelection[] = [];
    for (const item of obj['selected'] as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string') continue;
      if (typeof entry['relevanceReason'] !== 'string') continue;
      const role = entry['role'];
      if (role !== 'primary' && role !== 'dependency' && role !== 'test' && role !== 'config') continue;
      selected.push({
        id: entry['id'] as string,
        relevanceReason: entry['relevanceReason'] as string,
        role: role as ContextRole,
      });
    }

    return {
      selected,
      plan: obj['plan'] as string,
      estimatedFiles: (obj['estimatedFiles'] as unknown[])
        .filter((f): f is string => typeof f === 'string'),
    };
  } catch {
    return null;
  }
}

// ─── Symbol source retrieval ───────────────────────────────────────────────────

function fetchSymbolSources(
  db: Database.Database,
  repoId: string,
  symbols: SymbolRecord[],
): Map<string, string> {
  const fileCache = new Map<string, Buffer | null>();
  const result = new Map<string, string>();

  for (const sym of symbols) {
    if (!fileCache.has(sym.filePath)) {
      fileCache.set(sym.filePath, getFileContent(db, repoId, sym.filePath));
    }
    const content = fileCache.get(sym.filePath) ?? null;
    if (content) {
      result.set(sym.id, expandWithContextLines(content, sym.startByte, sym.endByte, 0));
    }
  }
  return result;
}

// ─── Handler ───────────────────────────────────────────────────────────────────

interface GetTaskContextArgs {
  repoId: string;
  task: string;
  maxSymbols?: number;
  includeSource?: boolean;
  model?: string;
}

export async function handler(args: GetTaskContextArgs): Promise<CallToolResult> {
  const t0 = Date.now();

  const repoId =
    args.repoId.length === 16 && /^[0-9a-f]+$/.test(args.repoId)
      ? args.repoId
      : computeRepoId(args.repoId);

  const maxSymbols = Math.min(args.maxSymbols ?? DEFAULT_MAX_SYMBOLS, 50);
  const includeSource = args.includeSource ?? false;

  const db = openDatabase(repoId);

  try {
    const repoMeta = getRepo(db, repoId);
    if (!repoMeta) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Repo not found: ${args.repoId}` }),
        }],
        isError: true,
      };
    }

    // ── Stage 1: Discovery ───────────────────────────────────────────────────

    let candidates: SymbolRecord[] = [];
    let usedSemantic = false;

    const embeddingCount = countEmbeddings(db, repoId);

    if (embeddingCount > 0) {
      try {
        const config = getConfig();
        const provider = createEmbeddingProvider(config);
        const vectorStore = new VectorStore(repoId, provider, db);
        await vectorStore.rebuild();
        const searcher = new HybridSearcher(repoId, vectorStore, db);

        const results = await searcher.search(args.task, {
          maxResults: DISCOVERY_CANDIDATES,
          keywordWeight: 0.4,
          semanticWeight: 0.6,
        });

        candidates = results.map((r) => r.symbol);
        usedSemantic = true;
        logger.debug('get_task_context: discovery via hybrid search', {
          candidates: candidates.length,
        });
      } catch (err) {
        logger.warn(`get_task_context: hybrid search failed (${err}), falling back to FTS5`);
      }
    }

    if (candidates.length === 0) {
      // FTS5 fallback
      const ftsResults = ftsSearchSymbols(db, repoId, args.task, { limit: DISCOVERY_CANDIDATES });
      candidates = ftsResults;
      logger.debug('get_task_context: discovery via FTS5', { candidates: candidates.length });
    }

    if (candidates.length === 0) {
      db.close();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            task: args.task,
            plan: 'No symbols found matching this task description. The repo may need re-indexing.',
            contextItems: [],
            estimatedFiles: [],
            totalTokens: 0,
            _meta: {
              ...buildMeta({ timingMs: Date.now() - t0 }),
              aiUsed: false,
              candidatesDiscovered: 0,
              symbolsSelected: 0,
            },
          }),
        }],
      };
    }

    // ── Stage 2: AI Ranking (or semantic fallback) ────────────────────────────

    let contextItems: ContextItem[] = [];
    let plan = '';
    let estimatedFiles: string[] = [];
    let aiUsed = false;

    const prompt = buildPlanningPrompt(args.task, candidates);
    const aiText = await callAI(prompt, args.model);

    if (aiText) {
      const parsed = parsePlanResponse(aiText);
      if (parsed && parsed.selected.length > 0) {
        const symbolMap = new Map(candidates.map((s) => [s.id, s]));
        plan = parsed.plan;
        estimatedFiles = parsed.estimatedFiles;
        aiUsed = true;

        const selected = parsed.selected.slice(0, maxSymbols);
        for (const sel of selected) {
          const sym = symbolMap.get(sel.id);
          if (!sym) continue;
          contextItems.push({
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind as SymbolKind,
            filePath: sym.filePath,
            signature: sym.signature,
            summary: sym.summary,
            relevanceReason: sel.relevanceReason,
            role: sel.role,
          });
        }

        logger.debug('get_task_context: AI ranking complete', {
          selected: contextItems.length,
        });
      } else {
        logger.warn('get_task_context: AI response parse failed, falling back to semantic ranking');
      }
    }

    // Semantic/keyword ranking fallback (no AI or parse failure)
    if (contextItems.length === 0) {
      const top = candidates.slice(0, maxSymbols);
      for (const sym of top) {
        contextItems.push({
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind as SymbolKind,
          filePath: sym.filePath,
          signature: sym.signature,
          summary: sym.summary,
          relevanceReason: usedSemantic
            ? 'Ranked by hybrid semantic+keyword similarity to task description'
            : 'Ranked by keyword similarity to task description',
          role: 'primary',
        });
      }
      // Derive estimated files from selected symbols
      estimatedFiles = [...new Set(contextItems.map((item) => item.filePath))];
      plan = aiUsed
        ? 'AI response could not be parsed — showing top-ranked candidates by semantic similarity.'
        : 'No AI provider configured — showing top-ranked candidates by semantic similarity.';
    }

    // ── Source retrieval (optional) ───────────────────────────────────────────

    let totalTokens = 0;

    if (includeSource && contextItems.length > 0) {
      const symbolsToFetch = contextItems
        .map((item) => candidates.find((c) => c.id === item.symbolId))
        .filter((s): s is SymbolRecord => s !== undefined);

      const sourceMap = fetchSymbolSources(db, repoId, symbolsToFetch);
      for (const item of contextItems) {
        const src = sourceMap.get(item.symbolId);
        if (src) {
          item.source = src;
          totalTokens += Math.ceil(src.length / 4); // ~4 chars per token
        }
      }
    } else {
      // Estimate tokens from summaries + signatures
      for (const item of contextItems) {
        totalTokens += Math.ceil((item.summary.length + item.signature.length) / 4);
      }
    }

    db.close();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          {
            task: args.task,
            plan,
            contextItems,
            estimatedFiles,
            totalTokens,
            _meta: {
              ...buildMeta({ timingMs: Date.now() - t0 }),
              aiUsed,
              candidatesDiscovered: candidates.length,
              symbolsSelected: contextItems.length,
            },
          },
          null,
          2,
        ),
      }],
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
