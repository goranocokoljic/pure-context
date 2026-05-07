import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitHubPushPayload {
  ref: string;
  repository: {
    full_name: string;
    clone_url: string;
  };
  head_commit: { id: string } | null;
  commits: Array<{
    added: string[];
    modified: string[];
    removed: string[];
  }>;
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verify GitHub webhook HMAC-SHA256 signature (X-Hub-Signature-256 header).
 * Returns true if the signature is valid, or if no secret is configured.
 */
export function verifyGitHubSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!secret) return true;
  if (!signature) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  if (signature.length !== expected.length) return false;

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Payload parsing ──────────────────────────────────────────────────────────

/**
 * Parse a GitHub push payload from a raw JSON buffer.
 * Returns null if the payload is missing required fields.
 */
export function parseGitHubPayload(body: Buffer): GitHubPushPayload | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof parsed['ref'] !== 'string') return null;

  const repo = parsed['repository'];
  if (
    typeof repo !== 'object' ||
    repo === null ||
    typeof (repo as Record<string, unknown>)['full_name'] !== 'string' ||
    typeof (repo as Record<string, unknown>)['clone_url'] !== 'string'
  ) {
    return null;
  }

  const rawCommits = Array.isArray(parsed['commits'])
    ? (parsed['commits'] as Array<Record<string, unknown>>)
    : [];

  const commits = rawCommits.map((c) => ({
    added:    Array.isArray(c['added'])    ? (c['added']    as string[]) : [],
    modified: Array.isArray(c['modified']) ? (c['modified'] as string[]) : [],
    removed:  Array.isArray(c['removed'])  ? (c['removed']  as string[]) : [],
  }));

  const headCommit = parsed['head_commit'];

  return {
    ref: parsed['ref'] as string,
    repository: {
      full_name: (repo as Record<string, unknown>)['full_name'] as string,
      clone_url: (repo as Record<string, unknown>)['clone_url'] as string,
    },
    head_commit:
      typeof headCommit === 'object' && headCommit !== null
        ? { id: (headCommit as Record<string, unknown>)['id'] as string }
        : null,
    commits,
  };
}

// ─── File extraction ──────────────────────────────────────────────────────────

/**
 * Aggregate changed and deleted file paths from all commits in the payload.
 */
export function extractChangedFiles(payload: GitHubPushPayload): {
  changedPaths: string[];
  deletedPaths: string[];
} {
  const changed = new Set<string>();
  const deleted = new Set<string>();

  for (const commit of payload.commits) {
    for (const f of commit.added)    changed.add(f);
    for (const f of commit.modified) changed.add(f);
    for (const f of commit.removed)  deleted.add(f);
  }

  // A file deleted after being added in the same push is only deleted
  for (const f of deleted) changed.delete(f);

  return {
    changedPaths: [...changed],
    deletedPaths: [...deleted],
  };
}
