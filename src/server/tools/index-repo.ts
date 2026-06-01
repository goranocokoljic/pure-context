/**
 * index_repo tool — clone a Git repository and index it, or index via the
 * GitHub API without cloning (auto-detected for github.com URLs).
 *
 * Git-clone path: clones to ~/.purecontext/clones/<repoId>/ using
 * `git clone --depth=<GIT_HISTORY_DEPTH>` (default 50) so that git log
 * has enough history for git metadata capture, then runs the standard
 * indexing pipeline.
 *
 * GitHub API path: downloads only the files (no git history) to
 * ~/.purecontext/github-cache/<urlHash>/ using the GitHub REST API tree
 * endpoint. Incremental: on re-index only files with a changed blob SHA
 * are re-fetched from the API. Requires no git installation.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { indexFolder } from '../../core/index-manager.js';
import { computeRepoId, openDatabase, setGitTreeSha } from '../../core/db/schema.js';
import { getAllRemoteShas, updateRemoteSha } from '../../core/db/file-store.js';
import { deleteByFile } from '../../core/db/symbol-store.js';
import { deleteEdgesByFile } from '../../core/db/dep-store.js';
import { deleteFile } from '../../core/db/file-store.js';
import { getSupportedExtensions } from '../../handlers/handler-registry.js';
import { getAdapterExtensions, getRegisteredAdapters } from '../../adapters/adapter-registry.js';
import {
  GitHubApiFetcher,
  parseGitHubUrl,
  isGitHubUrl,
  type GitHubTreeEntry,
} from '../../core/github-api-fetcher.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'index_repo';

export const description =
  'Clone a Git repository and index it, or index a GitHub repo via the API (no git clone required). ' +
  'For github.com URLs, GitHub API mode is auto-detected — set useGitHubApi: false to force git clone. ' +
  'Incremental: unchanged files are skipped on re-index. ' +
  'Returns the repo ID and indexing statistics.';

export const inputSchema = {
  url: z.string().describe('Git repository URL (https://, http://, or git@) or GitHub URL'),
  branch: z.string().optional().describe('Branch or tag to clone/index (default: repository default branch)'),
  token: z.string().optional().describe('GitHub/GitLab personal access token for private repos (git clone path)'),
  fileLimit: z.number().int().positive().optional().describe('Maximum number of files to index (default 5000)'),
  useGitHubApi: z
    .boolean()
    .optional()
    .describe(
      'Force GitHub API mode (auto-detected for github.com URLs). ' +
        'Set to false to use git clone even for GitHub URLs.',
    ),
  githubToken: z
    .string()
    .optional()
    .describe('GitHub personal access token for API mode. Falls back to GITHUB_TOKEN env var.'),
};

// ─── URL validation ───────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = /^(https?:\/\/|git@)/;

function validateUrl(url: string): string | null {
  if (!ALLOWED_SCHEMES.test(url)) {
    return `Invalid URL scheme. Only https://, http://, and git@ URLs are supported. Got: ${url}`;
  }
  return null;
}

/**
 * Inject a token into an https:// URL as credentials.
 * Never logs the token.
 */
function injectToken(url: string, token: string): string {
  if (!token) return url;
  if (!url.startsWith('https://') && !url.startsWith('http://')) return url;
  const u = new URL(url);
  u.username = token;
  u.password = 'x-oauth-basic';
  return u.toString();
}

// ─── Clone directory helpers ──────────────────────────────────────────────────

function getClonesDir(): string {
  return join(homedir(), '.purecontext', 'clones');
}

/**
 * Deterministic clone directory: ~/.purecontext/clones/<sha256(url)[:16]>/
 */
function getCloneDir(url: string): string {
  const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(getClonesDir(), id);
}

/** Cache directory for GitHub API fetched files. */
function getGitHubCacheDir(): string {
  return join(homedir(), '.purecontext', 'github-cache');
}

/** Deterministic GitHub cache dir: ~/.purecontext/github-cache/<sha256(url)[:16]>/ */
function getGitHubCacheDirForUrl(url: string): string {
  const id = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return join(getGitHubCacheDir(), id);
}

// ─── Git clone ────────────────────────────────────────────────────────────────

const CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Shallow-clone depth. Larger values give richer git history for git_metadata. */
function getCloneDepth(): number {
  const env = process.env['GIT_HISTORY_DEPTH'];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return 50;
}

