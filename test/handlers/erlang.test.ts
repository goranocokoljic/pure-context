import { describe, it, expect } from 'vitest';
import { erlangHandler } from '../../src/handlers/erlang.js';
import type { Tree } from '../../src/core/types.js';

// Erlang handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('Erlang handler — extractSymbols', () => {

  // ── -module → 'class' ─────────────────────────────────────────────────────

  it('extracts -module as kind "class"', () => {
    const { tree, buf } = parse(`-module(myapp).\n`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'myapp.erl');
    const sym = syms.find((s) => s.name === 'myapp');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('-module(myapp)');
  });

  // ── -record → 'class' ─────────────────────────────────────────────────────

  it('extracts -record as kind "class"', () => {
    const { tree, buf } = parse(`-record(user, {id, name, email}).\n`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'user.erl');
    const sym = syms.find((s) => s.name === 'user');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('user');
  });

  // ── -type → 'type' ────────────────────────────────────────────────────────

  it('extracts -type as kind "type"', () => {
    const { tree, buf } = parse(`-type status() :: active | inactive | banned.\n`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'types.erl');
    const sym = syms.find((s) => s.name === 'status');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('status');
  });

  it('extracts -opaque as kind "type"', () => {
    const { tree, buf } = parse(`-opaque token() :: binary().\n`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'token.erl');
    const sym = syms.find((s) => s.name === 'token');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
  });

  // ── function extraction ───────────────────────────────────────────────────

  it('extracts function with arity in name: name/arity', () => {
    const { tree, buf } = parse(`
-module(math_utils).

add(A, B) ->
    A + B.
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'math_utils.erl');
    const sym = syms.find((s) => s.name === 'add/2');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('add/2');
  });

  it('extracts zero-arity function as name/0', () => {
    const { tree, buf } = parse(`
start() ->
    ok.
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'app.erl');
    const sym = syms.find((s) => s.name === 'start/0');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  it('extracts function with complex params and correct arity', () => {
    const { tree, buf } = parse(`
create_user(Name, Email, Role) ->
    #user{name=Name, email=Email, role=Role}.
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'user.erl');
    const sym = syms.find((s) => s.name === 'create_user/3');
    expect(sym).toBeDefined();
  });

  // ── multiple clauses → single symbol ─────────────────────────────────────

  it('emits one symbol for a function with multiple clauses', () => {
    const { tree, buf } = parse(`
classify(X) when X > 0 -> positive;
classify(X) when X < 0 -> negative;
classify(0) -> zero.
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'classify.erl');
    const fns = syms.filter((s) => s.name === 'classify/1');
    expect(fns).toHaveLength(1);
  });

  it('emits separate symbols for functions with different arities', () => {
    const { tree, buf } = parse(`
greet() ->
    "Hello!".

greet(Name) ->
    "Hello, " ++ Name ++ "!".
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'greet.erl');
    expect(syms.find((s) => s.name === 'greet/0')).toBeDefined();
    expect(syms.find((s) => s.name === 'greet/1')).toBeDefined();
  });

  // ── -spec used as signature ───────────────────────────────────────────────

  it('uses -spec as signature for the function', () => {
    const { tree, buf } = parse(`
-spec get_user(integer()) -> {ok, user()} | {error, not_found}.
get_user(Id) ->
    db:lookup(users, Id).
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'user.erl');
    const sym = syms.find((s) => s.name === 'get_user/1');
    expect(sym).toBeDefined();
    expect(sym!.signature).toContain('get_user');
    expect(sym!.signature).toContain('integer()');
  });

  it('uses -spec with multiple args as signature', () => {
    const { tree, buf } = parse(`
-spec send_email(binary(), binary(), binary()) -> ok | {error, term()}.
send_email(To, Subject, Body) ->
    mailer:send(To, Subject, Body).
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'mailer.erl');
    const sym = syms.find((s) => s.name === 'send_email/3');
    expect(sym).toBeDefined();
    expect(sym!.signature).toContain('binary()');
  });

  // ── EDoc comment as summary ───────────────────────────────────────────────

  it('uses %% @doc comment as summary', () => {
    const { tree, buf } = parse(
      `%% @doc Returns the user record for the given ID.\nget_user(Id) ->\n    db:find(Id).\n`,
    );
    const syms = erlangHandler.extractSymbols(tree, buf, 'user.erl');
    const sym = syms.find((s) => s.name === 'get_user/1');
    expect(sym!.summary).toContain('Returns the user record');
  });

  it('uses plain %% comment as summary when no @doc present', () => {
    const { tree, buf } = parse(
      `%% Validates the input parameters.\nvalidate(X) ->\n    X > 0.\n`,
    );
    const syms = erlangHandler.extractSymbols(tree, buf, 'val.erl');
    const sym = syms.find((s) => s.name === 'validate/1');
    expect(sym!.summary).toContain('Validates the input');
  });

  it('uses %% comment when -spec appears between comment and function', () => {
    const { tree, buf } = parse(`
%% @doc Looks up a key in the cache.
-spec lookup(term()) -> {ok, term()} | miss.
lookup(Key) ->
    ets:lookup(cache, Key).
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'cache.erl');
    const sym = syms.find((s) => s.name === 'lookup/1');
    expect(sym!.summary).toContain('Looks up a key');
  });

  // ── complete module example ───────────────────────────────────────────────

  it('extracts all symbols from a complete module', () => {
    const { tree, buf } = parse(`
-module(user_service).

-export([get_user/1, create_user/2, list_users/0]).

-record(user, {id, name, email}).

-type user_id() :: integer().

%% @doc Retrieve a user by ID.
-spec get_user(user_id()) -> {ok, #user{}} | {error, not_found}.
get_user(Id) ->
    db:find(users, Id).

%% @doc Create a new user.
create_user(Name, Email) ->
    #user{id=generate_id(), name=Name, email=Email}.

list_users() ->
    db:all(users).
`);
    const syms = erlangHandler.extractSymbols(tree, buf, 'user_service.erl');
    const names = syms.map((s) => s.name);
    expect(names).toContain('user_service');  // module
    expect(names).toContain('user');           // record
    expect(names).toContain('user_id');        // type
    expect(names).toContain('get_user/1');
    expect(names).toContain('create_user/2');
    expect(names).toContain('list_users/0');
  });

  // ── byte offsets ──────────────────────────────────────────────────────────

  it('sets non-zero startByte and endByte for functions', () => {
    const { tree, buf } = parse(`\nfoo(X) ->\n    X + 1.\n`);
    const sym = erlangHandler.extractSymbols(tree, buf, 'foo.erl').find((s) => s.name === 'foo/1')!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });

  // ── deterministic ID ─────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`add(A, B) -> A + B.\n`);
    const sym = erlangHandler.extractSymbols(tree, buf, 'math.erl').find((s) => s.name === 'add/2')!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = erlangHandler.extractSymbols(tree, buf, 'math.erl').find((s) => s.name === 'add/2')!;
    expect(sym2.id).toBe(sym.id);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('Erlang handler — extractImports', () => {

  it('extracts -import statement as ImportRecords', () => {
    const { tree, buf } = parse(`-import(lists, [map/2, filter/2, foldl/3]).\n`);
    const imports = erlangHandler.extractImports(tree, buf);
    expect(imports.length).toBe(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('lists:map/2');
    expect(specs).toContain('lists:filter/2');
    expect(specs).toContain('lists:foldl/3');
  });

  it('sets importedNames to the function name without arity', () => {
    const { tree, buf } = parse(`-import(lists, [map/2]).\n`);
    const imports = erlangHandler.extractImports(tree, buf);
    expect(imports[0]!.importedNames).toContain('map');
  });

  it('marks all Erlang imports as external (resolvedPath null)', () => {
    const { tree, buf } = parse(`-import(lists, [map/2]).\n`);
    const imports = erlangHandler.extractImports(tree, buf);
    expect(imports[0]!.resolvedPath).toBeNull();
  });

  it('deduplicates repeated import entries', () => {
    const { tree, buf } = parse(
      `-import(lists, [map/2]).\n-import(lists, [map/2]).\n`,
    );
    const imports = erlangHandler.extractImports(tree, buf);
    expect(imports).toHaveLength(1);
  });

  it('returns empty array for files with no -import', () => {
    const { tree, buf } = parse(`-module(foo).\nfoo() -> ok.\n`);
    expect(erlangHandler.extractImports(tree, buf)).toHaveLength(0);
  });

  it('handles multiple -import declarations', () => {
    const { tree, buf } = parse(`
-import(lists, [map/2, filter/2]).
-import(string, [join/2]).
`);
    const imports = erlangHandler.extractImports(tree, buf);
    expect(imports.length).toBe(3);
    const specs = imports.map((i) => i.specifier);
    expect(specs).toContain('lists:map/2');
    expect(specs).toContain('lists:filter/2');
    expect(specs).toContain('string:join/2');
  });
});
