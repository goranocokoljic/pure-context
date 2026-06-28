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
import { ftsSearchSymbols, getSymbolsByFile } from '../../core/db/symbol-store.js';
import { countCommits } from '../../core/db/co-change-store.js';
import { getContextBundle, getBlastRadius } from '../../graph/graph-traversal.js';
import { getCoChange } from './co-change.js';
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
  "In the default 'associative' mode it discovers seed symbols, then walks the real " +
  'dependency + co-change graph around them (imports, callers, historically co-changing ' +
  'files), derives each symbol\'s role from the edge that surfaced it, and reports ' +
  'evidenceGaps (what was dropped / co-change partners you may also need) and ' +
  'suggestedProbes. AI ranking is used when configured; otherwise results are ranked by ' +
  'graph provenance. Pass mode:"flat" for the legacy single-pass similarity selection. ' +
  'Eliminates the need for iterative search-and-read discovery loops.';

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
  mode: z
    .enum(['flat', 'associative'])
    .optional()
    .describe(
      "Retrieval mode. 'associative' (default) expands the top discovery hits along the " +
        'dependency + co-change graph, derives roles from edges, and reports evidence gaps. ' +
        "'flat' is the legacy single-pass similarity selection.",
    ),
};

// ─── Types ─────────────────────────────────────────────────────────────────────

// 'primary' | 'dependency' | 'test' | 'config' are the original (flat-mode / AI) roles.
// 'caller' | 'historical' are derived from graph edges in associative mode.
type ContextRole = 'primary' | 'dependency' | 'caller' | 'historical' | 'test' | 'config';

/** How a candidate entered the pool during associative expansion. */
type ExpansionVia = 'seed' | 'imports' | 'importedBy' | 'coChange';

/** Provenance of an associative-mode candidate: which graph edge surfaced it. */
interface Provenance {
  via: ExpansionVia;
  /** Seed symbol this candidate was reached from (absent for seeds themselves). */
  seedId?: string;
  seedName?: string;
  /** Co-change directional confidence (only for via='coChange'). */
  confidence?: number;
}

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
  /** Present only in mode='associative'. */
  provenance?: Provenance;
}

/** Config governing associative fanout (config.taskContext). */
interface TaskContextCfg {
  seedCount: number;
  expansionDepth: number;
  maxPool: number;
  maxCoChangePartners: number;
  maxSymbolsPerPartner: number;
}

