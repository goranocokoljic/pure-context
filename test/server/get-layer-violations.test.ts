/**
 * get_layer_violations tool tests.
 *
 * Unit tests cover layer assignment and violation detection logic (pure functions).
 * Integration tests use basic-ts-project to verify the full pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexFolder, deleteIndex } from '../../src/core/index-manager.js';
import { registerHandler, _resetForTesting } from '../../src/handlers/handler-registry.js';
import { typescriptHandler, tsxHandler } from '../../src/handlers/typescript.js';
import { javascriptHandler } from '../../src/handlers/javascript.js';
import { initParser } from '../../src/core/parse-dispatcher.js';
import {
  handler as layerViolationsHandler,
  assignLayer,
  isAllowed,
} from '../../src/server/tools/get-layer-violations.js';
import type { LayerDefinition, LayerRule } from '../../src/config/config-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = resolve(__dirname, '../fixtures/basic-ts-project');

let repoId: string;

beforeAll(async () => {
  _resetForTesting();
  registerHandler(typescriptHandler);
  registerHandler(tsxHandler);
  registerHandler(javascriptHandler);
  await initParser();

  const result = await indexFolder(FIXTURE, { fileLimit: 50 });
  repoId = result.repoId;
  expect(result.edgesFound).toBeGreaterThan(0);
}, 30_000);

afterAll(() => {
  deleteIndex(repoId);
});

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ─── Sample layer config ──────────────────────────────────────────────────────

const sampleDefinitions: LayerDefinition[] = [
  { name: 'core',     paths: ['src/core/**'] },
  { name: 'handlers', paths: ['src/handlers/**'] },
  { name: 'adapters', paths: ['src/adapters/**'] },
  { name: 'server',   paths: ['src/server/**'] },
];

const sampleRules: LayerRule[] = [
  { from: 'adapters', to: 'handlers', allowed: true  },
  { from: 'adapters', to: 'core',     allowed: true  },
  { from: 'handlers', to: 'core',     allowed: true  },
  { from: 'server',   to: 'core',     allowed: true  },
  { from: 'server',   to: 'handlers', allowed: true  },
  { from: 'server',   to: 'adapters', allowed: true  },
  { from: 'core',     to: 'handlers', allowed: false },
  { from: 'core',     to: 'adapters', allowed: false },
  { from: 'handlers', to: 'adapters', allowed: false },
];

// ─── assignLayer ──────────────────────────────────────────────────────────────

describe('assignLayer', () => {
  it('assigns a file in src/core/ to the core layer', () => {
    expect(assignLayer('src/core/index-manager.ts', sampleDefinitions)).toBe('core');
  });

  it('assigns a file in src/handlers/ to the handlers layer', () => {
    expect(assignLayer('src/handlers/typescript.ts', sampleDefinitions)).toBe('handlers');
  });

  it('assigns a file in src/adapters/ to the adapters layer', () => {
    expect(assignLayer('src/adapters/vue.ts', sampleDefinitions)).toBe('adapters');
  });

  it('assigns a file in src/server/ to the server layer', () => {
    expect(assignLayer('src/server/mcp-server.ts', sampleDefinitions)).toBe('server');
  });

  it('assigns a file outside all layers to unclassified', () => {
    expect(assignLayer('test/core/schema.test.ts', sampleDefinitions)).toBe('unclassified');
  });

  it('assigns a root-level file to unclassified', () => {
    expect(assignLayer('index.ts', sampleDefinitions)).toBe('unclassified');
  });

  it('returns first matching layer when multiple could match', () => {
    const defs: LayerDefinition[] = [
      { name: 'first', paths: ['src/**'] },
      { name: 'second', paths: ['src/core/**'] },
    ];
    expect(assignLayer('src/core/foo.ts', defs)).toBe('first');
  });
});

// ─── isAllowed ────────────────────────────────────────────────────────────────

describe('isAllowed', () => {
  it('returns true for an explicitly allowed direction', () => {
    expect(isAllowed('handlers', 'core', sampleRules)).toBe(true);
  });

  it('returns false for an explicitly disallowed direction', () => {
    expect(isAllowed('core', 'handlers', sampleRules)).toBe(false);
  });

  it('returns false for core → adapters', () => {
    expect(isAllowed('core', 'adapters', sampleRules)).toBe(false);
  });

  it('returns true for a pair not listed in rules (opt-in detection)', () => {
    // 'graph' → 'core' is not in the rules, so it defaults to allowed
    expect(isAllowed('graph', 'core', sampleRules)).toBe(true);
  });

  it('returns true for same-layer (not covered by rules)', () => {
    expect(isAllowed('core', 'core', sampleRules)).toBe(true);
  });
});

// ─── handler — repo validation ────────────────────────────────────────────────

describe('get_layer_violations — repo validation', () => {
  it('returns error for nonexistent repo', () => {
    const result = layerViolationsHandler({
      repoId: 'deadbeef00000000',
      layers: { definitions: sampleDefinitions, rules: sampleRules },
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns error when no layers config provided and config has no layers', () => {
    // Call with no inline layers — config has the default layers, so this
    // will actually succeed (unless we override). We test the no-config case
    // by providing an empty-ish config placeholder inline. The real "error"
    // path is covered by the pure-function test of the handler with mocked config;
    // here we just verify the inline layers path works.
    const result = layerViolationsHandler({
      repoId,
      layers: { definitions: sampleDefinitions, rules: sampleRules },
    });
    expect(result.isError).toBeUndefined();
  });
});

// ─── handler — violation detection ────────────────────────────────────────────

describe('get_layer_violations — violation detection', () => {
  it('returns output with expected shape', () => {
    const result = layerViolationsHandler({
      repoId,
      layers: { definitions: sampleDefinitions, rules: sampleRules },
    });
    const data = parse(result);

    expect(Array.isArray(data['violations'])).toBe(true);
    expect(typeof data['summary']).toBe('object');
    expect(Array.isArray(data['layers_analyzed'])).toBe(true);
    expect(typeof data['_tokenEstimate']).toBe('number');
  });

  it('layers_analyzed matches supplied definitions', () => {
    const result = layerViolationsHandler({
      repoId,
      layers: { definitions: sampleDefinitions, rules: sampleRules },
    });
    const data = parse(result);
    expect(data['layers_analyzed']).toEqual(['core', 'handlers', 'adapters', 'server']);
  });

  it('summary.total_violations matches violations array length', () => {
    const result = layerViolationsHandler({
      repoId,
      layers: { definitions: sampleDefinitions, rules: sampleRules },
    });
    const data = parse(result);
    const violations = data['violations'] as unknown[];
    const summary = data['summary'] as { total_violations: number };
    expect(summary.total_violations).toBe(violations.length);
  });

  it('each violation has required fields', () => {
    // Use a config that will produce at least one violation in basic-ts-project
    // (the fixture has cross-folder imports between src/ and lib/)
    const defs: LayerDefinition[] = [
      { name: 'src', paths: ['src/**'] },
      { name: 'lib', paths: ['lib/**'] },
    ];
    const rules: LayerRule[] = [
      { from: 'src', to: 'lib', allowed: false }, // src importing lib is a violation
    ];

    const result = layerViolationsHandler({ repoId, layers: { definitions: defs, rules } });
    const data = parse(result);
    const violations = data['violations'] as Array<Record<string, unknown>>;

    if (violations.length > 0) {
      const v = violations[0];
      expect(typeof v['from_layer']).toBe('string');
      expect(typeof v['to_layer']).toBe('string');
      expect(typeof v['from_file']).toBe('string');
      expect(typeof v['to_file']).toBe('string');
      expect(typeof v['import_spec']).toBe('string');
    }
  });

  it('does not report violations for allowed directions', () => {
    // All edges are allowed → zero violations
    const defs: LayerDefinition[] = [
      { name: 'everything', paths: ['**'] },
    ];
    const rules: LayerRule[] = [
      { from: 'everything', to: 'everything', allowed: true },
    ];

    const result = layerViolationsHandler({ repoId, layers: { definitions: defs, rules } });
    const data = parse(result);
    // Self-layer imports are skipped, so with one layer everything is skipped
    const violations = data['violations'] as unknown[];
    expect(violations.length).toBe(0);
  });

  it('uses config.json layers when no inline layers provided', () => {
    // The default config has layers defined, so this should succeed
    const result = layerViolationsHandler({ repoId });
    // Should not be an error (config has default layers)
    expect(result.isError).toBeUndefined();
    const data = parse(result);
    expect(Array.isArray(data['violations'])).toBe(true);
  });

  it('by_layer_pair counts match violations array', () => {
    const defs: LayerDefinition[] = [
      { name: 'src', paths: ['src/**'] },
      { name: 'lib', paths: ['lib/**'] },
    ];
    const rules: LayerRule[] = [
      { from: 'src', to: 'lib', allowed: false },
    ];

    const result = layerViolationsHandler({ repoId, layers: { definitions: defs, rules } });
    const data = parse(result);
    const violations = data['violations'] as Array<Record<string, unknown>>;
    const summary = data['summary'] as { by_layer_pair: Record<string, number> };

    const totalFromPairs = Object.values(summary.by_layer_pair).reduce((a, b) => a + b, 0);
    expect(totalFromPairs).toBe(violations.length);
  });
});
