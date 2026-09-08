/**
 * Phase 96 — query-vocabulary follow-ups (retrieval-side).
 *
 * Task 597: `register → add` verb synonym (nuxt gt-24 finisher — the addX
 * registration-API family: addEventListener, addServerHandler, addPlugin,
 * add_action). One direction only: `add` stays a plain generic word.
 *
 * Task 598 (-tion nominalisation stems) was measured and reverted — see the
 * note at the end of this file.
 *
 * Evidence: dev-docs/in-progress/phase95-margins.md, dev-docs/PHASE96_TASKS.md.
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import {
  expandVerbSynonyms,
  preprocessQuery,
  toOrFallbackQuery,
} from '../../src/core/search/query-preprocessor.js';
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
    signature: opts.signature ?? name,
    summary: opts.summary ?? '',
  };
}

const overlapOf = (name: string, query: string, kind: SymbolRecord['kind'] = 'function') =>
  rankSymbols([sym(name, { kind })], query, true)[0]!.debugScore!.wordOverlap;

// ─── Task 597 — register → add ───────────────────────────────────────────────

describe('Phase 96 Task 597 — register → add synonym', () => {
  it('register expands to add (and keeps subscribe/listen)', () => {
    const syns = expandVerbSynonyms('register');
    expect(syns).toContain('add');
    expect(syns).toContain('subscribe');
    expect(syns).toContain('listen');
  });

  it('is one-directional: add does NOT expand to register (add is a generic word)', () => {
    expect(expandVerbSynonyms('add')).not.toContain('register');
  });

  it('retrieval: the AND query carries add inside the register OR-group', () => {
    const q = preprocessQuery('register a server event handler');
    expect(q).toBe('(register OR subscribe OR listen OR add) AND server AND event AND handler');
    // (handler → handle is a pre-existing OR-fallback expansion)
    expect(toOrFallbackQuery(q)).toBe(
      'register OR subscribe OR listen OR add OR server OR event OR handler OR handle',
    );
  });

  it('gt-24 shape: the addX compound beats the bare generic `handler` and the overlap-only competitor', () => {
    const query =
      'register a Nitro server event handler for a specific route pattern and HTTP method';
    const pool = [
      sym('handler', { filePath: 'packages/nitro-server/src/runtime/middleware/no-ssr.ts' }),
      sym('normalizeHandlerMethod', {
        filePath: 'packages/kit/src/nitro.ts',
        signature: 'normalizeHandlerMethod(handler: NitroEventHandler)',
      }),
      sym('addServerHandler', {
        filePath: 'packages/kit/src/nitro.ts',
        signature: 'addServerHandler(handler: NitroEventHandler)',
      }),
    ];
    const ranked = rankSymbols(pool, query, true);
    expect(ranked[0]!.symbol.name).toBe('addServerHandler');
    const target = ranked.find((r) => r.symbol.name === 'addServerHandler')!;
    // every part (add / server / handler) is now a query word → the Phase-95
    // counterweight fires against the pool's ÷3-scaled bare `handler`
    expect(target.debugScore!.camelCompoundBoost).toBe(30);
    const bare = ranked.find((r) => r.symbol.name === 'handler')!;
    expect(bare.debugScore!.identityExact).toBe(20);
  });

  it('negative (registerUser shape): a bare `register` carrying identity still beats an addX competitor', () => {
    const query = 'register a new user account with email and password';
    const pool = [
      sym('add', { filePath: 'src/users/util.ts' }),
      sym('addUser', { filePath: 'src/users/service.ts' }),
      sym('register', { filePath: 'src/auth/decorators.ts' }),
    ];
    const ranked = rankSymbols(pool, query, true);
    expect(ranked[0]!.symbol.name).toBe('register');
    // register is NOT a generic word — full identity, never scaled
    expect(ranked[0]!.debugScore!.identityExact).toBe(60);
  });

  it('nestjs gt-01 guard shape: the register-named service method still wins its real pool', () => {
    // AuthService.register has no identityExact (dotted name) — it wins on the
    // service kindBoost + methodVerbBonus. Accepted trade-off, documented: a
    // sibling `XService.addUser` would match TWO query words (add + user) and
    // out-overlap it; no such sibling exists in the real pool (replay + sweep
    // `phase96-597` guard it).
    const query = 'register a new user account with email and password';
    const pool = [
      sym('UsersService.changePassword', {
        kind: 'method',
        filePath: 'src/modules/users/users.service.ts',
        signature: 'UsersService.changePassword(userId: string, dto: ChangePasswordDto)',
      }),
      sym('AuthListener.handleUserRegistered', {
        kind: 'method',
        filePath: 'src/modules/notifications/listeners/auth.listener.ts',
        signature: 'AuthListener.handleUserRegistered(event: UserRegisteredEvent)',
      }),
      sym('AuthService.register', {
        kind: 'method',
        filePath: 'src/modules/auth/auth.service.ts',
        signature: 'AuthService.register(dto: RegisterDto)',
      }),
    ];
    const ranked = rankSymbols(pool, query, true);
    expect(ranked[0]!.symbol.name).toBe('AuthService.register');
  });
});

// Task 598 (-tion nominalisation → verb-family stems) was built, measured and
// REVERTED in-phase: gt-22 rose only 75 → 7 (an identity-credit wall), while
// "cursor navigation" / "with rotation" — context nouns — lifted verb-named
// siblings over the expected symbols (novu P@1 −4, excalidraw P@3 −4). See
// dev-docs/in-progress/phase96-findings.md. No test enshrines the gap.
