import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { bashHandler } from '../../src/handlers/bash.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, bashHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Bash handler — extractSymbols', () => {

  // ── function keyword syntax ───────────────────────────────────────────────

  it('extracts function defined with function keyword', async () => {
    const { tree, buf } = await parse(`function deploy() {\n  echo "deploying"\n}\n`);
    const syms = bashHandler.extractSymbols(tree, buf, 'deploy.sh');
    const fn = syms.find((s) => s.name === 'deploy');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('function deploy');
  });

  // ── POSIX syntax without function keyword ────────────────────────────────

  it('extracts function defined without function keyword (POSIX syntax)', async () => {
    const { tree, buf } = await parse(`start_server() {\n  ./server &\n}\n`);
    const syms = bashHandler.extractSymbols(tree, buf, 'server.sh');
    const fn = syms.find((s) => s.name === 'start_server');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  // ── readonly constant ─────────────────────────────────────────────────────

  it('extracts readonly variable as const', async () => {
    const { tree, buf } = await parse(`readonly API_KEY="abc123"\n`);
    const syms = bashHandler.extractSymbols(tree, buf, 'config.sh');
    const sym = syms.find((s) => s.name === 'API_KEY');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── declare -g constant ───────────────────────────────────────────────────

  it('extracts declare -g variable as const', async () => {
    const { tree, buf } = await parse(`declare -g APP_NAME="myapp"\n`);
    const syms = bashHandler.extractSymbols(tree, buf, 'config.sh');
    const sym = syms.find((s) => s.name === 'APP_NAME');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── skip non-readonly declare ─────────────────────────────────────────────

  it('does not extract declare without -g', async () => {
    const { tree, buf } = await parse(`declare LOCAL_VAR="value"\n`);
    const syms = bashHandler.extractSymbols(tree, buf, 'config.sh');
    expect(syms.filter((s) => s.name === 'LOCAL_VAR')).toHaveLength(0);
  });

  // ── comment summary ───────────────────────────────────────────────────────

  it('uses preceding # comment as summary', async () => {
    const { tree, buf } = await parse(
      `# Deploy the application to production.\nfunction deploy() {\n  echo done\n}\n`,
    );
    const syms = bashHandler.extractSymbols(tree, buf, 'deploy.sh');
    const fn = syms.find((s) => s.name === 'deploy');
    expect(fn!.summary).toContain('Deploy');
  });

  // ── deterministic ID ─────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', async () => {
    const { tree, buf } = await parse(`function foo() { echo hi; }\n`);
    const sym = bashHandler.extractSymbols(tree, buf, 'test.sh')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = bashHandler.extractSymbols(tree, buf, 'test.sh')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple functions and constants from the same file', async () => {
    const { tree, buf } = await parse(`#!/bin/bash
readonly APP_VERSION="1.0"

function build() {
  echo "building"
}

deploy() {
  echo "deploying"
}
`);
    const syms = bashHandler.extractSymbols(tree, buf, 'ci.sh');
    expect(syms.length).toBeGreaterThanOrEqual(3);
    expect(syms.find((s) => s.name === 'APP_VERSION')?.kind).toBe('const');
    expect(syms.find((s) => s.name === 'build')?.kind).toBe('function');
    expect(syms.find((s) => s.name === 'deploy')?.kind).toBe('function');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Bash handler — extractImports', () => {

  it('extracts source ./file.sh as import', async () => {
    const { tree, buf } = await parse(`source ./utils.sh\n`);
    const imports = bashHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./utils.sh');
    expect(imports[0]!.resolvedPath).toBe('./utils.sh');
  });

  it('extracts . ./file.sh (dot source) as import', async () => {
    const { tree, buf } = await parse(`. ./helpers.sh\n`);
    const imports = bashHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./helpers.sh');
  });

  it('extracts multiple source statements', async () => {
    const { tree, buf } = await parse(`source ./lib/utils.sh\nsource ./lib/config.sh\n`);
    const imports = bashHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(2);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('./lib/utils.sh');
    expect(specs).toContain('./lib/config.sh');
  });

  it('deduplicates repeated source statements', async () => {
    const { tree, buf } = await parse(`source ./utils.sh\nsource ./utils.sh\n`);
    const imports = bashHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('does not extract non-source commands', async () => {
    const { tree, buf } = await parse(`echo "hello"\nrm -rf /tmp/stuff\n`);
    const imports = bashHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(0);
  });
});
