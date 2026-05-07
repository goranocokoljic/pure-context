import { describe, it, expect } from 'vitest';
import { fortranHandler } from '../../src/handlers/fortran.js';
import type { Tree } from '../../src/core/types.js';

// Handler is regex-based (grammarPath returns null) — no tree-sitter needed.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Fortran handler — extractSymbols', () => {

  // ── SUBROUTINE → 'function' ──────────────────────────────────────────────

  it('extracts SUBROUTINE as kind "function"', () => {
    const { tree, buf } = parse(`
SUBROUTINE compute(x, y)
  REAL, INTENT(IN) :: x, y
END SUBROUTINE compute
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'math.f90');
    const sym = syms.find((s) => s.name === 'compute');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('SUBROUTINE compute');
  });

  it('normalises subroutine name to lowercase', () => {
    const { tree, buf } = parse(`
SUBROUTINE ComputeMatrix(A, B)
END SUBROUTINE ComputeMatrix
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'matrix.f90');
    expect(syms.find((s) => s.name === 'computematrix')).toBeDefined();
  });

  it('handles lowercase subroutine keyword', () => {
    const { tree, buf } = parse(`
subroutine add(a, b, c)
  integer, intent(out) :: c
end subroutine add
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'add.f90');
    expect(syms.find((s) => s.name === 'add')).toBeDefined();
  });

  // ── FUNCTION → 'function' ────────────────────────────────────────────────

  it('extracts FUNCTION as kind "function"', () => {
    const { tree, buf } = parse(`
REAL FUNCTION dot_product(a, b, n)
  REAL, INTENT(IN) :: a(n), b(n)
  INTEGER, INTENT(IN) :: n
END FUNCTION dot_product
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'linalg.f90');
    const sym = syms.find((s) => s.name === 'dot_product');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts FUNCTION with RESULT clause', () => {
    const { tree, buf } = parse(`
FUNCTION factorial(n) RESULT(res)
  INTEGER, INTENT(IN) :: n
  INTEGER :: res
END FUNCTION factorial
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'math.f90');
    expect(syms.find((s) => s.name === 'factorial' && s.kind === 'function')).toBeDefined();
  });

  // ── MODULE → 'class' ─────────────────────────────────────────────────────

  it('extracts MODULE as kind "class"', () => {
    const { tree, buf } = parse(`
MODULE geometry
  IMPLICIT NONE
  REAL :: pi = 3.14159
END MODULE geometry
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'geometry.f90');
    const sym = syms.find((s) => s.name === 'geometry');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('MODULE geometry');
  });

  it('normalises module name to lowercase', () => {
    const { tree, buf } = parse(`
MODULE MathUtils
END MODULE MathUtils
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'mathutils.f90');
    expect(syms.find((s) => s.name === 'mathutils')).toBeDefined();
  });

  // ── CONTAINS subroutines qualify with module name ─────────────────────────

  it('qualifies subroutine inside CONTAINS with module name', () => {
    const { tree, buf } = parse(`
MODULE mymod
  IMPLICIT NONE
CONTAINS
  SUBROUTINE helper()
  END SUBROUTINE helper
END MODULE mymod
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'mymod.f90');
    expect(syms.find((s) => s.name === 'mymod.helper')).toBeDefined();
    expect(syms.find((s) => s.name === 'mymod')).toBeDefined();
  });

  // ── TYPE → 'type' ────────────────────────────────────────────────────────

  it('extracts TYPE :: name as kind "type"', () => {
    const { tree, buf } = parse(`
TYPE :: point
  REAL :: x, y
END TYPE point
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'types.f90');
    const sym = syms.find((s) => s.name === 'point');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
  });

  it('normalises type name to lowercase', () => {
    const { tree, buf } = parse(`
TYPE :: Vector3D
  REAL :: x, y, z
END TYPE Vector3D
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'types.f90');
    expect(syms.find((s) => s.name === 'vector3d')).toBeDefined();
  });

  // ── INTERFACE → 'interface' ───────────────────────────────────────────────

  it('extracts INTERFACE name as kind "interface"', () => {
    const { tree, buf } = parse(`
INTERFACE operator(+)
  MODULE PROCEDURE add_vec
END INTERFACE operator(+)
`);
    // Named interface block
    const { tree: t2, buf: b2 } = parse(`
INTERFACE swap
  MODULE PROCEDURE swap_int, swap_real
END INTERFACE swap
`);
    const syms = fortranHandler.extractSymbols(t2, b2, 'iface.f90');
    const sym = syms.find((s) => s.name === 'swap' && s.kind === 'interface');
    expect(sym).toBeDefined();
  });

  // ── Ford-style doc comments ───────────────────────────────────────────────

  it('uses preceding !> comment as summary', () => {
    const { tree, buf } = parse(
      `!> Computes the Euclidean distance.\nSUBROUTINE distance(a, b)\nEND SUBROUTINE distance\n`,
    );
    const syms = fortranHandler.extractSymbols(tree, buf, 'geo.f90');
    const sym = syms.find((s) => s.name === 'distance');
    expect(sym!.summary).toContain('Computes the Euclidean distance');
  });

  it('uses preceding !! comment as summary', () => {
    const { tree, buf } = parse(
      `!! Solves a linear system.\nFUNCTION solve(A, b)\nEND FUNCTION solve\n`,
    );
    const syms = fortranHandler.extractSymbols(tree, buf, 'linalg.f90');
    const sym = syms.find((s) => s.name === 'solve');
    expect(sym!.summary).toContain('Solves a linear system');
  });

  it('concatenates multi-line doc comments', () => {
    const { tree, buf } = parse(
      `!> Multiplies two matrices\n!> of compatible dimensions.\nSUBROUTINE matmul(A, B, C)\nEND SUBROUTINE matmul\n`,
    );
    const syms = fortranHandler.extractSymbols(tree, buf, 'mat.f90');
    const sym = syms.find((s) => s.name === 'matmul');
    expect(sym!.summary).toContain('Multiplies');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets startByte and endByte for subroutine', () => {
    const { tree, buf } = parse(`\nSUBROUTINE foo()\nEND SUBROUTINE foo\n`);
    const sym = fortranHandler.extractSymbols(tree, buf, 'foo.f90').find((s) => s.name === 'foo')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  // ── deterministic ID ──────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`SUBROUTINE bar()\nEND SUBROUTINE bar\n`);
    const sym = fortranHandler.extractSymbols(tree, buf, 'bar.f90').find((s) => s.name === 'bar')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = fortranHandler.extractSymbols(tree, buf, 'bar.f90').find((s) => s.name === 'bar')!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── multiple symbols ──────────────────────────────────────────────────────

  it('extracts multiple symbols from a single file', () => {
    const { tree, buf } = parse(`
MODULE physics
  IMPLICIT NONE
  TYPE :: particle
    REAL :: mass, charge
  END TYPE particle
CONTAINS
  SUBROUTINE accelerate(p, force)
  END SUBROUTINE accelerate
  FUNCTION kinetic_energy(p) RESULT(ke)
    REAL :: ke
  END FUNCTION kinetic_energy
END MODULE physics
`);
    const syms = fortranHandler.extractSymbols(tree, buf, 'physics.f90');
    const names = syms.map((s) => s.name);
    expect(names).toContain('physics');
    expect(names).toContain('particle');
    expect(names).toContain('physics.accelerate');
    expect(names).toContain('physics.kinetic_energy');
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Fortran handler — extractImports', () => {

  it('extracts USE statement', () => {
    const { tree, buf } = parse(`USE geometry\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.specifier).toBe('geometry');
  });

  it('normalises module name to lowercase', () => {
    const { tree, buf } = parse(`USE MathUtils\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('mathutils');
  });

  it('handles USE with only keyword', () => {
    const { tree, buf } = parse(`USE iso_fortran_env, ONLY: int32, real64\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports[0]!.specifier).toBe('iso_fortran_env');
  });

  it('extracts multiple USE statements', () => {
    const { tree, buf } = parse(`USE geometry\nUSE physics\nUSE math_utils\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports.length).toBeGreaterThanOrEqual(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('geometry');
    expect(specs).toContain('physics');
    expect(specs).toContain('math_utils');
  });

  it('deduplicates repeated USE statements', () => {
    const { tree, buf } = parse(`USE geometry\nUSE geometry\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('sets resolvedPath to null (compiler-dependent)', () => {
    const { tree, buf } = parse(`USE mymodule\n`);
    const imports = fortranHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('returns empty array for file with no USE statements', () => {
    const { tree, buf } = parse(`SUBROUTINE foo()\nEND SUBROUTINE foo\n`);
    expect(fortranHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
