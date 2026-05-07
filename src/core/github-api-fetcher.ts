/**
 * GitHub API fetcher for repository indexing without git clone.
 *
 * Uses the GitHub REST API (v3) to:
 *   1. Fetch the full recursive file tree in a single call
 *   2. Fetch individual file content by blob SHA (raw bytes, no base64)
 *   3. Resolve the default branch and current tree SHA
 *
 * Rate limiting: detects 403/429 responses, retries with exponential
 * backoff + jitter up to MAX_RETRIES times. With a GITHUB_TOKEN the
 * rate limit is 5 000 req/hr; without it is 60 req/hr.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { GitHubApiError, PureContextError } from './errors.js';
import { logger } from './logger.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GitHubTreeEntry {
  /** File path relative to repo root, e.g. "src/index.ts" */
  path: string;
  /** Git blob SHA — uniquely identifies the content of this file version */
  sha: string;
  /** File size in bytes */
  size: number;
  /** 'blob' for files, 'tree' for directories */
  type: 'blob' | 'tree';
  /** URL to fetch via GitHub API */
  url: string;
}

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
}

/** Injectable type for Node's https.request — allows mocking in tests. */
export type HttpRequestFn = typeof httpsRequest;

// ─── URL parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a GitHub URL into owner/repo.
 *
 * Supported forms:
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo/tree/branch`  (branch portion ignored)
 *   - `git@github.com:owner/repo.git`
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  // HTTPS form
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#.]+?)(?:\.git)?(?:[/?#].*)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH form: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/** Returns true if the URL is a GitHub repository URL. */
export function isGitHubUrl(url: string): boolean {
  return parseGitHubUrl(url) !== null;
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────

const GITHUB_API_HOST = 'api.github.com';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
/** Skip files larger than this from the GitHub tree (same as local indexing default). */
const MAX_FILE_SIZE_BYTES = 500_000;

export class GitHubApiFetcher {
  private readonly headers: Record<string, string>;

  constructor(
    token?: string,
    /** Inject a custom request function for testing. */
    private readonly requestFn: HttpRequestFn = httpsRequest,
  ) {
    this.headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'purecontext-mcp',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) {
      this.headers['Authorization'] = `Bearer ${token}`;
    }
  }

  /**
   * Get the default branch name for a repository.
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const data = await this.requestJson<{ default_branch: string }>(
      `/repos/${owner}/${repo}`,
    );
    return data.default_branch;
  }

  /**
   * Get the current commit SHA for a branch.
   * The SHA changes whenever any file is pushed to the branch.
   */
  async getCommitSha(owner: string, repo: string, branch: string): Promise<string> {
    const data = await this.requestJson<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    );
    return data.object.sha;
  }

  /**
   * List all indexable files in a repository using the recursive tree API.
   * Returns only `blob` entries (files, not directories).
   * Files > 500 KB are filtered out.
   *
   * @param owner  GitHub owner (user or org)
   * @param repo   Repository name
   * @param branch Branch name or commit SHA to tree from
   */
  async listFiles(owner: string, repo: string, branch: string): Promise<GitHubTreeEntry[]> {
    const data = await this.requestJson<{
      tree: GitHubTreeEntry[];
      truncated: boolean;
    }>(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);

    if (data.truncated) {
      logger.warn(
        `GitHub tree API returned a truncated result for ${owner}/${repo}. ` +
          'Very large repositories may be partially indexed.',
      );
    }

    return data.tree.filter(
      (e) => e.type === 'blob' && (e.size ?? 0) <= MAX_FILE_SIZE_BYTES,
    );
  }

  /**
   * Fetch the raw byte content of a file by its blob SHA.
   *
   * Uses `Accept: application/vnd.github.raw` to receive binary content
   * directly — no base64 decoding required.
   *
   * @param owner    GitHub owner
   * @param repo     Repository name
   * @param blobSha  Git blob SHA (from `listFiles` tree entry)
   */
  async fetchFileByBlobSha(owner: string, repo: string, blobSha: string): Promise<Buffer> {
    return this.requestBuffer(
      `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
      'application/vnd.github.raw',
    );
  }

  // ─── Internal HTTP helpers ───────────────────────────────────────────────────

  /**
   * Make a JSON GET request to the GitHub API with retry on rate limits.
   */
  private requestJson<T>(path: string, retries = 0): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        hostname: GITHUB_API_HOST,
        path,
        method: 'GET',
        headers: { ...this.headers, 'Accept': 'application/vnd.github+json' },
      };

      const req = this.requestFn(options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          const shouldRetry = this.handleRateLimit(res, status, retries);
          if (shouldRetry !== null) {
            setTimeout(() => {
              this.requestJson<T>(path, retries + 1).then(resolve, reject);
            }, shouldRetry);
            return;
          }

          const err = this.checkError(status, body, path);
          if (err) { reject(err); return; }

          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(
              new PureContextError(
                `Failed to parse GitHub API JSON response for ${path}: ${body.slice(0, 200)}`,
              ),
            );
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Make a raw binary GET request to the GitHub API (for blob content).
   */
  private requestBuffer(path: string, accept: string, retries = 0): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const options: RequestOptions = {
        hostname: GITHUB_API_HOST,
        path,
        method: 'GET',
        headers: { ...this.headers, 'Accept': accept },
      };

      const req = this.requestFn(options, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;

          const shouldRetry = this.handleRateLimit(res, status, retries);
          if (shouldRetry !== null) {
            setTimeout(() => {
              this.requestBuffer(path, accept, retries + 1).then(resolve, reject);
            }, shouldRetry);
            return;
          }

          if (status < 200 || status >= 300) {
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 200);
            reject(this.checkError(status, body, path) ?? new GitHubApiError(status, body));
            return;
          }

          resolve(Buffer.concat(chunks));
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Check for rate limit headers. Returns wait time in ms if should retry,
   * or null if no retry needed.
   */
  private handleRateLimit(
    res: IncomingMessage,
    status: number,
    retries: number,
  ): number | null {
    if ((status !== 403 && status !== 429) || retries >= MAX_RETRIES) return null;

    const resetHeader = res.headers['x-ratelimit-reset'];
    const resetTime = resetHeader ? parseInt(String(resetHeader), 10) * 1_000 : 0;
    const now = Date.now();

    const waitMs =
      resetTime > now
        ? Math.min(resetTime - now + 1_000, 60_000)
        : BASE_BACKOFF_MS * Math.pow(2, retries) + Math.random() * 500;

    logger.warn(`GitHub API rate limited (HTTP ${status}). Retrying in ${Math.round(waitMs)}ms (attempt ${retries + 1}/${MAX_RETRIES})`);
    return waitMs;
  }

  /**
   * Map HTTP status codes to typed errors. Returns null on success (2xx).
   */
  private checkError(status: number, body: string, path: string): GitHubApiError | null {
    if (status >= 200 && status < 300) return null;

    if (status === 401) {
      return new GitHubApiError(
        401,
        `Unauthorized — provide a GitHub token for ${path}`,
      );
    }

    if (status === 404) {
      return new GitHubApiError(
        404,
        `Not found: ${path}. The repository may be private — provide a GITHUB_TOKEN.`,
      );
    }

    return new GitHubApiError(status, body.slice(0, 200));
  }
}