/** Result of associative seed expansion (Stage 1.5). */
interface ExpansionResult {
  /** Candidate pool (discovery first, then expansion-only), capped to maxPool. */
  pool: SymbolRecord[];
  /** symbolId → provenance (seeds + expansion-reached symbols). */
  provenance: Map<string, Provenance>;
  /** Count of candidates dropped by the maxPool cap. */
  droppedByBudget: number;
  /** Co-change partner files surfaced during expansion (for the gap report). */
  coChangePartnerFiles: Set<string>;
  /** True when co-change was suppressed (no commits / signalQuality 'low'). */
  coChangeSuppressed: boolean;
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

/** Render a one-line provenance hint for the AI prompt (empty when no provenance). */
function provenanceHint(p: Provenance | undefined): string {
  if (!p) return '';
  if (p.via === 'seed') return '  via=seed';
  const seed = p.seedName ?? p.seedId ?? '?';
  if (p.via === 'coChange') {
    const conf = p.confidence !== undefined ? `, conf=${p.confidence.toFixed(2)}` : '';
    return `  via=coChange(seed=${seed}${conf})`;
  }
  return `  via=${p.via}(seed=${seed})`;
}

/** Map a graph edge type to a context role (associative mode). */
function roleFromVia(via: ExpansionVia | undefined): ContextRole {
  switch (via) {
    case 'imports':
      return 'dependency';
    case 'importedBy':
      return 'caller';
    case 'coChange':
      return 'historical';
    case 'seed':
    default:
      return 'primary';
  }
}

/** Human-readable relevance reason for the no-AI fallback path (associative mode). */
function fallbackReason(p: Provenance | undefined, usedSemantic: boolean): string {
  const seed = p?.seedName ?? p?.seedId ?? 'a seed';
  switch (p?.via) {
    case 'imports':
      return `Dependency imported by seed ${seed}`;
    case 'importedBy':
      return `Caller / dependent of seed ${seed}`;
    case 'coChange':
      return `Historically co-changes with seed ${seed}`;
    case 'seed':
    default:
      return usedSemantic
        ? 'Ranked by hybrid semantic+keyword similarity to task description'
        : 'Ranked by keyword similarity to task description';
  }
}

/** Provenance-weight for ranking expansion-only candidates into the pool cap. */
function provenanceWeight(via: ExpansionVia | undefined): number {
  switch (via) {
    case 'importedBy':
      return 3;
    case 'imports':
      return 2;
    case 'coChange':
      return 1;
    default:
      return 0;
  }
}

/**
 * Stage 1.5 — active associative expansion.
 *
 * For the top `seedCount` discovery candidates, walk the dependency graph
 * (forward imports + reverse callers) and the temporal co-change graph, building
 * a deduped candidate pool annotated with provenance. Pure function over the open
 * db — composes existing engines (getContextBundle / getBlastRadius / getCoChange);
 * no graph logic is reimplemented here.
 *
 * Exported for testing.
 */
export function expandSeeds(
  db: Database.Database,
  repoId: string,
  candidates: SymbolRecord[],
  cfg: TaskContextCfg,
): ExpansionResult {
  const provenance = new Map<string, Provenance>();
  const pool = new Map<string, SymbolRecord>();
  for (const c of candidates) pool.set(c.id, c);

  const seeds = candidates.slice(0, cfg.seedCount);
  for (const s of seeds) provenance.set(s.id, { via: 'seed' });

  const hasCommits = countCommits(db, repoId) > 0;
  let coChangeSuppressed = !hasCommits;
  const coChangePartnerFiles = new Set<string>();
  const megaCommitThreshold = getConfig().git?.megaCommitThreshold ?? 30;
  const ccCache = new Map<string, ReturnType<typeof getCoChange>>();

  const add = (sym: SymbolRecord, via: ExpansionVia, seed: SymbolRecord, confidence?: number): void => {
    if (!pool.has(sym.id)) pool.set(sym.id, sym);
    // First writer wins: never downgrade a seed (or an earlier, stronger edge).
    if (!provenance.has(sym.id)) {
      const p: Provenance = { via, seedId: seed.id, seedName: seed.name };
      if (confidence !== undefined) p.confidence = confidence;
      provenance.set(sym.id, p);
    }
  };

  for (const seed of seeds) {
    // Forward deps — what the seed needs.
    for (const sym of getContextBundle(seed.id, repoId, db, cfg.expansionDepth).symbols) {
      add(sym, 'imports', seed);
    }
    // Reverse deps — callers / dependents (cheap dep_edges BFS, not a content scan).
    for (const sym of getBlastRadius(seed.id, repoId, db, cfg.expansionDepth).symbols) {
      add(sym, 'importedBy', seed);
    }
    // Temporal — historically co-changing partner files (the edge no static graph has).
    if (hasCommits && cfg.maxCoChangePartners > 0) {
      let cc = ccCache.get(seed.filePath);
      if (!cc) {
        cc = getCoChange(db, repoId, seed.filePath, {
          megaCommitThreshold,
          topN: cfg.maxCoChangePartners,
        });
        ccCache.set(seed.filePath, cc);
      }
      if (cc.signalQuality === 'low') {
        coChangeSuppressed = true;
      } else {
        for (const partner of cc.partners.slice(0, cfg.maxCoChangePartners)) {
          coChangePartnerFiles.add(partner.filePath);
          const partnerSyms = getSymbolsByFile(db, repoId, partner.filePath).slice(
            0,
            cfg.maxSymbolsPerPartner,
          );
          for (const sym of partnerSyms) add(sym, 'coChange', seed, partner.confidence);
        }
      }
    }
  }

  // Rank for the cap: discovery candidates first (preserve discovery order), then
  // expansion-only symbols by provenance weight, then by id for determinism.
  const discoveryIds = new Set(candidates.map((c) => c.id));
  const expansionOnly = [...pool.values()].filter((s) => !discoveryIds.has(s.id));
  expansionOnly.sort((a, b) => {
    const w = provenanceWeight(provenance.get(b.id)?.via) - provenanceWeight(provenance.get(a.id)?.via);
    if (w !== 0) return w;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const ordered = [...candidates, ...expansionOnly];
  const droppedByBudget = Math.max(0, ordered.length - cfg.maxPool);

  return {
    pool: ordered.slice(0, cfg.maxPool),
    provenance,
    droppedByBudget,
    coChangePartnerFiles,
    coChangeSuppressed,
  };
}

/**
 * Build the AI prompt for context planning.
 * Exported for testing.
 */
export function buildPlanningPrompt(
  task: string,
  candidates: SymbolRecord[],
  provenance?: Map<string, Provenance>,
): string {
  const candidateList = candidates
    .map((s, i) => {
      const hint = provenance ? provenanceHint(provenance.get(s.id)) : '';
      return `${i + 1}. id=${s.id}  name=${s.name}  kind=${s.kind}  file=${s.filePath}${hint}\n   ${s.summary}`;
    })
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
  mode?: 'flat' | 'associative';
}

export async function handler(args: GetTaskContextArgs): Promise<CallToolResult> {
  const t0 = Date.now();

  const repoId =
    args.repoId.length === 16 && /^[0-9a-f]+$/.test(args.repoId)
      ? args.repoId
      : computeRepoId(args.repoId);

  const maxSymbols = Math.min(args.maxSymbols ?? DEFAULT_MAX_SYMBOLS, 50);
  const includeSource = args.includeSource ?? false;
  const mode = args.mode ?? 'associative';

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
      const emptyAssociative =
        mode === 'associative'
          ? {
              evidenceGaps: { lowConfidenceSeeds: [], droppedByBudget: 0, unselectedCoChange: [] },
              suggestedProbes: [
                `No symbols matched "${args.task}". Confirm the feature exists, re-word the ` +
                  'query, or re-index the repo if it is stale.',
              ],
            }
          : {};
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            task: args.task,
            plan: 'No symbols found matching this task description. The repo may need re-indexing.',
            contextItems: [],
            estimatedFiles: [],
            totalTokens: 0,
            ...emptyAssociative,
            _meta: {
              ...buildMeta({ timingMs: Date.now() - t0 }),
              aiUsed: false,
              candidatesDiscovered: 0,
              symbolsSelected: 0,
              ...(mode === 'associative' ? { mode, seedsExpanded: 0, poolSize: 0 } : {}),
            },
          }),
        }],
      };
    }

    // ── Stage 1.5: Active associative expansion (associative mode only) ────────

    let pool: SymbolRecord[] = candidates;
    let provenance = new Map<string, Provenance>();
    let droppedByBudget = 0;
    let coChangePartnerFiles = new Set<string>();
    let coChangeSuppressed = true;
    let seedsExpanded = 0;

    if (mode === 'associative') {
      const tcCfg = getConfig().taskContext;
      const exp = expandSeeds(db, repoId, candidates, tcCfg);
      pool = exp.pool;
      provenance = exp.provenance;
      droppedByBudget = exp.droppedByBudget;
      coChangePartnerFiles = exp.coChangePartnerFiles;
      coChangeSuppressed = exp.coChangeSuppressed;
      seedsExpanded = Math.min(tcCfg.seedCount, candidates.length);
      logger.debug('get_task_context: associative expansion', {
        discovery: candidates.length,
        pool: pool.length,
        droppedByBudget,
      });
    }

    // ── Stage 2: AI Ranking (or semantic fallback) ────────────────────────────

    let contextItems: ContextItem[] = [];
    let plan = '';
    let estimatedFiles: string[] = [];
    let aiUsed = false;

    const prompt = buildPlanningPrompt(
      args.task,
      pool,
      mode === 'associative' ? provenance : undefined,
    );
    const aiText = await callAI(prompt, args.model);

    if (aiText) {
      const parsed = parsePlanResponse(aiText);
      if (parsed && parsed.selected.length > 0) {
        const symbolMap = new Map(pool.map((s) => [s.id, s]));
        plan = parsed.plan;
        estimatedFiles = parsed.estimatedFiles;
        aiUsed = true;

        const selected = parsed.selected.slice(0, maxSymbols);
        for (const sel of selected) {
          const sym = symbolMap.get(sel.id);
          if (!sym) continue;
          const prov = provenance.get(sym.id);
          const item: ContextItem = {
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind as SymbolKind,
            filePath: sym.filePath,
            signature: sym.signature,
            summary: sym.summary,
            relevanceReason: sel.relevanceReason,
            // Associative: derive the edge-type role from the graph, not the AI guess.
            role: mode === 'associative' ? roleFromVia(prov?.via) : sel.role,
          };
          if (mode === 'associative' && prov) item.provenance = prov;
          contextItems.push(item);
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
      // Associative: rank the expanded pool (discovery first, then graph neighbors);
      // flat: the original discovery-only top-N.
      const top = (mode === 'associative' ? pool : candidates).slice(0, maxSymbols);
      for (const sym of top) {
        const prov = provenance.get(sym.id);
        const item: ContextItem = {
          symbolId: sym.id,
          name: sym.name,
          kind: sym.kind as SymbolKind,
          filePath: sym.filePath,
          signature: sym.signature,
          summary: sym.summary,
          relevanceReason:
            mode === 'associative'
              ? fallbackReason(prov, usedSemantic)
              : usedSemantic
                ? 'Ranked by hybrid semantic+keyword similarity to task description'
                : 'Ranked by keyword similarity to task description',
          role: mode === 'associative' ? roleFromVia(prov?.via) : 'primary',
        };
        if (mode === 'associative' && prov) item.provenance = prov;
        contextItems.push(item);
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
        .map((item) => pool.find((c) => c.id === item.symbolId))
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

    // ── Evidence gaps + suggested probes (associative mode only) ───────────────

    let associativeFields: Record<string, unknown> = {};
    if (mode === 'associative') {
      const selectedFiles = new Set(contextItems.map((i) => i.filePath));
      const unselectedCoChange = coChangeSuppressed
        ? []
        : [...coChangePartnerFiles].filter((f) => !selectedFiles.has(f)).sort();
      // Few candidates surfacing is the real "this may not exist" signal.
      const lowConfidenceSeeds =
        candidates.length < 5 ? candidates.slice(0, seedsExpanded).map((s) => s.name) : [];

      const suggestedProbes: string[] = [];
      if (lowConfidenceSeeds.length > 0) {
        suggestedProbes.push(
          `Only ${candidates.length} candidate(s) matched "${args.task}". Try a broader or ` +
            'differently-worded query, or confirm the feature exists before assuming it does.',
        );
      }
      if (droppedByBudget > 0) {
        suggestedProbes.push(
          `${droppedByBudget} related symbol(s) were dropped by the pool cap ` +
            `(taskContext.maxPool=${getConfig().taskContext.maxPool}). Raise maxPool/maxSymbols, ` +
            'or call get_context_bundle on a key symbol to expand further.',
        );
      }
      if (unselectedCoChange.length > 0) {
        suggestedProbes.push(
          `${unselectedCoChange.length} file(s) that historically co-change with the edited ` +
            'area were not selected — review whether they also need changes.',
        );
      }

      associativeFields = {
        evidenceGaps: { lowConfidenceSeeds, droppedByBudget, unselectedCoChange },
        suggestedProbes,
      };
    }

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
            ...associativeFields,
            _meta: {
              ...buildMeta({ timingMs: Date.now() - t0 }),
              aiUsed,
              candidatesDiscovered: candidates.length,
              symbolsSelected: contextItems.length,
              ...(mode === 'associative'
                ? { mode, seedsExpanded, poolSize: pool.length }
                : {}),
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
