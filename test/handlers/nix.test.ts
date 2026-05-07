import { describe, it, expect } from 'vitest';
import { nixHandler } from '../../src/handlers/nix.js';
import type { Tree } from '../../src/core/types.js';

// Nix handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Nix handler — extractSymbols', () => {

  // ── top-level const binding ───────────────────────────────────────────────

  it('extracts top-level attribute binding as kind "const"', async () => {
    const { tree, buf } = parse(`{
  description = "My NixOS configuration";
  version = "1.0";
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'default.nix');
    const desc = syms.find((s) => s.name === 'description');
    expect(desc).toBeDefined();
    expect(desc!.kind).toBe('const');
  });

  // ── function binding (attrset pattern) ───────────────────────────────────

  it('extracts attrset-pattern lambda as kind "function"', async () => {
    const { tree, buf } = parse(`{
  outputs = { self, nixpkgs }: {
    packages.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.hello;
  };
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'flake.nix');
    const fn = syms.find((s) => s.name === 'outputs');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  // ── function binding (simple lambda) ─────────────────────────────────────

  it('extracts simple arg-lambda as kind "function"', async () => {
    const { tree, buf } = parse(
      '{\n  mkUser = name: { home = "/home/"; };\n}\n',
    );
    const syms = nixHandler.extractSymbols(tree, buf, 'lib.nix');
    const fn = syms.find((s) => s.name === 'mkUser');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  // ── stdenv.mkDerivation → class ──────────────────────────────────────────

  it('extracts stdenv.mkDerivation as kind "class" using name attribute', async () => {
    const { tree, buf } = parse(`
{ pkgs ? import <nixpkgs> {} }:

pkgs.stdenv.mkDerivation {
  name = "my-app";
  src = ./.;
  buildInputs = [ pkgs.gcc ];
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'default.nix');
    const drv = syms.find((s) => s.kind === 'class');
    expect(drv).toBeDefined();
    expect(drv!.name).toBe('my-app');
  });

  // ── pname attribute for derivation ───────────────────────────────────────

  it('uses pname attribute for derivation name when present', async () => {
    const { tree, buf } = parse(`
{ pkgs }:

pkgs.buildRustPackage {
  pname = "my-rust-app";
  version = "0.1.0";
  src = ./.;
  cargoHash = "";
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'package.nix');
    const drv = syms.find((s) => s.kind === 'class');
    expect(drv).toBeDefined();
    expect(drv!.name).toBe('my-rust-app');
  });

  // ── preceding comment as summary ─────────────────────────────────────────

  it('uses preceding # comment as summary', async () => {
    const { tree, buf } = parse(`{
  # The list of extra packages to include.
  extraPackages = [];
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'config.nix');
    const sym = syms.find((s) => s.name === 'extraPackages');
    expect(sym).toBeDefined();
    expect(sym!.summary).toContain('extra packages');
  });

  // ── flake.nix top-level bindings ─────────────────────────────────────────

  it('extracts flake.nix top-level bindings', async () => {
    const { tree, buf } = parse(`{
  description = "My project flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-23.05";
  };

  outputs = { self, nixpkgs }: {
    packages.default = nixpkgs.legacyPackages.x86_64-linux.hello;
  };
}
`);
    const syms = nixHandler.extractSymbols(tree, buf, 'flake.nix');
    const names = syms.map((s) => s.name);
    expect(names).toContain('description');
    expect(names).toContain('inputs');
    expect(names).toContain('outputs');

    const outputs = syms.find((s) => s.name === 'outputs');
    expect(outputs!.kind).toBe('function');
  });

  // ── deterministic IDs ─────────────────────────────────────────────────────

  it('generates deterministic 16-char hex IDs', async () => {
    const { tree, buf } = parse(`{\n  myAttr = "value";\n}\n`);
    const sym = nixHandler.extractSymbols(tree, buf, 'test.nix')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = nixHandler.extractSymbols(tree, buf, 'test.nix')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── skip keywords ──────────────────────────────────────────────────────────

  it('does not emit symbols for Nix keywords (let, in, with, etc.)', async () => {
    const { tree, buf } = parse(`let\n  x = 1;\nin x\n`);
    const syms = nixHandler.extractSymbols(tree, buf, 'expr.nix');
    const names = syms.map((s) => s.name);
    expect(names).not.toContain('let');
    expect(names).not.toContain('in');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Nix handler — extractImports', () => {

  it('extracts import ./file.nix as local import', async () => {
    const { tree, buf } = parse(`
{ config, pkgs, ... }:

{
  imports = [ (import ./hardware-configuration.nix) ];
}
`);
    const imports = nixHandler.extractImports(tree, buf);
    const local = imports.find((i) => i.specifier === './hardware-configuration.nix');
    expect(local).toBeDefined();
    expect(local!.resolvedPath).toBe('./hardware-configuration.nix');
  });

  it('extracts import <nixpkgs> as external import', async () => {
    const { tree, buf } = parse(`{ pkgs ? import <nixpkgs> {} }:\nnull\n`);
    const imports = nixHandler.extractImports(tree, buf);
    const external = imports.find((i) => i.specifier === '<nixpkgs>');
    expect(external).toBeDefined();
    expect(external!.resolvedPath).toBeNull();
  });

  it('extracts multiple import expressions', async () => {
    const { tree, buf } = parse(`
{
  hardware = import ./hardware-configuration.nix;
  users = import ./users.nix {};
  extra = import ./extra.nix { inherit pkgs; };
}
`);
    const imports = nixHandler.extractImports(tree, buf);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('./hardware-configuration.nix');
    expect(specs).toContain('./users.nix');
    expect(specs).toContain('./extra.nix');
  });

  it('deduplicates repeated imports', async () => {
    const { tree, buf } = parse(
      `import ./lib.nix\nimport ./lib.nix\n`,
    );
    const imports = nixHandler.extractImports(tree, buf);
    expect(imports.filter((i) => i.specifier === './lib.nix')).toHaveLength(1);
  });

  it('does not extract imports from comment lines', async () => {
    const { tree, buf } = parse(`# import ./commented-out.nix\nnull\n`);
    const imports = nixHandler.extractImports(tree, buf);
    expect(imports.find((i) => i.specifier === './commented-out.nix')).toBeUndefined();
  });
});
