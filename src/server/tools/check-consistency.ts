import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolsByRepo } from '../../core/db/symbol-store.js';
import { getConfig } from '../../config/config-loader.js';
import { gateCheckConsistency } from './gate-envelope.js';
import { buildMeta } from './_meta.js';
import type { SymbolRecord, SymbolKind } from '../../core/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'check_consistency';

export const description =
  'Pre-write consistency check for a symbol/file you are ABOUT to create — the greenfield ' +
  'mirror of prepare_change (needs zero git history). Given the intended name (+ optional ' +
  'kind/signature/file path), it returns: duplicates ("you already wrote this"), patternFit ' +
  '(the closest existing siblings to mirror), placement (does the intended path fit the ' +
  'established structure?), and existingApiPointer (what already lives in the target area). ' +
  'Runs on structural search alone — no embedding provider required (mode:"structural").';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  name: z.string().describe('The intended new symbol name (e.g. "WindsurfConnector", "parseExpenseRow")'),
  kind: z
    .string()
    .optional()
    .describe('Intended symbol kind (function, class, method, component, …) — narrows pattern matching'),
  signature: z.string().optional().describe('Intended one-line signature (optional, improves matching)'),
  intendedFilePath: z
    .string()
    .optional()
    .describe('Where you intend to put it (repo-relative) — enables placement + existingApiPointer'),
  codeSnippet: z.string().optional().describe('Optional draft body (reserved for future semantic dedup)'),
};

// ── Small structural helpers (no embeddings needed) ───────────────────────────

