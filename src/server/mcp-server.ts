import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../core/logger.js';
import { VERSION } from '../version.js';
import { getConfig } from '../config/config-loader.js';
import { startHttpServer } from './http-server.js';
import type { TransportMode } from './transport.js';
import { HttpSseTransport } from './transport.js';
import { PureContextError } from '../core/errors.js';
import { track } from '../core/telemetry.js';

// ── Tool modules ──────────────────────────────────────────────────────────────
import * as indexFolderTool from './tools/index-folder.js';
import * as listReposTool from './tools/list-repos.js';
import * as resolveRepoTool from './tools/resolve-repo.js';
import * as searchSymbolsTool from './tools/search-symbols.js';
import * as getSymbolSourceTool from './tools/get-symbol-source.js';
import * as getFileOutlineTool from './tools/get-file-outline.js';
import * as getRepoOutlineTool from './tools/get-repo-outline.js';
import * as getFileTreeTool from './tools/get-file-tree.js';
import * as getContextBundleTool from './tools/get-context-bundle.js';
import * as getBlastRadiusTool from './tools/get-blast-radius.js';
import * as findImportersTool from './tools/find-importers.js';
import * as findDeadCodeTool from './tools/find-dead-code.js';
import * as searchTextTool from './tools/search-text.js';
import * as getLayerViolationsTool from './tools/get-layer-violations.js';
import * as indexRepoTool from './tools/index-repo.js';
import * as searchSemanticTool from './tools/search-semantic.js';
import * as getSavingsStatsTool from './tools/get-savings-stats.js';
import * as findReferencesTool from './tools/find-references.js';
import * as getFileContentTool from './tools/get-file-content.js';
import * as getSymbolsTool from './tools/get-symbols.js';
import * as invalidateCacheTool from './tools/invalidate-cache.js';
import * as searchColumnsTool from './tools/search-columns.js';
import * as searchSimilarTool from './tools/search-similar.js';
import * as findCrossRepoUsagesTool from './tools/find-cross-repo-usages.js';
import * as getSymbolHistoryTool from './tools/get-symbol-history.js';
import * as analyzeDiffTool from './tools/analyze-diff.js';
import * as getChurnMetricsTool from './tools/get-churn-metrics.js';
import * as getCoChangeTool from './tools/get-co-change.js';
import * as getSymbolRiskTool from './tools/get-symbol-risk.js';
import * as getQualityMetricsTool from './tools/get-quality-metrics.js';
import * as detectAntipatternsTool from './tools/detect-antipatterns.js';
import * as findRefactoringOpportunitiesTool from './tools/find-refactoring-opportunities.js';
import * as getTaskContextTool from './tools/get-task-context.js';
import * as generateDocsTool from './tools/generate-docs.js';
import * as exportIndexTool from './tools/export-index.js';
import * as importIndexTool from './tools/import-index.js';
import * as fetchPublicIndexTool from './tools/fetch-public-index.js';
import * as getCouplingMapTool from './tools/get-coupling-map.js';
import * as findImplementationsTool from './tools/find-implementations.js';
import * as findCyclesTool from './tools/find-cycles.js';
import * as getClassHierarchyTool from './tools/get-class-hierarchy.js';
import * as getCallHierarchyTool from './tools/get-call-hierarchy.js';
import * as renderDiagramTool from './tools/render-diagram.js';
import * as renderCallGraphTool from './tools/render-call-graph.js';
import * as renderImportGraphTool from './tools/render-import-graph.js';
import * as renderDepMatrixTool from './tools/render-dep-matrix.js';
import * as renderClassHierarchyTool from './tools/render-class-hierarchy.js';
import * as getArchitectureSnapshotTool from './tools/get-architecture-snapshot.js';
import * as checkRenameSafeTool from './tools/check-rename-safe.js';
import * as checkDeleteSafeTool from './tools/check-delete-safe.js';
import * as checkMoveSafeTool from './tools/check-move-safe.js';
import * as planRefactoringTool from './tools/plan-refactoring.js';
import * as getDebtReportTool from './tools/get-debt-report.js';
import * as healthRadarTool from './tools/health-radar.js';
import * as diffHealthRadarTool from './tools/diff-health-radar.js';
import * as searchBySignatureTool from './tools/search-by-signature.js';
import * as searchByComplexityTool from './tools/search-by-complexity.js';
import * as searchAstTool from './tools/search-ast.js';
import * as searchByDecoratorTool from './tools/search-by-decorator.js';
import * as getPublicApiTool from './tools/get-public-api.js';
import * as getTodosTool from './tools/get-todos.js';
import * as getEntryPointsTool from './tools/get-entry-points.js';
import * as getComplexityHotspotsTool from './tools/get-complexity-hotspots.js';
import * as findUntestedSymbolsTool from './tools/find-untested-symbols.js';
import * as getTestCoverageMapTool from './tools/get-test-coverage-map.js';
import * as getTypeGraphTool from './tools/get-type-graph.js';
import * as getLexicalScopeMatchesTool from './tools/get-lexical-scope-matches.js';
import * as traceInvocationChainTool from './tools/trace-invocation-chain.js';

