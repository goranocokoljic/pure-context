import { z } from 'zod';
import { createHash } from 'crypto';
import { writeFile, unlink, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { openDatabase, getIndexDir } from '../../core/db/schema.js';
import { handler as importHandler } from './import-index.js';
import { buildMeta } from './_meta.js';
import { PureContextError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ─── Registry constants ────────────────────────────────────────────────────────

export const REGISTRY_BASE_URL = 'https://registry.purecontext.dev';
export const REGISTRY_MANIFEST_URL = `${REGISTRY_BASE_URL}/manifest.json`;

// ─── Manifest types ────────────────────────────────────────────────────────────

export interface RegistryVersionEntry {
  version: string;
  /** SHA-256 hex digest of the raw bundle bytes (for integrity verification) */
  sha256: string;
  bundleSize: number;
  symbolCount: number;
  fileCount: number;
  publishedAt: string;
  /** Absolute CDN URL for the .pcx bundle */
  url: string;
}

export interface RegistryRepoEntry {
  /** GitHub "owner/repo" slug */
  repo: string;
  latest: string;
  versions: RegistryVersionEntry[];
}

export interface RegistryManifest {
  /** Manifest format version string, e.g. "1.0" */
  version: string;
  updatedAt: string;
  repos: RegistryRepoEntry[];
}

// ─── Local registry cache (tracks what we've downloaded) ─────────────────────

interface RegistryCacheEntry {
  repoId: string;
  repo: string;
  version: string;
  symbolCount: number;
  indexedAt: number;
}

type RegistryCache = Record<string, RegistryCacheEntry>; // keyed by "owner/repo"

function getRegistryCachePath(): string {
  const dataDir = process.env['PCTX_DATA_DIR'] ?? join(homedir(), '.purecontext');
  return join(dataDir, 'registry-cache.json');
}

async function loadRegistryCache(): Promise<RegistryCache> {
  try {
    const raw = await readFile(getRegistryCachePath(), 'utf8');
    return JSON.parse(raw) as RegistryCache;
  } catch {
    return {};
  }
}

async function saveRegistryCache(cache: RegistryCache): Promise<void> {
  const path = getRegistryCachePath();
  mkdirSync(join(homedir(), '.purecontext'), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
}

// ─── Tool definition ───────────────────────────────────────────────────────────

export const name = 'fetch_public_index';

export const description =
  'Download a pre-built index bundle for a popular open-source repository from the ' +
  'PureContext public registry. After fetching, the repo is immediately searchable via ' +
  'search_symbols, get_repo_outline, and other tools — no local clone or indexing needed. ' +
  'Bundles are signed (SHA-256) and verified before import. Use list_public_indexes to ' +
  'see the available repos.';

export const inputSchema = {
  repo: z
    .string()
    .describe('GitHub repository in "owner/repo" format, e.g. "expressjs/express"'),
  version: z
    .string()
    .optional()
    .describe('Git tag or version to fetch. Defaults to "latest".'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Re-download and re-import even if the repo is already locally cached. Default: false.',
    ),
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repo: string;
  version?: string;
  force?: boolean;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repo } = args;
  const requestedVersion = args.version ?? 'latest';
  const force = args.force ?? false;

  // Validate repo format
  if (!repo.includes('/') || repo.split('/').length !== 2) {
    throw new PureContextError(
      `Invalid repo format: "${repo}". Expected "owner/repo" (e.g. "expressjs/express").`,
      'fetch_public_index',
    );
  }

  // ── Check local cache ─────────────────────────────────────────────────────

  const cache = await loadRegistryCache();
  if (!force && cache[repo]) {
    const entry = cache[repo];
    logger.info('fetch_public_index: repo already cached locally, skipping download', {
      repo,
      repoId: entry.repoId,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId: entry.repoId,
              repo,
              version: entry.version,
              symbolCount: entry.symbolCount,
              cachedAt: new Date(entry.indexedAt).toISOString(),
              source: 'cache',
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // ── Fetch manifest ────────────────────────────────────────────────────────

  logger.info('fetch_public_index: fetching registry manifest', { repo, requestedVersion });

  let manifest: RegistryManifest;
  try {
    const response = await fetchWithTimeout(REGISTRY_MANIFEST_URL, 10_000);
    if (!response.ok) {
      throw new PureContextError(
        `Registry manifest fetch failed: HTTP ${response.status}. ` +
        `Check your network connection or visit ${REGISTRY_MANIFEST_URL} to verify the registry is available.`,
        'fetch_public_index',
      );
    }
    manifest = (await response.json()) as RegistryManifest;
  } catch (err) {
    if (err instanceof PureContextError) throw err;
    throw new PureContextError(
      `Failed to reach the PureContext registry at ${REGISTRY_MANIFEST_URL}. ` +
      `Check your network connection.\nError: ${String(err)}`,
      'fetch_public_index',
    );
  }

  // ── Resolve repo entry ────────────────────────────────────────────────────

  const repoEntry = manifest.repos.find((r) => r.repo === repo);
  if (!repoEntry) {
    const available = manifest.repos.map((r) => r.repo).join('\n  ');
    throw new PureContextError(
      `Repo "${repo}" is not in the public registry.\n\n` +
      `Available repos:\n  ${available || '(none yet)'}\n\n` +
      `To index a local clone instead, use: index_folder\n` +
      `To see all available repos, use: list_public_indexes`,
      'fetch_public_index',
    );
  }

  const resolvedVersion =
    requestedVersion === 'latest' ? repoEntry.latest : requestedVersion;

  const versionEntry = repoEntry.versions.find((v) => v.version === resolvedVersion);
  if (!versionEntry) {
    const available = repoEntry.versions.map((v) => v.version).join(', ');
    throw new PureContextError(
      `Version "${resolvedVersion}" not found for ${repo}.\n` +
      `Available versions: ${available || '(none)'}`,
      'fetch_public_index',
    );
  }

  // ── Download bundle ───────────────────────────────────────────────────────

  logger.info('fetch_public_index: downloading bundle', {
    url: versionEntry.url,
    bundleSize: versionEntry.bundleSize,
  });

  let bundleBytes: Buffer;
  try {
    const response = await fetchWithTimeout(versionEntry.url, 120_000);
    if (!response.ok) {
      throw new PureContextError(
        `Bundle download failed: HTTP ${response.status} for ${versionEntry.url}`,
        'fetch_public_index',
      );
    }
    bundleBytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof PureContextError) throw err;
    throw new PureContextError(
      `Failed to download bundle from ${versionEntry.url}.\nError: ${String(err)}`,
      'fetch_public_index',
    );
  }

  // ── Verify SHA-256 signature ──────────────────────────────────────────────

  const actualHash = createHash('sha256').update(bundleBytes).digest('hex');
  if (actualHash !== versionEntry.sha256) {
    throw new PureContextError(
      `Bundle integrity check failed for ${repo}@${resolvedVersion}.\n` +
      `Expected SHA-256: ${versionEntry.sha256}\n` +
      `Actual   SHA-256: ${actualHash}\n\n` +
      `The downloaded bundle may be corrupt or tampered with. Please try again or ` +
      `report this at https://github.com/gococ/purecontext-mcp/issues`,
      'fetch_public_index',
    );
  }

  logger.info('fetch_public_index: SHA-256 verified', { sha256: actualHash });

  // ── Write to temp file and import ─────────────────────────────────────────

  const tmpPath = join(tmpdir(), `purecontext-registry-${Date.now()}.pcx`);
  try {
    await writeFile(tmpPath, bundleBytes);

    const importResult = await importHandler({
      bundlePath: tmpPath,
      merge: true,
    });

    // Extract repoId and symbolCount from the import result
    const importText = importResult.content[0];
    let repoId = '';
    let symbolCount = versionEntry.symbolCount;
    if (importText.type === 'text') {
      try {
        const parsed = JSON.parse(importText.text) as {
          repoId?: string;
          symbolCount?: number;
        };
        repoId = parsed.repoId ?? '';
        symbolCount = parsed.symbolCount ?? symbolCount;
      } catch {
        // ignore — use defaults
      }
    }

    // ── Tag repo as registry-sourced in the DB ─────────────────────────────

    if (repoId) {
      try {
        const db = openDatabase(repoId);
        try {
          db.prepare("UPDATE repos SET source = 'registry' WHERE id = ?").run(repoId);
        } finally {
          db.close();
        }
      } catch (err) {
        // Non-fatal: source column may not exist yet; migration adds it on next open
        logger.debug('fetch_public_index: could not set source=registry', { repoId, err: String(err) });
      }
    }

    // ── Persist to local registry cache ───────────────────────────────────

    const now = Date.now();
    cache[repo] = {
      repoId,
      repo,
      version: resolvedVersion,
      symbolCount,
      indexedAt: now,
    };
    await saveRegistryCache(cache);

    logger.info('fetch_public_index: bundle imported from registry', {
      repo,
      version: resolvedVersion,
      repoId,
      symbolCount,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              repoId,
              repo,
              version: resolvedVersion,
              symbolCount,
              cachedAt: new Date(now).toISOString(),
              source: 'registry',
              _meta: buildMeta({ timingMs: Date.now() - t0 }),
            },
            null,
            2,
          ),
        },
      ],
    };
  } finally {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ─── Manifest fetch (shared with CLI list-public) ─────────────────────────────

export async function fetchManifest(): Promise<RegistryManifest> {
  const response = await fetchWithTimeout(REGISTRY_MANIFEST_URL, 10_000);
  if (!response.ok) {
    throw new PureContextError(
      `Registry manifest fetch failed: HTTP ${response.status}.`,
      'fetch_public_index',
    );
  }
  return (await response.json()) as RegistryManifest;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}
