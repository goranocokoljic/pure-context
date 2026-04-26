import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { logger } from './logger.js';
import { getConfig } from '../config/config-loader.js';
import { VERSION } from '../version.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TelemetryEvent {
  event: string;
  [key: string]: unknown;
}

// ─── Session ID ───────────────────────────────────────────────────────────────

/**
 * Random UUID generated once per process start.
 * Not persisted — no cross-session tracking.
 */
const SESSION_ID = randomUUID();

// ─── PII blocklist ────────────────────────────────────────────────────────────

/**
 * Keys that must never appear in a telemetry payload.
 * If accidentally passed, they are silently dropped.
 */
const PII_KEYS = new Set([
  'filePath', 'path', 'rootPath', 'repoPath', 'clonePath',
  'name', 'symbolName', 'repoName', 'source', 'content',
  'signature', 'summary', 'importedNames', 'specifier',
]);

function sanitize(event: TelemetryEvent): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (PII_KEYS.has(k)) continue;
    // Drop string values that look like file-system paths
    if (typeof v === 'string' && (v.includes('/') || v.includes('\\'))) continue;
    safe[k] = v;
  }
  return safe;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true when telemetry is enabled in config.
 * Synchronous — config is loaded at startup.
 */
export function isTelemetryEnabled(): boolean {
  try {
    return getConfig().telemetry.enabled;
  } catch {
    return false;
  }
}

/**
 * Track an anonymous telemetry event.
 *
 * When disabled: logs at debug level what would have been sent, returns immediately.
 * When enabled:  appends to ~/.purecontext/telemetry.jsonl, then POSTs to the
 *                configured endpoint. Network errors are silently discarded.
 * Never throws.
 */
export async function track(event: TelemetryEvent): Promise<void> {
  const payload = sanitize({
    ...event,
    version: VERSION,
    nodeVersion: process.version.replace(/^v/, ''),
    platform: platform(),
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });

  if (!isTelemetryEnabled()) {
    logger.debug(`Telemetry (disabled) — would have sent: ${JSON.stringify(payload)}`);
    return;
  }

  // Always write to local JSONL log so the user can inspect what was sent
  try {
    const logDir = join(homedir(), '.purecontext');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'telemetry.jsonl'), JSON.stringify(payload) + '\n', 'utf8');
  } catch {
    // Non-fatal — proceed to network send regardless
  }

  // Send to configured endpoint (best-effort)
  let endpoint: string;
  try {
    endpoint = getConfig().telemetry.endpoint ?? DEFAULT_TELEMETRY_ENDPOINT;
  } catch {
    endpoint = DEFAULT_TELEMETRY_ENDPOINT;
  }

  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silently discard network errors — telemetry must never affect the user
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.purecontext.dev/v1/event';
