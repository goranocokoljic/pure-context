import { describe, it, expect } from 'vitest';
import { hclHandler } from '../../src/handlers/hcl.js';
import type { Tree } from '../../src/core/types.js';

function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

describe('HCL handler — extensions', () => {
  it('claims .tf, .tfvars, .hcl', () => {
    const exts = hclHandler.extensions();
    expect(exts).toContain('.tf');
    expect(exts).toContain('.tfvars');
    expect(exts).toContain('.hcl');
  });

  it('has no grammar (regex-only)', () => {
    expect(hclHandler.grammarPath()).toBeNull();
  });
});

describe('HCL handler — extractSymbols', () => {

  // ── variable ──────────────────────────────────────────────────────────────

  it('extracts variable block as kind "const"', () => {
    const { tree, buf } = parse(`
variable "region" {
  type    = string
  default = "us-east-1"
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'var.region');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.signature).toContain('variable "region"');
  });

  // ── output ────────────────────────────────────────────────────────────────

  it('extracts output block as kind "const"', () => {
    const { tree, buf } = parse(`
output "cluster_name" {
  value = module.eks.cluster_name
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'outputs.tf');
    const sym = syms.find((s) => s.name === 'output.cluster_name');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── resource ──────────────────────────────────────────────────────────────

  it('extracts resource block as kind "class" with type.name', () => {
    const { tree, buf } = parse(`
resource "aws_eks_cluster" "main" {
  name = "my-cluster"
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'aws_eks_cluster.main');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('resource "aws_eks_cluster" "main"');
  });

  // ── data ──────────────────────────────────────────────────────────────────

  it('extracts data block as kind "const" with type.name', () => {
    const { tree, buf } = parse(`
data "aws_availability_zones" "available" {
  filter { }
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'data.aws_availability_zones.available');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── module ────────────────────────────────────────────────────────────────

  it('extracts module block as kind "class"', () => {
    const { tree, buf } = parse(`
module "fargate" {
  source = "./modules/fargate"
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'module.fargate');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
  });

  // ── provider ──────────────────────────────────────────────────────────────

  it('extracts provider block as kind "const"', () => {
    const { tree, buf } = parse(`
provider "aws" {
  region = var.region
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'aws');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── locals ────────────────────────────────────────────────────────────────

  it('extracts locals block items as individual const symbols', () => {
    const { tree, buf } = parse(`
locals {
  foo = 1
  bar = "hello"
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const fooSym = syms.find((s) => s.name === 'local.foo');
    const barSym = syms.find((s) => s.name === 'local.bar');
    expect(fooSym).toBeDefined();
    expect(fooSym!.kind).toBe('const');
    expect(barSym).toBeDefined();
    expect(barSym!.kind).toBe('const');
  });

  // ── comment as summary ────────────────────────────────────────────────────

  it('uses preceding # comment as summary', () => {
    const { tree, buf } = parse(`
# AWS region for deployment
variable "region" {
  type = string
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'vars.tf');
    const sym = syms.find((s) => s.name === 'var.region');
    expect(sym!.summary).toContain('AWS region for deployment');
  });

  it('uses preceding // comment as summary', () => {
    const { tree, buf } = parse(`
// EKS cluster resource
resource "aws_eks_cluster" "main" {
  name = "test"
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'aws_eks_cluster.main');
    expect(sym!.summary).toContain('EKS cluster resource');
  });

  // ── nested blocks not emitted ─────────────────────────────────────────────

  it('does not emit nested block labels as top-level symbols', () => {
    const { tree, buf } = parse(`
resource "aws_security_group" "web" {
  ingress {
    from_port = 80
    to_port   = 80
  }
}
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    // Only the resource itself, not the nested ingress block
    expect(syms).toHaveLength(1);
    expect(syms[0]!.name).toBe('aws_security_group.web');
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple blocks from a single file', () => {
    const { tree, buf } = parse(`
variable "region" { type = string }
variable "env" { type = string }
resource "aws_eks_cluster" "main" { name = "test" }
module "vpc" { source = "./vpc" }
`);
    const syms = hclHandler.extractSymbols(tree, buf, 'main.tf');
    const names = syms.map((s) => s.name);
    expect(names).toContain('var.region');
    expect(names).toContain('var.env');
    expect(names).toContain('aws_eks_cluster.main');
    expect(names).toContain('module.vpc');
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`variable "region" { type = string }`);
    const sym = hclHandler.extractSymbols(tree, buf, 'main.tf')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = hclHandler.extractSymbols(tree, buf, 'main.tf')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets startByte and endByte for a block', () => {
    const { tree, buf } = parse(`\nvariable "region" {\n  type = string\n}\n`);
    const sym = hclHandler.extractSymbols(tree, buf, 'main.tf')[0]!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });
});

describe('HCL handler — extractImports', () => {
  it('returns empty array (HCL has no import statements)', () => {
    const { tree, buf } = parse(`variable "x" {}`);
    expect(hclHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
