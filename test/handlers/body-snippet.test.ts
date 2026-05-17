/**
 * Task 203 — Body snippet population in language handlers.
 *
 * Verifies that `bodySnippet` is populated by the TypeScript and PHP handlers
 * for function/method symbols so that FTS5 can match body-level tokens.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { typescriptHandler } from '../../src/handlers/typescript.js';
import { phpHandler } from '../../src/handlers/php.js';

async function parseTs(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, typescriptHandler);
  return { tree, buf };
}

async function parsePhp(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, phpHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── TypeScript ───────────────────────────────────────────────────────────────

describe('TypeScript handler — bodySnippet', () => {
  it('populates bodySnippet on a function declaration', async () => {
    const src = `
export function fetchUser(id: string) {
  const result = db.query('SELECT * FROM users WHERE id = ?', [id]);
  return result.row();
}
`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fn = syms.find((s) => s.name === 'fetchUser');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet).toBeDefined();
    expect(fn!.bodySnippet).toContain('db');
    expect(fn!.bodySnippet).toContain('query');
  });

  it('populates bodySnippet on a class method', async () => {
    const src = `
export class UserService {
  authenticate(username: string, password: string): boolean {
    const hash = bcrypt.hash(password);
    return this.db.verify(username, hash);
  }
}
`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const method = syms.find((s) => s.name === 'UserService.authenticate');
    expect(method).toBeDefined();
    expect(method!.bodySnippet).toBeDefined();
    expect(method!.bodySnippet).toContain('bcrypt');
    expect(method!.bodySnippet).toContain('hash');
  });

  it('populates bodySnippet on an arrow function with a block body', async () => {
    const src = `
export const processOrder = (order: Order) => {
  const total = order.items.reduce((sum, item) => sum + item.price, 0);
  return applyDiscount(total);
};
`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fn = syms.find((s) => s.name === 'processOrder');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet).toBeDefined();
    expect(fn!.bodySnippet).toContain('reduce');
  });

  it('does NOT set bodySnippet on an arrow function with an expression body', async () => {
    const src = `export const double = (x: number) => x * 2;`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fn = syms.find((s) => s.name === 'double');
    expect(fn).toBeDefined();
    // Expression body has no statement_block — bodySnippet should be absent or empty
    expect(fn!.bodySnippet ?? '').toBe('');
  });

  it('does NOT set bodySnippet on a type alias', async () => {
    const src = `export type UserId = string;`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const sym = syms.find((s) => s.name === 'UserId');
    expect(sym).toBeDefined();
    expect(sym!.bodySnippet).toBeUndefined();
  });

  it('does NOT set bodySnippet on an interface', async () => {
    const src = `export interface Repository { find(id: string): unknown; }`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const sym = syms.find((s) => s.name === 'Repository');
    expect(sym).toBeDefined();
    expect(sym!.bodySnippet).toBeUndefined();
  });

  it('bodySnippet is at most 200 characters', async () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `const v${i} = computeValue${i}();`).join('\n');
    const src = `export function bigFn() {\n${longBody}\n}`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fn = syms.find((s) => s.name === 'bigFn');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet!.length).toBeLessThanOrEqual(200);
  });

  it('bodySnippet is undefined or empty for an empty function body', async () => {
    const src = `export function noop(): void {}`;
    const { tree, buf } = await parseTs(src);
    const syms = typescriptHandler.extractSymbols(tree, buf, 'src/a.ts');
    const fn = syms.find((s) => s.name === 'noop');
    expect(fn).toBeDefined();
    // Empty body → snippet is empty string or undefined
    expect(fn!.bodySnippet ?? '').toBe('');
  });
});

// ─── PHP ──────────────────────────────────────────────────────────────────────

describe('PHP handler — bodySnippet', () => {
  it('populates bodySnippet on a top-level function', async () => {
    const src = `<?php
function get_row(string $sql, array $params = []): ?object {
    $query = $this->db->query($sql, $params);
    return $query->row();
}
`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/core/Model.php');
    const fn = syms.find((s) => s.name === 'get_row');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet).toBeDefined();
    expect(fn!.bodySnippet).toContain('query');
    expect(fn!.bodySnippet).toContain('row');
  });

  it('populates bodySnippet on a class method', async () => {
    const src = `<?php
class CIR_Model extends CI_Model {
    public function insert_row(string $table, array $data): bool {
        $this->db->insert($table, $data);
        return $this->db->affected_rows() > 0;
    }
}
`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/core/CIR_Model.php');
    const method = syms.find((s) => s.name === 'CIR_Model::insert_row');
    expect(method).toBeDefined();
    expect(method!.bodySnippet).toBeDefined();
    expect(method!.bodySnippet).toContain('insert');
    expect(method!.bodySnippet).toContain('affected_rows');
  });

  it('populates bodySnippet on a method with database query pattern', async () => {
    const src = `<?php
class Model {
    public function get_value(string $sql, array $params = []) {
        $query = $this->db->query($sql, $params);
        $row = $query->row();
        return $row ? $row->value : null;
    }
}
`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/Model.php');
    const method = syms.find((s) => s.name === 'Model::get_value');
    expect(method).toBeDefined();
    expect(method!.bodySnippet).toBeDefined();
    expect(method!.bodySnippet).toContain('query');
  });

  it('does NOT set bodySnippet on a class constant', async () => {
    const src = `<?php
class Config {
    const VERSION = '1.0.0';
}
`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/Config.php');
    const constant = syms.find((s) => s.name === 'Config::VERSION');
    expect(constant).toBeDefined();
    expect(constant!.bodySnippet).toBeUndefined();
  });

  it('bodySnippet is at most 200 characters', async () => {
    const longBody = Array.from({ length: 20 }, (_, i) => `$var${i} = computeValue${i}($var${i});`).join('\n    ');
    const src = `<?php\nfunction big_fn() {\n    ${longBody}\n}\n`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/fn.php');
    const fn = syms.find((s) => s.name === 'big_fn');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet!.length).toBeLessThanOrEqual(200);
  });

  it('bodySnippet is undefined or empty for an empty function body', async () => {
    const src = `<?php\nfunction noop(): void {}\n`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/fn.php');
    const fn = syms.find((s) => s.name === 'noop');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet ?? '').toBe('');
  });

  it('populates bodySnippet on a namespaced function', async () => {
    const src = `<?php
namespace App\\Services;
function render_template(string $path, array $vars = []): string {
    $twig = $this->twig->load($path);
    return $twig->render($vars);
}
`;
    const { tree, buf } = await parsePhp(src);
    const syms = phpHandler.extractSymbols(tree, buf, 'app/services/templates.php');
    const fn = syms.find((s) => s.name === 'App\\Services\\render_template');
    expect(fn).toBeDefined();
    expect(fn!.bodySnippet).toBeDefined();
    expect(fn!.bodySnippet).toContain('twig');
  });
});
