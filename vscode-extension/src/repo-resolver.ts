/**
 * RepoResolver — auto-detect the PureContext repoId that matches the current
 * workspace folder by comparing repo rootPaths against the open file path.
 *
 * Resolution priority:
 * 1. Explicit `purecontext.repoId` setting (non-empty).
 * 2. Match `GET /api/repos` by rootPath prefix against the active file.
 *
 * Results are cached for 60 s to avoid repeated API calls.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { listRepos, PureContextClientError, type RepoMeta } from './client';

interface Resolved {
  repoId: string;
  rootPath: string;
}

interface CacheEntry {
  result: Resolved | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;

export class RepoResolver {
  private readonly _cache = new Map<string, CacheEntry>();

  /**
   * Resolve the repo for the given file path.
   * Returns null when no matching repo is found (file not indexed).
   * Throws PureContextClientError on network failure.
   */
  async resolve(serverUrl: string, filePath: string | undefined): Promise<Resolved | null> {
    const config = vscode.workspace.getConfiguration('purecontext');
    const explicitId = config.get<string>('repoId');

    if (explicitId) {
      // Explicit config — look up the rootPath so callers can compute relative paths
      const key = `explicit:${serverUrl}:${explicitId}`;
      const cached = this._getCached(key);
      if (cached !== undefined) return cached;

      try {
        const repos = await listRepos(serverUrl);
        const meta = repos.repos.find((r) => r.repoId === explicitId);
        if (!meta) {
          this._setCached(key, null);
          return null;
        }
        const resolved = { repoId: meta.repoId, rootPath: meta.rootPath };
        this._setCached(key, resolved);
        return resolved;
      } catch (err) {
        if (err instanceof PureContextClientError) throw err;
        throw new PureContextClientError(0, String(err));
      }
    }

    // Auto-detect by workspace folder or active file path
    const searchPath = filePath ?? this._workspacePath();
    if (!searchPath) return null;

    const key = `auto:${serverUrl}:${searchPath}`;
    const cached = this._getCached(key);
    if (cached !== undefined) return cached;

    let repos: RepoMeta[];
    try {
      const response = await listRepos(serverUrl);
      repos = response.repos;
    } catch (err) {
      if (err instanceof PureContextClientError) throw err;
      throw new PureContextClientError(0, String(err));
    }

    // Sort by rootPath length descending — longest match wins
    const sorted = [...repos].sort((a, b) => b.rootPath.length - a.rootPath.length);
    const normalizedSearch = normalizePath(searchPath);
    const match = sorted.find((r) => normalizedSearch.startsWith(normalizePath(r.rootPath)));

    const resolved = match ? { repoId: match.repoId, rootPath: match.rootPath } : null;
    this._setCached(key, resolved);
    return resolved;
  }

  /** Invalidate cache so next call re-fetches. */
  invalidate(): void {
    this._cache.clear();
  }

  private _workspacePath(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private _getCached(key: string): Resolved | null | undefined {
    const entry = this._cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  private _setCached(key: string, result: Resolved | null): void {
    this._cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

function normalizePath(p: string): string {
  return path.normalize(p).replace(/\\/g, '/').toLowerCase();
}
