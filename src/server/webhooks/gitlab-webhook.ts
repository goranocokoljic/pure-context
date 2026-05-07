import { timingSafeEqual } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GitLabPushPayload {
  ref: string;
  project: {
    path_with_namespace: string;
    http_url_to_repo: string;
  };
  checkout_sha: string | null;
  commits: Array<{
    added: string[];
    modified: string[];
    removed: string[];
  }>;
}

// ─── Token verification ───────────────────────────────────────────────────────

/**
 * Verify GitLab webhook token (X-Gitlab-Token header).
 * GitLab uses a plain token, not an HMAC signature.
 * Returns true if tokens match, or if no secret is configured.
 */
export function verifyGitLabToken(
  providedToken: string | undefined,
  secret: string,
): boolean {
  if (!secret) return true;
  if (!providedToken) return false;
  if (providedToken.length !== secret.length) return false;

  try {
    return timingSafeEqual(Buffer.from(providedToken), Buffer.from(secret));
  } catch {
    return false;
  }
}

// ─── Payload parsing ──────────────────────────────────────────────────────────

/**
 * Parse a GitLab push payload from a raw JSON buffer.
 * Returns null if the payload is missing required fields.
 */
export function parseGitLabPayload(body: Buffer): GitLabPushPayload | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof parsed['ref'] !== 'string') return null;

  const project = parsed['project'];
  if (
    typeof project !== 'object' ||
    project === null ||
    typeof (project as Record<string, unknown>)['path_with_namespace'] !== 'string' ||
    typeof (project as Record<string, unknown>)['http_url_to_repo'] !== 'string'
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

  return {
    ref: parsed['ref'] as string,
    project: {
      path_with_namespace: (project as Record<string, unknown>)['path_with_namespace'] as string,
      http_url_to_repo:    (project as Record<string, unknown>)['http_url_to_repo']    as string,
    },
    checkout_sha:
      typeof parsed['checkout_sha'] === 'string' ? parsed['checkout_sha'] : null,
    commits,
  };
}

// ─── File extraction ──────────────────────────────────────────────────────────

/**
 * Aggregate changed and deleted file paths from all commits in the payload.
 */
export function extractChangedFilesGitLab(payload: GitLabPushPayload): {
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

  for (const f of deleted) changed.delete(f);

  return {
    changedPaths: [...changed],
    deletedPaths: [...deleted],
  };
}
