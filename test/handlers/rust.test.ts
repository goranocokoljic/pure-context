import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rustHandler } from '../../src/handlers/rust.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rustHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Rust handler — extractSymbols', () => {
  it('extracts a pub fn as function', async () => {
    const src = `pub fn authenticate(username: &str, password: &str) -> bool {\n    true\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/lib.rs');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('authenticate');
    expect(syms[0].kind).toBe('function');
    expect(syms[0].filePath).toBe('src/lib.rs');
    expect(syms[0].startByte).toBeGreaterThanOrEqual(0);
    expect(syms[0].endByte).toBeGreaterThan(syms[0].startByte);
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `pub fn foo() {}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    // Same call produces same ID
    const sym2 = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym2.id).toBe(sym.id);
  });

  it('does NOT extract private functions', async () => {
    const src = `pub fn exported() {}\nfn private() {}\n`;
    const { tree, buf } = await parse(src);
    const names = rustHandler.extractSymbols(tree, buf, 'src/a.rs').map((s) => s.name);
    expect(names).toContain('exported');
    expect(names).not.toContain('private');
  });

  it('extracts pub struct as kind=class', async () => {
    const src = `pub struct User {\n    pub name: String,\n    age: u32,\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.name).toBe('User');
    expect(sym.kind).toBe('class');
  });

  it('does NOT extract private struct', async () => {
    const src = `struct Internal {\n    secret: String,\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms).toHaveLength(0);
  });

  it('extracts pub enum as kind=enum', async () => {
    const src = `pub enum Role {\n    Admin,\n    User,\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.name).toBe('Role');
    expect(sym.kind).toBe('enum');
  });

  it('extracts pub trait as kind=interface', async () => {
    const src = `pub trait Validator {\n    fn validate(&self) -> bool;\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.name).toBe('Validator');
    expect(sym.kind).toBe('interface');
  });

  it('extracts pub const as kind=const', async () => {
    const src = `pub const MAX_RETRIES: u32 = 3;\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.name).toBe('MAX_RETRIES');
    expect(sym.kind).toBe('const');
  });

  it('extracts pub type alias as kind=type', async () => {
    const src = `use std::collections::HashMap;\npub type Config = HashMap<String, String>;\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const typeSym = syms.find((s) => s.kind === 'type');
    expect(typeSym).toBeDefined();
    expect(typeSym!.name).toBe('Config');
  });

  it('extracts impl methods with TypeName.method_name format', async () => {
    const src = `pub struct AuthService {}\nimpl AuthService {\n    pub fn new() -> Self { AuthService {} }\n    pub fn login(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const methods = syms.filter((s) => s.kind === 'method');
    const names = methods.map((s) => s.name);
    expect(names).toContain('AuthService.new');
    expect(names).toContain('AuthService.login');
  });

  it('extracts impl methods even without pub on method (impl block exception)', async () => {
    const src = `pub struct MyType {}\nimpl MyType {\n    fn internal_method(&self) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const methods = syms.filter((s) => s.kind === 'method');
    expect(methods.some((m) => m.name === 'MyType.internal_method')).toBe(true);
  });

  it('extracts trait impl methods with TypeName.method_name', async () => {
    const src = `pub trait Validator { fn validate(&self) -> bool; }\npub struct User {}\nimpl Validator for User {\n    fn validate(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const implMethods = syms.filter((s) => s.kind === 'method');
    expect(implMethods.some((m) => m.name === 'User.validate')).toBe(true);
  });

  it('builds signature capped at 120 chars', async () => {
    const src = `pub fn very_long_function_name(param_one: &str, param_two: &str, param_three: u64, param_four: bool) -> Result<String, Box<dyn std::error::Error>> {\n    Ok(String::new())\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.signature.length).toBeLessThanOrEqual(120);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('Rust handler — extractDocstring', () => {
  it('captures /// doc comment', async () => {
    const src = `/// Authenticate a user with credentials.\npub fn authenticate(username: &str) -> bool {\n    true\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms[0].summary).toBe('Authenticate a user with credentials.');
  });

  it('captures multi-line /// doc comment', async () => {
    const src = `/// First line.\n/// Second line.\npub fn foo() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms[0].summary).toContain('First line');
  });

  it('returns empty string when no doc comment', async () => {
    const src = `pub fn no_doc() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms[0].summary).toBe('');
  });

  it('ignores regular // comments (non-doc)', async () => {
    const src = `// not a doc comment\npub fn foo() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms[0].summary).toBe('');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Rust handler — extractImports', () => {
  it('extracts use_declaration', async () => {
    const src = `use std::collections::HashMap;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toContain('HashMap');
    expect(imports[0].resolvedPath).toBeNull();
  });

  it('extracts use with multiple names (use_list)', async () => {
    const src = `use std::collections::{HashMap, BTreeMap};\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(1);
    const names = imports.flatMap((i) => i.importedNames);
    expect(names).toContain('HashMap');
    expect(names).toContain('BTreeMap');
  });

  it('extracts extern_crate_declaration', async () => {
    const src = `extern crate serde;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('serde');
    expect(imports[0].resolvedPath).toBeNull();
  });
});

// ─── Fixture-based test ───────────────────────────────────────────────────────

describe('Rust handler — fixture files', () => {
  it('indexes rust-project/src/lib.rs correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/rust-project/src/lib.rs'));
    const tree = await parseFile(src, rustHandler);
    const syms = rustHandler.extractSymbols(tree, src, 'src/lib.rs');

    const names = syms.map((s) => s.name);
    // Public symbols should be present
    expect(names).toContain('User');
    expect(names).toContain('Role');
    expect(names).toContain('Validator');
    expect(names).toContain('Config');
    expect(names).toContain('MAX_RETRIES');
    expect(names).toContain('authenticate');
    // Impl methods
    expect(names).toContain('User.new');
    expect(names).toContain('User.email');
    // Private function should NOT be present
    expect(names).not.toContain('private_helper');
  });

  it('indexes rust-project/src/auth.rs correctly', async () => {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, '../fixtures/rust-project/src/auth.rs'));
    const tree = await parseFile(src, rustHandler);
    const syms = rustHandler.extractSymbols(tree, src, 'src/auth.rs');

    const names = syms.map((s) => s.name);
    expect(names).toContain('AuthService');
    expect(names).toContain('AuthService.new');
    expect(names).toContain('AuthService.start_session');
    expect(names).toContain('AuthService.is_active');
    expect(names).toContain('AuthService.end_session');
  });
});
