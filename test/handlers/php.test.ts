import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { phpHandler } from '../../src/handlers/php.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE_ROOT = resolve(import.meta.dirname ?? '', '../fixtures/php-project');

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, phpHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('PHP handler — extractSymbols', () => {
  it('extracts a top-level function', async () => {
    const { tree, buf } = await parse(`<?php\nfunction greet(string $name): string { return $name; }\n`);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('greet');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].startByte).toBeGreaterThanOrEqual(0);
    expect(syms[0].endByte).toBeGreaterThan(0);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const { tree, buf } = await parse(`<?php\nfunction foo() {}\n`);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('extracts a class with public and protected methods (skips private)', async () => {
    const src = `<?php
class UserService {
    public function getAll(): array { return []; }
    protected function validate(array $d): bool { return true; }
    private function secret(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('UserService::getAll');
    expect(names).toContain('UserService::validate');
    expect(names).not.toContain('UserService::secret');
    expect(syms.find((s) => s.name === 'UserService')?.kind).toBe('class');
    expect(syms.find((s) => s.name === 'UserService::getAll')?.kind).toBe('method');
  });

  it('extracts an interface with its methods', async () => {
    const src = `<?php
interface Countable {
    public function count(): int;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Countable');
    expect(syms.find((s) => s.name === 'Countable')?.kind).toBe('interface');
    expect(names).toContain('Countable::count');
  });

  it('extracts a trait as kind interface', async () => {
    const src = `<?php
trait Loggable {
    public function log(string $msg): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms.find((s) => s.name === 'Loggable')?.kind).toBe('interface');
    expect(syms.find((s) => s.name === 'Loggable::log')).toBeDefined();
  });

  it('extracts an enum', async () => {
    const src = `<?php
enum Status {
    case Active;
    case Inactive;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms.find((s) => s.name === 'Status' && s.kind === 'enum')).toBeDefined();
  });

  it('extracts a class constant', async () => {
    const src = `<?php
class Config {
    public const MAX_RESULTS = 100;
    public function get(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Config::MAX_RESULTS');
    expect(syms.find((s) => s.name === 'Config::MAX_RESULTS')?.kind).toBe('const');
  });

  it('qualifies names with namespace (braced form)', async () => {
    const src = `<?php
namespace App\\Controllers {
    class UserController {}
    function helper(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controllers\\UserController');
    expect(names).toContain('App\\Controllers\\helper');
  });

  it('qualifies names with namespace (unbraced form)', async () => {
    const src = `<?php
namespace App\\Models;

class User {}
class Post {}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Models\\User');
    expect(names).toContain('App\\Models\\Post');
  });

  it('builds a signature without the body', async () => {
    const src = `<?php
function greet(string $name): string {
    return "hello $name";
}`;
    const { tree, buf } = await parse(src);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym.signature).toContain('function greet');
    expect(sym.signature).not.toContain('return');
  });

  it('extracts all symbols from fixture UserController.php', async () => {
    const source = readFileSync(`${FIXTURE_ROOT}/src/UserController.php`, 'utf8');
    const buf = Buffer.from(source);
    const tree = await parseFile(buf, phpHandler);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/UserController.php');
    const names = syms.map((s) => s.name);

    expect(names).toContain('App\\Http\\Controllers\\UserController');
    expect(names).toContain('App\\Http\\Controllers\\UserController::index');
    expect(names).toContain('App\\Http\\Controllers\\UserController::show');
    expect(names).toContain('App\\Http\\Controllers\\UserController::validate');
    expect(names).not.toContain('App\\Http\\Controllers\\UserController::secret');
    expect(names).toContain('App\\Http\\Controllers\\UserController::MAX_RESULTS');
    expect(names).toContain('App\\Http\\Controllers\\greet');
    expect(names).toContain('App\\Http\\Controllers\\Countable');
    expect(names).toContain('App\\Http\\Controllers\\Loggable');
    expect(names).toContain('App\\Http\\Controllers\\Status');
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('PHP handler — extractDocstring', () => {
  it('extracts PHPDoc from a class', async () => {
    const src = `<?php
/**
 * Handles user requests.
 */
class UserController {}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]?.summary).toContain('Handles user requests');
  });

  it('extracts PHPDoc from a function', async () => {
    const src = `<?php
/** Returns a greeting. */
function greet(): string { return ''; }`;
    const { tree, buf } = await parse(src);
    expect(phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]?.summary).toBe('Returns a greeting.');
  });

  it('returns empty string when no docblock present', async () => {
    const src = `<?php\n// plain comment\nfunction foo() {}\n`;
    const { tree, buf } = await parse(src);
    expect(phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]?.summary).toBe('');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('PHP handler — extractImports', () => {
  it('extracts a simple use statement', async () => {
    const src = `<?php
use App\\Models\\User;
class Foo {}`;
    const { tree, buf } = await parse(src);
    const imports = phpHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('App\\Models\\User');
    expect(imports[0]!.importedNames).toContain('User');
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts a use statement with alias', async () => {
    const src = `<?php
use App\\Http\\Controllers\\UserController as UserCtrl;`;
    const { tree, buf } = await parse(src);
    const imports = phpHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('App\\Http\\Controllers\\UserController');
    expect(imports[0]!.importedNames).toContain('UserCtrl');
  });

  it('extracts multiple use statements', async () => {
    const src = `<?php
use App\\Models\\User;
use App\\Services\\UserService;`;
    const { tree, buf } = await parse(src);
    const imports = phpHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(2);
    const specifiers = imports.map((i) => i.specifier);
    expect(specifiers).toContain('App\\Models\\User');
    expect(specifiers).toContain('App\\Services\\UserService');
  });
});
