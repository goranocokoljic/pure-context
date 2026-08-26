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

  it('indexes non-pub functions with visibility "module" (Phase 87)', async () => {
    const src = `pub fn exported() {}\nfn private() {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const exported = syms.find((s) => s.name === 'exported');
    const priv = syms.find((s) => s.name === 'private');
    expect(exported).toBeDefined();
    expect(exported!.frameworkMeta?.['visibility']).toBeUndefined();
    expect(priv).toBeDefined();
    expect(priv!.frameworkMeta?.['visibility']).toBe('module');
  });

  it('indexes pub(crate) items with visibility "crate" (Phase 87)', async () => {
    const src = `pub(crate) fn internal_api() {}\npub(super) struct Guard {}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const fn = syms.find((s) => s.name === 'internal_api');
    const st = syms.find((s) => s.name === 'Guard');
    expect(fn!.frameworkMeta?.['visibility']).toBe('crate');
    expect(st!.frameworkMeta?.['visibility']).toBe('crate');
  });

  it('extracts pub struct as kind=class', async () => {
    const src = `pub struct User {\n    pub name: String,\n    age: u32,\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.name).toBe('User');
    expect(sym.kind).toBe('class');
  });

  it('indexes a no-modifier struct with visibility "module" (Phase 87)', async () => {
    const src = `struct Internal {\n    secret: String,\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms).toHaveLength(1);
    expect(syms[0].name).toBe('Internal');
    expect(syms[0].frameworkMeta?.['visibility']).toBe('module');
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

  it('extracts impl methods with bare method name (type context in signature)', async () => {
    const src = `pub struct AuthService {}\nimpl AuthService {\n    pub fn new() -> Self { AuthService {} }\n    pub fn login(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const methods = syms.filter((s) => s.kind === 'method');
    const names = methods.map((s) => s.name);
    // Phase 46: bare method names — search matches on bare name, type in signature
    expect(names).toContain('new');
    expect(names).toContain('login');
    expect(names).not.toContain('AuthService.new');
    expect(names).not.toContain('AuthService.login');
  });

  it('signature includes TypeName:: prefix for impl methods', async () => {
    const src = `pub struct AuthService {}\nimpl AuthService {\n    pub fn login(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const login = syms.find((s) => s.name === 'login' && s.kind === 'method');
    expect(login).toBeDefined();
    expect(login!.signature).toMatch(/^AuthService::/);
    expect(login!.signature).toContain('login');
  });

  it('indexes non-pub impl methods with visibility "module" (Phase 87)', async () => {
    const src = `pub struct MyType {}\nimpl MyType {\n    fn internal_method(&self) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const method = syms.find((s) => s.kind === 'method' && s.name === 'internal_method');
    expect(method).toBeDefined();
    expect(method!.frameworkMeta?.['visibility']).toBe('module');
  });

  it('extracts pub trait impl methods with bare method name', async () => {
    const src = `pub trait Validator { fn validate(&self) -> bool; }\npub struct User {}\nimpl Validator for User {\n    pub fn validate(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const implMethods = syms.filter((s) => s.kind === 'method');
    expect(implMethods.some((m) => m.name === 'validate')).toBe(true);
    expect(implMethods.some((m) => m.name === 'User.validate')).toBe(false);
  });

  it('builds signature capped at 120 chars', async () => {
    const src = `pub fn very_long_function_name(param_one: &str, param_two: &str, param_three: u64, param_four: bool) -> Result<String, Box<dyn std::error::Error>> {\n    Ok(String::new())\n}\n`;
    const { tree, buf } = await parse(src);
    const sym = rustHandler.extractSymbols(tree, buf, 'src/a.rs')[0];
    expect(sym.signature.length).toBeLessThanOrEqual(120);
  });
});

// ─── impl_item visibility filtering ──────────────────────────────────────────

describe('Rust handler — impl_item visibility filtering', () => {
  it('pub fn in impl → extracted with bare name', async () => {
    const src = `pub struct Svc {}\nimpl Svc {\n    pub fn fetch(&self) -> String { String::new() }\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms.some((s) => s.name === 'fetch' && s.kind === 'method')).toBe(true);
    expect(syms.some((s) => s.name === 'Svc.fetch')).toBe(false);
  });

  it('private fn in impl → extracted with visibility "module" (Phase 87)', async () => {
    const src = `pub struct Svc {}\nimpl Svc {\n    fn helper(&self) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    const helper = syms.find((s) => s.name === 'helper');
    expect(helper).toBeDefined();
    expect(helper!.frameworkMeta?.['visibility']).toBe('module');
  });

  it('pub(crate) fn in impl → extracted with bare name (starts with pub)', async () => {
    const src = `pub struct Svc {}\nimpl Svc {\n    pub(crate) fn internal_api(&self) {}\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rustHandler.extractSymbols(tree, buf, 'src/a.rs');
    expect(syms.some((s) => s.name === 'internal_api' && s.kind === 'method')).toBe(true);
    expect(syms.some((s) => s.name === 'Svc.internal_api')).toBe(false);
  });

  it('mix of pub and private in one impl → all extracted, visibility recorded (Phase 87)', async () => {
    const src = [
      'pub struct Cache {}',
      'impl Cache {',
      '    pub fn get(&self, key: &str) -> Option<String> { None }',
      '    fn evict(&self) {}',
      '    pub fn set(&mut self, key: String, val: String) {}',
      '    fn hash_key(&self, key: &str) -> u64 { 0 }',
      '}',
    ].join('\n');
    const { tree, buf } = await parse(src);
    const methods = rustHandler.extractSymbols(tree, buf, 'src/a.rs').filter((s) => s.kind === 'method');
    const names = methods.map((m) => m.name);
    expect(names).toContain('get');
    expect(names).toContain('set');
    expect(names).toContain('evict');
    expect(names).toContain('hash_key');
    expect(methods.find((m) => m.name === 'get')!.frameworkMeta?.['visibility']).toBeUndefined();
    expect(methods.find((m) => m.name === 'evict')!.frameworkMeta?.['visibility']).toBe('module');
    // Qualified names should not appear
    expect(names).not.toContain('Cache.get');
    expect(names).not.toContain('Cache.set');
  });

  it('trait impl (impl Trait for Type) — all methods extracted with bare names', async () => {
    const src = [
      'pub trait Writer { fn write(&self, data: &str); fn flush(&self); }',
      'pub struct FileWriter {}',
      'impl Writer for FileWriter {',
      '    pub fn write(&self, data: &str) {}',
      '    fn flush(&self) {}',
      '}',
    ].join('\n');
    const { tree, buf } = await parse(src);
    const methods = rustHandler.extractSymbols(tree, buf, 'src/a.rs').filter((s) => s.kind === 'method');
    const names = methods.map((m) => m.name);
    expect(names).toContain('write');
    expect(names).toContain('flush');
    expect(names).not.toContain('FileWriter.write');
  });

  it('impl with only private methods → extracted with visibility "module" (Phase 87)', async () => {
    const src = `pub struct Builder {}\nimpl Builder {\n    fn init(&self) {}\n    fn validate(&self) -> bool { true }\n}\n`;
    const { tree, buf } = await parse(src);
    const methods = rustHandler.extractSymbols(tree, buf, 'src/a.rs').filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(2);
    expect(methods.every((m) => m.frameworkMeta?.['visibility'] === 'module')).toBe(true);
  });

  it('bare name uses TypeName from impl, not trait name', async () => {
    const src = [
      'pub trait Serialize { fn serialize(&self) -> String; }',
      'pub struct Config {}',
      'impl Serialize for Config {',
      '    pub fn serialize(&self) -> String { String::new() }',
      '}',
    ].join('\n');
    const { tree, buf } = await parse(src);
    const methods = rustHandler.extractSymbols(tree, buf, 'src/a.rs').filter((s) => s.kind === 'method');
    // Bare name is 'serialize'; signature should have 'Config::' prefix
    expect(methods.some((m) => m.name === 'serialize')).toBe(true);
    const serializeMethod = methods.find((m) => m.name === 'serialize');
    expect(serializeMethod!.signature).toMatch(/^Config::/);
  });

  it('pub fn with return type → signature contains TypeName:: prefix and return type', async () => {
    const src = `pub struct Repo {}\nimpl Repo {\n    pub fn find_by_id(&self, id: u64) -> Option<String> { None }\n}\n`;
    const { tree, buf } = await parse(src);
    const methods = rustHandler.extractSymbols(tree, buf, 'src/a.rs').filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(1);
    expect(methods[0].name).toBe('find_by_id');
    expect(methods[0].signature).toMatch(/^Repo::/);
    expect(methods[0].signature).toContain('find_by_id');
    expect(methods[0].signature).toContain('Option<String>');
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

// ─── extractImports — specifier shapes for the resolver (Phase 87, Task 537) ──

describe('Rust handler — use specifier shapes (Phase 87)', () => {
  it('preserves the leading crate keyword', async () => {
    const src = `use crate::auth::Session;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('crate::auth::Session');
    expect(imports[0].importedNames).toEqual(['Session']);
  });

  it('preserves the leading super / self keywords', async () => {
    const src = `use super::util::helper;\nuse self::inner::Thing;\n`;
    const { tree, buf } = await parse(src);
    const specs = rustHandler.extractImports(tree, buf).map((i) => i.specifier);
    expect(specs).toContain('super::util::helper');
    expect(specs).toContain('self::inner::Thing');
  });

  it('flattens a grouped use into one record per leaf', async () => {
    const src = `use crate::models::{User, Order};\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier).sort()).toEqual([
      'crate::models::Order',
      'crate::models::User',
    ]);
    expect(imports.every((i) => i.importedNames.length === 1)).toBe(true);
  });

  it('flattens nested groups', async () => {
    const src = `use app::{net::{http, tcp}, io};\n`;
    const { tree, buf } = await parse(src);
    const specs = rustHandler.extractImports(tree, buf).map((i) => i.specifier).sort();
    expect(specs).toEqual(['app::io', 'app::net::http', 'app::net::tcp']);
  });

  it('keeps the crate keyword for a grouped use directly under crate', async () => {
    const src = `use crate::{auth, models};\n`;
    const { tree, buf } = await parse(src);
    const specs = rustHandler.extractImports(tree, buf).map((i) => i.specifier).sort();
    expect(specs).toEqual(['crate::auth', 'crate::models']);
  });

  it('handles self inside a group (imports the module itself)', async () => {
    const src = `use crate::net::{self, http};\n`;
    const { tree, buf } = await parse(src);
    const specs = rustHandler.extractImports(tree, buf).map((i) => i.specifier).sort();
    expect(specs).toEqual(['crate::net', 'crate::net::http']);
  });

  it('marks glob imports with importedNames ["*"]', async () => {
    const src = `use crate::prelude::*;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('crate::prelude');
    expect(imports[0].importedNames).toEqual(['*']);
  });

  it('marks a glob inside a group', async () => {
    const src = `use app::{prelude::*, config};\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    const glob = imports.find((i) => i.importedNames.includes('*'));
    expect(glob).toBeDefined();
    expect(glob!.specifier).toBe('app::prelude');
    expect(imports.some((i) => i.specifier === 'app::config')).toBe(true);
  });

  it('renames carry the ORIGINAL path, not the alias', async () => {
    const src = `use crate::io::Reader as FileReader;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0].specifier).toBe('crate::io::Reader');
    expect(imports[0].importedNames).toEqual(['Reader']);
  });

  it('renames inside a group carry the full original path', async () => {
    const src = `use app::io::{Reader as R, Writer};\n`;
    const { tree, buf } = await parse(src);
    const specs = rustHandler.extractImports(tree, buf).map((i) => i.specifier).sort();
    expect(specs).toEqual(['app::io::Reader', 'app::io::Writer']);
  });

  it('bare external use keeps its full path', async () => {
    const src = `use serde::Deserialize;\n`;
    const { tree, buf } = await parse(src);
    const imports = rustHandler.extractImports(tree, buf);
    expect(imports[0].specifier).toBe('serde::Deserialize');
    expect(imports[0].importedNames).toEqual(['Deserialize']);
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
    // Impl methods — bare names (Phase 46)
    expect(names).toContain('new');
    expect(names).toContain('email');
    expect(names).not.toContain('User.new');
    expect(names).not.toContain('User.email');
    // Module-private function IS indexed since Phase 87, with visibility metadata
    const priv = syms.find((s) => s.name === 'private_helper');
    expect(priv).toBeDefined();
    expect(priv!.frameworkMeta?.['visibility']).toBe('module');
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
    // Bare method names — Phase 46
    expect(names).toContain('new');
    expect(names).toContain('start_session');
    expect(names).toContain('is_active');
    expect(names).toContain('end_session');
    expect(names).not.toContain('AuthService.new');
    expect(names).not.toContain('AuthService.start_session');
  });
});
