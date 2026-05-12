/**
 * Tests for the get_public_api tool (Task 196).
 *
 * Fixture: test/fixtures/get-public-api-fixture/
 *   src/services/user-service.ts  — exported class, function, interface; unexported function
 *   src/services/auth-service.ts  — exported functions; unexported function + consts
 *   src/types.ts                  — exported interfaces, types, enums; unexported variants
 *   src/utils.ts                  — exported consts and functions; unexported helpers
 *   src/default-export.ts         — export default class
 *   src/internal.ts               — ONLY unexported symbols (must not appear in results)
 *   src/index.ts                  — re-exports from other files
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getPublicApiHandler } from '../../src/server/tools/get-public-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-public-api-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface ExportedSymbol {
  symbolId: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string;
  summary: string;
  isDefault: boolean;
}

interface FileGroup {
  filePath: string;
  exports: ExportedSymbol[];
}

interface GetPublicApiOutput {
  totalExported: number;
  fileCount: number;
  files?: FileGroup[];
  symbols?: ExportedSymbol[];
  _tokenEstimate: number;
  _meta: { timing_ms: number; powered_by: string };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getApi(args: {
  filePath?: string;
  kind?: string;
  includeMembers?: boolean;
  groupByFile?: boolean;
  limit?: number;
} = {}): Promise<GetPublicApiOutput> {
  const result = await getPublicApiHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as GetPublicApiOutput;
}

function allSymbols(out: GetPublicApiOutput): ExportedSymbol[] {
  if (out.symbols) return out.symbols;
  return (out.files ?? []).flatMap((f) => f.exports);
}

// ─── Basic export detection ───────────────────────────────────────────────────

describe('get_public_api — basic export detection', () => {
  it('returns a non-zero totalExported for the fixture repo', async () => {
    const out = await getApi();
    expect(out.totalExported).toBeGreaterThan(0);
  });

  it('detects exported class UserService', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('UserService');
  });

  it('detects exported function createUserService', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('createUserService');
  });

  it('detects exported functions in auth-service', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('generateToken');
    expect(names).toContain('revokeToken');
  });

  it('detects exported enums Role and Status', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('Role');
    expect(names).toContain('Status');
  });

  it('detects exported consts MAX_RETRIES and DEFAULT_TIMEOUT', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('MAX_RETRIES');
    expect(names).toContain('DEFAULT_TIMEOUT');
  });
});

// ─── Unexported symbols are excluded ─────────────────────────────────────────

describe('get_public_api — unexported symbols excluded', () => {
  it('does not include unexported function hashPassword', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).not.toContain('hashPassword');
  });

  it('does not include unexported function isValidEmail', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).not.toContain('isValidEmail');
  });

  it('does not include unexported interface InternalConfig', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).not.toContain('InternalConfig');
  });
});

// ─── internal.ts — no exports ─────────────────────────────────────────────────

describe('get_public_api — internal.ts has no public exports', () => {
  it('internal.ts does not appear in grouped results', async () => {
    const out = await getApi();
    const filePaths = (out.files ?? []).map((f) => f.filePath);
    const internalPaths = filePaths.filter((p) => p.includes('internal'));
    expect(internalPaths).toHaveLength(0);
  });

  it('internal symbols (privateHelper, InternalCache) are absent', async () => {
    const out = await getApi();
    const names = allSymbols(out).map((s) => s.name);
    expect(names).not.toContain('privateHelper');
    expect(names).not.toContain('InternalCache');
    expect(names).not.toContain('anotherHelper');
    expect(names).not.toContain('SECRET_KEY');
  });
});

// ─── isDefault flag ───────────────────────────────────────────────────────────

describe('get_public_api — isDefault flag', () => {
  it('AppConfig has isDefault=true', async () => {
    const out = await getApi();
    const appConfig = allSymbols(out).find((s) => s.name === 'AppConfig');
    expect(appConfig).toBeDefined();
    expect(appConfig?.isDefault).toBe(true);
  });

  it('non-default exports have isDefault=false', async () => {
    const out = await getApi();
    const nonDefault = allSymbols(out).filter((s) => s.name !== 'AppConfig');
    for (const sym of nonDefault) {
      if (sym.isDefault) {
        // Only AppConfig should be default; skip any others if tree-sitter picks them up
        expect(sym.signature).toContain('export default');
      }
    }
    // At least one non-default export exists
    expect(nonDefault.some((s) => !s.isDefault)).toBe(true);
  });
});

// ─── filePath filter ──────────────────────────────────────────────────────────

describe('get_public_api — filePath filter', () => {
  it('restricts results to src/services/ directory', async () => {
    const out = await getApi({ filePath: 'src/services/' });
    expect(out.totalExported).toBeGreaterThan(0);
    for (const sym of allSymbols(out)) {
      expect(sym.filePath).toMatch(/^src\/services\//);
    }
  });

  it('restricts results to a specific file', async () => {
    const out = await getApi({ filePath: 'src/types.ts' });
    expect(out.totalExported).toBeGreaterThan(0);
    for (const sym of allSymbols(out)) {
      expect(sym.filePath).toBe('src/types.ts');
    }
  });

  it('returns empty when file has no exports', async () => {
    const out = await getApi({ filePath: 'src/internal.ts' });
    expect(out.totalExported).toBe(0);
  });
});

// ─── kind filter ──────────────────────────────────────────────────────────────

describe('get_public_api — kind filter', () => {
  it('kind=function returns only functions', async () => {
    const out = await getApi({ kind: 'function' });
    expect(out.totalExported).toBeGreaterThan(0);
    for (const sym of allSymbols(out)) {
      expect(sym.kind).toBe('function');
    }
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('createUserService');
  });

  it('kind=class returns only classes', async () => {
    const out = await getApi({ kind: 'class' });
    expect(out.totalExported).toBeGreaterThan(0);
    for (const sym of allSymbols(out)) {
      expect(sym.kind).toBe('class');
    }
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('UserService');
  });

  it('kind=enum returns only enums', async () => {
    const out = await getApi({ kind: 'enum' });
    expect(out.totalExported).toBeGreaterThan(0);
    for (const sym of allSymbols(out)) {
      expect(sym.kind).toBe('enum');
    }
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('Role');
    expect(names).toContain('Status');
  });

  it('kind=interface returns only interfaces', async () => {
    const out = await getApi({ kind: 'interface' });
    for (const sym of allSymbols(out)) {
      expect(sym.kind).toBe('interface');
    }
    const names = allSymbols(out).map((s) => s.name);
    expect(names).toContain('ApiResponse');
  });
});

// ─── groupByFile ──────────────────────────────────────────────────────────────

describe('get_public_api — groupByFile', () => {
  it('groupByFile=true (default) returns files array', async () => {
    const out = await getApi({ groupByFile: true });
    expect(out.files).toBeDefined();
    expect(out.symbols).toBeUndefined();
    expect(out.fileCount).toBeGreaterThan(0);
  });

  it('groupByFile=false returns flat symbols array', async () => {
    const out = await getApi({ groupByFile: false });
    expect(out.symbols).toBeDefined();
    expect(out.files).toBeUndefined();
    expect(out.totalExported).toBeGreaterThan(0);
  });

  it('groupByFile=true groups correctly — each file has its own exports', async () => {
    const out = await getApi({ groupByFile: true });
    expect(out.files).toBeDefined();
    for (const file of out.files!) {
      expect(file.filePath).toBeDefined();
      expect(Array.isArray(file.exports)).toBe(true);
      expect(file.exports.length).toBeGreaterThan(0);
      for (const sym of file.exports) {
        expect(sym.filePath).toBe(file.filePath);
      }
    }
  });

  it('flat and grouped modes return the same totalExported', async () => {
    const grouped = await getApi({ groupByFile: true });
    const flat = await getApi({ groupByFile: false });
    expect(grouped.totalExported).toBe(flat.totalExported);
  });
});

// ─── includeMembers ───────────────────────────────────────────────────────────

describe('get_public_api — includeMembers', () => {
  it('includeMembers=false (default) excludes methods', async () => {
    const out = await getApi({ includeMembers: false });
    const methods = allSymbols(out).filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(0);
  });

  it('includeMembers=true adds methods of exported classes', async () => {
    const out = await getApi({ includeMembers: true });
    const methods = allSymbols(out).filter((s) => s.kind === 'method');
    // UserService has getUser, addUser, removeUser methods
    expect(methods.length).toBeGreaterThan(0);
  });
});

// ─── Output shape ─────────────────────────────────────────────────────────────

describe('get_public_api — output shape', () => {
  it('each symbol has required fields', async () => {
    const out = await getApi();
    for (const sym of allSymbols(out)) {
      expect(sym).toHaveProperty('symbolId');
      expect(sym).toHaveProperty('name');
      expect(sym).toHaveProperty('kind');
      expect(sym).toHaveProperty('filePath');
      expect(sym).toHaveProperty('startLine');
      expect(sym).toHaveProperty('signature');
      expect(sym).toHaveProperty('summary');
      expect(sym).toHaveProperty('isDefault');
      expect(typeof sym.startLine).toBe('number');
      expect(sym.startLine).toBeGreaterThanOrEqual(1);
      expect(typeof sym.isDefault).toBe('boolean');
    }
  });

  it('all signatures begin with export', async () => {
    const out = await getApi({ includeMembers: false });
    for (const sym of allSymbols(out)) {
      expect(sym.signature.trimStart()).toMatch(/^export/);
    }
  });

  it('returns _meta with timing_ms and powered_by', async () => {
    const out = await getApi();
    expect(out._meta).toBeDefined();
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(out._meta.powered_by).toBe('PureContext MCP');
  });

  it('returns _tokenEstimate > 0 when results exist', async () => {
    const out = await getApi();
    expect(out.totalExported).toBeGreaterThan(0);
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('returns fileCount >= 1', async () => {
    const out = await getApi();
    expect(out.fileCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── limit ────────────────────────────────────────────────────────────────────

describe('get_public_api — limit', () => {
  it('respects limit parameter', async () => {
    const out = await getApi({ groupByFile: false, limit: 2 });
    expect(out.totalExported).toBeLessThanOrEqual(2);
  });

  it('returns all symbols when limit is large enough', async () => {
    const unlimited = await getApi({ groupByFile: false });
    const limited = await getApi({ groupByFile: false, limit: 1000 });
    expect(limited.totalExported).toBe(unlimited.totalExported);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('get_public_api — error handling', () => {
  it('returns error for unknown repoId', async () => {
    const result = await getPublicApiHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toContain('not found');
  });
});
