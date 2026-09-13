/**
 * Phase 105 — Search-Quality Sweep 3 (the repos PureContext does not win).
 *
 * Every lever is gated on a language / kind / handler-meta flag (rule P3):
 *   653a  Scala case class / object → data-definition identity scaling (40/N)
 *   653c  Scala one-word member identity ÷3 on ≥8-word queries
 *   654a  Swift `extension Foo` rows → data-definition identity scaling
 *   654b  "protocol …" / "trait …" kind hint → interface (+35), Swift/ObjC/Scala/Rust files
 *   654c  ObjC class-qualified members: qualifier-half wordOverlap damp
 *   655a  Go structs (`go_struct`) → data-definition identity scaling
 *   655b  C/C++ 'struct' and 'macro' kinds → data-definition identity scaling
 * Findings: dev-docs/in-progress/phase105-findings.md
 */

import { describe, it, expect } from 'vitest';
import { rankSymbols } from '../../src/core/search/relevance-ranker.js';
import type { SymbolRecord } from '../../src/core/types.js';

function sym(
  name: string,
  opts: Partial<
    Pick<SymbolRecord, 'kind' | 'filePath' | 'signature' | 'summary' | 'frameworkMeta'>
  > = {},
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
    ...(opts.frameworkMeta ? { frameworkMeta: opts.frameworkMeta } : {}),
  };
}

const LONG_QUERY = 'method that fetches the paginated list of commits for a given pull request number from GitHub';

