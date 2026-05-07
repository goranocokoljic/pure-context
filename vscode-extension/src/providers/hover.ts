/**
 * HoverProvider — show PureContext symbol info when hovering over an identifier.
 *
 * On hover:
 *  1. Extract the word under the cursor.
 *  2. Search symbols in the current repo for an exact name match.
 *  3. Show: signature, summary, and blast radius count.
 *  4. Include a link to the web UI blast radius page.
 *
 * Results are cached 30 s per (repoId, word) to avoid hammering the server.
 */

import * as vscode from 'vscode';
import {
  searchSymbols,
  getBlastRadius,
  PureContextClientError,
  type SearchResult,
} from '../client';
import type { RepoResolver } from '../repo-resolver';

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  hover: vscode.Hover | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(repoId: string, word: string): string {
  return `${repoId}:${word}`;
}

function getCached(repoId: string, word: string): vscode.Hover | null | undefined {
  const entry = cache.get(cacheKey(repoId, word));
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(repoId, word));
    return undefined;
  }
  return entry.hover;
}

function setCached(repoId: string, word: string, hover: vscode.Hover | null): void {
  cache.set(cacheKey(repoId, word), { hover, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class HoverProvider implements vscode.HoverProvider {
  constructor(private readonly resolver: RepoResolver) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | null> {
    const config = vscode.workspace.getConfiguration('purecontext');
    if (!config.get<boolean>('enableHover')) return null;

    const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';

    const wordRange = document.getWordRangeAtPosition(position, /[\w$]+/);
    if (!wordRange) return null;
    const word = document.getText(wordRange);
    if (!word || word.length < 2) return null;

    let repoId: string;
    try {
      const resolved = await this.resolver.resolve(serverUrl, document.uri.fsPath);
      if (!resolved) return null;
      repoId = resolved.repoId;
    } catch {
      return null;
    }

    // Check cache
    const cached = getCached(repoId, word);
    if (cached !== undefined) return cached;

    const signal = token.isCancellationRequested
      ? AbortSignal.abort()
      : makeAbortSignal(token);

    let symbol: SearchResult | null = null;
    try {
      const result = await searchSymbols(serverUrl, repoId, word, { limit: 5 }, signal);
      // Find exact name match (case-sensitive)
      symbol = result.results.find((r) => r.name === word) ?? null;
    } catch (err) {
      if (err instanceof PureContextClientError && err.status === 0) {
        // Server offline — cache null so we don't spam requests
        setCached(repoId, word, null);
      }
      return null;
    }

    if (!symbol || token.isCancellationRequested) {
      setCached(repoId, word, null);
      return null;
    }

    // Fetch blast radius (best-effort — don't fail hover if unavailable)
    let blastCount = 0;
    try {
      const br = await getBlastRadius(serverUrl, repoId, symbol.id, signal);
      blastCount = br.totalAffected;
    } catch {
      // ignore
    }

    if (token.isCancellationRequested) return null;

    const hover = buildHover(symbol, blastCount, serverUrl, repoId);
    setCached(repoId, word, hover);
    return hover;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildHover(
  symbol: SearchResult,
  blastCount: number,
  serverUrl: string,
  repoId: string,
): vscode.Hover {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = false;

  // Header: kind + name
  md.appendMarkdown(`**\`${symbol.kind}\`** \`${symbol.name}\`\n\n`);

  // Signature block
  if (symbol.signature) {
    md.appendCodeblock(symbol.signature, 'typescript');
  }

  // Summary
  if (symbol.summary) {
    md.appendMarkdown(`\n${symbol.summary}\n\n`);
  }

  // Blast radius badge + link
  const blastBadge = blastCount > 0
    ? `$(flame) Blast radius: **${blastCount} file${blastCount === 1 ? '' : 's'}**`
    : `$(circle-slash) Blast radius: no dependents`;

  const webUiUrl = `${serverUrl}/repos/${repoId}/blast-radius?symbolId=${symbol.id}`;
  md.appendMarkdown(`${blastBadge} — [View in Web UI](${webUiUrl})\n`);

  return new vscode.Hover(md);
}

function makeAbortSignal(token: vscode.CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}
