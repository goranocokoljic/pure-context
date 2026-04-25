import { describe, it, expect, beforeAll } from 'vitest';
import { initParser, parseFile, _resetForTesting } from '../../src/core/parse-dispatcher.js';
import { rHandler } from '../../src/handlers/r.js';

async function parse(source: string) {
  const buf = Buffer.from(source);
  const tree = await parseFile(buf, rHandler);
  return { tree, buf };
}

beforeAll(async () => {
  _resetForTesting();
  await initParser();
});

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('R handler — extractSymbols', () => {
  it('extracts function with <- assignment as kind function', async () => {
    const src = `add <- function(x, y) {\n  x + y\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/functions.R');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts function with = assignment as kind function', async () => {
    const src = `multiply = function(x, y) x * y\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/functions.R');
    const fn = syms.find((s) => s.name === 'multiply');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts function with -> right-assignment as kind function', async () => {
    const src = `(function(x) x^2) -> square\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/functions.R');
    const fn = syms.find((s) => s.name === 'square');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });

  it('extracts constant (non-function) assignment as kind const', async () => {
    const src = `MAX_ITER <- 1000\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/utils.R');
    const c = syms.find((s) => s.name === 'MAX_ITER');
    expect(c).toBeDefined();
    expect(c!.kind).toBe('const');
  });

  it('detects S3 method (print.myclass) as kind method with r_s3_method metadata', async () => {
    const src = `print.myclass <- function(x, ...) {\n  cat(x$value)\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/classes.R');
    const m = syms.find((s) => s.name === 'print.myclass');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
    expect(m!.frameworkMeta?.r_s3_method).toBe(true);
  });

  it('detects summary S3 method', async () => {
    const src = `summary.mymodel <- function(object, ...) object\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/classes.R');
    const m = syms.find((s) => s.name === 'summary.mymodel');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
  });

  it('extracts setClass as kind class with r_s4_class metadata', async () => {
    const src = `setClass("Person", representation(name = "character", age = "numeric"))\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/classes.R');
    const cls = syms.find((s) => s.name === 'Person');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.r_s4_class).toBe(true);
  });

  it('extracts setMethod as kind method with r_s4_method metadata', async () => {
    const src = `setMethod("show", "Person", function(object) cat(object@name))\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/classes.R');
    const m = syms.find((s) => s.name === 'show');
    expect(m).toBeDefined();
    expect(m!.kind).toBe('method');
    expect(m!.frameworkMeta?.r_s4_method).toBe(true);
  });

  it('extracts R6Class as kind class with r_r6_class metadata', async () => {
    const src = `Counter <- R6Class("Counter",\n  public = list(\n    count = 0,\n    increment = function() self$count <- self$count + 1\n  )\n)\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/classes.R');
    const cls = syms.find((s) => s.name === 'Counter');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.frameworkMeta?.r_r6_class).toBe(true);
  });

  it('skips nested function assignments (local scope)', async () => {
    const src = `outer <- function(x) {\n  inner <- function(y) y + 1\n  inner(x)\n}\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/functions.R');
    // outer should be present, inner should not
    expect(syms.find((s) => s.name === 'outer')).toBeDefined();
    expect(syms.find((s) => s.name === 'inner')).toBeUndefined();
  });

  it('function signature contains name, <-, and params', async () => {
    const src = `transform <- function(x, method = "log", na.rm = TRUE) x\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/functions.R');
    const fn = syms.find((s) => s.name === 'transform');
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain('transform');
    expect(fn!.signature).toContain('<-');
    expect(fn!.signature).toContain('function');
  });

  it('generates a deterministic 16-char hex id', async () => {
    const src = `myFunc <- function() NULL\n`;
    const { tree, buf } = await parse(src);
    const sym = rHandler.extractSymbols(tree, buf, 'R/functions.R')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = rHandler.extractSymbols(tree, buf, 'R/functions.R')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  it('captures Roxygen2 #\' comments as docstring', async () => {
    const src = `#' Add two numbers together.\n#' @param x first operand\n#' @param y second operand\nadd <- function(x, y) x + y\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/utils.R');
    const fn = syms.find((s) => s.name === 'add');
    expect(fn).toBeDefined();
    expect(fn!.summary).toContain('Add two numbers');
  });

  it('does not capture regular # comments as docstring', async () => {
    const src = `# Plain comment\nfoo <- function() NULL\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/utils.R');
    const fn = syms.find((s) => s.name === 'foo');
    expect(fn).toBeDefined();
    expect(fn!.summary).toBeFalsy();
  });

  it('extracts multiple top-level symbols', async () => {
    const src = `PI <- 3.14159\narea <- function(r) PI * r^2\ncircumference <- function(r) 2 * PI * r\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/math.R');
    expect(syms.length).toBeGreaterThanOrEqual(3);
  });

  it('extracts <<- global assignment as function', async () => {
    const src = `init <<- function() invisible(NULL)\n`;
    const { tree, buf } = await parse(src);
    const syms = rHandler.extractSymbols(tree, buf, 'R/env.R');
    const fn = syms.find((s) => s.name === 'init');
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe('function');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('R handler — extractImports', () => {
  it('extracts library() as import', async () => {
    const src = `library(dplyr)\n`;
    const { tree, buf } = await parse(src);
    const imports = rHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('dplyr');
    expect(imports[0]!.resolvedPath).toBeNull();
    expect(imports[0]!.isTypeOnly).toBe(false);
  });

  it('extracts require() as import', async () => {
    const src = `require(ggplot2)\n`;
    const { tree, buf } = await parse(src);
    const imports = rHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('ggplot2');
  });

  it('extracts library() with quoted package name', async () => {
    const src = `library("tidyverse")\n`;
    const { tree, buf } = await parse(src);
    const imports = rHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('tidyverse');
  });

  it('extracts source() as import with resolvedPath', async () => {
    const src = `source("./utils.R")\n`;
    const { tree, buf } = await parse(src);
    const imports = rHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('./utils.R');
    expect(imports[0]!.resolvedPath).toBe('./utils.R');
  });

  it('extracts multiple imports', async () => {
    const src = `library(dplyr)\nlibrary(ggplot2)\nrequire(tidyr)\n`;
    const { tree, buf } = await parse(src);
    const imports = rHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(3);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('R handler — extractDocstring', () => {
  it('returns null when no comment precedes node', async () => {
    const src = `foo <- function() NULL\n`;
    const { tree, buf } = await parse(src);
    const root = tree.rootNode;
    const node = root.children.find((c) => c.isNamed);
    expect(rHandler.extractDocstring(node!)).toBeNull();
  });

  it('strips @param tags and returns description only', async () => {
    const src = `#' Compute the mean.\n#' @param x a numeric vector\nmean_val <- function(x) mean(x)\n`;
    const { tree, buf } = await parse(src);
    const root = tree.rootNode;
    const assign = root.children.find((c) => c.type === 'binary_operator');
    const doc = rHandler.extractDocstring(assign!);
    expect(doc).toBeTruthy();
    expect(doc).toContain('Compute the mean');
    expect(doc).not.toContain('@param');
  });

  it('handles multi-line Roxygen2 description', async () => {
    const src = `#' First line.\n#' Second line.\nbar <- function() 1\n`;
    const { tree, buf } = await parse(src);
    const root = tree.rootNode;
    const assign = root.children.find((c) => c.type === 'binary_operator');
    const doc = rHandler.extractDocstring(assign!);
    expect(doc).toContain('First line');
    expect(doc).toContain('Second line');
  });
});
