import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { cHandler } from '../../src/handlers/c.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/c-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, cHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('C handler — extractSymbols', () => {
  it('extracts a non-static function', async () => {
    const { tree, buf } = await parse(`int add(int a, int b) { return a + b; }\n`);
    const syms = cHandler.extractSymbols(tree, buf, 'math.c');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('add');
    expect(fn!.startByte).toBeGreaterThanOrEqual(0);
    expect(fn!.endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`void foo(void) {}\n`);
    const sym = cHandler.extractSymbols(tree, buf, 'test.c')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = cHandler.extractSymbols(tree, buf, 'test.c')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('skips static functions', async () => {
    const { tree, buf } = await parse(`static int internal_hash(const char *pw) { return 0; }\n`);
    const syms = cHandler.extractSymbols(tree, buf, 'util.c');
    expect(syms.filter((s) => s.kind === 'function')).toHaveLength(0);
  });

  it('extracts pointer-return function name correctly', async () => {
    const { tree, buf } = await parse(`char *get_name(int id) { return NULL; }\n`);
    const syms = cHandler.extractSymbols(tree, buf, 'util.c');
    const fn = syms.find((s) => s.name === 'get_name');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts a forward declaration from a header', async () => {
    const { tree, buf } = await parse(`int compute(int x, int y);\n`);
    const syms = cHandler.extractSymbols(tree, buf, 'api.h');
    const fn = syms.find((s) => s.name === 'compute');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts typedef struct as kind struct', async () => {
    const src = `typedef struct {\n  int x;\n  int y;\n} Point;\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'geo.h');
    const s = syms.find((s) => s.name === 'Point');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
    expect(s!.signature).toContain('Point');
  });

  it('extracts tagged typedef struct', async () => {
    const src = `typedef struct Node {\n  int value;\n  struct Node *next;\n} Node;\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'list.h');
    const s = syms.find((s) => s.name === 'Node');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
  });

  it('extracts typedef union as kind struct with c_union meta', async () => {
    const src = `typedef union {\n  int i;\n  float f;\n} Number;\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'types.h');
    const s = syms.find((s) => s.name === 'Number');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('struct');
    expect(s!.frameworkMeta?.c_union).toBe(true);
  });

  it('extracts typedef enum as kind enum', async () => {
    const src = `typedef enum {\n  RED,\n  GREEN,\n  BLUE,\n} Color;\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'color.h');
    const s = syms.find((s) => s.name === 'Color');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('enum');
    expect(s!.signature).toContain('Color');
  });

  it('extracts bare typedef as kind type', async () => {
    const src = `typedef unsigned int uint32;\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'types.h');
    const s = syms.find((s) => s.name === 'uint32');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('type');
    expect(s!.signature).toContain('typedef');
    expect(s!.signature).toContain('uint32');
  });

  it('extracts object-like #define macro', async () => {
    const src = `#define MAX_SIZE 1024\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'config.h');
    const m = syms.find((s) => s.name === 'MAX_SIZE');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('macro');
    expect(m!.signature).toBe('#define MAX_SIZE 1024');
  });

  it('skips function-like macros', async () => {
    const src = `#define MAX(a, b) ((a) > (b) ? (a) : (b))\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'util.h');
    expect(syms.filter((s) => s.kind === 'macro')).toHaveLength(0);
  });

  it('skips header guard macros (no value)', async () => {
    const src = `#ifndef HEADER_H\n#define HEADER_H\n#endif\n`;
    const { tree, buf } = await parse(src);
    const syms = cHandler.extractSymbols(tree, buf, 'header.h');
    expect(syms.filter((s) => s.kind === 'macro')).toHaveLength(0);
  });

  it('extracts symbols from fixture auth.h', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/include/auth.h`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, cHandler);
    const syms = cHandler.extractSymbols(tree, buf, 'include/auth.h');
    const names = syms.map((s) => s.name);

    // Forward declarations
    expect(names).toContain('auth_create');
    expect(names).toContain('auth_destroy');
    expect(names).toContain('auth_login');
    expect(names).toContain('auth_validate_token');
    expect(names).toContain('auth_logout');
    expect(names).toContain('auth_get_username');

    // Typedef enum
    const authResult = syms.find((s) => s.name === 'AuthResult');
    expect(authResult).toBeDefined();
    expect(authResult!.kind).toBe('enum');

    // Typedef struct
    const authSession = syms.find((s) => s.name === 'AuthSession');
    expect(authSession).toBeDefined();
    expect(authSession!.kind).toBe('struct');

    // Bare typedef (pointer)
    const authToken = syms.find((s) => s.name === 'AuthToken');
    expect(authToken).toBeDefined();
    expect(authToken!.kind).toBe('type');

    // Macros
    const maxUser = syms.find((s) => s.name === 'MAX_USERNAME_LEN');
    expect(maxUser).toBeDefined();
    expect(maxUser!.kind).toBe('macro');
  });

  it('extracts symbols from fixture auth.c', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/auth.c`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, cHandler);
    const syms = cHandler.extractSymbols(tree, buf, 'src/auth.c');
    const names = syms.map((s) => s.name);

    // Public functions extracted
    expect(names).toContain('auth_create');
    expect(names).toContain('auth_destroy');
    expect(names).toContain('auth_login');

    // Static functions skipped
    expect(names).not.toContain('hash_password');
    expect(names).not.toContain('generate_token');

    // Internal macros (with values) extracted
    const hashRounds = syms.find((s) => s.name === 'HASH_ROUNDS');
    expect(hashRounds).toBeDefined();
    expect(hashRounds!.kind).toBe('macro');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('C handler — extractDocstring', () => {
  it('captures block comment preceding a function', async () => {
    const src = `/* Computes the sum of two integers. */\nint add(int a, int b) { return a + b; }\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_definition');
    expect(fnNode).toBeDefined();
    const doc = cHandler.extractDocstring!(fnNode!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Computes');
  });

  it('captures line comment preceding a function', async () => {
    const src = `// Initialize the subsystem.\nvoid init(void) {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_definition');
    expect(fnNode).toBeDefined();
    const doc = cHandler.extractDocstring!(fnNode!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Initialize');
  });

  it('returns null when no preceding comment', async () => {
    const src = `void bare(void) {}\n`;
    const { tree } = await parse(src);
    const fnNode = tree.rootNode.children.find((c) => c.type === 'function_definition');
    expect(fnNode).toBeDefined();
    const doc = cHandler.extractDocstring!(fnNode!);
    expect(doc).toBeNull();
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('C handler — extractImports', () => {
  it('extracts a local #include with resolvedPath', async () => {
    const { tree, buf } = await parse(`#include "local.h"\n`);
    const imports = cHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('local.h');
    expect(imports[0]!.resolvedPath).toBe('local.h');
    expect(imports[0]!.importedNames).toEqual([]);
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('extracts a system #include with null resolvedPath', async () => {
    const { tree, buf } = await parse(`#include <stdio.h>\n`);
    const imports = cHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('stdio.h');
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts multiple includes', async () => {
    const src = `#include <stdlib.h>\n#include <string.h>\n#include "auth.h"\n`;
    const { tree, buf } = await parse(src);
    const imports = cHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('stdlib.h');
    expect(specs).toContain('string.h');
    expect(specs).toContain('auth.h');
  });

  it('resolvedPath is null for system includes and non-null for local', async () => {
    const src = `#include <stdint.h>\n#include "../include/auth.h"\n`;
    const { tree, buf } = await parse(src);
    const imports = cHandler.extractImports(tree, buf);
    const system = imports.find((i) => i.specifier === 'stdint.h');
    const local = imports.find((i) => i.specifier === '../include/auth.h');
    expect(system!.resolvedPath).toBeNull();
    expect(local!.resolvedPath).toBe('../include/auth.h');
  });

  it('extracts imports from fixture auth.c', async () => {
    const src = readFileSync(`${FIXTURE_ROOT}/src/auth.c`, 'utf8');
    const buf = Buffer.from(src);
    const tree = await parseFile(buf, cHandler);
    const imports = cHandler.extractImports(tree, buf);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('stdlib.h');
    expect(specs).toContain('string.h');
    expect(specs).toContain('../include/auth.h');

    const local = imports.find((i) => i.specifier === '../include/auth.h');
    expect(local!.resolvedPath).toBe('../include/auth.h');
    const system = imports.find((i) => i.specifier === 'stdlib.h');
    expect(system!.resolvedPath).toBeNull();
  });
});

// ─── Handler metadata ─────────────────────────────────────────────────────────

describe('C handler — metadata', () => {
  it('claims .c and .h extensions', () => {
    expect(cHandler.extensions()).toContain('.c');
    expect(cHandler.extensions()).toContain('.h');
  });

  it('grammarPath points to tree-sitter-c.wasm', () => {
    expect(cHandler.grammarPath()).toMatch(/tree-sitter-c\.wasm$/);
  });
});
