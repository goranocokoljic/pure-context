import { createHash } from 'crypto';
import yaml from 'js-yaml';
import type {
  LanguageHandler,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  SyntaxNode,
  Tree,
} from '../core/types.js';

// ─── Symbol ID ────────────────────────────────────────────────────────────────

function makeId(filePath: string, name: string, kind: SymbolKind): string {
  return createHash('sha256')
    .update(`${filePath}:${name}:${kind}`)
    .digest('hex')
    .slice(0, 16);
}

// ─── Spec types ───────────────────────────────────────────────────────────────

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
  trace?: OpenApiOperation;
}

interface JsonSchema {
  description?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  type?: string;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, OpenApiPathItem>;
  // OpenAPI 3.x
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
  // Swagger 2.x
  definitions?: Record<string, JsonSchema>;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

// ─── Path summary enrichment (Task 435) ──────────────────────────────────────

const METHOD_VERBS: Readonly<Record<string, readonly string[]>> = {
  POST:    ['create', 'add', 'submit'],
  GET:     ['retrieve', 'fetch', 'list', 'read'],
  PUT:     ['update', 'replace', 'modify'],
  PATCH:   ['update', 'modify', 'patch'],
  DELETE:  ['delete', 'remove', 'destroy'],
};

/**
 * Enrich a path operation summary with HTTP-verb semantics and path tokens so
 * natural-language queries ("retrieve customers", "create payment intent") find
 * the relevant endpoint via FTS even when the operation has no summary text.
 */
function enrichPathSummary(method: string, path: string, op: OpenApiOperation): string {
  const verbs = METHOD_VERBS[method] ?? [];
  const baseSummary = op.summary ?? op.description ?? '';
  // Tokenise the URL path: drop leading slash, split on / { }
  const pathTokens = path.replace(/^\//, '').split(/[/{}]/).filter(Boolean).join(' ');
  return [verbs.join(' '), baseSummary, pathTokens].filter(Boolean).join(' — ').slice(0, 200);
}

// ─── Byte-offset helpers ──────────────────────────────────────────────────────

/**
 * One-pass index of mapping-key → byte offset over the whole source.
 *
 * Large real-world specs (GitHub ~10–30 MB, Stripe ~7–20 MB) contain thousands
 * of paths/schemas; scanning the full buffer per key (the old findKeyOffset
 * behaviour) made extraction O(keys × bytes) — minutes per file. This builds
 * the offsets in two O(bytes) regex passes; findKeyOffset falls back to the
 * old scan only on a map miss.
 */
function buildKeyOffsetIndex(source: Buffer): Map<string, number> {
  const map = new Map<string, number>();
  const text = source.toString('utf8');
  // Char offsets equal byte offsets only for pure-ASCII content; otherwise
  // convert incrementally (matches arrive in ascending index order per pass).
  const ascii = text.length === source.length;

  const record = (key: string, charIdx: number, cursor: { char: number; byte: number }) => {
    if (map.has(key)) return;
    let byteIdx = charIdx;
    if (!ascii) {
      cursor.byte += Buffer.byteLength(text.slice(cursor.char, charIdx), 'utf8');
      cursor.char = charIdx;
      byteIdx = cursor.byte;
    }
    map.set(key, byteIdx);
  };

  // Pass 1 — line-anchored keys (YAML and pretty-printed JSON):
  //   key: … | "key": … | 'key': … | - key: …
  const lineKey = /^[ \t]*(?:- )?(?:"([^"\n]*)"|'([^'\n]*)'|([^\s'"#\n][^:\n]*?))[ \t]*:(?=[ \t]|$)/gm;
  const cursor1 = { char: 0, byte: 0 };
  for (let m = lineKey.exec(text); m; m = lineKey.exec(text)) {
    const key = m[1] ?? m[2] ?? m[3];
    if (key === undefined) continue;
    // Offset of the key itself (skip "  - " style indentation), mirroring the
    // old behaviour of pointing at the opening quote for quoted forms.
    const keyStart = m[0].indexOf(m[1] !== undefined ? `"${m[1]}"` : m[2] !== undefined ? `'${m[2]}'` : key);
    record(key, m.index + Math.max(0, keyStart), cursor1);
  }

  // Pass 2 — quoted keys anywhere (covers minified JSON on one giant line).
  const jsonKey = /"((?:[^"\\\n]|\\.)*)"[ \t]*:/g;
  const cursor2 = { char: 0, byte: 0 };
  for (let m = jsonKey.exec(text); m; m = jsonKey.exec(text)) {
    record(m[1], m.index, cursor2);
  }

  return map;
}

/**
 * Search the raw source Buffer for the first occurrence of `key` as a YAML/JSON
 * mapping key, returning the byte offset of the match (or 0 if not found).
 *
 * We look for patterns like:
 *   "key":      (JSON)
 *   'key':      (YAML single-quoted)
 *    key:       (YAML bare)
 */
function findKeyOffset(source: Buffer, key: string, index?: Map<string, number>): number {
  const indexed = index?.get(key);
  if (indexed !== undefined) return indexed;
  // Try JSON double-quoted form first
  const jsonForm = `"${key}"`;
  let idx = source.indexOf(jsonForm);
  if (idx >= 0) return idx;

  // YAML single-quoted
  const sqForm = `'${key}'`;
  idx = source.indexOf(sqForm);
  if (idx >= 0) return idx;

  // YAML bare key (key followed by colon — avoid partial matches)
  const bareForm = `${key}:`;
  idx = source.indexOf(bareForm);
  return idx >= 0 ? idx : 0;
}