/** Split an identifier into lowercase word tokens (camelCase + snake + separators). */
function nameTokens(raw: string): string[] {
  const out: string[] = [];
  for (const seg of raw.split(/[\\/:.@\-\s]+/)) {
    for (const sub of seg.split('_').filter(Boolean)) {
      const camel = sub
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(' ')
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 2);
      out.push(...camel);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(0, i) : '';
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

const DUPLICATE_JACCARD = 0.6;
const SMALL_INDEX_THRESHOLD = 15; // below this the index is too sparse for confident dedup

interface DuplicateHit {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string;
  similarity: number;
  reasons: string[];
}

export function handler(args: {
  repoId: string;
  name: string;
  kind?: string;
  signature?: string;
  intendedFilePath?: string;
  codeSnippet?: string;
}): CallToolResult {
  const start = Date.now();
  const cfg = getConfig();
  const maxDuplicates = cfg.consistency?.maxDuplicates ?? 5;
  const maxPatternFit = cfg.consistency?.maxPatternFit ?? 5;
  const maxApiPointer = cfg.consistency?.maxApiPointer ?? 20;

  const db = openDatabase(args.repoId);
  try {
    const repo = getRepo(db, args.repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { error: `Repository ${args.repoId} not found — run index_folder first`, repoId: args.repoId },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const all = getSymbolsByRepo(db, args.repoId);
    const signalQuality: 'ok' | 'low' = all.length < SMALL_INDEX_THRESHOLD ? 'low' : 'ok';

    const intendedTokens = nameTokens(args.name);
    const intendedSet = new Set(intendedTokens);
    const lowerName = args.name.toLowerCase();
    const intendedPath = args.intendedFilePath ? normPath(args.intendedFilePath) : null;
    const intendedDir = intendedPath ? dirOf(intendedPath) : null;

    // Candidate pool: everything except symbols already in the file being written.
    const pool = all.filter((s) => normPath(s.filePath) !== intendedPath);

    // ── duplicates ─────────────────────────────────────────────────────────
    // Suppressed on a near-empty index — never invent "you already wrote this"
    // when there's almost nothing to compare against.
    let duplicates: DuplicateHit[] = [];
    if (signalQuality === 'ok') {
      const scored: DuplicateHit[] = [];
      for (const s of pool) {
        const exact = s.name.toLowerCase() === lowerName;
        const sim = exact ? 1 : jaccard(intendedSet, new Set(nameTokens(s.name)));
        if (!exact && sim < DUPLICATE_JACCARD) continue;
        const reasons: string[] = [];
        if (exact) reasons.push(`A symbol named "${s.name}" already exists in ${s.filePath}`);
        else reasons.push(`Shares ${Math.round(sim * 100)}% of its name tokens with existing "${s.name}" (${s.filePath})`);
        if (args.kind && s.kind === args.kind) reasons.push(`Same kind (${s.kind}) — likely the same concept`);
        scored.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          filePath: s.filePath,
          signature: s.signature,
          similarity: Number(sim.toFixed(3)),
          reasons,
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      duplicates = scored.slice(0, maxDuplicates);
    }

    // ── patternFit ───────────────────────────────────────────────────────────
    // Existing siblings that share the dominant concept token (e.g. the
    // "Connector" in "WindsurfConnector") — the house style to mirror.
    const familyToken = intendedTokens.length > 0 ? intendedTokens[intendedTokens.length - 1] : null;
    const dupIds = new Set(duplicates.map((d) => d.id));
    const patternFit: Array<{ id: string; name: string; kind: SymbolKind; filePath: string; reasons: string[] }> = [];
    if (familyToken) {
      const fam = pool
        .filter((s) => !dupIds.has(s.id))
        .filter((s) => (args.kind ? s.kind === args.kind : true))
        .map((s) => ({ s, toks: new Set(nameTokens(s.name)) }))
        .filter((x) => x.toks.has(familyToken))
        .map((x) => ({ s: x.s, sim: jaccard(intendedSet, x.toks) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, maxPatternFit);
      for (const { s } of fam) {
        patternFit.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          filePath: s.filePath,
          reasons: [`Existing ${s.kind} sharing the "${familyToken}" concept — mirror its shape and placement`],
        });
      }
    }

    // ── placement ──────────────────────────────────────────────────────────
    let placement: { intendedFilePath: string; fits: boolean; reasons: string[] } | null = null;
    if (intendedPath) {
      const reasons: string[] = [];
      let fits = true;
      // Where do the sibling-family symbols actually live?
      const famDirs = new Map<string, number>();
      for (const pf of patternFit) {
        const d = dirOf(pf.filePath);
        famDirs.set(d, (famDirs.get(d) ?? 0) + 1);
      }
      if (famDirs.size > 0) {
        const dominant = [...famDirs.entries()].sort((a, b) => b[1] - a[1])[0];
        const inFamilyDir = intendedDir !== null && famDirs.has(intendedDir);
        if (!inFamilyDir) {
          fits = false;
          reasons.push(
            `Sibling ${args.kind ?? 'symbol'}s of this kind live under "${dominant[0]}/" — intended path is "${intendedDir}/"`,
          );
        } else {
          reasons.push(`Intended directory "${intendedDir}/" matches where similar symbols already live`);
        }
      } else {
        reasons.push('No established sibling location found — first of its kind, placement is unconstrained');
      }
      placement = { intendedFilePath: intendedPath, fits, reasons };
    }

    // ── existingApiPointer ───────────────────────────────────────────────────
    // What already lives in the target directory, so the cold agent doesn't grep.
    let existingApiPointer: { dir: string; symbols: string[] } | null = null;
    if (intendedDir !== null) {
      const prefix = intendedDir === '' ? '' : intendedDir + '/';
      const names = all
        .filter((s) => normPath(s.filePath).startsWith(prefix))
        .filter((s) => normPath(s.filePath) !== intendedPath)
        .map((s) => s.name);
      existingApiPointer = { dir: intendedDir, symbols: Array.from(new Set(names)).slice(0, maxApiPointer) };
    }

    const envelope = gateCheckConsistency({ signalQuality, duplicates, placement });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId: args.repoId,
              mode: 'structural',
              signalQuality,
              ...(signalQuality === 'low' && {
                note: 'Index is sparse — duplicate detection suppressed to avoid false "already exists" claims.',
              }),
              ...envelope,
              duplicates,
              patternFit,
              placement,
              existingApiPointer,
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
