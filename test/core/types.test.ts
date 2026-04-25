import { describe, it, expectTypeOf } from 'vitest';
import type { SymbolKind } from '../../src/core/types.js';

describe('SymbolKind — Phase 6 additions', () => {
  it("'namespace' is a valid SymbolKind", () => {
    const kind: SymbolKind = 'namespace';
    expectTypeOf(kind).toMatchTypeOf<SymbolKind>();
  });

  it("'widget' is a valid SymbolKind", () => {
    const kind: SymbolKind = 'widget';
    expectTypeOf(kind).toMatchTypeOf<SymbolKind>();
  });

  it('all Phase 1–5 kinds remain valid', () => {
    const kinds: SymbolKind[] = [
      'function', 'class', 'method', 'const', 'type',
      'interface', 'enum', 'component', 'composable',
      'hook', 'route', 'decorator', 'middleware',
      'model', 'view', 'struct', 'macro', 'signal',
    ];
    expectTypeOf(kinds).toMatchTypeOf<SymbolKind[]>();
  });
});
