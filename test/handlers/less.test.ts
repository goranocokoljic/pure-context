/**
 * Task 234 — LESS handler tests (Phase 42).
 *
 * The LESS handler is regex-based (grammarPath returns null),
 * so no tree-sitter initialisation is needed.
 */
import { describe, it, expect } from 'vitest';
import { lessHandler } from '../../src/handlers/less.js';
import type { Tree } from '../../src/core/types.js';

// Regex-based handler — pass a null tree (it is never used).
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── Metadata ────────────────────────────────────────────────────────────────

describe('LESS handler — metadata', () => {
  it('reports .less extension', () => {
    expect(lessHandler.extensions()).toContain('.less');
    expect(lessHandler.extensions()).toHaveLength(1);
  });

  it('grammarPath returns null (regex-based)', () => {
    expect(lessHandler.grammarPath()).toBeNull();
  });

  it('extractDocstring returns null', () => {
    expect(lessHandler.extractDocstring(null as never)).toBeNull();
  });
});

// ─── @variables ───────────────────────────────────────────────────────────────

describe('LESS handler — @variables', () => {
  it('extracts top-level @variable declarations', () => {
    const { tree, buf } = parse(`
@primary-color: #3498db;
@font-size-base: 14px;
@spacing: 8px;
`);
    const syms = lessHandler.extractSymbols(tree, buf, 'vars.less');
    expect(syms.find((s) => s.name === '@primary-color')).toBeDefined();
    expect(syms.find((s) => s.name === '@font-size-base')).toBeDefined();
    expect(syms.find((s) => s.name === '@spacing')).toBeDefined();
  });

  it('sets kind to "const" for variables', () => {
    const { tree, buf } = parse(`@brand: #e74c3c;\n`);
    const sym = lessHandler.extractSymbols(tree, buf, 'vars.less').find(
      (s) => s.name === '@brand',
    );
    expect(sym!.kind).toBe('const');
  });

  it('includes the value in the signature', () => {
    const { tree, buf } = parse(`@link-color: #0078d4;\n`);
    const sym = lessHandler.extractSymbols(tree, buf, 'vars.less').find(
      (s) => s.name === '@link-color',
    );
    expect(sym!.signature).toContain('#0078d4');
  });

  it('uses the preceding // comment as summary', () => {
    const { tree, buf } = parse(`
// Primary brand color
@primary: #3498db;
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'vars.less').find(
      (s) => s.name === '@primary',
    );
    expect(sym!.summary).toContain('Primary brand color');
  });

  it('does NOT extract @media as a variable', () => {
    const { tree, buf } = parse(`@media (max-width: 768px) { .col { width: 100%; } }\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'responsive.less');
    expect(syms.find((s) => s.name === '@media')).toBeUndefined();
  });

  it('does NOT extract @import as a variable', () => {
    const { tree, buf } = parse(`@import 'variables';\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'main.less');
    expect(syms.find((s) => s.name === '@import')).toBeUndefined();
  });

  it('does NOT extract @keyframes keyword as a variable', () => {
    const { tree, buf } = parse(`@keyframes spin { to { transform: rotate(360deg); } }\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'anims.less');
    expect(syms.find((s) => s.name === '@keyframes')).toBeUndefined();
  });

  it('does NOT extract @font-face as a variable', () => {
    const { tree, buf } = parse(`@font-face { font-family: "MyFont"; src: url("font.woff"); }\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'fonts.less');
    expect(syms.find((s) => s.name === '@font-face')).toBeUndefined();
  });

  it('does NOT extract @variable declared inside a selector block', () => {
    const { tree, buf } = parse(`
.component {
  @local-color: red;
  color: @local-color;
}
`);
    const syms = lessHandler.extractSymbols(tree, buf, 'comp.less');
    expect(syms.find((s) => s.name === '@local-color')).toBeUndefined();
  });

  it('generates a deterministic 16-hex-char ID for variables', () => {
    const { tree, buf } = parse(`@brand: #333;\n`);
    const sym = lessHandler.extractSymbols(tree, buf, 'v.less').find(
      (s) => s.name === '@brand',
    );
    expect(sym!.id).toHaveLength(16);
    expect(sym!.id).toMatch(/^[0-9a-f]+$/);
  });
});

// ─── Mixins ───────────────────────────────────────────────────────────────────

describe('LESS handler — mixins', () => {
  it('extracts a parametric mixin', () => {
    const { tree, buf } = parse(`
.border-radius(@radius: 5px) {
  -webkit-border-radius: @radius;
  border-radius: @radius;
}
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'border-radius',
    );
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('.border-radius');
    expect(sym!.signature).toContain('@radius');
  });

  it('extracts a mixin with empty parameter list', () => {
    const { tree, buf } = parse(`
.clearfix() {
  &::after {
    content: '';
    display: table;
    clear: both;
  }
}
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'clearfix',
    );
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts a mixin with multiple parameters', () => {
    const { tree, buf } = parse(`
.gradient(@start-color: #555, @end-color: #333) {
  background-color: @start-color;
  background-image: linear-gradient(@start-color, @end-color);
}
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'gradient',
    );
    expect(sym).toBeDefined();
    expect(sym!.signature).toContain('@start-color');
    expect(sym!.signature).toContain('@end-color');
  });

  it('sets endByte to cover the full mixin block', () => {
    const src = `.rounded(@r: 4px) {\n  border-radius: @r;\n  -webkit-border-radius: @r;\n}\n`;
    const { tree, buf } = parse(src);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'rounded',
    );
    expect(sym).toBeDefined();
    // endByte must reach past the closing brace line
    expect(sym!.endByte).toBeGreaterThan(sym!.startByte + src.indexOf('}'));
  });

  it('does NOT extract plain class selectors (no parentheses)', () => {
    const { tree, buf } = parse(`.button {\n  color: @primary;\n}\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'styles.less');
    expect(syms.find((s) => s.name === 'button')).toBeUndefined();
  });

  it('does NOT extract mixin calls inside selector blocks', () => {
    const { tree, buf } = parse(`
.component {
  .border-radius(4px);
  color: @primary;
}
`);
    const syms = lessHandler.extractSymbols(tree, buf, 'comp.less');
    // The call `.border-radius(4px);` ends with `;` not `{`, so it is not extracted.
    expect(syms.find((s) => s.name === 'border-radius')).toBeUndefined();
  });

  it('uses the preceding // comment as summary', () => {
    const { tree, buf } = parse(`
// Flexbox centering helper
.flex-center(@direction: row) {
  display: flex;
  align-items: center;
}
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'flex-center',
    );
    expect(sym!.summary).toContain('Flexbox centering helper');
  });

  it('generates a deterministic 16-hex-char ID for mixins', () => {
    const { tree, buf } = parse(`.btn(@c) { color: @c; }\n`);
    const sym = lessHandler.extractSymbols(tree, buf, 'mixins.less').find(
      (s) => s.name === 'btn',
    );
    expect(sym!.id).toHaveLength(16);
    expect(sym!.id).toMatch(/^[0-9a-f]+$/);
  });

  it('generates different IDs for the same mixin in different files', () => {
    const src = `.btn(@c) { color: @c; }\n`;
    const { tree, buf } = parse(src);
    const symsA = lessHandler.extractSymbols(tree, buf, 'a.less');
    const symsB = lessHandler.extractSymbols(tree, buf, 'b.less');
    expect(symsA[0]!.id).not.toBe(symsB[0]!.id);
  });
});

// ─── @keyframes ───────────────────────────────────────────────────────────────

describe('LESS handler — @keyframes', () => {
  it('extracts @keyframes as kind "type"', () => {
    const { tree, buf } = parse(`
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
`);
    const sym = lessHandler.extractSymbols(tree, buf, 'animations.less').find(
      (s) => s.name === 'fadeIn',
    );
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('@keyframes fadeIn');
  });

  it('extracts vendor-prefixed @keyframes', () => {
    const { tree, buf } = parse(`@-webkit-keyframes spin { to { transform: rotate(360deg); } }\n`);
    const sym = lessHandler.extractSymbols(tree, buf, 'a.less').find(
      (s) => s.name === 'spin',
    );
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
  });
});

// ─── Comment handling ─────────────────────────────────────────────────────────

describe('LESS handler — comment handling', () => {
  it('ignores symbols inside /* ... */ block comments', () => {
    const { tree, buf } = parse(`
/*
.hidden-mixin(@x) {
  color: @x;
}
@hidden-var: red;
*/
.real-mixin() {
  color: red;
}
`);
    const syms = lessHandler.extractSymbols(tree, buf, 'styles.less');
    expect(syms.find((s) => s.name === 'hidden-mixin')).toBeUndefined();
    expect(syms.find((s) => s.name === '@hidden-var')).toBeUndefined();
    expect(syms.find((s) => s.name === 'real-mixin')).toBeDefined();
  });

  it('ignores symbols after // comments on the same line', () => {
    const { tree, buf } = parse(`// .fake-mixin(@x) { color: @x; }\n.real() { color: red; }\n`);
    const syms = lessHandler.extractSymbols(tree, buf, 'styles.less');
    expect(syms.find((s) => s.name === 'fake-mixin')).toBeUndefined();
    expect(syms.find((s) => s.name === 'real')).toBeDefined();
  });
});

// ─── Import extraction ────────────────────────────────────────────────────────

describe('LESS handler — extractImports', () => {
  it('extracts @import paths (single-quoted)', () => {
    const { tree, buf } = parse(`@import 'variables';\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('variables');
  });

  it('extracts @import paths (double-quoted)', () => {
    const { tree, buf } = parse(`@import "mixins";\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('mixins');
  });

  it('extracts @import (reference) paths', () => {
    const { tree, buf } = parse(`@import (reference) 'library';\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('library');
  });

  it('extracts @import (less) paths', () => {
    const { tree, buf } = parse(`@import (less) "styles.css";\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('styles.css');
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(`@import 'vars';\n@import 'vars';\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports.filter((i) => i.specifier === 'vars')).toHaveLength(1);
  });

  it('sets resolvedPath to null for external URLs', () => {
    const { tree, buf } = parse(`@import 'https://cdn.example.com/styles.less';\n`);
    const imports = lessHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });
});

// ─── Mixed LESS file ──────────────────────────────────────────────────────────

describe('LESS handler — mixed LESS file', () => {
  it('extracts all symbol types from a realistic LESS file', () => {
    const { tree, buf } = parse(`
// Brand colors
@primary: #3498db;
@secondary: #2ecc71;

// Keyframe animation
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

// Mixin
.flex-center(@direction: row) {
  display: flex;
  flex-direction: @direction;
  align-items: center;
}

// Another mixin
.border-radius(@r: 4px) {
  border-radius: @r;
}
`);
    const syms = lessHandler.extractSymbols(tree, buf, 'styles.less');
    expect(syms.find((s) => s.name === '@primary')).toBeDefined();
    expect(syms.find((s) => s.name === '@secondary')).toBeDefined();
    expect(syms.find((s) => s.name === 'fadeIn')).toBeDefined();
    expect(syms.find((s) => s.name === 'flex-center')).toBeDefined();
    expect(syms.find((s) => s.name === 'border-radius')).toBeDefined();
    expect(syms).toHaveLength(5);
  });
});
