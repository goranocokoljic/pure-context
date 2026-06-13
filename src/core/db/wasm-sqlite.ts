import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Buffer } from 'node:buffer';
import type { SqliteDatabase, SqliteFactory, SqliteOpenOptions } from './sqlite-loader.js';
import { logger } from '../logger.js';

/**
 * WASM SQLite backend — the ABI-independent fallback.
 *
 * Wraps `@sqlite.org/sqlite-wasm` (FTS5-enabled) in an object that is
 * structurally compatible with the subset of the better-sqlite3 API the
 * codebase uses: `prepare(sql) -> { get, all, run }`, `exec`, `transaction`,
 * `close`. This lets the rest of the codebase stay engine-agnostic.
 *
 * The wasm build has no native file VFS in Node, so persistence is manual:
 * on open we deserialize the file's bytes into an in-memory database; on write
 * we mark the DB dirty and flush (export bytes -> atomic file write) on close
 * and via a short debounce. Heavier than native file I/O, but this is the
 * fallback tier for uncommon Node versions, where correctness matters more
 * than peak throughput.
 */

// ─── Minimal structural types for the sqlite-wasm surface we touch ────────────

interface WasmStmt {
  pointer: number;
  bind(index: number, value: unknown): WasmStmt;
  step(): boolean;
  get(index: number): unknown;
  getColumnNames(): string[];
  reset(clearBindings?: boolean): WasmStmt;
  finalize(): void;
}

interface WasmOo1Db {
  pointer: number;
  exec(sql: string): unknown;
  prepare(sql: string): WasmStmt;
  changes(): number;
  close(): void;
}

interface Sqlite3 {
  oo1: { DB: new (filename: string) => WasmOo1Db };
  capi: {
    sqlite3_bind_parameter_count(pStmt: number): number;
    sqlite3_bind_parameter_name(pStmt: number, i: number): string | null;
    sqlite3_last_insert_rowid(pDb: number): number | bigint;
    sqlite3_js_db_export(pDb: number): Uint8Array;
    sqlite3_deserialize(
      pDb: number,
      schema: string,
      pData: number,
      szDb: number,
      szBuf: number,
      flags: number,
    ): number;
    SQLITE_DESERIALIZE_FREEONCLOSE?: number;
    SQLITE_DESERIALIZE_RESIZEABLE?: number;
  };
  wasm: { allocFromTypedArray(arr: Uint8Array): number; dealloc(ptr: number): void };
}

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

let _sqlite3: Sqlite3 | null = null;

/** Initialise the wasm module once and return a factory backed by it. */
export async function createWasmFactory(): Promise<SqliteFactory> {
  if (!_sqlite3) {
    const mod = (await import('@sqlite.org/sqlite-wasm')) as unknown as {
      default: (opts?: unknown) => Promise<Sqlite3>;
    };
    _sqlite3 = await mod.default();
  }
  const sqlite3 = _sqlite3;
  return {
    backend: 'wasm',
    open(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
      return new WasmDatabase(sqlite3, filename, options?.readonly ?? false) as unknown as SqliteDatabase;
    },
  };
}

// ─── Value conversion ─────────────────────────────────────────────────────────

function isNamedBindObject(args: unknown[]): args is [Record<string, unknown>] {
  if (args.length !== 1) return false;
  const v = args[0];
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !ArrayBuffer.isView(v) // excludes Buffer / Uint8Array / typed arrays
  );
}

/** Normalise a value for binding (mirror better-sqlite3 leniency we rely on). */
function normIn(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  // Buffer is a Uint8Array subclass; sqlite-wasm binds Uint8Array as a BLOB.
  return value;
}

