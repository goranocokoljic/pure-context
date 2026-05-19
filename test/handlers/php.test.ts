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

  it('extracts public and protected class properties', async () => {
    const src = `<?php
class User {
    public string $name;
    protected int $age = 0;
    private string $secret;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('User::$name');
    expect(names).toContain('User::$age');
    expect(names).not.toContain('User::$secret');
    expect(syms.find((s) => s.name === 'User::$name')?.kind).toBe('property');
    expect(syms.find((s) => s.name === 'User::$age')?.kind).toBe('property');
  });

  it('property signature includes type and default value', async () => {
    const src = `<?php
class Config {
    public string $mode = 'production';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const prop = syms.find((s) => s.name === 'Config::$mode');
    expect(prop).toBeDefined();
    expect(prop?.signature).toContain('$mode');
    expect(prop?.signature).toContain('string');
  });

  it('extracts static class property', async () => {
    const src = `<?php
class Registry {
    public static int $count = 0;
    private static string $secret = 'x';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Registry::$count');
    expect(names).not.toContain('Registry::$secret');
  });

  it('extracts nullable typed property', async () => {
    const src = `<?php
class Order {
    public ?string $notes = null;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const prop = syms.find((s) => s.name === 'Order::$notes');
    expect(prop).toBeDefined();
    expect(prop?.signature).toContain('$notes');
  });

  it('extracts PHPDoc from a property', async () => {
    const src = `<?php
class Post {
    /** The post title. */
    public string $title;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const prop = syms.find((s) => s.name === 'Post::$title');
    expect(prop?.summary).toContain('The post title');
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
    expect(names).toContain('App\\Http\\Controllers\\UserController::$status');
    expect(names).toContain('App\\Http\\Controllers\\UserController::$timeout');
    expect(names).not.toContain('App\\Http\\Controllers\\UserController::$service');
    expect(names).toContain('App\\Http\\Controllers\\greet');
    expect(names).toContain('App\\Http\\Controllers\\Countable');
    expect(names).toContain('App\\Http\\Controllers\\Countable::MAX_COUNT');
    expect(names).toContain('App\\Http\\Controllers\\Countable::count');
    expect(names).toContain('App\\Http\\Controllers\\Loggable');
    expect(names).toContain('App\\Http\\Controllers\\BaseController');
    expect(names).toContain('App\\Http\\Controllers\\BaseController::index');
    expect(names).toContain('App\\Http\\Controllers\\BaseController::render');
    expect(names).toContain('App\\Http\\Controllers\\Status');
    expect(names).toContain('App\\Http\\Controllers\\Status::Active');
    expect(names).toContain('App\\Http\\Controllers\\Status::Inactive');
    expect(names).toContain('App\\Http\\Controllers\\APP_NAME');
    expect(names).toContain('App\\Http\\Controllers\\MAX_UPLOAD_SIZE');
    expect(names).toContain('App\\Http\\Controllers\\formatUser');
    expect(names).toContain('App\\Http\\Controllers\\calculateAge');
  });
});

// ─── Abstract methods ─────────────────────────────────────────────────────────

describe('PHP handler — abstract methods', () => {
  it('extracts abstract methods from an abstract class', async () => {
    const src = `<?php
abstract class Repository {
    abstract public function find(int $id): ?object;
    abstract public function save(object $entity): void;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Repository::find');
    expect(names).toContain('Repository::save');
  });

  it('abstract method kind is method', async () => {
    const src = `<?php
abstract class Base {
    abstract public function doWork(): void;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const method = syms.find((s) => s.name === 'Base::doWork');
    expect(method?.kind).toBe('method');
  });

  it('abstract method signature has no body', async () => {
    const src = `<?php
abstract class Base {
    abstract public function calculate(int $x, int $y): int;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const method = syms.find((s) => s.name === 'Base::calculate');
    expect(method?.signature).toContain('calculate');
    expect(method?.signature).not.toContain('{');
  });

  it('skips protected abstract method only if private', async () => {
    const src = `<?php
abstract class Base {
    abstract public function pub(): void;
    abstract protected function prot(): void;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Base::pub');
    expect(names).toContain('Base::prot');
  });

  it('extracts PHPDoc from an abstract method', async () => {
    const src = `<?php
abstract class Base {
    /** Loads the entity by its primary key. */
    abstract public function load(int $id): ?object;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const method = syms.find((s) => s.name === 'Base::load');
    expect(method?.summary).toContain('Loads the entity');
  });

  it('extracts abstract methods in a namespaced abstract class', async () => {
    const src = `<?php
namespace App\\Repositories;
abstract class AbstractRepo {
    abstract public function findAll(): array;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Repositories\\AbstractRepo');
    expect(names).toContain('App\\Repositories\\AbstractRepo::findAll');
  });

  it('extracts abstract methods from a trait', async () => {
    const src = `<?php
trait Validatable {
    abstract protected function rules(): array;
    public function validate(array $data): bool {
        return !empty($this->rules());
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Validatable::rules');
    expect(names).toContain('Validatable::validate');
  });

  it('generates a deterministic id for an abstract method', async () => {
    const src = `<?php
abstract class Base {
    abstract public function run(): void;
}`;
    const { tree, buf } = await parse(src);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php').find((s) => s.name === 'Base::run')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = phpHandler.extractSymbols(tree, buf, 'src/a.php').find((s) => s.name === 'Base::run')!;
    expect(sym2.id).toBe(sym.id);
  });
});

// ─── Enum cases ───────────────────────────────────────────────────────────────

describe('PHP handler — enum cases', () => {
  it('extracts cases from a pure enum', async () => {
    const src = `<?php
enum Direction {
    case North;
    case South;
    case East;
    case West;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Direction::North');
    expect(names).toContain('Direction::South');
    expect(names).toContain('Direction::East');
    expect(names).toContain('Direction::West');
  });

  it('enum case kind is const', async () => {
    const src = `<?php
enum Color { case Red; }`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const caseSymbol = syms.find((s) => s.name === 'Color::Red');
    expect(caseSymbol?.kind).toBe('const');
  });

  it('extracts int-backed enum cases', async () => {
    const src = `<?php
enum Priority: int {
    case Low = 1;
    case Medium = 2;
    case High = 3;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Priority::Low');
    expect(names).toContain('Priority::Medium');
    expect(names).toContain('Priority::High');
  });

  it('int-backed enum case signature includes value', async () => {
    const src = `<?php
enum Priority: int { case High = 3; }`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const caseSymbol = syms.find((s) => s.name === 'Priority::High');
    expect(caseSymbol?.signature).toContain('High');
    expect(caseSymbol?.signature).toContain('3');
  });

  it('extracts string-backed enum cases', async () => {
    const src = `<?php
enum Status: string {
    case Active = 'active';
    case Inactive = 'inactive';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Status::Active');
    expect(names).toContain('Status::Inactive');
  });

  it('string-backed enum case signature includes quoted value', async () => {
    const src = `<?php
enum Status: string { case Active = 'active'; }`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const caseSymbol = syms.find((s) => s.name === 'Status::Active');
    expect(caseSymbol?.signature).toContain('Active');
    expect(caseSymbol?.signature).toContain('active');
  });

  it('extracts PHPDoc from an enum case', async () => {
    const src = `<?php
enum Status: string {
    /** The user is active. */
    case Active = 'active';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const caseSymbol = syms.find((s) => s.name === 'Status::Active');
    expect(caseSymbol?.summary).toContain('The user is active');
  });

  it('extracts enum cases in a namespaced enum', async () => {
    const src = `<?php
namespace App\\Enums;
enum Role: string {
    case Admin = 'admin';
    case User = 'user';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Enums\\Role');
    expect(names).toContain('App\\Enums\\Role::Admin');
    expect(names).toContain('App\\Enums\\Role::User');
  });

  it('generates a deterministic id for an enum case', async () => {
    const src = `<?php
enum Color { case Red; }`;
    const { tree, buf } = await parse(src);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php').find((s) => s.name === 'Color::Red')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = phpHandler.extractSymbols(tree, buf, 'src/a.php').find((s) => s.name === 'Color::Red')!;
    expect(sym2.id).toBe(sym.id);
  });
});

// ─── Interface constants ──────────────────────────────────────────────────────

describe('PHP handler — interface constants', () => {
  it('extracts constants from an interface', async () => {
    const src = `<?php
interface Cache {
    const TTL = 3600;
    public function get(string $key): mixed;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Cache::TTL');
  });

  it('interface constant kind is const', async () => {
    const src = `<?php
interface Cache { const TTL = 3600; }`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const constant = syms.find((s) => s.name === 'Cache::TTL');
    expect(constant?.kind).toBe('const');
  });

  it('interface constant and method coexist', async () => {
    const src = `<?php
interface Countable {
    const MAX_COUNT = 1000;
    public function count(): int;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('Countable::MAX_COUNT');
    expect(names).toContain('Countable::count');
  });

  it('extracts interface constants in namespaced interface', async () => {
    const src = `<?php
namespace App\\Contracts;
interface Pageable {
    const DEFAULT_PAGE_SIZE = 25;
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms.map((s) => s.name)).toContain('App\\Contracts\\Pageable::DEFAULT_PAGE_SIZE');
  });
});

// ─── define() constants ───────────────────────────────────────────────────────

describe('PHP handler — define() constants', () => {
  it('extracts a single-quoted define() constant', async () => {
    const src = `<?php\ndefine('APP_NAME', 'MyApp');\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('APP_NAME');
    expect(syms[0]!.kind).toBe('const');
  });

  it('extracts a double-quoted define() constant', async () => {
    const src = `<?php\ndefine("DB_HOST", "localhost");\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('DB_HOST');
    expect(syms[0]!.kind).toBe('const');
  });

  it('extracts a define() with a numeric value', async () => {
    const src = `<?php\ndefine('MAX_SIZE', 1048576);\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.name).toBe('MAX_SIZE');
    expect(syms[0]!.kind).toBe('const');
  });

  it('includes define() signature in the symbol record', async () => {
    const src = `<?php\ndefine('TIMEOUT', 30);\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.signature).toContain('define');
    expect(syms[0]!.signature).toContain('TIMEOUT');
  });

  it('qualifies define() constant with namespace (unbraced)', async () => {
    const src = `<?php\nnamespace App\\Config;\ndefine('VERSION', '2.0');\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Config\\VERSION');
  });

  it('qualifies define() constant with namespace (braced)', async () => {
    const src = `<?php\nnamespace App\\Config {\n    define('VERSION', '2.0');\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Config\\VERSION');
  });

  it('extracts PHPDoc summary from a define() constant', async () => {
    const src = `<?php\n/** The application version. */\ndefine('APP_VERSION', '1.0.0');\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.summary).toContain('The application version');
  });

  it('extracts multiple define() constants', async () => {
    const src = `<?php\ndefine('FOO', 1);\ndefine('BAR', 2);\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('FOO');
    expect(names).toContain('BAR');
  });

  it('does not extract define() call with non-identifier constant name', async () => {
    // e.g. dynamic name — not a static symbol
    const src = `<?php\n$n = 'X';\ndefine($n, 1);\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const constSyms = syms.filter((s) => s.kind === 'const');
    expect(constSyms).toHaveLength(0);
  });

  it('coexists with const declarations', async () => {
    const src = `<?php\nconst MY_CONST = 42;\ndefine('MY_DEFINE', 99);\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('MY_CONST');
    expect(names).toContain('MY_DEFINE');
  });

  it('generates a deterministic 16-char hex id for a define() constant', async () => {
    const src = `<?php\ndefine('API_KEY', 'secret');\n`;
    const { tree, buf } = await parse(src);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym2.id).toBe(sym.id);
  });
});

// ─── UTF-8 multibyte safety ───────────────────────────────────────────────────

describe('PHP handler — UTF-8 multibyte safety', () => {
  it('extracts correct method name after multibyte chars in a comment', async () => {
    // The docblock contains a 3-byte UTF-8 emoji before the class. Without the
    // nodeText() fix, the byte/char offset mismatch shifts name reads and
    // produces garbled names like "rvice" instead of "Service".
    const src = `<?php
/** Héllo wörld — ñoño. */
class UserService {
    public function getUser(): void {}
    public function saveUser(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('UserService::getUser');
    expect(names).toContain('UserService::saveUser');
  });

  it('extracts correct method name after multibyte string literal in the file', async () => {
    // Multibyte characters in a string literal that precedes the class
    const src = `<?php
$greeting = "Héllo wörld — ñoño";
class OrderService {
    public function placeOrder(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('OrderService');
    expect(names).toContain('OrderService::placeOrder');
  });

  it('extracts correct function name after multibyte chars in namespace', async () => {
    const src = `<?php
namespace Héllo\\Wörld;
function processOrder(): void {}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]?.name).toMatch(/processOrder$/);
  });

  it('extracts correct import specifier after multibyte chars', async () => {
    const src = `<?php
$x = "Héllo wörld";
use App\\Models\\UserService;`;
    const { tree, buf } = await parse(src);
    const imports = phpHandler.extractImports(tree, buf);
    expect(imports[0]?.specifier).toBe('App\\Models\\UserService');
    expect(imports[0]?.importedNames).toContain('UserService');
  });
});

// ─── Closures ─────────────────────────────────────────────────────────────────

describe('PHP handler — closures', () => {
  it('extracts an anonymous function assigned to a variable', async () => {
    const src = `<?php\n$greet = function(string $name): string { return "Hello $name"; };\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('greet');
  });

  it('closure kind is function', async () => {
    const src = `<?php\n$greet = function(string $name): string { return "Hello"; };\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.kind).toBe('function');
  });

  it('closure signature includes variable name and params but not body', async () => {
    const src = `<?php\n$handler = function(string $event, array $data = []): bool {\n    return true;\n};\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const sym = syms[0]!;
    expect(sym.signature).toContain('$handler');
    expect(sym.signature).toContain('$event');
    expect(sym.signature).not.toContain('return true');
  });

  it('extracts an arrow function assigned to a variable', async () => {
    const src = `<?php\n$double = fn(int $n): int => $n * 2;\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('double');
  });

  it('arrow function kind is function', async () => {
    const src = `<?php\n$triple = fn($x) => $x * 3;\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.kind).toBe('function');
  });

  it('arrow function signature includes variable name', async () => {
    const src = `<?php\n$square = fn(int $x): int => $x ** 2;\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.signature).toContain('$square');
  });

  it('qualifies closure name with namespace', async () => {
    const src = `<?php\nnamespace App\\Utils;\n$format = function(string $s): string { return strtolower($s); };\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms.map((s) => s.name)).toContain('App\\Utils\\format');
  });

  it('extracts PHPDoc summary from a closure', async () => {
    const src = `<?php\n/** Trims whitespace from a string. */\n$trim = function(string $s): string { return trim($s); };\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.summary).toContain('Trims whitespace');
  });

  it('populates bodySnippet for an anonymous function closure', async () => {
    const src = `<?php\n$getUser = function(int $id): ?object {\n    $row = $this->db->query($id);\n    return $row;\n};\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    expect(syms[0]!.bodySnippet).toBeDefined();
    expect(syms[0]!.bodySnippet).toContain('db');
  });

  it('arrow function has no compound_statement bodySnippet', async () => {
    const src = `<?php\n$double = fn(int $n): int => $n * 2;\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    // Arrow functions have an expression body — no compound_statement
    expect(syms[0]!.bodySnippet ?? '').toBe('');
  });

  it('extracts multiple closures', async () => {
    const src = `<?php\n$add = function(int $a, int $b): int { return $a + $b; };\n$sub = fn(int $a, int $b): int => $a - $b;\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('add');
    expect(names).toContain('sub');
  });

  it('coexists with top-level functions and classes', async () => {
    const src = `<?php\nfunction regularFn(): void {}\n$myClosure = function(): void {};\nclass Foo {}\n`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/a.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('regularFn');
    expect(names).toContain('myClosure');
    expect(names).toContain('Foo');
  });

  it('generates a deterministic 16-char hex id for a closure', async () => {
    const src = `<?php\n$handler = function(string $event): void {};\n`;
    const { tree, buf } = await parse(src);
    const sym = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = phpHandler.extractSymbols(tree, buf, 'src/a.php')[0]!;
    expect(sym2.id).toBe(sym.id);
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

// ─── PHP 8 attribute syntax (#[...]) ─────────────────────────────────────────

describe('PHP 8 attribute syntax', () => {
  it('extracts class and methods when PHP 8 route attributes are present', async () => {
    const src = `<?php
namespace App\\Controller;

class HomeController
{
    #[Route('/home', name: 'homepage')]
    public function index(): Response
    {
        return $this->render('home/index.html.twig');
    }

    #[Route('/about', name: 'about', methods: ['GET'])]
    public function about(): Response
    {
        return $this->render('home/about.html.twig');
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/HomeController.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controller\\HomeController');
    expect(names).toContain('App\\Controller\\HomeController::index');
    expect(names).toContain('App\\Controller\\HomeController::about');
  });

  it('does not produce spurious symbols from inside attribute bodies', async () => {
    const src = `<?php
namespace App\\Controller;

class PageController
{
    #[Route('/page/{id}', name: 'page_show', requirements: ['id' => '\\d+'])]
    public function show(int $id): Response
    {
        return $this->render('page/show.html.twig');
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/PageController.php');
    // Only the class and the one method; no symbols from inside #[Route(...)]
    expect(syms.length).toBe(2);
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controller\\PageController');
    expect(names).toContain('App\\Controller\\PageController::show');
  });

  it('produces clean signatures that omit the attribute line', async () => {
    const src = `<?php
namespace App\\Controller;

class ArticleController
{
    #[Route('/articles', name: 'article_list', methods: ['GET'])]
    public function list(): Response
    {
        return $this->json([]);
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/ArticleController.php');
    const method = syms.find((s) => s.name === 'App\\Controller\\ArticleController::list');
    expect(method).toBeDefined();
    // Signature should NOT include the #[Route(...)] attribute text
    expect(method!.signature).not.toContain('#[');
    expect(method!.signature).not.toContain('Route(');
    expect(method!.signature).toContain('public function list');
  });

  it('handles multiple attributes stacked on a single method', async () => {
    const src = `<?php
namespace App\\Controller;

class ApiController
{
    #[Route('/api/users', methods: ['GET'])]
    #[IsGranted('ROLE_USER')]
    public function getUsers(): JsonResponse
    {
        return $this->json([]);
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/ApiController.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controller\\ApiController::getUsers');
    const method = syms.find((s) => s.name === 'App\\Controller\\ApiController::getUsers');
    expect(method!.signature).not.toContain('#[');
    expect(method!.signature).toContain('public function getUsers');
  });

  it('handles PHP 8 constructor property promotion', async () => {
    const src = `<?php
namespace App\\Service;

class UserService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LoggerInterface $logger
    ) {}

    public function createUser(string $email): User
    {
        $user = new User($email);
        $this->em->persist($user);
        return $user;
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Service/UserService.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Service\\UserService');
    expect(names).toContain('App\\Service\\UserService::__construct');
    expect(names).toContain('App\\Service\\UserService::createUser');
  });

  it('handles PHP 8 union type hints in method signatures', async () => {
    const src = `<?php
namespace App\\Service;

class DataProcessor
{
    public function handle(int|string $id, array|null $options = null): Response|JsonResponse
    {
        return new Response();
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Service/DataProcessor.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Service\\DataProcessor::handle');
    const method = syms.find((s) => s.name === 'App\\Service\\DataProcessor::handle');
    expect(method!.signature).toContain('handle');
  });

  it('handles PHP 8 named arguments in attributes without crashing', async () => {
    const src = `<?php
namespace App\\EventListener;

class KernelRequestListener
{
    #[AsEventListener(event: KernelEvents::REQUEST, priority: 10)]
    public function onKernelRequest(RequestEvent $event): void
    {
        if (!$event->isMainRequest()) return;
    }

    #[AsEventListener(event: KernelEvents::RESPONSE)]
    public function onKernelResponse(ResponseEvent $event): void
    {
        // handle response
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/EventListener/KernelRequestListener.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\EventListener\\KernelRequestListener');
    expect(names).toContain('App\\EventListener\\KernelRequestListener::onKernelRequest');
    expect(names).toContain('App\\EventListener\\KernelRequestListener::onKernelResponse');
  });

  it('handles PHP 8.1 readonly properties gracefully (not extracted as symbols)', async () => {
    const src = `<?php
namespace App\\Entity;

class Product
{
    public readonly string $name;
    public readonly float $price;

    public function __construct(string $name, float $price)
    {
        $this->name = $name;
        $this->price = $price;
    }

    public function getDisplayName(): string
    {
        return $this->name;
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Entity/Product.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Entity\\Product');
    // Constructor and getter extracted
    expect(names).toContain('App\\Entity\\Product::__construct');
    expect(names).toContain('App\\Entity\\Product::getDisplayName');
  });

  it('handles Symfony #[Route] on controller with namespace correctly', async () => {
    const src = `<?php
namespace App\\Controller;

use Symfony\\Bundle\\FrameworkBundle\\Controller\\AbstractController;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\Routing\\Attribute\\Route;

class SecurityController extends AbstractController
{
    #[Route('/login', name: 'app_login')]
    public function login(): Response
    {
        return $this->render('security/login.html.twig');
    }

    #[Route('/logout', name: 'app_logout', methods: ['POST'])]
    public function logout(): void {}
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/SecurityController.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controller\\SecurityController');
    expect(names).toContain('App\\Controller\\SecurityController::login');
    expect(names).toContain('App\\Controller\\SecurityController::logout');
    // Signatures should be clean (no attribute noise)
    const loginMethod = syms.find((s) => s.name.endsWith('::login'));
    expect(loginMethod!.signature).not.toContain('#[');
  });

  it('extracts abstract methods with PHP 8 attributes', async () => {
    const src = `<?php
namespace App\\Controller;

abstract class BaseController
{
    #[Required]
    abstract public function configure(): void;

    public function render(string $template): Response
    {
        return new Response();
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Controller/BaseController.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Controller\\BaseController');
    expect(names).toContain('App\\Controller\\BaseController::configure');
    expect(names).toContain('App\\Controller\\BaseController::render');
  });

  it('handles PHP 8 enum with backed type and attributes', async () => {
    const src = `<?php
namespace App\\Enum;

enum Status: string
{
    #[Label('Active')]
    case Active = 'active';

    #[Label('Inactive')]
    case Inactive = 'inactive';
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Enum/Status.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Enum\\Status');
    // Enum cases should still be extracted even with attributes on them
    expect(names.some((n) => n.includes('Status::'))).toBe(true);
  });

  it('class with PHP 8 attributes on the class itself extracts correctly', async () => {
    const src = `<?php
namespace App\\Entity;

#[ORM\\Entity(repositoryClass: UserRepository::class)]
#[ORM\\Table(name: 'users')]
class User
{
    public function getId(): int { return $this->id; }
    public function getEmail(): string { return $this->email; }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Entity/User.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Entity\\User');
    expect(names).toContain('App\\Entity\\User::getId');
    expect(names).toContain('App\\Entity\\User::getEmail');
    const cls = syms.find((s) => s.name === 'App\\Entity\\User');
    // Class signature should not include #[ORM\...] attribute text
    expect(cls!.signature).not.toContain('#[');
    expect(cls!.signature).toContain('class User');
  });

  it('handles PHP 8 intersection types in method parameters', async () => {
    const src = `<?php
namespace App\\Service;

class ValidatorService
{
    public function validate(Countable&Traversable $collection): bool
    {
        return count($collection) > 0;
    }
}`;
    const { tree, buf } = await parse(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'src/Service/ValidatorService.php');
    const names = syms.map((s) => s.name);
    expect(names).toContain('App\\Service\\ValidatorService::validate');
  });
});