// ── Resource handlers ──────────────────────────────────────────────────────────
import {
  readReposResource,
  readRepoOutlineResource,
  readFileOutlineResource,
  readSymbolSourceResource,
} from './resources.js';

// ─── Tool error handling ──────────────────────────────────────────────────────

/**
 * Convert a known PureContextError into a structured MCP error response so the
 * AI agent sees the userMessage instead of a raw exception or server crash.
 * Re-throws anything that is not a PureContextError (let the SDK handle it).
 */
/**
 * Bridge the SDK's untyped args (unknown) to a strongly-typed handler.
 * registerTool in SDK >=1.20 leaves the callback args as `unknown` unless
 * InputArgs is explicitly provided; this helper restores the concrete type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function typed(handler: (args: any) => CallToolResult | Promise<CallToolResult>) {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (err) {
      return handleToolError(err);
    }
  };
}

function handleToolError(err: unknown): CallToolResult {
  if (err instanceof PureContextError) {
    const msg = err.userMessage ?? err.message;
    const detail = err.suggestion ? `\n\nSuggestion: ${err.suggestion}` : '';
    return {
      content: [{ type: 'text', text: msg + detail }],
      isError: true,
    };
  }
  throw err;
}

// ─── Resource change notifications ────────────────────────────────────────────

/**
 * Returns an `onChanged` callback (suitable for `startWatching`) that sends
 * MCP resource-update notifications to the client whenever files are reindexed.
 *
 * Pass the returned callback to `startWatching({ onChanged })` so that resource
 * subscribers are notified after every watcher-triggered reindex.
 */
