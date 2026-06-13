import { createRequire } from 'module';
import type BetterSqlite3 from 'better-sqlite3';
import { NativeDependencyError } from '../errors.js';
import { logger } from '../logger.js';

/**
 * SQLite backend loader.
 *
 * PureContext stores its index in SQLite. The default engine is the native
 * `better-sqlite3` addon, which is fast but ABI-bound: a prebuilt binary only
 * loads under the Node version (NODE_MODULE_VERSION) it was built for. We ship
 * prebuilds for Node 18/20/22, so on any other Node — or if the prebuild fails
 * to load for any reason — we fall back to a pure-WASM SQLite build that is
 * ABI-independent and runs on any Node >= 18.
 *
 * Tiers (best first):
 *   1. better-sqlite3   — native, fastest, when a matching prebuild loads
 *   2. @sqlite.org/sqlite-wasm — WASM fallback, FTS5-capable, any Node/ABI
 *
 * The WASM engine needs async initialisation, so call `initSqliteBackend()`
 * once during startup (bootstrap). After that, `getSqliteFactory()` is sync and
 * usable from any code path. The returned databases are structurally
 * compatible with the subset of the better-sqlite3 API the codebase uses, so
 * call sites keep their `Database.Database` types unchanged.
 */

// The contract every backend's database object must satisfy is "the subset of
// better-sqlite3's Database that the codebase uses" — so we type it as that.
export type SqliteDatabase = BetterSqlite3.Database;

export type SqliteBackendKind = 'better-sqlite3' | 'wasm';

export interface SqliteOpenOptions {
  /** Open the database read-only (no writes / no persistence flush). */
  readonly?: boolean;
}

export interface SqliteFactory {
  /** Open (or create) a database at `filename`, or an in-memory DB for ':memory:'. */
  open(filename: string, options?: SqliteOpenOptions): SqliteDatabase;
  /** Which engine backs this factory — for diagnostics/telemetry. */
  readonly backend: SqliteBackendKind;
}

const _require = createRequire(import.meta.url);

let _factory: SqliteFactory | null = null;
let _lastLoadError: unknown = null;

// ─── Tier 1: native better-sqlite3 ──────────────────────────────────────────

function tryLoadNative(): SqliteFactory | null {
  try {
    const Database = _require('better-sqlite3') as typeof BetterSqlite3;
    // require() only loads better-sqlite3's JS wrapper; the native .node addon
    // is loaded lazily on the first `new Database()`, which is where an ABI
    // mismatch (wrong NODE_MODULE_VERSION) actually throws. Force that load now
    // with a throwaway in-memory DB so a mismatch surfaces here and we fall
    // back to WASM — rather than committing to native and crashing at open().
    new Database(':memory:').close();
    return {
      backend: 'better-sqlite3',
      open(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
        // better-sqlite3 rejects readonly for ':memory:' — only pass it for files.
        if (options?.readonly && filename !== ':memory:') {
          return new Database(filename, { readonly: true });
        }
        return new Database(filename);
      },
    };
  } catch (err) {
    _lastLoadError = err;
    return null;
  }
}

/** Returns true when the WASM backend is explicitly requested via env. */
function wasmForced(): boolean {
  const v = process.env['PCTX_SQLITE_BACKEND'];
  return v === 'wasm' || process.env['PCTX_FORCE_WASM'] === '1';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialise the SQLite backend, selecting the best available engine. Call once
 * during startup. Safe to call multiple times (memoised). Async because the
 * WASM fallback requires async module init.
 */
export async function initSqliteBackend(): Promise<SqliteFactory> {
  if (_factory) return _factory;

  // Tier 1 — native (fast path), unless WASM is explicitly forced.
  if (!wasmForced()) {
    const native = tryLoadNative();
    if (native) {
      _factory = native;
      logger.debug('SQLite backend: better-sqlite3 (native)');
      return _factory;
    }
    logger.warn(
      'better-sqlite3 native addon unavailable for this Node version; ' +
        'falling back to WASM SQLite (slower, but ABI-independent)',
    );
  }

  // Tier 2 — WASM fallback. ABI-independent; runs on any Node >= 18.
  const { createWasmFactory } = await import('./wasm-sqlite.js');
  _factory = await createWasmFactory();
  logger.info('SQLite backend: WASM (@sqlite.org/sqlite-wasm)');
  return _factory;
}

/**
 * Get the selected SQLite factory. If `initSqliteBackend()` has not run yet,
 * this performs a synchronous native-only init (back-compat for code paths that
 * open a database before bootstrap). The WASM fallback is only reachable via
 * the async `initSqliteBackend()`.
 */
export function getSqliteFactory(): SqliteFactory {
  if (_factory) return _factory;

  // Sync path: native only. The WASM backend needs async init, so if it is
  // forced or native is unavailable, the caller must have run
  // `initSqliteBackend()` first.
  if (!wasmForced()) {
    const native = tryLoadNative();
    if (native) {
      _factory = native;
      return _factory;
    }
  }

  throw new NativeDependencyError(_lastLoadError);
}

/** Test-only: inject a specific factory (e.g. force WASM) without env/global state. */
export function _setSqliteFactoryForTests(factory: SqliteFactory): void {
  _factory = factory;
}

/** Test-only: reset memoised state so a different backend can be selected. */
export function _resetSqliteBackendForTests(): void {
  _factory = null;
  _lastLoadError = null;
}