/** Convert an out value: BLOBs come back as Uint8Array; expose as Buffer. */
function normOut(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

// ─── Statement wrapper ──────────────────────────────────────────────────────

class WasmStatement {
  private stmt: WasmStmt | null = null;
  /** Cached 1-based bind index -> object key for named params; null until compiled. */
  private namedPlan: Array<{ index: number; key: string }> | null = null;
  private columnNames: string[] | null = null;

  constructor(private readonly owner: WasmDatabase, private readonly sql: string) {}

  private compile(): WasmStmt {
    if (!this.stmt) {
      this.stmt = this.owner.rawDb.prepare(this.sql);
      this.owner.trackStatement(this.stmt);
      const capi = this.owner.sqlite3.capi;
      const count = capi.sqlite3_bind_parameter_count(this.stmt.pointer);
      const plan: Array<{ index: number; key: string }> = [];
      for (let i = 1; i <= count; i++) {
        const name = capi.sqlite3_bind_parameter_name(this.stmt.pointer, i);
        // name is like "@id"/":id"/"$id" for named params, null for positional "?"
        if (name) plan.push({ index: i, key: name.slice(1) });
      }
      this.namedPlan = plan;
    }
    return this.stmt;
  }

  private bindArgs(stmt: WasmStmt, args: unknown[]): void {
    if (isNamedBindObject(args)) {
      const obj = args[0];
      for (const { index, key } of this.namedPlan ?? []) {
        stmt.bind(index, normIn(obj[key]));
      }
    } else {
      for (let i = 0; i < args.length; i++) stmt.bind(i + 1, normIn(args[i]));
    }
  }

  private readRow(stmt: WasmStmt): Record<string, unknown> {
    if (!this.columnNames) this.columnNames = stmt.getColumnNames();
    const row: Record<string, unknown> = {};
    for (let i = 0; i < this.columnNames.length; i++) {
      row[this.columnNames[i]] = normOut(stmt.get(i));
    }
    return row;
  }

  run(...args: unknown[]): RunResult {
    const stmt = this.compile();
    try {
      this.bindArgs(stmt, args);
      stmt.step();
      const changes = this.owner.rawDb.changes();
      const lastInsertRowid = this.owner.sqlite3.capi.sqlite3_last_insert_rowid(
        this.owner.rawDb.pointer,
      );
      this.owner.markDirty();
      return { changes: Number(changes), lastInsertRowid };
    } finally {
      stmt.reset(true);
    }
  }

  get(...args: unknown[]): unknown {
    const stmt = this.compile();
    try {
      this.bindArgs(stmt, args);
      if (!stmt.step()) return undefined;
      return this.readRow(stmt);
    } finally {
      stmt.reset(true);
    }
  }

  all(...args: unknown[]): unknown[] {
    const stmt = this.compile();
    try {
      this.bindArgs(stmt, args);
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(this.readRow(stmt));
      return rows;
    } finally {
      stmt.reset(true);
    }
  }
}

// ─── Database wrapper ─────────────────────────────────────────────────────────

class WasmDatabase {
  readonly rawDb: WasmOo1Db;
  private readonly persistent: boolean;
  private readonly statements = new Set<WasmStmt>();
  private dirty = false;
  private txnDepth = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    readonly sqlite3: Sqlite3,
    private readonly filename: string,
    private readonly readonly_: boolean,
  ) {
    this.persistent = !!filename && filename !== ':memory:';
    this.rawDb = new sqlite3.oo1.DB(':memory:');
    if (this.persistent && existsSync(filename) && statSync(filename).size > 0) {
      this.deserializeFrom(readFileSync(filename));
    }
  }

  private deserializeFrom(buf: Buffer): void {
    const { capi, wasm } = this.sqlite3;
    // allocFromTypedArray needs a plain Uint8Array — a Node Buffer (a Uint8Array
    // subclass) trips its element-size detection. Copy into a clean Uint8Array.
    const bytes = Uint8Array.from(buf);
    const ptr = wasm.allocFromTypedArray(bytes);
    const flags =
      (capi.SQLITE_DESERIALIZE_FREEONCLOSE ?? 1) | (capi.SQLITE_DESERIALIZE_RESIZEABLE ?? 2);
    const rc = capi.sqlite3_deserialize(this.rawDb.pointer, 'main', ptr, bytes.length, bytes.length, flags);
    if (rc !== 0) {
      wasm.dealloc(ptr);
      throw new Error(`sqlite3_deserialize failed (rc=${rc}) for ${this.filename}`);
    }
  }

  prepare(sql: string): WasmStatement {
    return new WasmStatement(this, sql);
  }

  exec(sql: string): this {
    this.rawDb.exec(sql);
    this.markDirty();
    return this;
  }

  // better-sqlite3-compatible transaction: returns a callable that runs `fn`
  // inside a transaction (savepoints for nesting), passing through args/return.
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const depth = this.txnDepth;
      const savepoint = `_pc_sp_${depth}`;
      this.rawDb.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      this.txnDepth++;
      try {
        const result = fn(...args);
        this.rawDb.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        this.markDirty();
        return result;
      } catch (err) {
        try {
          this.rawDb.exec(
            depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
          );
        } catch {
          // best-effort rollback
        }
        throw err;
      } finally {
        this.txnDepth--;
      }
    };
  }

  // Pragmas are issued via the DDL strings (exec); provide a minimal method for
  // API compatibility. Returns [] since no caller reads pragma results.
  pragma(source: string): unknown[] {
    this.rawDb.exec(`PRAGMA ${source}`);
    return [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.flush();
    } finally {
      for (const stmt of this.statements) {
        try {
          stmt.finalize();
        } catch {
          // ignore
        }
      }
      this.statements.clear();
      this.rawDb.close();
    }
  }

  // ── internal ──────────────────────────────────────────────────────────────

  trackStatement(stmt: WasmStmt): void {
    this.statements.add(stmt);
  }

  markDirty(): void {
    if (!this.persistent || this.readonly_ || this.closed) return;
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        try {
          this.flush();
        } catch (err) {
          logger.warn(`WASM SQLite debounced flush failed: ${(err as Error).message}`);
        }
      }, 250);
      // Don't keep the event loop alive solely for a pending flush.
      this.flushTimer.unref?.();
    }
  }

  private flush(): void {
    if (!this.dirty || !this.persistent || this.readonly_) return;
    const bytes = this.sqlite3.capi.sqlite3_js_db_export(this.rawDb.pointer);
    mkdirSync(dirname(this.filename), { recursive: true });
    const tmp = `${this.filename}.tmp-${process.pid}`;
    writeFileSync(tmp, Buffer.from(bytes));
    renameSync(tmp, this.filename);
    this.dirty = false;
  }
}
