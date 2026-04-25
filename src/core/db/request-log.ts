/**
 * RequestLogStore — persists per-request telemetry in the central auth database.
 *
 * Used by the Admin API to compute usage stats and detect abuse patterns.
 * Logs are pruned periodically to prevent unbounded growth.
 */

import type Database from 'better-sqlite3';

// ─── DDL ──────────────────────────────────────────────────────────────────────

export const REQUEST_LOG_DDL = `
CREATE TABLE IF NOT EXISTS request_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,
  tenant_id     TEXT,
  tool          TEXT    NOT NULL,
  duration_ms   INTEGER,
  status        TEXT    NOT NULL,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_log_tenant
  ON request_log(tenant_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_request_log_timestamp
  ON request_log(timestamp);
`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RequestLogEntry {
  timestamp: string;
  tenantId: string | null;
  tool: string;
  durationMs: number | null;
  status: 'success' | 'error' | 'rate_limited';
  errorMessage: string | null;
}

export interface LogStats {
  requests: number;
  rateLimited: number;
}

// ─── RequestLogStore ──────────────────────────────────────────────────────────

export class RequestLogStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert a log entry. Best-effort — never throws. */
  log(entry: RequestLogEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO request_log (timestamp, tenant_id, tool, duration_ms, status, error_message)
           VALUES (@timestamp, @tenantId, @tool, @durationMs, @status, @errorMessage)`,
        )
        .run({
          timestamp: entry.timestamp,
          tenantId: entry.tenantId ?? null,
          tool: entry.tool,
          durationMs: entry.durationMs ?? null,
          status: entry.status,
          errorMessage: entry.errorMessage ?? null,
        });
    } catch {
      // Never let logging errors affect the caller
    }
  }

  /**
   * Aggregate stats for all tenants since `since` (ISO timestamp).
   */
  getStats(since: string): LogStats {
    const row = this.db
      .prepare<[string], { requests: number; rate_limited: number }>(
        `SELECT
           COUNT(*)                                         AS requests,
           SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited
         FROM request_log
         WHERE timestamp >= ?`,
      )
      .get(since);
    return {
      requests: row?.requests ?? 0,
      rateLimited: row?.rate_limited ?? 0,
    };
  }

  /**
   * Aggregate stats for a single tenant since `since` (ISO timestamp).
   */
  getTenantStats(tenantId: string, since: string): LogStats {
    const row = this.db
      .prepare<[string, string], { requests: number; rate_limited: number }>(
        `SELECT
           COUNT(*)                                         AS requests,
           SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited
         FROM request_log
         WHERE tenant_id = ? AND timestamp >= ?`,
      )
      .get(tenantId, since);
    return {
      requests: row?.requests ?? 0,
      rateLimited: row?.rate_limited ?? 0,
    };
  }

  /**
   * Delete log entries older than `daysToKeep` days.
   * Returns the number of rows deleted.
   */
  pruneOld(daysToKeep: number): number {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare('DELETE FROM request_log WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }
}
