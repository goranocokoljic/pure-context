/**
 * index_repo tool — clone a Git repository and index it.
 *
 * Clones the repo to ~/.purecontext/clones/<repoId>/ using `git clone --depth=1`,
 * then runs the standard indexing pipeline on the clone directory.
 *
 * The clone directory is persistent — call delete_index to remove both the
 * SQLite database and the clone directory.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { indexFolder } from '../../core/index-manager.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'index_repo';

export const description =
  'Clone a Git repository and index it. Supports public and private repos (pass a token for private). ' +
  'Returns the repo ID and indexing statistics. The clone is persistent — call delete_index to remove it.';

export const inputSchema = {
  url: z.string().describe('Git repository URL (https:// or git@)'),
  branch: z.string().optional().describe('Branch or tag to clone (default: repository default branch)'),
  token: z.string().optional().describe('GitHub/GitLab personal access token for private repos'),
  fileLimit: z.number().int().positive().optional().describe('Maximum number of files to index (default 5000)'),
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

// ─── Git clone ────────────────────────────────────────────────────────────────

const CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function runGitClone(
  cloneUrl: string,
  targetDir: string,
  branch?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth=1'];
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

// ─── Tool handler ─────────────────────────────────────────────────────────────

export async function handler(args: {
  url: string;
  branch?: string;
  token?: string;
  fileLimit?: number;
}): Promise<CallToolResult> {
  const { url, branch, token, fileLimit = 5000 } = args;

  // Validate URL scheme
  const urlError = validateUrl(url);
  if (urlError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: urlError }) }],
      isError: true,
    };
  }

  // Build clone URL (inject token for private repos)
  const cloneUrl = token ? injectToken(url, token) : url;
  const cloneDir = getCloneDir(url); // keyed on original URL, not credentialed one

  // Create clones dir
  mkdirSync(getClonesDir(), { recursive: true });

  // Clone (or re-use existing clone)
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

  // Index the cloned directory
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