export function createResourceNotifier(
  server: McpServer,
): (repoId: string, changedPaths: string[], deletedPaths: string[]) => void {
  return (repoId, changedPaths, deletedPaths) => {
    const allPaths = [...changedPaths, ...deletedPaths];

    // Notify for the repo outline (it changed because symbols were re-extracted)
    server.server.sendResourceUpdated({ uri: `purecontext://repos/${repoId}/outline` }).catch(() => {});

    // Notify for each changed/deleted file's outline
    for (const filePath of allPaths) {
      const encodedPath = encodeURIComponent(filePath);
      server.server.sendResourceUpdated({
        uri: `purecontext://repos/${repoId}/files/${encodedPath}`,
      }).catch(() => {});
    }

    // Notify the repo list in case symbol/file counts changed
    server.server.sendResourceUpdated({ uri: 'purecontext://repos' }).catch(() => {});
  };
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'purecontext-mcp',
    version: VERSION,
  });

  // ── Register tools ─────────────────────────────────────────────────────────
  //
  // Convention: each tool module exports:
  //   name:        string (the tool name)
  //   description: string
  //   inputSchema: Record<string, ZodType> (raw Zod shape — not z.object())
  //   handler:     function(args) => CallToolResult | Promise<CallToolResult>
  //

  server.registerTool(indexFolderTool.name, {
    description: indexFolderTool.description,
    inputSchema: indexFolderTool.inputSchema,
  }, typed((args) => indexFolderTool.handler(args)));

  server.registerTool(listReposTool.name, {
    description: listReposTool.description,
    inputSchema: listReposTool.inputSchema,
  }, typed(() => listReposTool.handler()));

  server.registerTool(resolveRepoTool.name, {
    description: resolveRepoTool.description,
    inputSchema: resolveRepoTool.inputSchema,
  }, typed((args) => resolveRepoTool.handler(args)));

  server.registerTool(searchSymbolsTool.name, {
    description: searchSymbolsTool.description,
    inputSchema: searchSymbolsTool.inputSchema,
  }, typed((args) => searchSymbolsTool.handler(args)));

  server.registerTool(getSymbolSourceTool.name, {
    description: getSymbolSourceTool.description,
    inputSchema: getSymbolSourceTool.inputSchema,
  }, typed((args) => getSymbolSourceTool.handler(args)));

  server.registerTool(getFileOutlineTool.name, {
    description: getFileOutlineTool.description,
    inputSchema: getFileOutlineTool.inputSchema,
  }, typed((args) => getFileOutlineTool.handler(args)));

  server.registerTool(getRepoOutlineTool.name, {
    description: getRepoOutlineTool.description,
    inputSchema: getRepoOutlineTool.inputSchema,
  }, typed((args) => getRepoOutlineTool.handler(args)));

  server.registerTool(getFileTreeTool.name, {
    description: getFileTreeTool.description,
    inputSchema: getFileTreeTool.inputSchema,
  }, typed((args) => getFileTreeTool.handler(args)));

  server.registerTool(getContextBundleTool.name, {
    description: getContextBundleTool.description,
    inputSchema: getContextBundleTool.inputSchema,
  }, typed((args) => getContextBundleTool.handler(args)));

  server.registerTool(getBlastRadiusTool.name, {
    description: getBlastRadiusTool.description,
    inputSchema: getBlastRadiusTool.inputSchema,
  }, typed((args) => getBlastRadiusTool.handler(args)));

  server.registerTool(findImportersTool.name, {
    description: findImportersTool.description,
    inputSchema: findImportersTool.inputSchema,
  }, typed((args) => findImportersTool.handler(args)));

  server.registerTool(findDeadCodeTool.name, {
    description: findDeadCodeTool.description,
    inputSchema: findDeadCodeTool.inputSchema,
  }, typed((args) => findDeadCodeTool.handler(args)));

  server.registerTool(searchTextTool.name, {
    description: searchTextTool.description,
    inputSchema: searchTextTool.inputSchema,
  }, typed((args) => searchTextTool.handler(args)));

  server.registerTool(getLayerViolationsTool.name, {
    description: getLayerViolationsTool.description,
    inputSchema: getLayerViolationsTool.inputSchema,
  }, typed((args) => getLayerViolationsTool.handler(args)));

  server.registerTool(indexRepoTool.name, {
    description: indexRepoTool.description,
    inputSchema: indexRepoTool.inputSchema,
  }, typed((args) => indexRepoTool.handler(args)));

  server.registerTool(searchSemanticTool.name, {
    description: searchSemanticTool.description,
    inputSchema: searchSemanticTool.inputSchema,
  }, typed((args) => searchSemanticTool.handler(args)));

  server.registerTool(getSavingsStatsTool.name, {
    description: getSavingsStatsTool.description,
    inputSchema: getSavingsStatsTool.inputSchema,
  }, typed((args) => getSavingsStatsTool.handler(args)));

  server.registerTool(findReferencesTool.name, {
    description: findReferencesTool.description,
    inputSchema: findReferencesTool.inputSchema,
  }, typed((args) => findReferencesTool.handler(args)));

  server.registerTool(getFileContentTool.name, {
    description: getFileContentTool.description,
    inputSchema: getFileContentTool.inputSchema,
  }, typed((args) => getFileContentTool.handler(args)));

  server.registerTool(getSymbolsTool.name, {
    description: getSymbolsTool.description,
    inputSchema: getSymbolsTool.inputSchema,
  }, typed((args) => getSymbolsTool.handler(args)));

  server.registerTool(invalidateCacheTool.name, {
    description: invalidateCacheTool.description,
    inputSchema: invalidateCacheTool.inputSchema,
  }, typed((args) => invalidateCacheTool.handler(args)));

  server.registerTool(searchColumnsTool.name, {
    description: searchColumnsTool.description,
    inputSchema: searchColumnsTool.inputSchema,
  }, typed((args) => searchColumnsTool.handler(args)));

  server.registerTool(searchSimilarTool.name, {
    description: searchSimilarTool.description,
    inputSchema: searchSimilarTool.inputSchema,
  }, typed((args) => searchSimilarTool.handler(args)));

  server.registerTool(findCrossRepoUsagesTool.name, {
    description: findCrossRepoUsagesTool.description,
    inputSchema: findCrossRepoUsagesTool.inputSchema,
  }, typed((args) => findCrossRepoUsagesTool.handler(args)));

  server.registerTool(getSymbolHistoryTool.name, {
    description: getSymbolHistoryTool.description,
    inputSchema: getSymbolHistoryTool.inputSchema,
  }, typed((args) => getSymbolHistoryTool.handler(args)));

  server.registerTool(analyzeDiffTool.name, {
    description: analyzeDiffTool.description,
    inputSchema: analyzeDiffTool.inputSchema,
  }, typed((args) => analyzeDiffTool.handler(args)));

  server.registerTool(getChurnMetricsTool.name, {
    description: getChurnMetricsTool.description,
    inputSchema: getChurnMetricsTool.inputSchema,
  }, typed((args) => getChurnMetricsTool.handler(args)));

  server.registerTool(getCoChangeTool.name, {
    description: getCoChangeTool.description,
    inputSchema: getCoChangeTool.inputSchema,
  }, typed((args) => getCoChangeTool.handler(args)));

  server.registerTool(getSymbolRiskTool.name, {
    description: getSymbolRiskTool.description,
    inputSchema: getSymbolRiskTool.inputSchema,
  }, typed((args) => getSymbolRiskTool.handler(args)));

  server.registerTool(getQualityMetricsTool.name, {
    description: getQualityMetricsTool.description,
    inputSchema: getQualityMetricsTool.inputSchema,
  }, typed((args) => getQualityMetricsTool.handler(args)));

  server.registerTool(detectAntipatternsTool.name, {
    description: detectAntipatternsTool.description,
    inputSchema: detectAntipatternsTool.inputSchema,
  }, typed((args) => detectAntipatternsTool.handler(args)));

  server.registerTool(findRefactoringOpportunitiesTool.name, {
    description: findRefactoringOpportunitiesTool.description,
    inputSchema: findRefactoringOpportunitiesTool.inputSchema,
  }, typed((args) => findRefactoringOpportunitiesTool.handler(args)));

  server.registerTool(getTaskContextTool.name, {
    description: getTaskContextTool.description,
    inputSchema: getTaskContextTool.inputSchema,
  }, typed((args) => getTaskContextTool.handler(args)));

  server.registerTool(generateDocsTool.name, {
    description: generateDocsTool.description,
    inputSchema: generateDocsTool.inputSchema,
  }, typed((args) => generateDocsTool.handler(args)));

  server.registerTool(exportIndexTool.name, {
    description: exportIndexTool.description,
    inputSchema: exportIndexTool.inputSchema,
  }, typed((args) => exportIndexTool.handler(args)));

  server.registerTool(importIndexTool.name, {
    description: importIndexTool.description,
    inputSchema: importIndexTool.inputSchema,
  }, typed((args) => importIndexTool.handler(args)));

  server.registerTool(fetchPublicIndexTool.name, {
    description: fetchPublicIndexTool.description,
    inputSchema: fetchPublicIndexTool.inputSchema,
  }, typed((args) => fetchPublicIndexTool.handler(args)));

  server.registerTool(getCouplingMapTool.name, {
    description: getCouplingMapTool.description,
    inputSchema: getCouplingMapTool.inputSchema,
  }, typed((args) => getCouplingMapTool.handler(args)));

  server.registerTool(findImplementationsTool.name, {
    description: findImplementationsTool.description,
    inputSchema: findImplementationsTool.inputSchema,
  }, typed((args) => findImplementationsTool.handler(args)));

  server.registerTool(findCyclesTool.name, {
    description: findCyclesTool.description,
    inputSchema: findCyclesTool.inputSchema,
  }, typed((args) => findCyclesTool.handler(args)));

  server.registerTool(getClassHierarchyTool.name, {
    description: getClassHierarchyTool.description,
    inputSchema: getClassHierarchyTool.inputSchema,
  }, typed((args) => getClassHierarchyTool.handler(args)));

  server.registerTool(getCallHierarchyTool.name, {
    description: getCallHierarchyTool.description,
    inputSchema: getCallHierarchyTool.inputSchema,
  }, typed((args) => getCallHierarchyTool.handler(args)));

  server.registerTool(renderDiagramTool.name, {
    description: renderDiagramTool.description,
    inputSchema: renderDiagramTool.inputSchema,
  }, typed((args) => renderDiagramTool.handler(args)));

  server.registerTool(renderCallGraphTool.name, {
    description: renderCallGraphTool.description,
    inputSchema: renderCallGraphTool.inputSchema,
  }, typed((args) => renderCallGraphTool.handler(args)));

  server.registerTool(renderImportGraphTool.name, {
    description: renderImportGraphTool.description,
    inputSchema: renderImportGraphTool.inputSchema,
  }, typed((args) => renderImportGraphTool.handler(args)));

  server.registerTool(renderDepMatrixTool.name, {
    description: renderDepMatrixTool.description,
    inputSchema: renderDepMatrixTool.inputSchema,
  }, typed((args) => renderDepMatrixTool.handler(args)));

  server.registerTool(renderClassHierarchyTool.name, {
    description: renderClassHierarchyTool.description,
    inputSchema: renderClassHierarchyTool.inputSchema,
  }, typed((args) => renderClassHierarchyTool.handler(args)));

  server.registerTool(getArchitectureSnapshotTool.name, {
    description: getArchitectureSnapshotTool.description,
    inputSchema: getArchitectureSnapshotTool.inputSchema,
  }, typed((args) => getArchitectureSnapshotTool.handler(args)));

  server.registerTool(checkRenameSafeTool.name, {
    description: checkRenameSafeTool.description,
    inputSchema: checkRenameSafeTool.inputSchema,
  }, typed((args) => checkRenameSafeTool.handler(args)));

  server.registerTool(checkDeleteSafeTool.name, {
    description: checkDeleteSafeTool.description,
    inputSchema: checkDeleteSafeTool.inputSchema,
  }, typed((args) => checkDeleteSafeTool.handler(args)));

  server.registerTool(checkMoveSafeTool.name, {
    description: checkMoveSafeTool.description,
    inputSchema: checkMoveSafeTool.inputSchema,
  }, typed((args) => checkMoveSafeTool.handler(args)));

  server.registerTool(planRefactoringTool.name, {
    description: planRefactoringTool.description,
    inputSchema: planRefactoringTool.inputSchema,
  }, typed((args) => planRefactoringTool.handler(args)));

  server.registerTool(getDebtReportTool.name, {
    description: getDebtReportTool.description,
    inputSchema: getDebtReportTool.inputSchema,
  }, typed((args) => getDebtReportTool.handler(args)));

  server.registerTool(healthRadarTool.name, {
    description: healthRadarTool.description,
    inputSchema: healthRadarTool.inputSchema,
  }, typed((args) => healthRadarTool.handler(args)));

  server.registerTool(diffHealthRadarTool.name, {
    description: diffHealthRadarTool.description,
    inputSchema: diffHealthRadarTool.inputSchema,
  }, typed((args) => diffHealthRadarTool.handler(args)));

  server.registerTool(searchBySignatureTool.name, {
    description: searchBySignatureTool.description,
    inputSchema: searchBySignatureTool.inputSchema,
  }, typed((args) => searchBySignatureTool.handler(args)));

  server.registerTool(searchByComplexityTool.name, {
    description: searchByComplexityTool.description,
    inputSchema: searchByComplexityTool.inputSchema,
  }, typed((args) => searchByComplexityTool.handler(args)));

  server.registerTool(searchAstTool.name, {
    description: searchAstTool.description,
    inputSchema: searchAstTool.inputSchema,
  }, typed((args) => searchAstTool.handler(args)));

  server.registerTool(searchByDecoratorTool.name, {
    description: searchByDecoratorTool.description,
    inputSchema: searchByDecoratorTool.inputSchema,
  }, typed((args) => searchByDecoratorTool.handler(args)));

  server.registerTool(getPublicApiTool.name, {
    description: getPublicApiTool.description,
    inputSchema: getPublicApiTool.inputSchema,
  }, typed((args) => getPublicApiTool.handler(args)));

  server.registerTool(getTodosTool.name, {
    description: getTodosTool.description,
    inputSchema: getTodosTool.inputSchema,
  }, typed((args) => getTodosTool.handler(args)));

  server.registerTool(getEntryPointsTool.name, {
    description: getEntryPointsTool.description,
    inputSchema: getEntryPointsTool.inputSchema,
  }, typed((args) => getEntryPointsTool.handler(args)));

  server.registerTool(getComplexityHotspotsTool.name, {
    description: getComplexityHotspotsTool.description,
    inputSchema: getComplexityHotspotsTool.inputSchema,
  }, typed((args) => getComplexityHotspotsTool.handler(args)));

  server.registerTool(findUntestedSymbolsTool.name, {
    description: findUntestedSymbolsTool.description,
    inputSchema: findUntestedSymbolsTool.inputSchema,
  }, typed((args) => findUntestedSymbolsTool.handler(args)));

  server.registerTool(getTestCoverageMapTool.name, {
    description: getTestCoverageMapTool.description,
    inputSchema: getTestCoverageMapTool.inputSchema,
  }, typed((args) => getTestCoverageMapTool.handler(args)));

  server.registerTool(getTypeGraphTool.name, {
    description: getTypeGraphTool.description,
    inputSchema: getTypeGraphTool.inputSchema,
  }, typed((args) => getTypeGraphTool.handler(args)));

  server.registerTool(getLexicalScopeMatchesTool.name, {
    description: getLexicalScopeMatchesTool.description,
    inputSchema: getLexicalScopeMatchesTool.inputSchema,
  }, typed((args) => getLexicalScopeMatchesTool.handler(args)));

  server.registerTool(traceInvocationChainTool.name, {
    description: traceInvocationChainTool.description,
    inputSchema: traceInvocationChainTool.inputSchema,
  }, typed((args) => traceInvocationChainTool.handler(args)));

  // ── MCP Resources ─────────────────────────────────────────────────────────

  // Static resource: list all indexed repos
  server.registerResource(
    'purecontext-repos',
    'purecontext://repos',
    { mimeType: 'application/json', description: 'List of all indexed repositories' },
    (uri) => readReposResource(uri.toString()),
  );

  // Template: per-repo symbol outline
  server.registerResource(
    'purecontext-repo-outline',
    new ResourceTemplate('purecontext://repos/{repoId}/outline', { list: undefined }),
    { mimeType: 'application/json', description: 'Symbol outline for a repository' },
    (uri, { repoId }) => {
      if (typeof repoId !== 'string') throw new Error('repoId required');
      return readRepoOutlineResource(uri.toString(), repoId);
    },
  );

  // Template: per-file symbol outline
  // Note: filePath in the URI is URL-encoded (slashes → %2F)
  server.registerResource(
    'purecontext-file-outline',
    new ResourceTemplate('purecontext://repos/{repoId}/files/{filePath}', { list: undefined }),
    { mimeType: 'application/json', description: 'Symbol outline for a file in a repository' },
    (uri, { repoId, filePath }) => {
      if (typeof repoId !== 'string') throw new Error('repoId required');
      if (typeof filePath !== 'string') throw new Error('filePath required');
      return readFileOutlineResource(uri.toString(), repoId, decodeURIComponent(filePath));
    },
  );

  // Template: symbol source code
  server.registerResource(
    'purecontext-symbol-source',
    new ResourceTemplate('purecontext://repos/{repoId}/symbols/{symbolId}', { list: undefined }),
    { mimeType: 'text/plain', description: 'Source code of a specific symbol' },
    (uri, { repoId, symbolId }) => {
      if (typeof repoId !== 'string') throw new Error('repoId required');
      if (typeof symbolId !== 'string') throw new Error('symbolId required');
      return readSymbolSourceResource(uri.toString(), repoId, symbolId);
    },
  );

  return server;
}

