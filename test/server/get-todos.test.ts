/**
 * Tests for the get_todos tool (Task 197).
 *
 * Fixture: test/fixtures/get-todos-fixture/
 *   src/services/user-service.ts  — TODO, TODO(alice), TODO(bob), FIXME, HACK, NOTE
 *   src/utils/helpers.ts          — OPTIMIZE, BUG, XXX, NOTE
 *   src/index.ts                  — TODO (module-level)
 *   src/clean.ts                  — no TODO/FIXME comments at all
 *
 * Expected todos in fixture:
 *   user-service.ts : TODO, TODO(alice), FIXME, HACK, NOTE, TODO(bob)  → 6
 *   helpers.ts      : OPTIMIZE, BUG, XXX, NOTE                         → 4
 *   index.ts        : TODO                                              → 1
 *   clean.ts        : (none)                                            → 0
 *   Total: 11
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import { handler as getTodosHandler } from '../../src/server/tools/get-todos.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/get-todos-fixture');

let repoId: string;

// ─── Output types ─────────────────────────────────────────────────────────────

interface TodoItem {
  filePath: string;
  line: number;
  tag: string;
  assignee: string | null;
  text: string;
}

interface FileGroup {
  filePath: string;
  todos: TodoItem[];
}

interface GetTodosOutput {
  totalTodos: number;
  fileCount: number;
  tagCounts: Record<string, number>;
  truncated: boolean;
  files?: FileGroup[];
  todos?: TodoItem[];
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

async function getTodos(args: {
  tags?: string[];
  filePath?: string;
  assignee?: string;
  groupByFile?: boolean;
  limit?: number;
} = {}): Promise<GetTodosOutput> {
  const result = await getTodosHandler({ repoId, ...args });
  expect(result.isError).toBeFalsy();
  const text = (result.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as GetTodosOutput;
}

function allTodos(out: GetTodosOutput): TodoItem[] {
  if (out.todos) return out.todos;
  return (out.files ?? []).flatMap((f) => f.todos);
}

// ─── Basic detection ──────────────────────────────────────────────────────────

describe('get_todos — basic detection', () => {
  it('returns totalTodos > 0 for the fixture repo', async () => {
    const out = await getTodos();
    expect(out.totalTodos).toBeGreaterThan(0);
  });

  it('detects TODO tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('TODO');
  });

  it('detects FIXME tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('FIXME');
  });

  it('detects HACK tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('HACK');
  });

  it('detects NOTE tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('NOTE');
  });

  it('detects OPTIMIZE tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('OPTIMIZE');
  });

  it('detects BUG tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('BUG');
  });

  it('detects XXX tags', async () => {
    const out = await getTodos();
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('XXX');
  });
});

// ─── Clean file ───────────────────────────────────────────────────────────────

describe('get_todos — clean file has no todos', () => {
  it('src/clean.ts does not appear in grouped results', async () => {
    const out = await getTodos({ groupByFile: true });
    const filePaths = (out.files ?? []).map((f) => f.filePath);
    const cleanPaths = filePaths.filter((p) => p.includes('clean'));
    expect(cleanPaths).toHaveLength(0);
  });

  it('filePath filter on clean.ts returns 0 todos', async () => {
    const out = await getTodos({ filePath: 'src/clean.ts' });
    expect(out.totalTodos).toBe(0);
  });
});

// ─── Assignee parsing ─────────────────────────────────────────────────────────

describe('get_todos — assignee parsing', () => {
  it('parses assignee "alice" from TODO(alice)', async () => {
    const out = await getTodos();
    const aliceItems = allTodos(out).filter((t) => t.assignee === 'alice');
    expect(aliceItems.length).toBeGreaterThan(0);
    expect(aliceItems[0].tag).toBe('TODO');
  });

  it('parses assignee "bob" from TODO(bob)', async () => {
    const out = await getTodos();
    const bobItems = allTodos(out).filter((t) => t.assignee === 'bob');
    expect(bobItems.length).toBeGreaterThan(0);
    expect(bobItems[0].tag).toBe('TODO');
  });

  it('items without parentheses have null assignee', async () => {
    const out = await getTodos();
    const noAssignee = allTodos(out).filter((t) => t.assignee === null);
    expect(noAssignee.length).toBeGreaterThan(0);
  });

  it('includes comment text after the tag', async () => {
    const out = await getTodos();
    const fixme = allTodos(out).find((t) => t.tag === 'FIXME');
    expect(fixme).toBeDefined();
    expect(fixme!.text.length).toBeGreaterThan(0);
  });
});

// ─── assignee filter ──────────────────────────────────────────────────────────

describe('get_todos — assignee filter', () => {
  it('assignee="alice" returns only alice items', async () => {
    const out = await getTodos({ assignee: 'alice' });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.assignee?.toLowerCase()).toBe('alice');
    }
  });

  it('assignee="bob" returns only bob items', async () => {
    const out = await getTodos({ assignee: 'bob' });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.assignee?.toLowerCase()).toBe('bob');
    }
  });

  it('assignee filter is case-insensitive', async () => {
    const lower = await getTodos({ assignee: 'alice' });
    const upper = await getTodos({ assignee: 'ALICE' });
    expect(lower.totalTodos).toBe(upper.totalTodos);
  });

  it('assignee="nobody" returns 0 results', async () => {
    const out = await getTodos({ assignee: 'nobody' });
    expect(out.totalTodos).toBe(0);
  });
});

// ─── tags filter ──────────────────────────────────────────────────────────────

describe('get_todos — tags filter', () => {
  it('tags=["FIXME"] returns only FIXME items', async () => {
    const out = await getTodos({ tags: ['FIXME'] });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.tag).toBe('FIXME');
    }
  });

  it('tags=["TODO"] returns only TODO items', async () => {
    const out = await getTodos({ tags: ['TODO'] });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.tag).toBe('TODO');
    }
  });

  it('tags=["TODO","FIXME"] returns only those two kinds', async () => {
    const out = await getTodos({ tags: ['TODO', 'FIXME'] });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(['TODO', 'FIXME']).toContain(item.tag);
    }
  });

  it('tags=["XXX"] returns only XXX items', async () => {
    const out = await getTodos({ tags: ['XXX'] });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.tag).toBe('XXX');
    }
  });
});

// ─── filePath filter ──────────────────────────────────────────────────────────

describe('get_todos — filePath filter', () => {
  it('restricts to src/services/ directory', async () => {
    const out = await getTodos({ filePath: 'src/services/' });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.filePath).toMatch(/^src\/services\//);
    }
  });

  it('restricts to a specific file', async () => {
    const out = await getTodos({ filePath: 'src/utils/helpers.ts' });
    expect(out.totalTodos).toBeGreaterThan(0);
    for (const item of allTodos(out)) {
      expect(item.filePath).toBe('src/utils/helpers.ts');
    }
  });

  it('helpers.ts has OPTIMIZE, BUG, XXX, NOTE tags', async () => {
    const out = await getTodos({ filePath: 'src/utils/helpers.ts' });
    const tags = allTodos(out).map((t) => t.tag);
    expect(tags).toContain('OPTIMIZE');
    expect(tags).toContain('BUG');
    expect(tags).toContain('XXX');
    expect(tags).toContain('NOTE');
  });
});

// ─── groupByFile ──────────────────────────────────────────────────────────────

describe('get_todos — groupByFile', () => {
  it('groupByFile=true (default) returns files array', async () => {
    const out = await getTodos({ groupByFile: true });
    expect(out.files).toBeDefined();
    expect(out.todos).toBeUndefined();
    expect(out.fileCount).toBeGreaterThan(0);
  });

  it('groupByFile=false returns flat todos array', async () => {
    const out = await getTodos({ groupByFile: false });
    expect(out.todos).toBeDefined();
    expect(out.files).toBeUndefined();
    expect(out.totalTodos).toBeGreaterThan(0);
  });

  it('grouped and flat modes return the same totalTodos', async () => {
    const grouped = await getTodos({ groupByFile: true });
    const flat = await getTodos({ groupByFile: false });
    expect(grouped.totalTodos).toBe(flat.totalTodos);
  });

  it('grouped mode: each file group has matching filePaths', async () => {
    const out = await getTodos({ groupByFile: true });
    for (const fileGroup of out.files ?? []) {
      for (const item of fileGroup.todos) {
        expect(item.filePath).toBe(fileGroup.filePath);
      }
    }
  });
});

// ─── limit ────────────────────────────────────────────────────────────────────

describe('get_todos — limit', () => {
  it('respects limit parameter', async () => {
    const out = await getTodos({ groupByFile: false, limit: 3 });
    expect(out.totalTodos).toBeLessThanOrEqual(3);
  });

  it('truncated=true when limit is hit', async () => {
    const out = await getTodos({ groupByFile: false, limit: 1 });
    expect(out.totalTodos).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('truncated=false when all results fit', async () => {
    const out = await getTodos({ groupByFile: false, limit: 1000 });
    expect(out.truncated).toBe(false);
  });
});

// ─── tagCounts ────────────────────────────────────────────────────────────────

describe('get_todos — tagCounts', () => {
  it('tagCounts includes counts for each present tag', async () => {
    const out = await getTodos();
    expect(out.tagCounts).toBeDefined();
    expect(typeof out.tagCounts).toBe('object');
    expect(out.tagCounts['TODO']).toBeGreaterThan(0);
    expect(out.tagCounts['FIXME']).toBeGreaterThan(0);
  });

  it('tagCounts sum equals totalTodos', async () => {
    const out = await getTodos({ groupByFile: false });
    const sum = Object.values(out.tagCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(out.totalTodos);
  });
});

// ─── Output shape ─────────────────────────────────────────────────────────────

describe('get_todos — output shape', () => {
  it('each item has required fields', async () => {
    const out = await getTodos({ groupByFile: false });
    for (const item of allTodos(out)) {
      expect(item).toHaveProperty('filePath');
      expect(item).toHaveProperty('line');
      expect(item).toHaveProperty('tag');
      expect(item).toHaveProperty('assignee');
      expect(item).toHaveProperty('text');
      expect(typeof item.line).toBe('number');
      expect(item.line).toBeGreaterThanOrEqual(1);
      expect(typeof item.tag).toBe('string');
    }
  });

  it('line numbers are positive integers', async () => {
    const out = await getTodos({ groupByFile: false });
    for (const item of allTodos(out)) {
      expect(Number.isInteger(item.line)).toBe(true);
      expect(item.line).toBeGreaterThan(0);
    }
  });

  it('returns _meta with timing_ms and powered_by', async () => {
    const out = await getTodos();
    expect(out._meta).toBeDefined();
    expect(out._meta.timing_ms).toBeGreaterThanOrEqual(0);
    expect(out._meta.powered_by).toBe('PureContext MCP');
  });

  it('returns _tokenEstimate > 0 when results exist', async () => {
    const out = await getTodos();
    expect(out.totalTodos).toBeGreaterThan(0);
    expect(out._tokenEstimate).toBeGreaterThan(0);
  });

  it('returns fileCount >= 1', async () => {
    const out = await getTodos();
    expect(out.fileCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('get_todos — error handling', () => {
  it('returns error for unknown repoId', async () => {
    const result = await getTodosHandler({ repoId: 'deadbeef00000000' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: string; text: string }).text;
    const parsed = JSON.parse(text) as { error: string };
    expect(parsed.error).toContain('not found');
  });
});