function runGitClone(
  cloneUrl: string,
  targetDir: string,
  branch?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [`clone`, `--depth=${getCloneDepth()}`];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push(cloneUrl, targetDir);

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error('git is not available on PATH. Install git and try again.'));
      return;
    }

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('git clone timed out after 5 minutes'));
    }, CLONE_TIMEOUT_MS);

    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.debug(`git clone: ${chunk.toString('utf8').trim()}`);
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if ((err as { code?: string }).code === 'ENOENT') {
        reject(new Error('git is not available on PATH. Install git and try again.'));
      } else {
        reject(new Error(`git clone failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git clone exited with code ${code}`));
      }
    });
  });
}

// ─── GitHub API indexing ──────────────────────────────────────────────────────

/**
 * Index a GitHub repository via the GitHub REST API.
 * Downloads only files (no git history) to a local cache directory,
 * skipping files whose blob SHA has not changed since the last run.
 */
async function indexViaGitHubApi(args: {
  url: string;
  owner: string;
  repo: string;
  branch?: string;
  githubToken?: string;
  fileLimit: number;
}): Promise<CallToolResult> {
  const { url, owner, repo, branch: requestedBranch, githubToken, fileLimit } = args;

  const token = githubToken ?? process.env['GITHUB_TOKEN'];
  const fetcher = new GitHubApiFetcher(token);

  // Resolve the branch to index
  let branch: string;
  try {
    branch = requestedBranch ?? await fetcher.getDefaultBranch(owner, repo);
    logger.info(`GitHub API: indexing ${owner}/${repo} @ ${branch}`);
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }

  // Get the current tree SHA (a single value that changes whenever any file changes)
  let commitSha: string;
  try {
    commitSha = await fetcher.getCommitSha(owner, repo, branch);
    logger.debug(`GitHub API: commit SHA ${commitSha}`);
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }

  // Fetch the full recursive file tree (single API call)
  let treeEntries: GitHubTreeEntry[];
  try {
    treeEntries = await fetcher.listFiles(owner, repo, branch);
    logger.info(`GitHub API: tree has ${treeEntries.length} indexable files`);
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }

  // Filter tree to extensions supported by PureContext. Include adapter-only
  // extensions (e.g. .vue/.svelte/.astro) so SFC blobs aren't dropped before the
  // remote repo is fetched — indexFolder re-runs real adapter detection at index time.
  const supportedExts = new Set([
    ...getSupportedExtensions(),
    ...getAdapterExtensions(getRegisteredAdapters()),
  ]);
  const indexableEntries = treeEntries.filter((e) => {
    const dot = e.path.lastIndexOf('.');
    if (dot === -1) return false;
    return supportedExts.has(e.path.slice(dot));
  });

  logger.info(`GitHub API: ${indexableEntries.length} files with supported extensions`);

  // Set up local cache directory
  const cacheDir = getGitHubCacheDirForUrl(url);
  mkdirSync(cacheDir, { recursive: true });
  const repoId = computeRepoId(cacheDir);

  // Load stored blob SHAs from a previous run (for incremental indexing)
  const db = openDatabase(repoId);
  const storedShas = getAllRemoteShas(db, repoId);

  // Identify files that have been deleted from GitHub (in our DB but not in tree)
  const indexablePaths = new Set(indexableEntries.map((e) => e.path));
  const deletedPaths = [...storedShas.keys()].filter((p) => !indexablePaths.has(p));

  // Remove deleted files from cache dir and DB
  if (deletedPaths.length > 0) {
    logger.info(`GitHub API: removing ${deletedPaths.length} deleted file(s)`);
    for (const relPath of deletedPaths) {
      const fsPath = join(cacheDir, ...relPath.split('/'));
      if (existsSync(fsPath)) {
        try { unlinkSync(fsPath); } catch { /* best-effort */ }
      }
      deleteByFile(db, repoId, relPath);
      deleteEdgesByFile(db, repoId, relPath);
      deleteFile(db, repoId, relPath);
    }
  }

  // Identify changed/new files (blob SHA differs from stored SHA)
  const toFetch = indexableEntries.filter((e) => storedShas.get(e.path) !== e.sha);
  logger.info(`GitHub API: ${toFetch.length} file(s) to fetch (${indexableEntries.length - toFetch.length} unchanged)`);

  db.close();

  // Apply file limit: honour fileLimit across all indexable files
  const limitedEntries =
    fileLimit > 0 ? indexableEntries.slice(0, fileLimit) : indexableEntries;
  const limitedToFetch = toFetch.filter((e) =>
    limitedEntries.some((le) => le.path === e.path),
  );

  // Fetch changed/new files from GitHub API and write to local cache
  const fetchErrors: Array<{ file: string; message: string }> = [];
  let fetched = 0;

  for (const entry of limitedToFetch) {
    try {
      const content = await fetcher.fetchFileByBlobSha(owner, repo, entry.sha);
      const fsPath = join(cacheDir, ...entry.path.split('/'));
      mkdirSync(dirname(fsPath), { recursive: true });
      writeFileSync(fsPath, content);
      fetched++;
      logger.debug(`GitHub API: fetched ${entry.path} (${content.length} bytes)`);
    } catch (err) {
      fetchErrors.push({ file: entry.path, message: String(err) });
      logger.warn(`GitHub API: failed to fetch ${entry.path}: ${err}`);
    }
  }

  logger.info(`GitHub API: fetched ${fetched} files, ${fetchErrors.length} errors`);

  // Run the standard indexing pipeline on the local cache directory
  let result;
  try {
    result = await indexFolder(cacheDir, {
      fileLimit,
      clonePath: cacheDir,
    });
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }

  // Post-indexing: update remote_sha for all fetched files and store commit SHA
  try {
    const db2 = openDatabase(repoId);

    // Update remote_sha for files we just fetched
    const fetchedPaths = new Set(limitedToFetch.map((e) => e.path));
    for (const entry of limitedEntries) {
      if (fetchedPaths.has(entry.path)) {
        updateRemoteSha(db2, repoId, entry.path, entry.sha);
      }
    }

    // Store the commit SHA so we can detect tree changes on next call
    setGitTreeSha(db2, repoId, commitSha);
    db2.close();
  } catch (err) {
    // Non-fatal: remote SHA tracking is an optimisation, not correctness-critical
    logger.warn(`GitHub API: failed to update remote SHAs: ${err}`);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            repoId: result.repoId,
            mode: 'github-api',
            owner,
            repo,
            branch,
            commitSha,
            cacheDir,
            filesFetched: fetched,
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            symbolsFound: result.symbolsFound,
            edgesFound: result.edgesFound,
            durationMs: result.durationMs,
            errors: [...fetchErrors, ...result.errors],
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handler(args: {
  url: string;
  branch?: string;
  token?: string;
  fileLimit?: number;
  useGitHubApi?: boolean;
  githubToken?: string;
}): Promise<CallToolResult> {
  const { url, branch, token, fileLimit = 5000, useGitHubApi, githubToken } = args;

  // Validate URL scheme
  const urlError = validateUrl(url);
  if (urlError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: urlError }) }],
      isError: true,
    };
  }

  // Determine whether to use GitHub API mode
  const parsed = parseGitHubUrl(url);
  const useApi = useGitHubApi !== false && parsed !== null && (useGitHubApi === true || isGitHubUrl(url));

  if (useApi && parsed) {
    return indexViaGitHubApi({
      url,
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      githubToken,
      fileLimit,
    });
  }

  // ── Git clone path ────────────────────────────────────────────────────────

  const cloneUrl = token ? injectToken(url, token) : url;
  const cloneDir = getCloneDir(url); // keyed on original URL, not credentialed one

  mkdirSync(getClonesDir(), { recursive: true });

  if (!existsSync(cloneDir)) {
    logger.info(`Cloning ${url} → ${cloneDir}`);
    try {
      await runGitClone(cloneUrl, cloneDir, branch);
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
        isError: true,
      };
    }
  } else {
    logger.info(`Re-using existing clone at ${cloneDir}`);
  }

  try {
    const result = await indexFolder(cloneDir, { fileLimit, clonePath: cloneDir });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            repoId: result.repoId,
            cloneDir,
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            symbolsFound: result.symbolsFound,
            edgesFound: result.edgesFound,
            durationMs: result.durationMs,
            errors: result.errors,
          }, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: String(err) }) }],
      isError: true,
    };
  }
}