describe('Phase 105 Task 653 — Scala data definitions and one-word members', () => {
  it('scales a Scala case class named by one context word to the data-kind identity (40/N, min 10)', () => {
    const [r] = rankSymbols(
      [sym('Commit', { kind: 'class', filePath: 'src/main/scala/model/Github.scala', signature: 'case class Commit(sha: String)', frameworkMeta: { scala_case_class: true } })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(10);
  });

  it('scales a Scala companion/namespace object the same way', () => {
    const [r] = rankSymbols(
      [sym('Github', { kind: 'class', filePath: 'src/main/scala/model/Github.scala', signature: 'object Github', frameworkMeta: { scala_object: true } })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(10);
  });

  it('leaves a plain Scala class at the full identity (a one-word TYPE named by the query is the target)', () => {
    const [r] = rankSymbols(
      [sym('Queue', { kind: 'class', filePath: 'core/src/main/scala/zio/Queue.scala', signature: 'sealed abstract class Queue[A]' })],
      'sealed abstract class for a bounded or unbounded asynchronous FIFO queue',
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('scales a one-word Scala member to ⅓ on a ≥8-word query', () => {
    const [r] = rankSymbols(
      [sym('commit', { kind: 'method', filePath: 'src/main/scala/PullRequestService.scala', signature: 'def commit: Commit' })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(20);
  });

  it('keeps the full identity for a one-word Scala member on a short query', () => {
    const [r] = rankSymbols(
      [sym('commit', { kind: 'method', filePath: 'src/main/scala/PullRequestService.scala', signature: 'def commit: Commit' })],
      'commit accessor of the status',
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('applies the same damp to a one-word member in a non-Scala file (Phase 106 Task 660 made the rule global)', () => {
    const [r] = rankSymbols(
      [sym('commit', { kind: 'method', filePath: 'src/repo/Service.kt', signature: 'fun commit(): Commit' })],
      LONG_QUERY,
      true,
    );
    expect(r!.debugScore!.identityExact).toBe(20);
  });
});

describe('Phase 105 Task 654 — Swift extensions, protocol/trait hint, ObjC members', () => {
  it('scales a Swift extension row named by one query word; the protocol row keeps its interface scaling', () => {
    const results = rankSymbols(
      [
        sym('Middleware', { kind: 'class', filePath: 'Sources/Vapor/Middleware/Middleware.swift', signature: 'extension Middleware', frameworkMeta: { swift_extension: true } }),
        sym('Middleware', { kind: 'interface', filePath: 'Sources/Vapor/Middleware/Middleware.swift', signature: 'public protocol Middleware' }),
      ],
      'base object for middleware that authenticates an incoming request by examining its content',
      true,
    );
    for (const r of results) expect(r.debugScore!.identityExact).toBe(10);
  });

  it('"protocol …" lifts interface rows in Swift files by +35 and leaves structs alone', () => {
    const results = rankSymbols(
      [
        sym('BearerAuthenticator', { kind: 'interface', filePath: 'Sources/Vapor/Authentication/Authenticator.swift', signature: 'public protocol BearerAuthenticator: RequestAuthenticator' }),
        sym('BearerAuthorization', { kind: 'class', filePath: 'Sources/Vapor/Authentication/BearerAuthorization.swift', signature: 'public struct BearerAuthorization' }),
      ],
      'protocol for authentication middleware that validates requests using a Bearer authorization header token',
      true,
    );
    const iface = results.find((r) => r.symbol.kind === 'interface')!;
    const strct = results.find((r) => r.symbol.kind === 'class')!;
    expect(iface.debugScore!.kindHintBoost).toBe(35);
    expect(strct.debugScore!.kindHintBoost).toBe(0);
  });

  it('"trait …" lifts interface rows in Scala and Rust files, never elsewhere', () => {
    const q = 'trait for the read side of a concurrent queue providing take and poll operations';
    const [scala] = rankSymbols([sym('Dequeue', { kind: 'interface', filePath: 'core/src/main/scala/zio/Dequeue.scala' })], q, true);
    const [rust] = rankSymbols([sym('Dequeue', { kind: 'interface', filePath: 'src/dequeue.rs' })], q, true);
    const [ts] = rankSymbols([sym('Dequeue', { kind: 'interface', filePath: 'src/dequeue.ts' })], q, true);
    expect(scala!.debugScore!.kindHintBoost).toBe(35);
    expect(rust!.debugScore!.kindHintBoost).toBe(35);
    expect(ts!.debugScore!.kindHintBoost).toBe(0);
  });

  it('"protocol" in an Erlang or TypeScript query does nothing (P5 audit: emqx, trpc)', () => {
    const [erl] = rankSymbols([sym('info/2', { kind: 'function', filePath: 'src/emqx_channel.erl' })], 'get channel info by key such as clientid or protocol version', true);
    expect(erl!.debugScore!.kindHintBoost).toBe(0);
  });

  it('damps ObjC members for query words matched only through the class qualifier', () => {
    const q = 'model object representing a remote file with binary content and a download trigger';
    const [prop] = rankSymbols(
      [sym('SSFile.content', { kind: 'property', filePath: 'SparkleShare/Classes/SSFile.h', signature: '@property NSData *content' })],
      q, true,
    );
    const [method] = rankSymbols(
      [sym('SSFile:loadContent', { kind: 'method', filePath: 'SparkleShare/Classes/SSFile.m', signature: '- (void)loadContent', frameworkMeta: { isClassMethod: false } })],
      q, true,
    );
    // "file" is matched only via the SSFile qualifier → −5 each; the member
    // segment's own word ("content") is untouched. Control: a .py path (no
    // member damp of any kind applies there).
    const [propUndamped] = rankSymbols(
      [sym('SSFile.content', { kind: 'property', filePath: 'SparkleShare/Classes/SSFile.py', signature: '@property NSData *content' })],
      q, true,
    );
    expect(prop!.debugScore!.wordOverlap).toBe(propUndamped!.debugScore!.wordOverlap - 5);
    expect(method!.debugScore!.wordOverlap).toBeLessThan(propUndamped!.debugScore!.wordOverlap);
  });

  it('never damps a C++ Class::method row in a .h file (no isClassMethod meta)', () => {
    const q = 'model object representing a remote file with binary content and a download trigger';
    const [cpp] = rankSymbols([sym('SSFile::loadContent', { kind: 'method', filePath: 'include/SSFile.h' })], q, true);
    const [objc] = rankSymbols([sym('SSFile::loadContent', { kind: 'method', filePath: 'include/SSFile.h', frameworkMeta: { isClassMethod: true } })], q, true);
    expect(objc!.debugScore!.wordOverlap).toBeLessThan(cpp!.debugScore!.wordOverlap);
  });
});

describe('Phase 105 Task 655 — Go structs, C structs and macros', () => {
  const q = 'queue a campaign message for bulk delivery';

  it('scales a Go struct named by one query word (go_struct meta)', () => {
    const [r] = rankSymbols(
      [sym('Campaign', { kind: 'class', filePath: 'models/campaigns.go', signature: 'type Campaign struct', frameworkMeta: { go_struct: true } })],
      q, true,
    );
    expect(r!.debugScore!.identityExact).toBe(10);
  });

  it('leaves an un-tagged class at the full identity', () => {
    const [r] = rankSymbols([sym('Campaign', { kind: 'class', filePath: 'models/campaigns.go' })], q, true);
    expect(r!.debugScore!.identityExact).toBe(60);
  });

  it('scales C struct and macro kinds', () => {
    const cq = 'decrypt a WEP-encrypted packet payload';
    const [s] = rankSymbols([sym('packet', { kind: 'struct', filePath: 'src/wpaclean.c' })], cq, true);
    const [m] = rankSymbols([sym('WEP', { kind: 'macro', filePath: 'src/ivstools.c' })], cq, true);
    const [f] = rankSymbols([sym('packet', { kind: 'function', filePath: 'src/wpaclean.c' })], cq, true);
    expect(s!.debugScore!.identityExact).toBe(10);
    expect(m!.debugScore!.identityExact).toBe(10);
    // Phase 106 (Task 660): the one-word FUNCTION is now damped to ⅓ too once the
    // query expands to ≥8 queryWords (stems + synonyms) — it was 60 in Phase 105.
    expect(f!.debugScore!.identityExact).toBe(20);
  });
});
