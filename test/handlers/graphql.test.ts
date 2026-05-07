import { describe, it, expect } from 'vitest';
import { graphqlHandler } from '../../src/handlers/graphql.js';
import type { Tree } from '../../src/core/types.js';

// GraphQL handler is regex-based (grammarPath returns null) — no tree-sitter needed.
// Pass null as the tree; extractSymbols/extractImports ignore it.
function parse(source: string) {
  const buf = Buffer.from(source);
  return { tree: null as unknown as Tree, buf };
}

// ─── extractSymbols ───────────────────────────────────────────────────────────

describe('GraphQL handler — extractSymbols', () => {

  // ── type → class ──────────────────────────────────────────────────────────

  it('extracts type as kind "class"', () => {
    const { tree, buf } = parse(`
type User {
  id: ID!
  name: String!
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('type User');
  });

  it('extracts type with implements clause', () => {
    const { tree, buf } = parse(`
type User implements Node & Timestamps {
  id: ID!
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('implements');
  });

  // ── interface → interface ─────────────────────────────────────────────────

  it('extracts interface as kind "interface"', () => {
    const { tree, buf } = parse(`
interface Node {
  id: ID!
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'Node');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('interface');
    expect(sym!.signature).toContain('interface Node');
  });

  // ── enum → enum ───────────────────────────────────────────────────────────

  it('extracts enum as kind "enum"', () => {
    const { tree, buf } = parse(`
enum Status {
  ACTIVE
  INACTIVE
  PENDING
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'Status');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('enum');
    expect(sym!.signature).toContain('enum Status');
  });

  // ── input → class ────────────────────────────────────────────────────────

  it('extracts input type as kind "class"', () => {
    const { tree, buf } = parse(`
input CreateUserInput {
  name: String!
  email: String!
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'CreateUserInput');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('class');
    expect(sym!.signature).toContain('input CreateUserInput');
  });

  // ── scalar → type ────────────────────────────────────────────────────────

  it('extracts scalar as kind "type"', () => {
    const { tree, buf } = parse(`scalar DateTime\n`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'DateTime');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('type');
    expect(sym!.signature).toContain('scalar DateTime');
  });

  // ── directive → decorator ─────────────────────────────────────────────────

  it('extracts directive as kind "decorator"', () => {
    const { tree, buf } = parse(
      `directive @auth(role: String) on FIELD_DEFINITION\n`,
    );
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'auth');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('decorator');
    expect(sym!.signature).toContain('directive @auth');
  });

  // ── query → function ─────────────────────────────────────────────────────

  it('extracts named query as kind "function"', () => {
    const { tree, buf } = parse(`
query GetUser($id: ID!) {
  user(id: $id) {
    id
    name
  }
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'operations.graphql');
    const sym = syms.find((s) => s.name === 'GetUser');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
    expect(sym!.signature).toContain('query GetUser');
  });

  // ── mutation → function ──────────────────────────────────────────────────

  it('extracts named mutation as kind "function"', () => {
    const { tree, buf } = parse(`
mutation CreateUser($input: CreateUserInput!) {
  createUser(input: $input) {
    id
  }
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'operations.graphql');
    const sym = syms.find((s) => s.name === 'CreateUser');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  // ── subscription → function ──────────────────────────────────────────────

  it('extracts named subscription as kind "function"', () => {
    const { tree, buf } = parse(`
subscription OnMessage {
  messageAdded {
    id
  }
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'operations.graphql');
    const sym = syms.find((s) => s.name === 'OnMessage');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('function');
  });

  // ── fragment → const ─────────────────────────────────────────────────────

  it('extracts fragment as kind "const"', () => {
    const { tree, buf } = parse(`
fragment UserFields on User {
  id
  name
  email
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'fragments.graphql');
    const sym = syms.find((s) => s.name === 'UserFields');
    expect(sym).toBeDefined();
    expect(sym!.kind).toBe('const');
    expect(sym!.signature).toContain('fragment UserFields on User');
  });

  // ── extend type is skipped ───────────────────────────────────────────────

  it('does not emit symbol for extend type block', () => {
    const { tree, buf } = parse(`
type User {
  id: ID!
}

extend type User {
  email: String
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const userSyms = syms.filter((s) => s.name === 'User');
    // Should only have the original type, not the extend
    expect(userSyms).toHaveLength(1);
  });

  // ── triple-quoted docstring as summary ───────────────────────────────────

  it('uses inline """...""" docstring as summary', () => {
    const { tree, buf } = parse(`"""A user in the system."""\ntype User {\n  id: ID!\n}\n`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym!.summary).toContain('user in the system');
  });

  it('uses multi-line """...""" docstring as summary', () => {
    const { tree, buf } = parse(`"""\nA user in the system.\n"""\ntype User {\n  id: ID!\n}\n`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym!.summary).toContain('user in the system');
  });

  // ── # comment as summary ─────────────────────────────────────────────────

  it('uses preceding # comment as summary', () => {
    const { tree, buf } = parse(`# Represents a user.\ntype User {\n  id: ID!\n}\n`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'schema.graphql');
    const sym = syms.find((s) => s.name === 'User');
    expect(sym!.summary).toContain('Represents a user');
  });

  // ── deterministic ID ─────────────────────────────────────────────────────

  it('generates a deterministic 16-char hex ID', () => {
    const { tree, buf } = parse(`type Foo {\n  id: ID!\n}\n`);
    const sym = graphqlHandler.extractSymbols(tree, buf, 'foo.graphql')[0]!;
    expect(sym.id).toHaveLength(16);
    expect(sym.id).toMatch(/^[0-9a-f]+$/);
    const sym2 = graphqlHandler.extractSymbols(tree, buf, 'foo.graphql')[0]!;
    expect(sym2.id).toBe(sym.id);
  });

  // ── full schema file ─────────────────────────────────────────────────────

  it('extracts multiple symbol types from a full schema file', () => {
    const { tree, buf } = parse(`
scalar DateTime

interface Node {
  id: ID!
}

enum Status {
  ACTIVE
  INACTIVE
}

input CreateUserInput {
  name: String!
}

type User implements Node {
  id: ID!
  name: String!
  status: Status!
  createdAt: DateTime
}

directive @auth(role: String) on FIELD_DEFINITION

query GetUser($id: ID!) {
  user(id: $id) { id name }
}

fragment UserFields on User {
  id
  name
}
`);
    const syms = graphqlHandler.extractSymbols(tree, buf, 'full.graphql');
    const names = syms.map((s) => s.name);
    expect(names).toContain('DateTime');
    expect(names).toContain('Node');
    expect(names).toContain('Status');
    expect(names).toContain('CreateUserInput');
    expect(names).toContain('User');
    expect(names).toContain('auth');
    expect(names).toContain('GetUser');
    expect(names).toContain('UserFields');
  });

  // ── byte offsets ─────────────────────────────────────────────────────────

  it('sets non-zero startByte and endByte for block types', () => {
    const { tree, buf } = parse(`\ntype Foo {\n  id: ID!\n}\n`);
    const sym = graphqlHandler.extractSymbols(tree, buf, 'foo.graphql')[0]!;
    expect(sym.startByte).toBeGreaterThan(0);
    expect(sym.endByte).toBeGreaterThan(sym.startByte);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('GraphQL handler — extractImports', () => {

  it('returns empty array (GraphQL has no native import syntax)', () => {
    const { tree, buf } = parse(`
type User {
  id: ID!
}
query GetUser { user { id } }
`);
    expect(graphqlHandler.extractImports(tree, buf)).toHaveLength(0);
  });
});
