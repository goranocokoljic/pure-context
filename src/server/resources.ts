/**
 * MCP Resource handlers — Task 153: MCP Resources Exposure.
 *
 * Exposes indexed repos and their files as MCP Resources so that clients
 * supporting the Resources protocol can browse the index without tool calls.
 *
 * URI scheme: purecontext://repos/{repoId}/...
 */

import { readdirSync, existsSync } from 'fs';
import { getIndexDir, openDatabase, getRepo } from '../core/db/schema.js';
import { getSymbolsByRepo, getSymbolsByFile, getSymbolById } from '../core/db/symbol-store.js';
import { getFileContent } from '../core/db/file-store.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

// ─── purecontext://repos ──────────────────────────────────────────────────────

/**
 * List all indexed repos. Used for the static `purecontext://repos` resource.
 */
export function readReposResource(uri: string): ReadResourceResult {
  const dir = getIndexDir();
  const repos: object[] = [];

  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.db')) continue;
      const repoId = file.slice(0, -3);
      try {
        const db = openDatabase(repoId);
        const meta = getRepo(db, repoId);
        db.close();
        if (meta) repos.push({ ...meta, workspaceId: meta.tenantId ?? 'local' });
      } catch { /* skip corrupt DBs */ }
    }
  }

  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ repos }, null, 2),
    }],
  };
}

// ─── purecontext://repos/{repoId}/outline ─────────────────────────────────────

/**
 * Return the symbol outline for a repo. Methods are excluded (top-level only).
 */
export function readRepoOutlineResource(uri: string, repoId: string): ReadResourceResult {
  const db = openDatabase(repoId);
  const allSymbols = getSymbolsByRepo(db, repoId);
  db.close();

  const byFile = new Map<string, object[]>();
  for (const s of allSymbols) {
    if (s.kind === 'method') continue;
    let arr = byFile.get(s.filePath);
    if (!arr) { arr = []; byFile.set(s.filePath, arr); }
    arr.push({ id: s.id, name: s.name, kind: s.kind, signature: s.signature, summary: s.summary });
  }

  const files = Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, symbols]) => ({ filePath, symbols }));

  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({ repoId, fileCount: files.length, files }, null, 2),
    }],
  };
}

// ─── purecontext://repos/{repoId}/files/{filePath} ───────────────────────────

/**
 * Return the symbol outline for a specific file in a repo.
 * `filePath` should be URL-decoded before being passed here.
 */
export function readFileOutlineResource(uri: string, repoId: string, filePath: string): ReadResourceResult {
  const db = openDatabase(repoId);
  const symbols = getSymbolsByFile(db, repoId, filePath);
  db.close();

  return {
    contents: [{
      uri,
      mimeType: 'application/json',
      text: JSON.stringify({
        repoId,
        filePath,
        count: symbols.length,
        symbols: symbols.map((s) => ({
          id: s.id, name: s.name, kind: s.kind, signature: s.signature, summary: s.summary,
        })),
      }, null, 2),
    }],
  };
}

// ─── purecontext://repos/{repoId}/symbols/{symbolId} ─────────────────────────

/**
 * Return the raw source code for a symbol (byte-slice from cached file content).
 * Throws if the symbol or its cached file content is not found.
 */
export function readSymbolSourceResource(uri: string, repoId: string, symbolId: string): ReadResourceResult {
  const db = openDatabase(repoId);
  const symbol = getSymbolById(db, repoId, symbolId);

  if (!symbol) {
    db.close();
    throw new Error(`Symbol "${symbolId}" not found in repo "${repoId}"`);
  }

  const raw = getFileContent(db, repoId, symbol.filePath);
  db.close();

  if (!raw) {
    throw new Error(`Source content for "${symbol.filePath}" is not cached. Re-index with content storage enabled.`);
  }

  const source = raw.slice(symbol.startByte, symbol.endByte).toString('utf8');

  return {
    contents: [{ uri, mimeType: 'text/plain', text: source }],
  };
}
