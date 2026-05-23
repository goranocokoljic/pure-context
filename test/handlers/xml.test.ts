import { describe, it, expect } from 'vitest';
import { xmlHandler } from '../../src/handlers/xml.js';
import type { Tree } from '../../src/core/types.js';

// XML handler is regex-based (grammarPath returns null) — no tree-sitter needed.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('XML handler — extractSymbols', () => {

  // ── root element → 'class' ────────────────────────────────────────────────

  it('extracts root element as kind "class"', () => {
    const { tree, buf } = parse(`<?xml version="1.0"?>\n<configuration>\n</configuration>\n`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'config.xml');
    const sym = syms.find((s) => s.name === 'configuration');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('<configuration>');
  });

  it('extracts root element without XML declaration', () => {
    const { tree, buf } = parse(`<project>\n  <name>MyApp</name>\n</project>\n`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'pom.xml');
    const sym = syms.find((s) => s.name === 'project');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  it('skips DOCTYPE and XML declarations before finding root element', () => {
    const { tree, buf } = parse(
      `<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "dtd.dtd">\n<html>\n</html>\n`,
    );
    const syms = xmlHandler.extractSymbols(tree, buf, 'page.xml');
    const sym = syms.find((s) => s.name === 'html');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  // ── id-attributed elements → 'const' ─────────────────────────────────────

  it('extracts element with id attribute as kind "const"', () => {
    const { tree, buf } = parse(`
<root>
  <div id="header">Header</div>
  <div id="footer">Footer</div>
</root>
`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'layout.xml');
    const header = syms.find((s) => s.name === 'header');
    const footer = syms.find((s) => s.name === 'footer');
    expect(header).toBeDefined();
    expect(header!.kind).toBe('const');
    expect(header!.signature).toContain('id="header"');
    expect(footer).toBeDefined();
    expect(footer!.kind).toBe('const');
  });

  it('extracts id with single-quoted attribute', () => {
    const { tree, buf } = parse(`<root>\n  <span id='main-content'>text</span>\n</root>\n`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'page.xml');
    const sym = syms.find((s) => s.name === 'main-content');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  it('deduplicates elements with the same id', () => {
    const { tree, buf } = parse(`
<root>
  <div id="item">First</div>
  <div id="item">Second</div>
</root>
`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'dup.xml');
    const items = syms.filter((s) => s.name === 'item');
    expect(items).toHaveLength(1);
  });

  // ── XUL elements ──────────────────────────────────────────────────────────

  it('extracts XUL command element by id', () => {
    const { tree, buf } = parse(`
<overlay>
  <command id="cmd_save" oncommand="save()"/>
  <menuitem id="menu_save" label="Save" command="cmd_save"/>
</overlay>
`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'overlay.xul');
    const cmd = syms.find((s) => s.name === 'cmd_save');
    const menu = syms.find((s) => s.name === 'menu_save');
    expect(cmd).toBeDefined();
    expect(menu).toBeDefined();
  });

  // ── XML comment as summary ────────────────────────────────────────────────

  it('uses preceding XML comment as root element summary', () => {
    const { tree, buf } = parse(`<!-- Application configuration file -->\n<config>\n</config>\n`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'config.xml');
    const sym = syms.find((s) => s.name === 'config');
    expect(sym!.summary).toContain('Application configuration');
  });

  it('uses preceding XML comment as id element summary', () => {
    const { tree, buf } = parse(`
<root>
  <!-- Page header section -->
  <div id="header">Header</div>
</root>
`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'page.xml');
    const sym = syms.find((s) => s.name === 'header');
    expect(sym!.summary).toContain('Page header section');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets startByte for root element', () => {
    const { tree, buf } = parse(`<?xml version="1.0"?>\n<root/>\n`);
    const sym = xmlHandler.extractSymbols(tree, buf, 'test.xml').find((s) => s.name === 'root')!;
    expect(sym.startByte).toBeGreaterThanOrEqual(0);
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`<root/>\n`);
    const sym = xmlHandler.extractSymbols(tree, buf, 'test.xml').find((s) => s.name === 'root')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = xmlHandler.extractSymbols(tree, buf, 'test.xml').find((s) => s.name === 'root')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── empty/minimal files ───────────────────────────────────────────────────

  it('returns empty array for empty input', () => {
    const { tree, buf } = parse('');
    expect(xmlHandler.extractSymbols(tree, buf, 'empty.xml')).toHaveLength(0);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('XML handler — extractImports', () => {

  it('extracts script src as ImportRecord', () => {
    const { tree, buf } = parse(`<html>\n  <script src="app.js"></script>\n</html>\n`);
    const imports = xmlHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('app.js');
    expect(imports[0]!.resolvedPath).toBe('app.js');
  });

  it('marks external script src as resolvedPath null', () => {
    const { tree, buf } = parse(
      `<html>\n  <script src="https://cdn.example.com/lib.js"></script>\n</html>\n`,
    );
    const imports = xmlHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts xml-stylesheet href as ImportRecord', () => {
    const { tree, buf } = parse(
      `<?xml version="1.0"?>\n<?xml-stylesheet type="text/css" href="style.css"?>\n<root/>\n`,
    );
    const imports = xmlHandler.extractImports(tree, buf);
    const sheet = imports.find((i) => i.specifier === 'style.css');
    expect(sheet).toBeDefined();
    expect(sheet!.resolvedPath).toBe('style.css');
  });

  it('deduplicates repeated script src', () => {
    const { tree, buf } = parse(
      `<html>\n  <script src="app.js"></script>\n  <script src="app.js"></script>\n</html>\n`,
    );
    const imports = xmlHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for files with no imports', () => {
    const { tree, buf } = parse(`<root>\n  <item id="x"/>\n</root>\n`);
    expect(xmlHandler.extractImports(tree, buf)).toHaveLength(0);
  });

  it('extracts multiple script srcs', () => {
    const { tree, buf } = parse(`
<html>
  <script src="vendor.js"></script>
  <script src="app.js"></script>
</html>
`);
    const imports = xmlHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('vendor.js');
    expect(specs).toContain('app.js');
  });
});

// ─── XML symbol disambiguation ────────────────────────────────────────────────

describe('XML handler — symbol disambiguation', () => {

  it('appends parent dir name when file-stem is generic (pom)', () => {
    const { tree, buf } = parse(`<project>\n  <name>Core</name>\n</project>\n`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'maven-core/pom.xml');
    const sym = syms.find((s) => s.kind === 'class');
    expect(sym).toBeDefined();
    expect(sym!.name).toBe('project@maven-core');
    // Bare tag name preserved in bodySnippet for FTS fallback
    expect(sym!.bodySnippet).toBe('project');
  });

  it('two pom.xml files in different modules get distinct names', () => {
    const { tree: t1, buf: b1 } = parse(`<project></project>`);
    const { tree: t2, buf: b2 } = parse(`<project></project>`);
    const syms1 = xmlHandler.extractSymbols(t1, b1, 'maven-core/pom.xml');
    const syms2 = xmlHandler.extractSymbols(t2, b2, 'maven-plugin-api/pom.xml');
    expect(syms1[0]!.name).toBe('project@maven-core');
    expect(syms2[0]!.name).toBe('project@maven-plugin-api');
    expect(syms1[0]!.id).not.toBe(syms2[0]!.id);
  });

  it('root-level pom.xml (no parent dir) stays bare — unique at root', () => {
    const { tree, buf } = parse(`<project></project>`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'pom.xml');
    // Only one path segment → never disambiguated
    expect(syms[0]!.name).toBe('project');
  });

  it('uses file-stem as disambiguator when stem is non-generic and file is in subdir', () => {
    const { tree, buf } = parse(`<project></project>`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'some-dir/application.xml');
    // stem = 'application', tag = 'project' → project@application
    expect(syms[0]!.name).toBe('project@application');
  });

  it('no disambiguation when file-stem matches tag name', () => {
    const { tree, buf } = parse(`<project></project>`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'some-dir/project.xml');
    // stem == tagName → no disambiguation
    expect(syms[0]!.name).toBe('project');
  });

  it('generic stem (config) in subdir uses parent dir name', () => {
    const { tree, buf } = parse(`<beans></beans>`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'src/config.xml');
    // stem = 'config' (generic) → use parent dir 'src'
    expect(syms[0]!.name).toBe('beans@src');
  });

  it('no bodySnippet when name is not disambiguated', () => {
    const { tree, buf } = parse(`<beans></beans>`);
    const syms = xmlHandler.extractSymbols(tree, buf, 'src/beans.xml');
    // stem = 'beans', matches tag → no disambiguation, no bodySnippet
    expect(syms[0]!.name).toBe('beans');
    expect(syms[0]!.bodySnippet).toBeUndefined();
  });
});
