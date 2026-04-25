import { z } from 'zod';
import { minimatch } from 'minimatch';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { getConfig } from '../../config/config-loader.js';
import type { LayerDefinition, LayerRule, LayersConfig } from '../../config/config-schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_layer_violations';

export const description =
  'Analyse the dependency graph for architectural layer violations. ' +
  'Checks that files only import in allowed directions (e.g. core must not import handlers). ' +
  'Layer definitions can be provided inline or read from config.json.';

// ─── Input schema ─────────────────────────────────────────────────────────────

const layerDefinitionSchema = z.object({
  name: z.string().describe('Layer name'),
  paths: z.array(z.string()).describe('Glob patterns for files in this layer'),
});

const layerRuleSchema = z.object({
  from: z.string().describe('Source layer name'),
  to: z.string().describe('Target layer name'),
  allowed: z.boolean().describe('Whether this direction is allowed'),
});

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  layers: z
    .object({
      definitions: z.array(layerDefinitionSchema),
      rules: z.array(layerRuleSchema),
    })
    .optional()
    .describe(
      'Layer definitions and rules. If omitted, reads from config.json layers field.',
    ),
};

// ─── Internal types ───────────────────────────────────────────────────────────

interface Violation {
  from_layer: string;
  to_layer: string;
  from_file: string;
  to_file: string;
  import_spec: string;
}

// ─── Layer assignment ─────────────────────────────────────────────────────────

/**
 * Determine which layer a file belongs to.
 * Returns the name of the first matching layer definition, or 'unclassified'.
 */
export function assignLayer(filePath: string, definitions: LayerDefinition[]): string {
  for (const def of definitions) {
    for (const pattern of def.paths) {
      if (minimatch(filePath, pattern, { matchBase: false, dot: true })) {
        return def.name;
      }
    }
  }
  return 'unclassified';
}

/**
 * Check whether `from → to` is an allowed direction.
 * Any pair not explicitly listed in rules is treated as allowed (opt-in violation detection).
 */
export function isAllowed(from: string, to: string, rules: LayerRule[]): boolean {
  for (const rule of rules) {
    if (rule.from === from && rule.to === to) {
      return rule.allowed;
    }
  }
  return true; // unlisted = allowed
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handler(args: {
  repoId: string;
  layers?: { definitions: LayerDefinition[]; rules: LayerRule[] };
}): CallToolResult {
  // ── Resolve layer config ────────────────────────────────────────────────────
  let layersConfig: LayersConfig | null;

  if (args.layers) {
    layersConfig = args.layers;
  } else {
    const cfg = getConfig();
    layersConfig = cfg.layers;
  }

  if (!layersConfig) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error:
              'No layer config found. Provide a layers argument or add a layers config to ~/.purecontext/config.json.',
          }),
        },
      ],
      isError: true,
    };
  }

  const { definitions, rules } = layersConfig;

  // ── Open DB and verify repo ─────────────────────────────────────────────────
  const db = openDatabase(args.repoId);
  const repo = getRepo(db, args.repoId);

  if (!repo) {
    db.close();
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Repo "${args.repoId}" not found` }) }],
      isError: true,
    };
  }

  // ── Load all dep edges ──────────────────────────────────────────────────────
  const edges = getAllDepEdges(db, args.repoId);
  db.close();

  // ── Detect violations ───────────────────────────────────────────────────────
  const violations: Violation[] = [];
  const byLayerPair: Record<string, number> = {};

  for (const edge of edges) {
    const sourceLayer = assignLayer(edge.sourceFile, definitions);
    const targetLayer = assignLayer(edge.targetFile, definitions);

    // Skip unclassified files — they would generate noise
    if (sourceLayer === 'unclassified' || targetLayer === 'unclassified') continue;
    // Self-layer imports are always fine
    if (sourceLayer === targetLayer) continue;

    if (!isAllowed(sourceLayer, targetLayer, rules)) {
      violations.push({
        from_layer: sourceLayer,
        to_layer: targetLayer,
        from_file: edge.sourceFile,
        to_file: edge.targetFile,
        import_spec: edge.specifier,
      });

      const key = `${sourceLayer} → ${targetLayer}`;
      byLayerPair[key] = (byLayerPair[key] ?? 0) + 1;
    }
  }

  const layersAnalyzed = definitions.map((d) => d.name);
  const _tokenEstimate = Math.ceil(
    violations.reduce((n, v) => n + v.from_file.length + v.to_file.length + 30, 0) / 4,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            violations,
            summary: {
              total_violations: violations.length,
              by_layer_pair: byLayerPair,
            },
            layers_analyzed: layersAnalyzed,
            _tokenEstimate,
          },
          null,
          2,
        ),
      },
    ],
  };
}
