/**
 * Task 234 — SCSS/SASS handler tests (Phase 42).
 *
 * The SCSS handler is regex-based (grammarPath returns null),
 * so no tree-sitter initialisation is needed.
 */
import { describe, it, expect } from 'vitest';
import { scssHandler } from '../../src/handlers/scss.js';
import type { Tree } from '../../src/core/types.js';

// Regex-based handler — pass a null tree (it is never used).
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── Metadata ────────────────────────────────────────────────────────────────

describe('SCSS handler — metadata', () => {
  it('reports .scss and .sass extensions', () => {
    expect(scssHandler.extensions()).toContain('.scss');
    expect(scssHandler.extensions()).toContain('.sass');
  });

  it('grammarPath returns null (regex-based)', () => {
    expect(scssHandler.grammarPath()).toBeNull();
  });

  it('extractDocstring returns null', () => {
    expect(scssHandler.extractDocstring(null as never)).toBeNull();
  });
});

// ─── @mixin ───────────────────────────────────────────────────────────────────

describe('SCSS handler — @mixin', () => {
  it('extracts a simple mixin with parameters', () => {
    const { tree, buf } = parse(`
@mixin button-primary($color: blue) {
  background: $color;
  color: white;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'styles/buttons.scss');
    const sym = syms.find((s) => s.name === 'button-primary');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('@mixin button-primary');
    expect(sym!.signature).toContain('$color');
  });

  it('extracts mixin without parameters', () => {
    const { tree, buf } = parse(`
@mixin clearfix() {
  &::after {
    content: '';
    display: table;
    clear: both;
  }
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'utils.scss');
    const sym = syms.find((s) => s.name === 'clearfix');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts mixin name without parentheses (SCSS allows this)', () => {
    const { tree, buf } = parse(`@mixin flex-center {\n  display: flex;\n}\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'mixins.scss');
    const sym = syms.find((s) => s.name === 'flex-center');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('uses preceding // comment as summary', () => {
    const { tree, buf } = parse(`
// Flex centering utility
@mixin flex-center {
  display: flex;
  justify-content: center;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'mixins.scss');
    const sym = syms.find((s) => s.name === 'flex-center');
    expect(sym!.summary).toContain('Flex centering utility');
  });

  it('sets endByte to cover the full mixin block (not just the definition line)', () => {
    const src = `@mixin theme($color) {\n  color: $color;\n  background: darken($color, 10%);\n}\n`;
    const { tree, buf } = parse(src);
    const syms = scssHandler.extractSymbols(tree, buf, 'theme.scss');
    const sym = syms.find((s) => s.name === 'theme');
    expect(sym).toBeDefined();
    // endByte should reach past the closing brace, not just the first line
    expect(sym!.endByte).toBeGreaterThan(sym!.startByte + src.indexOf('}'));
  });

  it('generates a deterministic 16-hex-char ID', () => {
    const { tree, buf } = parse(`@mixin btn($c) { color: $c; }\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'styles/buttons.scss');
    const sym = syms.find((s) => s.name === 'btn');
    expect(sym!.id).toHaveLength(16);
    expect(sym!.id).toMatch(/^[0-9a-f]+$/);
  });

  it('generates different IDs for the same mixin in different files', () => {
    const src = `@mixin btn($c) { color: $c; }\n`;
    const { tree, buf } = parse(src);
    const symsA = scssHandler.extractSymbols(tree, buf, 'a.scss');
    const symsB = scssHandler.extractSymbols(tree, buf, 'b.scss');
    expect(symsA[0]!.id).not.toBe(symsB[0]!.id);
  });
});

// ─── @function ────────────────────────────────────────────────────────────────

describe('SCSS handler — @function', () => {
  it('extracts a SCSS function', () => {
    const { tree, buf } = parse(`
@function rem($px) {
  @return $px / 16px * 1rem;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'utils.scss');
    const sym = syms.find((s) => s.name === 'rem');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('@function rem');
  });

  it('extracts function with multiple parameters', () => {
    const { tree, buf } = parse(`
@function grid-width($n, $gap: 8px) {
  @return $n * $gap;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'grid.scss');
    const sym = syms.find((s) => s.name === 'grid-width');
    expect(sym).toBeDefined();
    expect(sym!.signature).toContain('$n');
    expect(sym!.signature).toContain('$gap');
  });

  it('extracts multiple functions from the same file', () => {
    const { tree, buf } = parse(`
@function px-to-em($px) { @return $px / 16 * 1em; }
@function em-to-px($em) { @return $em * 16; }
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'convert.scss');
    expect(syms.find((s) => s.name === 'px-to-em')).toBeDefined();
    expect(syms.find((s) => s.name === 'em-to-px')).toBeDefined();
  });
});

// ─── $variables ───────────────────────────────────────────────────────────────

describe('SCSS handler — $variables', () => {
  it('extracts top-level $variable declarations', () => {
    const { tree, buf } = parse(`
$primary-color: #3498db;
$font-size-base: 16px;
$spacing-unit: 8px;
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.scss');
    expect(syms.find((s) => s.name === '$primary-color')).toBeDefined();
    expect(syms.find((s) => s.name === '$font-size-base')).toBeDefined();
    expect(syms.find((s) => s.name === '$spacing-unit')).toBeDefined();
  });

  it('sets kind to "const" for variables', () => {
    const { tree, buf } = parse(`$border-radius: 4px;\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.scss');
    expect(syms.find((s) => s.name === '$border-radius')!.kind).toBe('const');
  });

  it('includes the value in the signature', () => {
    const { tree, buf } = parse(`$theme-color: #e74c3c;\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.scss');
    const sym = syms.find((s) => s.name === '$theme-color');
    expect(sym!.signature).toContain('#e74c3c');
  });

  it('strips !default from the signature value', () => {
    const { tree, buf } = parse(`$brand-color: #0078d4 !default;\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.scss');
    const sym = syms.find((s) => s.name === '$brand-color');
    expect(sym).toBeDefined();
    expect(sym!.signature).not.toContain('!default');
  });

  it('strips !global from the signature value', () => {
    const { tree, buf } = parse(`$global-var: 42px !global;\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.scss');
    const sym = syms.find((s) => s.name === '$global-var');
    expect(sym).toBeDefined();
    expect(sym!.signature).not.toContain('!global');
  });

  it('does NOT extract $variables inside a mixin body', () => {
    const { tree, buf } = parse(`
@mixin button($color: blue) {
  $padded-color: darken($color, 10%);
  background: $padded-color;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'buttons.scss');
    expect(syms.find((s) => s.name === '$padded-color')).toBeUndefined();
    // The mixin itself is still extracted
    expect(syms.find((s) => s.name === 'button')).toBeDefined();
  });

  it('does NOT extract $variables inside a @function body', () => {
    const { tree, buf } = parse(`
@function calc-rem($px) {
  $base: 16px;
  @return $px / $base * 1rem;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'fn.scss');
    expect(syms.find((s) => s.name === '$base')).toBeUndefined();
  });
});

// ─── %placeholder ─────────────────────────────────────────────────────────────

describe('SCSS handler — %placeholder', () => {
  it('extracts a placeholder selector', () => {
    const { tree, buf } = parse(`
%message-shared {
  border: 1px solid #ccc;
  padding: 10px;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'placeholders.scss');
    const sym = syms.find((s) => s.name === '%message-shared');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('%message-shared');
  });

  it('uses default summary when no preceding comment', () => {
    const { tree, buf } = parse(`%button-base { padding: 8px; }\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'p.scss');
    const sym = syms.find((s) => s.name === '%button-base');
    expect(sym!.summary).toContain('placeholder');
  });

  it('uses preceding comment as summary', () => {
    const { tree, buf } = parse(`
/* Shared flex layout */
%flex-layout {
  display: flex;
  gap: 1rem;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'p.scss');
    const sym = syms.find((s) => s.name === '%flex-layout');
    expect(sym!.summary).toContain('Shared flex layout');
  });
});

// ─── @keyframes ───────────────────────────────────────────────────────────────

describe('SCSS handler — @keyframes', () => {
  it('extracts @keyframes as kind "type"', () => {
    const { tree, buf } = parse(`
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'animations.scss');
    const sym = syms.find((s) => s.name === 'fadeIn');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('@keyframes fadeIn');
  });

  it('extracts vendor-prefixed @keyframes', () => {
    const { tree, buf } = parse(`@-webkit-keyframes slide { from {} to {} }\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'a.scss');
    const sym = syms.find((s) => s.name === 'slide');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
  });

  it('extracts multiple @keyframes', () => {
    const { tree, buf } = parse(`
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes bounce { 50% { transform: translateY(-20px); } }
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'anim.scss');
    expect(syms.find((s) => s.name === 'spin')).toBeDefined();
    expect(syms.find((s) => s.name === 'bounce')).toBeDefined();
  });
});

// ─── Comment handling ─────────────────────────────────────────────────────────

describe('SCSS handler — comment handling', () => {
  it('ignores symbols inside /* ... */ block comments', () => {
    const { tree, buf } = parse(`
/*
@mixin commented-out($x) {
  color: $x;
}
$also-commented: red;
*/
@mixin real-mixin() {
  color: red;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'styles.scss');
    expect(syms.find((s) => s.name === 'commented-out')).toBeUndefined();
    expect(syms.find((s) => s.name === '$also-commented')).toBeUndefined();
    expect(syms.find((s) => s.name === 'real-mixin')).toBeDefined();
  });

  it('ignores @mixin on a // commented line', () => {
    const { tree, buf } = parse(
      `// @mixin fake($x) { color: $x; }\n@mixin real() { color: red; }\n`,
    );
    const syms = scssHandler.extractSymbols(tree, buf, 'styles.scss');
    expect(syms.find((s) => s.name === 'fake')).toBeUndefined();
    expect(syms.find((s) => s.name === 'real')).toBeDefined();
  });
});

// ─── Import extraction ────────────────────────────────────────────────────────

describe('SCSS handler — extractImports', () => {
  it('extracts @import paths', () => {
    const { tree, buf } = parse(`@import 'variables';\n@import "mixins";\n`);
    const imports = scssHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('variables');
    expect(imports.map((i) => i.specifier)).toContain('mixins');
  });

  it('extracts @use paths', () => {
    const { tree, buf } = parse(`@use 'sass:math';\n@use 'theme' as t;\n`);
    const imports = scssHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('sass:math');
    expect(imports.map((i) => i.specifier)).toContain('theme');
  });

  it('extracts @forward paths', () => {
    const { tree, buf } = parse(`@forward 'variables';\n`);
    const imports = scssHandler.extractImports(tree, buf);
    expect(imports.map((i) => i.specifier)).toContain('variables');
  });

  it('deduplicates repeated imports', () => {
    const { tree, buf } = parse(`@import 'vars';\n@import 'vars';\n`);
    const imports = scssHandler.extractImports(tree, buf);
    expect(imports.filter((i) => i.specifier === 'vars')).toHaveLength(1);
  });

  it('sets resolvedPath to null for external URLs', () => {
    const { tree, buf } = parse(
      `@import 'https://fonts.googleapis.com/css2?family=Roboto';\n`,
    );
    const imports = scssHandler.extractImports(tree, buf);
    const imp = imports.find((i) => i.specifier.includes('googleapis'));
    expect(imp!.resolvedPath).toBeNull();
  });
});

// ─── .sass indented syntax ────────────────────────────────────────────────────

describe('SCSS handler — .sass indented syntax', () => {
  it('extracts @mixin in .sass files', () => {
    const { tree, buf } = parse(`@mixin flex-center\n  display: flex\n  justify-content: center\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'styles.sass');
    const sym = syms.find((s) => s.name === 'flex-center');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts @function in .sass files', () => {
    const { tree, buf } = parse(`@function to-rem($px)\n  @return $px / 16px * 1rem\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'fns.sass');
    expect(syms.find((s) => s.name === 'to-rem')).toBeDefined();
  });

  it('extracts top-level $variable in .sass (no leading whitespace)', () => {
    const { tree, buf } = parse(`$primary: blue\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.sass');
    expect(syms.find((s) => s.name === '$primary')).toBeDefined();
  });

  it('does NOT extract indented $variable in .sass (nested scope)', () => {
    const { tree, buf } = parse(`$outer: blue\n  $inner: red\n`);
    const syms = scssHandler.extractSymbols(tree, buf, 'vars.sass');
    expect(syms.find((s) => s.name === '$outer')).toBeDefined();
    expect(syms.find((s) => s.name === '$inner')).toBeUndefined();
  });
});

// ─── Mixed file ───────────────────────────────────────────────────────────────

describe('SCSS handler — mixed SCSS file', () => {
  it('extracts all symbol types from a realistic design-system file', () => {
    const { tree, buf } = parse(`
// Design system tokens
$color-primary: #0078d4;
$color-secondary: #605e5c;
$font-base: 16px;

// Animation
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

// Shared button styles
%btn-reset {
  border: none;
  cursor: pointer;
}

// Utility mixin
@mixin flex($direction: row, $gap: 0) {
  display: flex;
  flex-direction: $direction;
  gap: $gap;
}

// Value function
@function spacing($n) {
  @return $n * 8px;
}
`);
    const syms = scssHandler.extractSymbols(tree, buf, 'design-system.scss');
    expect(syms.find((s) => s.name === '$color-primary')).toBeDefined();
    expect(syms.find((s) => s.name === '$color-secondary')).toBeDefined();
    expect(syms.find((s) => s.name === '$font-base')).toBeDefined();
    expect(syms.find((s) => s.name === 'fade-in')).toBeDefined();
    expect(syms.find((s) => s.name === '%btn-reset')).toBeDefined();
    expect(syms.find((s) => s.name === 'flex')).toBeDefined();
    expect(syms.find((s) => s.name === 'spacing')).toBeDefined();
    expect(syms).toHaveLength(7);
  });
});