// ─── Path extraction ──────────────────────────────────────────────────────────

function extractPaths(spec: OpenApiSpec, source: Buffer, filePath: string, keyIndex?: Map<string, number>): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  if (!spec.paths) return symbols;

  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const op = item[method as HttpMethod] as OpenApiOperation | undefined;
      if (!op) continue;

      const methodUpper = method.toUpperCase();
      const name = `${methodUpper} ${path}`;
      const kind: SymbolKind = 'function';

      const signature = op.operationId
        ? op.operationId
        : `${methodUpper} ${path}`.slice(0, 120);

      const summary = enrichPathSummary(methodUpper, path, op);

      const startByte = findKeyOffset(source, path, keyIndex);
      const endByte = startByte + Buffer.byteLength(path, 'utf8');

      symbols.push({
        id: makeId(filePath, name, kind),
        name,
        kind,
        filePath,
        startByte,
        endByte,
        signature: signature.slice(0, 120),
        summary: summary.slice(0, 200),
        frameworkMeta: {
          method: methodUpper,
          path,
          operationId: op.operationId ?? null,
          tags: op.tags ?? [],
          parameters: op.parameters ?? [],
          requestBody: op.requestBody ?? null,
        },
      });
    }
  }

  return symbols;
}

// ─── Schema extraction ────────────────────────────────────────────────────────

function buildSchemaSignature(name: string, schema: JsonSchema): string {
  const props = schema.properties ? Object.keys(schema.properties) : [];
  if (props.length === 0) return `interface ${name}`;
  const propList = props.slice(0, 5).join(', ');
  const suffix = props.length > 5 ? ', ...' : '';
  return `interface ${name} { ${propList}${suffix} }`.slice(0, 120);
}

function extractSchemas(spec: OpenApiSpec, source: Buffer, filePath: string, keyIndex?: Map<string, number>): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];

  // OpenAPI 3.x: components.schemas
  const schemas3 = spec.components?.schemas ?? {};
  // Swagger 2.x: definitions
  const schemas2 = spec.definitions ?? {};
  const allSchemas = { ...schemas3, ...schemas2 };

  for (const [name, schema] of Object.entries(allSchemas)) {
    if (!schema || typeof schema !== 'object') continue;

    const kind: SymbolKind = 'class';
    const signature = buildSchemaSignature(name, schema);
    const summary = schema.description ?? signature;

    const startByte = findKeyOffset(source, name, keyIndex);
    const endByte = startByte + Buffer.byteLength(name, 'utf8');

    symbols.push({
      id: makeId(filePath, name, kind),
      name,
      kind,
      filePath,
      startByte,
      endByte,
      signature: signature.slice(0, 120),
      summary: summary.slice(0, 200),
      frameworkMeta: {
        properties: schema.properties ? Object.keys(schema.properties) : [],
        required: schema.required ?? [],
        type: schema.type ?? 'object',
      },
    });
  }

  return symbols;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

function parseSpec(source: Buffer): OpenApiSpec | null {
  const text = source.toString('utf8');

  // Try JSON first (fast path for .json files)
  if (text.trimStart().startsWith('{')) {
    try {
      return JSON.parse(text) as OpenApiSpec;
    } catch {
      return null;
    }
  }

  // YAML (covers .yaml, .yml, and YAML-formatted .json edge cases)
  try {
    return yaml.load(text) as OpenApiSpec;
  } catch {
    return null;
  }
}

function isOpenApiSpec(spec: unknown): spec is OpenApiSpec {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  return typeof s['openapi'] === 'string' || typeof s['swagger'] === 'string';
}

export const openApiHandler: LanguageHandler = {
  extensions() {
    return ['.yaml', '.yml', '.json'];
  },

  grammarPath() {
    return null;
  },

  detect(content: Buffer): boolean {
    // Quick byte-scan — look for openapi: or swagger: near the top.
    // YAML: key appears at line-start (bare or quoted).
    // JSON: key appears as "openapi": or "swagger": anywhere in the first chunk.
    const head = content.slice(0, 8192).toString('utf8');
    if (
      /^\s*["']?openapi["']?\s*:/m.test(head) ||
      /^\s*["']?swagger["']?\s*:/m.test(head) ||
      /"openapi"\s*:/.test(head) ||
      /"swagger"\s*:/.test(head)
    ) return true;

    // Full-parse fallback for large spec files (e.g. Stripe, Kubernetes) where
    // the version key appears after a large schemas/definitions block.
    const spec = parseSpec(content);
    return !!spec && isOpenApiSpec(spec);
  },

  extractSymbols(_tree: Tree, source: Buffer, filePath: string): SymbolRecord[] {
    const spec = parseSpec(source);
    if (!spec || !isOpenApiSpec(spec)) return [];

    const keyIndex = buildKeyOffsetIndex(source);
    const pathSymbols = extractPaths(spec, source, filePath, keyIndex);
    const schemaSymbols = extractSchemas(spec, source, filePath, keyIndex);

    return [...pathSymbols, ...schemaSymbols];
  },

  extractImports(_tree: Tree, _source: Buffer): ImportRecord[] {
    return [];
  },

  extractDocstring(_node: SyntaxNode): string | null {
    return null;
  },
};
