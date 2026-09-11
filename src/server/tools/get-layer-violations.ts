import { z } from 'zod';
import { minimatch } from 'minimatch';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getAllDepEdges } from '../../core/db/dep-store.js';
import { openWorkspace, rootLabels, workspaceAdjacency } from '../../graph/workspace-graph.js';
import { getConfig } from '../../config/config-loader.js';
import type { LayerDefinition, LayerRule, LayersConfig } from '../../config/config-schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const name = 'get_layer_violations';

export const description =
  'Analyse the dependency graph for architectural layer violations. ' +
  'Checks that files only import in allowed directions (e.g. core must not import handlers). ' +
  'Layer definitions can be provided inline or read from config.json. ' +
  'crossIndex:true (since 1.35.0) also checks this root\'s imports INTO linked indexes: a ' +
  'linked file is matched as `<rootName>:<path>` (rootName = basename of the linked root), so ' +
  'a definition `{ name: "db", paths: ["lib:src/db/**"] }` plus a rule `ui → db` disallowed ' +
  'catches ui/… importing lib/src/db/…. Plain globs match local files only; `<rootName>:` globs ' +
  'match only that root (the glob applies to the path inside it). Rules are this root\'s; edges ' +
  'FROM linked roots are judged by their own root\'s rules (call the tool there).';

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
  crossIndex: z
    .boolean()
    .optional()
    .describe(
      'Also check edges from this root into LINKED indexes (default false). Linked targets ' +
      'are matched as `<rootName>:<path>`; violations carry `to_repo_id` / `to_root`.',
    ),
};

// ─── Internal types ───────────────────────────────────────────────────────────

export interface Violation {
  from_layer: string;
  to_layer: string;
  from_file: string;
  to_file: string;
  import_spec: string;
  /** Phase 102: set when the target lives in a LINKED index (`to_file` is then `<rootName>:<path>`). */
  to_repo_id?: string;
  to_root?: string;
}

/** The layer-matching form of a linked file (Task 637, P3): `<rootName>:<path>`. */
export function crossTargetPath(rootName: string, path: string): string {
  return `${rootName}:${path}`;
}

export interface LayerEdgeLike {
  sourceFile: string;
  targetFile: string;
  specifier: string;
  /** Set on a cross-index edge — the target is matched under its root's prefix. */
  targetRepoId?: string | null;
  targetRoot?: string;
}

/**
 * The one violation detector (shared with compare_change_impact / snapshots).
 * `labels` maps a linked repo id to its root name; without it cross edges are
 * skipped (a caller that did not opt in never sees a prefixed path).
 */
export function detectLayerViolations(
  edges: Iterable<LayerEdgeLike>,
  definitions: LayerDefinition[],
  rules: LayerRule[],
  labels?: Map<string, string>,
): Violation[] {
  const violations: Violation[] = [];
  for (const edge of edges) {
    const sourceLayer = assignLayer(edge.sourceFile, definitions);
    let toFile = edge.targetFile;
    let targetLayer: string;
    if (edge.targetRepoId) {
      if (!labels) continue;
      const rootName = labels.get(edge.targetRepoId) ?? edge.targetRepoId;
      toFile = crossTargetPath(rootName, edge.targetFile);
      targetLayer = assignCrossLayer(rootName, edge.targetFile, definitions);
    } else {
      targetLayer = assignLayer(edge.targetFile, definitions);
    }

    // Skip unclassified files — they would generate noise
    if (sourceLayer === 'unclassified' || targetLayer === 'unclassified') continue;
    // Self-layer imports are always fine
    if (sourceLayer === targetLayer) continue;

    if (!isAllowed(sourceLayer, targetLayer, rules)) {
      violations.push({
        from_layer: sourceLayer,
        to_layer: targetLayer,
        from_file: edge.sourceFile,
        to_file: toFile,
        import_spec: edge.specifier,
        ...(edge.targetRepoId ? { to_repo_id: edge.targetRepoId, to_root: edge.targetRoot ?? '' } : {}),
      });
    }
  }
  return violations;
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
 * Layer of a file in a LINKED root (Phase 102): only patterns of the form
 * `<rootName>:<glob>` apply, with the glob matched against the file's path
 * INSIDE that root. Plain patterns never match a linked file (and a
 * prefixed pattern never matches a local one — local paths carry no `:`),
 * so definition order between the two forms does not matter.
 */
export function assignCrossLayer(rootName: string, path: string, definitions: LayerDefinition[]): string {
  const prefix = `${rootName}:`;
  for (const def of definitions) {
    for (const pattern of def.paths) {
      if (!pattern.startsWith(prefix)) continue;
      if (minimatch(path, pattern.slice(prefix.length), { matchBase: false, dot: true })) {
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
  crossIndex?: boolean;
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

  // ── Load edges and detect violations ───────────────────────────────────────
  let violations: Violation[];
  let crossFields: Record<string, unknown> = {};
  if (args.crossIndex) {
    // Phase 102 (Task 637): this root's rules, applied to its local edges AND
    // its edges into linked roots (P3 — never to a linked root's own edges).
    const ws = openWorkspace(db, args.repoId, repo.rootPath);
    try {
      const labels = rootLabels(ws);
      const rootOf = new Map(ws.links.map((m) => [m.repoId, m.rootPath] as const));
      const { edges } = workspaceAdjacency(ws, { scope: 'local-source', excludeEdgeTypes: [], skipSelfLoops: false });
      violations = detectLayerViolations(
        edges.map((e) => ({
          sourceFile: e.source.path,
          targetFile: e.target.path,
          specifier: e.specifier,
          ...(e.target.repoId !== ws.local.repoId
            ? { targetRepoId: e.target.repoId, targetRoot: rootOf.get(e.target.repoId) ?? '' }
            : {}),
        })),
        definitions,
        rules,
        labels,
      );
      crossFields = {
        crossIndex: true,
        links: ws.links.map((m) => ({ repoId: m.repoId, rootPath: m.rootPath, rootName: labels.get(m.repoId) })),
      };
    } finally {
      ws.close();
    }
  } else {
    violations = detectLayerViolations(getAllDepEdges(db, args.repoId), definitions, rules);
  }
  db.close();

  const byLayerPair: Record<string, number> = {};
  for (const v of violations) {
    const key = `${v.from_layer} → ${v.to_layer}`;
    byLayerPair[key] = (byLayerPair[key] ?? 0) + 1;
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
            ...crossFields,
            _tokenEstimate,
          },
          null,
          2,
        ),
      },
    ],
  };
}
