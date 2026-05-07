import { describe, it, expect } from 'vitest';
import { perlHandler } from '../../src/handlers/perl.js';
import type { Tree } from '../../src/core/types.js';

// Perl handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Perl handler — extractSymbols', () => {

  // ── sub declaration ───────────────────────────────────────────────────────

  it('extracts a sub declaration as kind "function"', async () => {
    const { tree, buf } = await parse(`sub greet {\n  print "hello";\n}\n`);
    const syms = perlHandler.extractSymbols(tree, buf, 'utils.pl');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
    expect(fn!.signature).toContain('sub greet');
  });

  // ── package declaration → class ───────────────────────────────────────────

  it('extracts a package declaration as kind "class"', async () => {
    const { tree, buf } = await parse(`package MyApp::Utils;\n\nsub helper { 1 }\n`);
    const syms = perlHandler.extractSymbols(tree, buf, 'Utils.pm');
    const pkg = syms.find((s) => s.kind === 'class');
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe('MyApp::Utils');
    expect(pkg!.signature).toContain('package MyApp::Utils');
  });

  // ── multiple subs ─────────────────────────────────────────────────────────

  it('extracts multiple subroutines', async () => {
    const { tree, buf } = await parse(`
sub connect { 1 }
sub disconnect { 1 }
sub query { 1 }
`);
    const syms = perlHandler.extractSymbols(tree, buf, 'db.pl');
    const names = syms.map((s) => s.name);
    expect(names).toContain('connect');
    expect(names).toContain('disconnect');
    expect(names).toContain('query');
  });

  // ── POD docstring ─────────────────────────────────────────────────────────

  it('extracts POD documentation as summary', async () => {
    const { tree, buf } = await parse(`
=head2 greet

Greets the user by name.

=cut

sub greet {
  my ($name) = @_;
  print "Hello, $name\\n";
}
`);
    const syms = perlHandler.extractSymbols(tree, buf, 'app.pl');
    const fn = syms.find((s) => s.name === 'greet');
    expect(fn).toBeDefined();
    expect(fn!.summary).toContain('Greet');
  });

  // ── comment summary ───────────────────────────────────────────────────────

  it('uses preceding # comment as summary when no POD', async () => {
    const { tree, buf } = await parse(
      `# Connects to the database.\nsub connect {\n  1;\n}\n`,
    );
    const syms = perlHandler.extractSymbols(tree, buf, 'db.pl');
    const fn = syms.find((s) => s.name === 'connect');
    expect(fn!.summary).toContain('Connects');
  });

  // ── file-scope uppercase my variable → const ─────────────────────────────

  it('extracts uppercase file-scope my variable as const', async () => {
    const { tree, buf } = await parse(`my $MAX_RETRIES = 5;\n`);
    const syms = perlHandler.extractSymbols(tree, buf, 'config.pl');
    const sym = syms.find((s) => s.name === '$MAX_RETRIES');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  it('does not extract lowercase my variable', async () => {
    const { tree, buf } = await parse(`my $count = 0;\n`);
    const syms = perlHandler.extractSymbols(tree, buf, 'app.pl');
    expect(syms.filter((s) => s.name === '$count')).toHaveLength(0);
  });

  // ── deterministic ID ─────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', async () => {
    const { tree, buf } = await parse(`sub foo { 1 }\n`);
    const sym = perlHandler.extractSymbols(tree, buf, 'test.pl')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = perlHandler.extractSymbols(tree, buf, 'test.pl')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── full module ───────────────────────────────────────────────────────────

  it('extracts package + subs from a full module', async () => {
    const { tree, buf } = await parse(`
package Animal;

sub new {
  my ($class, %args) = @_;
  return bless \\%args, $class;
}

sub speak {
  print "...\\n";
}
`);
    const syms = perlHandler.extractSymbols(tree, buf, 'Animal.pm');
    expect(syms.find((s) => s.kind === 'class')?.name).toBe('Animal');
    expect(syms.find((s) => s.name === 'new')?.kind).toBe('function');
    expect(syms.find((s) => s.name === 'speak')?.kind).toBe('function');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Perl handler — extractImports', () => {

  it('extracts use Module as import', async () => {
    const { tree, buf } = await parse(`use Scalar::Util qw(blessed reftype);\n`);
    const imports = perlHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('Scalar::Util');
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('extracts multiple use statements', async () => {
    const { tree, buf } = await parse(`use strict;\nuse warnings;\nuse Carp;\n`);
    const imports = perlHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('strict');
    expect(specs).toContain('warnings');
    expect(specs).toContain('Carp');
  });

  it('extracts require file as local import', async () => {
    const { tree, buf } = await parse(`require './lib/utils.pl';\n`);
    const imports = perlHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./lib/utils.pl');
    expect(imports[0]!.resolvedPath).toBe('./lib/utils.pl');
  });

  it('marks external use module as non-local (resolvedPath null)', async () => {
    const { tree, buf } = await parse(`use POSIX qw(floor ceil);\n`);
    const imports = perlHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.resolvedPath).toBeNull();
  });
});
