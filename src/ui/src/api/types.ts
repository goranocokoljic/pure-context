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
}

export interface SearchResult extends SymbolSummary {
  filePath: string;
  repoId: string;
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

// ─── Errors ───────────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  status: number;
}
