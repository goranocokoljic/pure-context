import { describe, it, expect } from 'vitest';
import { openApiHandler } from '../../src/handlers/openapi.js';
import type { Tree } from '../../src/core/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OPENAPI_3_YAML = `
openapi: "3.0.3"
info:
  title: Test API
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      summary: List all users
      tags: [users]
      parameters: []
      responses:
        "200":
          description: OK
    post:
      operationId: createUser
      summary: Create a user
      tags: [users]
      requestBody:
        required: true
      responses:
        "201":
          description: Created
  /users/{id}:
    get:
      operationId: getUser
      summary: Get a user by ID
      tags: [users]
      responses:
        "200":
          description: OK
    delete:
      operationId: deleteUser
      summary: Delete a user
      responses:
        "204":
          description: No Content
components:
  schemas:
    User:
      description: A user object
      properties:
        id:
          type: string
        email:
          type: string
        name:
          type: string
      required: [id, email]
    Error:
      description: Error response
      properties:
        code:
          type: integer
        message:
          type: string
`.trimStart();

const SWAGGER_2_YAML = `
swagger: "2.0"
info:
  title: Swagger Test
  version: "1.0"
paths:
  /items:
    get:
      operationId: listItems
      summary: List all items
      responses:
        200:
          description: OK
    post:
      summary: Create an item
      responses:
        201:
          description: Created
definitions:
  Item:
    description: An item
    properties:
      id:
        type: integer
      name:
        type: string
    required: [id]
`.trimStart();

const OPENAPI_3_JSON = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'JSON API', version: '1.0.0' },
  paths: {
    '/health': {
      get: {
        operationId: 'healthCheck',
        summary: 'Health check',
        responses: { '200': { description: 'OK' } },
      },
    },
  },
  components: {
    schemas: {
      HealthResponse: {
        description: 'Health status',
        properties: { status: { type: 'string' } },
      },
    },
  },
});

const NON_OPENAPI_YAML = `
name: my-project
version: "1.0.0"
description: Just a config file
dependencies:
  foo: "^1.0.0"
