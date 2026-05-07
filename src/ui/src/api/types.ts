// ─── Shared meta ──────────────────────────────────────────────────────────────

export interface Meta {
  timingMs: number;
  version?: string;
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export interface RepoMeta {
  repoId: string;
  rootPath: string;
  symbolCount: number;
  fileCount: number;
  lastIndexed: string;
}

export interface ListReposResponse {
  repos: RepoMeta[];
  _meta: Meta;
}

// ─── File tree ────────────────────────────────────────────────────────────────

export type FileTreeNode =
  | { type: 'dir'; children: Record<string, FileTreeNode>; fileCount: number }
  | { type: 'file' };

export interface GetFileTreeResponse {
  repoId: string;
  tree: Record<string, FileTreeNode>;
  _meta: Meta;
}

// ─── Repo outline ─────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'const'
  | 'type'
  | 'interface'
  | 'enum'
  | 'component'
  | 'composable'
  | 'hook'
  | 'route'
  | 'decorator'
  | 'middleware';

export interface SymbolSummary {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string;
  startByte: number;
  endByte: number;
}

export interface FileSummary {
  filePath: string;
  symbols: SymbolSummary[];
}

export interface GetRepoOutlineResponse {
  repoId: string;
  files: FileSummary[];
  _meta: Meta;
}

// ─── Symbol search ────────────────────────────────────────────────────────────

export interface SearchSymbolsParams {
  query: string;
  kind?: SymbolKind;
  filePath?: string;
  limit?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  /** For cross-repo search: list of repo IDs to search across. */
  repoIds?: string[];
}

export interface SearchResult extends SymbolSummary {
  filePath: string;
  repoId: string;
  /** Present in multi-repo results. */
  repoName?: string;
}

export interface SearchSymbolsResponse {
  results: SearchResult[];
  _meta: Meta;
}

// ─── Symbol source ────────────────────────────────────────────────────────────

export interface SymbolSource {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string;
  summary: string;
  source: string;
  language: string;
}

export interface GetSymbolSourceResponse {
  symbol: SymbolSource;
  _meta: Meta;
}

// ─── File outline ─────────────────────────────────────────────────────────────

export interface GetFileOutlineResponse {
  filePath: string;
  count: number;
  symbols: SymbolSummary[];
  _meta: Meta;
}

// ─── Find importers ───────────────────────────────────────────────────────────

export interface ImporterSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
}

export interface ImporterFile {
  file: string;
  symbols: ImporterSymbol[];
}

export interface FindImportersResponse {
  filePath: string;
  importerCount: number;
  importers: ImporterFile[];
  _meta: Meta;
}

// ─── Dependency graph ─────────────────────────────────────────────────────────

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  path: string;
  symbolCount: number;
}

export interface GraphNode {
  id: string;
  data: GraphNodeData;
}

export interface GraphEdgeData extends Record<string, unknown> {
  edgeType: string;
  specifier: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  data: GraphEdgeData;
}

export interface GetGraphResponse {
  repoId: string;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  _meta: Meta;
}

// ─── Blast radius ─────────────────────────────────────────────────────────────

export interface BlastRadiusSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string;
}

export interface BlastRadiusEntry {
  filePath: string;
  depth: number;
  symbolCount: number;
  symbols: BlastRadiusSymbol[];
}

export interface GetBlastRadiusResponse {
  symbolId: string;
  symbolName: string;
  symbolKind: SymbolKind;
  sourceFile: string;
  totalFiles: number;
  totalSymbols: number;
  entries: BlastRadiusEntry[];
  _meta: Meta;
}

// ─── Test coverage ────────────────────────────────────────────────────────────

export type CoverageStatus = 'tested' | 'untested' | 'unknown';

export interface TestMapping {
  symbolId: string;
  testSymbolIds: string[];
  testFilePaths: string[];
  coverageStatus: CoverageStatus;
}

/** Response when querying a single symbol: { mapping, _meta } */
export interface GetSymbolCoverageResponse {
  mapping: TestMapping;
  _meta: Meta;
}

/** Response when querying all symbols in a repo: { mappings, _meta } */
export interface GetRepoCoverageResponse {
  mappings: TestMapping[];
  _meta: Meta;
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────

export type HeatmapMode = 'complexity' | 'churn' | 'combined';

/** Aggregated heatmap scores for a single file. All scores are 0–100. */
export interface FileHeatScore {
  /** Worst-symbol quality score in this file (0–100, 100 = critical). */
  complexityScore: number;
  /** Normalised churn score (0–100, 100 = hotspot, capped at 10 commits/90d). */
  churnScore: number;
  /** Weighted composite: 60 % complexity + 40 % churn. */
  combinedScore: number;
  /** Average cyclomatic complexity across symbols in this file. */
  avgComplexity: number;
  /** Number of commits in the analysis window. */
  commitCount: number;
  /** Number of symbols rated 'critical'. */
  criticalSymbols: number;
}

// ─── Quality metrics (mirrors get_quality_metrics tool output) ─────────────────

export interface SymbolQualityRecord {
  symbolId: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  lineCount: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  paramCount: number;
  returnCount: number;
  nestingDepth: number;
  qualityScore: number;
  riskLevel: 'good' | 'moderate' | 'high' | 'critical';
}

export interface GetQualityMetricsResponse {
  repoId: string;
  symbolsAnalyzed: number;
  worstOffenders: SymbolQualityRecord[];
  summary: {
    avgComplexity: number;
    avgLineCount: number;
    criticalCount: number;
    goodCount: number;
  };
  _meta: Meta;
}

// ─── Churn metrics (mirrors get_churn_metrics tool output, file granularity) ──

export interface ChurnRecord {
  filePath: string;
  commitCount: number;
  uniqueAuthors: number;
  lastChanged: string;
  churnScore: number;
  riskLevel: 'stable' | 'active' | 'volatile' | 'hotspot';
}

export interface GetChurnMetricsResponse {
  repoId: string;
  dayWindow: number;
  topChurn: ChurnRecord[];
  summary: {
    totalFilesAnalyzed: number;
    hotspots: number;
    stableFiles: number;
    mostActiveAuthor: string;
  };
  _meta: Meta;
}

// ─── Symbol history ───────────────────────────────────────────────────────────

export interface SymbolCommit {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;        // ISO 8601
  daysAgo: number;
  message: string;
}

export interface SymbolHistoryResponse {
  symbol: {
    name: string;
    kind: SymbolKind;
    filePath: string;
  };
  history: SymbolCommit[];
  totalCommits: number;
  firstSeen: SymbolCommit | null;
  lastChanged: SymbolCommit | null;
  churnScore: number;
  note?: string;
  _meta: Meta;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  status: number;
}
