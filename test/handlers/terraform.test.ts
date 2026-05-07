import { describe, it, expect } from 'vitest';
import { terraformHandler } from '../../src/handlers/terraform.js';
import type { Tree } from '../../src/core/types.js';

// Terraform handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Terraform handler — extractSymbols', () => {

  // ── resource block → class ────────────────────────────────────────────────

  it('extracts resource block as kind "class" with type.name', async () => {
    const { tree, buf } = parse(`
resource "aws_s3_bucket" "main" {
  bucket = "my-bucket"
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'aws_s3_bucket.main');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('aws_s3_bucket');
    expect(sym!.signature).toContain('main');
  });

  // ── data block → const ───────────────────────────────────────────────────

  it('extracts data block as kind "const" with data.type.name', async () => {
    const { tree, buf } = parse(`
data "aws_ami" "ubuntu" {
  most_recent = true
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'data.tf');
    const sym = syms.find((s) => s.name === 'data.aws_ami.ubuntu');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.signature).toContain('data');
    expect(sym!.signature).toContain('aws_ami');
  });

  // ── variable block → const ────────────────────────────────────────────────

  it('extracts variable block as kind "const" with var.name', async () => {
    const { tree, buf } = parse(`
variable "instance_type" {
  description = "EC2 instance type"
  default     = "t2.micro"
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'variables.tf');
    const sym = syms.find((s) => s.name === 'var.instance_type');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
  });

  // ── description attribute used as summary ─────────────────────────────────

  it('uses description attribute as summary when present', async () => {
    const { tree, buf } = parse(`
variable "region" {
  description = "AWS region to deploy into"
  default     = "us-east-1"
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'variables.tf');
    const sym = syms.find((s) => s.name === 'var.region');
    expect(sym!.summary).toContain('AWS region');
  });

  // ── preceding comment used as summary ────────────────────────────────────

  it('falls back to preceding # comment as summary', async () => {
    const { tree, buf } = parse(
      `# Main S3 bucket for asset storage.\nresource "aws_s3_bucket" "assets" {\n  bucket = "assets"\n}\n`,
    );
    const syms = terraformHandler.extractSymbols(tree, buf, 'storage.tf');
    const sym = syms.find((s) => s.name === 'aws_s3_bucket.assets');
    expect(sym!.summary).toContain('Main S3 bucket');
  });

  // ── output block → const ─────────────────────────────────────────────────

  it('extracts output block as kind "const" with output.name', async () => {
    const { tree, buf } = parse(`
output "bucket_arn" {
  description = "The ARN of the S3 bucket"
  value       = aws_s3_bucket.main.arn
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'outputs.tf');
    const sym = syms.find((s) => s.name === 'output.bucket_arn');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.summary).toContain('ARN');
  });

  // ── module block → function ───────────────────────────────────────────────

  it('extracts module block as kind "function" with module.name', async () => {
    const { tree, buf } = parse(`
module "vpc" {
  source  = "./modules/vpc"
  cidr    = "10.0.0.0/16"
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'main.tf');
    const sym = syms.find((s) => s.name === 'module.vpc');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('module');
    expect(sym!.signature).toContain('vpc');
  });

  // ── locals block → const per key ─────────────────────────────────────────

  it('extracts locals block keys as individual const symbols', async () => {
    const { tree, buf } = parse(`
locals {
  bucket_name = "my-bucket"
  region      = "us-east-1"
  env         = "prod"
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'locals.tf');
    expect(syms.find((s) => s.name === 'local.bucket_name')).toBeDefined();
    expect(syms.find((s) => s.name === 'local.region')).toBeDefined();
    expect(syms.find((s) => s.name === 'local.env')).toBeDefined();
    for (const s of syms) {
      expect(s.kind).toBe('const');
    }
  });

  // ── deterministic IDs ─────────────────────────────────────────────────────

  it('generates deterministic 16-char hex IDs', async () => {
    const { tree, buf } = parse(`resource "aws_s3_bucket" "test" {\n  bucket = "test"\n}\n`);
    const sym = terraformHandler.extractSymbols(tree, buf, 'main.tf')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = terraformHandler.extractSymbols(tree, buf, 'main.tf')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple block types ──────────────────────────────────────────────────

  it('extracts multiple block types from a single file', async () => {
    const { tree, buf } = parse(`
variable "env" {
  default = "dev"
}

resource "aws_instance" "web" {
  ami           = "ami-12345"
  instance_type = var.instance_type
}

output "public_ip" {
  value = aws_instance.web.public_ip
}
`);
    const syms = terraformHandler.extractSymbols(tree, buf, 'infra.tf');
    const names = syms.map((s) => s.name);
    expect(names).toContain('var.env');
    expect(names).toContain('aws_instance.web');
    expect(names).toContain('output.public_ip');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Terraform handler — extractImports', () => {

  it('extracts local module source as import with resolvedPath', async () => {
    const { tree, buf } = parse(`
module "vpc" {
  source = "./modules/vpc"
  cidr   = "10.0.0.0/16"
}
`);
    const imports = terraformHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./modules/vpc');
    expect(imports[0]!.resolvedPath).toBe('./modules/vpc');
  });

  it('marks registry module source as external (resolvedPath null)', async () => {
    const { tree, buf } = parse(`
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 19.0"
}
`);
    const imports = terraformHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('terraform-aws-modules/eks/aws');
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('extracts multiple module sources', async () => {
    const { tree, buf } = parse(`
module "vpc" {
  source = "./modules/vpc"
}

module "rds" {
  source = "./modules/rds"
}
`);
    const imports = terraformHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('./modules/vpc');
    expect(specs).toContain('./modules/rds');
  });

  it('deduplicates repeated module sources', async () => {
    const { tree, buf } = parse(`
module "a" {
  source = "./modules/shared"
}

module "b" {
  source = "./modules/shared"
}
`);
    const imports = terraformHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns no imports for files without module blocks', async () => {
    const { tree, buf } = parse(`
variable "name" {
  default = "test"
}

resource "aws_s3_bucket" "test" {
  bucket = "test"
}
`);
    const imports = terraformHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(0);
  });
});