`.trimStart();

const NON_OPENAPI_JSON = JSON.stringify({
  name: 'my-package',
  version: '1.0.0',
  scripts: { build: 'tsc' },
});

// ─── detect() ─────────────────────────────────────────────────────────────────

describe('openApiHandler.detect()', () => {
  it('returns true for OpenAPI 3.x YAML', () => {
    expect(openApiHandler.detect!(Buffer.from(OPENAPI_3_YAML))).toBe(true);
  });

  it('returns true for Swagger 2.0 YAML', () => {
    expect(openApiHandler.detect!(Buffer.from(SWAGGER_2_YAML))).toBe(true);
  });

  it('returns true for OpenAPI 3.x JSON', () => {
    expect(openApiHandler.detect!(Buffer.from(OPENAPI_3_JSON))).toBe(true);
  });

  it('returns false for a plain config YAML (no openapi/swagger key)', () => {
    expect(openApiHandler.detect!(Buffer.from(NON_OPENAPI_YAML))).toBe(false);
  });

  it('returns false for package.json', () => {
    expect(openApiHandler.detect!(Buffer.from(NON_OPENAPI_JSON))).toBe(false);
  });
});

// ─── grammarPath() ────────────────────────────────────────────────────────────

describe('openApiHandler.grammarPath()', () => {
  it('returns null (no tree-sitter grammar)', () => {
    expect(openApiHandler.grammarPath()).toBeNull();
  });
});

// ─── extensions() ────────────────────────────────────────────────────────────

describe('openApiHandler.extensions()', () => {
  it('claims .yaml, .yml, .json', () => {
    expect(openApiHandler.extensions()).toEqual(
      expect.arrayContaining(['.yaml', '.yml', '.json']),
    );
  });
});

// ─── OpenAPI 3.x path extraction ─────────────────────────────────────────────

describe('openApiHandler — OpenAPI 3.x path extraction', () => {
  const buf = Buffer.from(OPENAPI_3_YAML);
  const syms = () =>
    openApiHandler.extractSymbols(null as unknown as Tree, buf, 'api/openapi.yaml');

  it('extracts GET /users', () => {
    const s = syms().find((x) => x.name === 'GET /users');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
    expect(s!.filePath).toBe('api/openapi.yaml');
  });

  it('extracts POST /users', () => {
    const s = syms().find((x) => x.name === 'POST /users');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('function');
  });

  it('extracts GET /users/{id}', () => {
    const s = syms().find((x) => x.name === 'GET /users/{id}');
    expect(s).toBeDefined();
  });

  it('extracts DELETE /users/{id}', () => {
    const s = syms().find((x) => x.name === 'DELETE /users/{id}');
    expect(s).toBeDefined();
  });

  it('sets summary from operation.summary', () => {
    const s = syms().find((x) => x.name === 'GET /users');
    expect(s!.summary).toBe('List all users');
  });

  it('sets signature from operationId', () => {
    const s = syms().find((x) => x.name === 'GET /users');
    expect(s!.signature).toBe('listUsers');
  });

  it('includes method, path, tags in frameworkMeta', () => {
    const s = syms().find((x) => x.name === 'GET /users');
    expect(s!.frameworkMeta).toMatchObject({
      method: 'GET',
      path: '/users',
      tags: ['users'],
    });
  });

  it('generates a deterministic 16-char hex id', () => {
    const s = syms().find((x) => x.name === 'GET /users');
    expect(s!.id).toHaveLength(16);
    expect(s!.id).toMatch(/^[0-9a-f]+$/);
    const s2 = syms().find((x) => x.name === 'GET /users');
    expect(s2!.id).toBe(s!.id);
  });
});

// ─── OpenAPI 3.x schema extraction ───────────────────────────────────────────

describe('openApiHandler — OpenAPI 3.x schema extraction', () => {
  const buf = Buffer.from(OPENAPI_3_YAML);
  const syms = () =>
    openApiHandler.extractSymbols(null as unknown as Tree, buf, 'api/openapi.yaml');

  it('extracts User schema as class', () => {
    const s = syms().find((x) => x.name === 'User');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
  });

  it('extracts Error schema as class', () => {
    const s = syms().find((x) => x.name === 'Error');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
  });

  it('sets summary from schema.description', () => {
    const s = syms().find((x) => x.name === 'User');
    expect(s!.summary).toBe('A user object');
  });

  it('signature lists top-level properties', () => {
    const s = syms().find((x) => x.name === 'User');
    expect(s!.signature).toContain('User');
    expect(s!.signature).toContain('id');
  });

  it('includes properties and required in frameworkMeta', () => {
    const s = syms().find((x) => x.name === 'User');
    expect(s!.frameworkMeta).toMatchObject({
      properties: expect.arrayContaining(['id', 'email', 'name']),
      required: ['id', 'email'],
    });
  });
});

// ─── Swagger 2.x ─────────────────────────────────────────────────────────────

describe('openApiHandler — Swagger 2.0', () => {
  const buf = Buffer.from(SWAGGER_2_YAML);
  const syms = () =>
    openApiHandler.extractSymbols(null as unknown as Tree, buf, 'swagger.yaml');

  it('extracts GET /items', () => {
    expect(syms().find((x) => x.name === 'GET /items')).toBeDefined();
  });

  it('extracts POST /items', () => {
    expect(syms().find((x) => x.name === 'POST /items')).toBeDefined();
  });

  it('extracts Item definition as class', () => {
    const s = syms().find((x) => x.name === 'Item');
    expect(s).toBeDefined();
    expect(s!.kind).toBe('class');
    expect(s!.summary).toBe('An item');
  });
});

// ─── JSON format ──────────────────────────────────────────────────────────────

describe('openApiHandler — JSON format', () => {
  const buf = Buffer.from(OPENAPI_3_JSON);
  const syms = () =>
    openApiHandler.extractSymbols(null as unknown as Tree, buf, 'openapi.json');

  it('extracts GET /health from JSON spec', () => {
    expect(syms().find((x) => x.name === 'GET /health')).toBeDefined();
  });

  it('extracts HealthResponse schema from JSON spec', () => {
    expect(syms().find((x) => x.name === 'HealthResponse')).toBeDefined();
  });
});

// ─── Non-OpenAPI files ────────────────────────────────────────────────────────

describe('openApiHandler — non-OpenAPI files', () => {
  it('returns empty symbols for plain YAML', () => {
    const buf = Buffer.from(NON_OPENAPI_YAML);
    const syms = openApiHandler.extractSymbols(
      null as unknown as Tree,
      buf,
      'config.yaml',
    );
    expect(syms).toHaveLength(0);
  });

  it('returns empty symbols for package.json', () => {
    const buf = Buffer.from(NON_OPENAPI_JSON);
    const syms = openApiHandler.extractSymbols(
      null as unknown as Tree,
      buf,
      'package.json',
    );
    expect(syms).toHaveLength(0);
  });
});

// ─── extractImports ───────────────────────────────────────────────────────────

describe('openApiHandler.extractImports()', () => {
  it('always returns empty array', () => {
    const buf = Buffer.from(OPENAPI_3_YAML);
    expect(
      openApiHandler.extractImports(null as unknown as Tree, buf),
    ).toHaveLength(0);
  });
});

// ─── extractDocstring ─────────────────────────────────────────────────────────

describe('openApiHandler.extractDocstring()', () => {
  it('always returns null', () => {
    expect(openApiHandler.extractDocstring(null as unknown as any)).toBeNull();
  });
});