// ─── Start the server ─────────────────────────────────────────────────────────

export interface StartServerOptions {
  /** Override the transport mode from config. */
  transport?: TransportMode;
  /** Override the HTTP port from config. */
  port?: number;
  /** Override the HTTP host from config. */
  host?: string;
  /**
   * Override server.requireAuth from config.
   * When true, API key auth is enforced on all /mcp and /api/* requests.
   */
  requireAuth?: boolean;
  /**
   * When true, print a human-readable server-mode startup banner to stderr
   * instead of the terse stdio ready line. Used with the --server flag.
   */
  serverMode?: boolean;
}

export async function startServer(options: StartServerOptions = {}): Promise<void> {
  // Fire-and-forget telemetry on startup
  track({ event: 'server_start' }).catch(() => { /* silently ignored */ });

  const cfg = getConfig();
  const mode: TransportMode = options.transport ?? cfg.transport;
  const port = options.port ?? cfg.http.port;
  const host = options.host ?? cfg.http.host;
  const { corsOrigins } = cfg.http;
  const requireAuth = options.requireAuth ?? cfg.server.requireAuth;

  let stdioServer: McpServer | undefined;

  // ── stdio transport ───────────────────────────────────────────────────────
  if (mode === 'stdio' || mode === 'both') {
    stdioServer = createMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    logger.info('PureContext MCP server started (stdio)');
  }

  // ── HTTP transport ────────────────────────────────────────────────────────
  let httpServer: import('node:http').Server | undefined;
  let httpSseTransport: HttpSseTransport | undefined;
  if (mode === 'http' || mode === 'both') {
    // Create the stateful SSE transport (one per server, manages multiple agent sessions).
    httpSseTransport = new HttpSseTransport(createMcpServer);
    await httpSseTransport.init();

    httpServer = await startHttpServer({
      port,
      host,
      corsOrigins,
      auth: cfg.http.auth,
      rateLimit: cfg.rateLimit,
      serverFactory: createMcpServer,
      sseTransport: httpSseTransport,
    });

    if (options.serverMode) {
      const addr = httpServer.address() as { address: string; port: number } | null;
      const boundHost = addr?.address ?? host;
      const boundPort = addr?.port ?? port;
      const adminKeySet = Boolean(process.env['PCTX_ADMIN_KEY'] ?? cfg.server.adminKey);

      // Count workspaces for the startup banner
      let workspaceCount = 0;
      try {
        const { openAuthDatabase } = await import('../core/db/api-keys.js');
        const { TenantStore } = await import('../core/db/tenants.js');
        const authDb = openAuthDatabase();
        workspaceCount = new TenantStore(authDb).list().length;
        authDb.close();
      } catch { /* ignore — auth DB may not exist yet on first run */ }

      process.stderr.write(`\nPureContext MCP Server v${VERSION}\n`);
      process.stderr.write(`Listening on http://${boundHost}:${boundPort}\n`);
      process.stderr.write(
        `Auth: ${requireAuth ? 'enabled' : 'disabled (--no-auth)'}` +
        (requireAuth && !adminKeySet ? ' — set PCTX_ADMIN_KEY to manage API keys' : '') +
        '\n',
      );
      process.stderr.write(`Workspaces: ${workspaceCount || 1} (${workspaceCount <= 1 ? 'default' : 'total'})\n\n`);
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async () => {
    logger.info('Shutting down...');
    httpServer?.close();
    if (httpSseTransport) await httpSseTransport.close().catch(() => {});
    if (stdioServer) await stdioServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
