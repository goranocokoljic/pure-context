/**
 * Phase 94 (Task 584) — qualifier-word damp for TS class fields.
 *
 * TS class fields are named Parent.field, so their split parts contain every
 * parent name word. On parent-concept queries fields outscored sibling
 * methods (angular-realworld: P@3/R@5 −8pp when field extraction landed).
 * Query words matched only via the qualifier segment count half for kind
 * 'property' in .ts/.tsx. Damp only — no parent shadow transfer.
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(
  name: string,
  opts: Partial<Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary'>> = {},
): SymbolRecord {
  return {
    id: `id-${name}-${opts.filePath ?? 'x'}`,
    name,
    kind: opts.kind ?? 'function',
    filePath: opts.filePath ?? 'src/index.ts',
    startByte: 0,
    endByte: 100,
    signature: opts.signature ?? `${name}`,
    summary: opts.summary ?? '',
  };
}

describe('Phase 94 — TS field qualifier damp', () => {
  it('a sibling method outranks a field that matches only via parent words', () => {
    const results = rankSymbols(
      [
        sym('FavoriteButtonComponent.article', {
          kind: 'property',
          filePath: 'src/app/favorite-button.component.ts',
          signature: '@Input() article!: Article',
        }),
        sym('FavoriteButtonComponent.toggleFavorite', {
          kind: 'method',
          filePath: 'src/app/favorite-button.component.ts',
          signature: 'toggleFavorite(): void',
        }),
      ],
      'component button that allows toggling article favorited state',
    );
    expect(results[0]!.symbol.name).toBe('FavoriteButtonComponent.toggleFavorite');
  });

  it('a field whose OWN segment is the query target still wins', () => {
    const results = rankSymbols(
      [
        sym('SettingsComponent.themeConfig', {
          kind: 'property',
          filePath: 'src/app/settings.component.ts',
          signature: 'themeConfig = signal(defaultTheme)',
        }),
        sym('SettingsComponent.save', {
          kind: 'method',
          filePath: 'src/app/settings.component.ts',
          signature: 'save(): void',
        }),
      ],
      'theme config field',
    );
    expect(results[0]!.symbol.name).toBe('SettingsComponent.themeConfig');
  });

  it('does not damp dotted properties outside .ts/.tsx (C# stays untouched)', () => {
    // Identical shapes; only the extension differs. Parent-word-only query:
    // the .cs property keeps full overlap, the .ts field is damped.
    const cs = sym('InvoiceService.Printer', {
      kind: 'property',
      filePath: 'src/InvoiceService.cs',
    });
    const ts = sym('InvoiceService.printer', {
      kind: 'property',
      filePath: 'src/invoice.service.ts',
    });
    const results = rankSymbols([cs, ts], 'invoice service');
    const csScore = results.find((r) => r.symbol.filePath.endsWith('.cs'))!.score;
    const tsScore = results.find((r) => r.symbol.filePath.endsWith('.ts'))!.score;
    expect(csScore).toBeGreaterThan(tsScore);
  });

  it('kind middleware gets the interceptor/guard boost (586 reclassification)', () => {
    // Same symbol shape; only the kind differs. On a "guard" query the
    // middleware row must not score below its old function classification.
    const asMiddleware = rankSymbols(
      [
        sym('premiumInterestRedirectGuard', {
          kind: 'middleware' as never,
          filePath: 'apps/web/src/app/vault/guards/premium.guard.ts',
        }),
      ],
      'route guard checking premium redirect status',
    )[0]!.score;
    const asFunction = rankSymbols(
      [
        sym('premiumInterestRedirectGuard', {
          kind: 'function',
          filePath: 'apps/web/src/app/vault/guards/premium.guard.ts',
        }),
      ],
      'route guard checking premium redirect status',
    )[0]!.score;
    expect(asMiddleware).toBeGreaterThanOrEqual(asFunction);
  });

  it('methods are never damped (Phase 95 owns any global change)', () => {
    // Same name shape as a field but kind method — full overlap kept.
    const method = sym('ProfileComponent.ngOnInit', {
      kind: 'method',
      filePath: 'src/app/profile.component.ts',
    });
    const field = sym('ProfileComponent.destroyRef', {
      kind: 'property',
      filePath: 'src/app/profile.component.ts',
    });
    const results = rankSymbols([method, field], 'profile component initialization');
    expect(results[0]!.symbol.name).toBe('ProfileComponent.ngOnInit');
  });
});
