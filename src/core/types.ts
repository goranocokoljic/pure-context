import type Database from 'better-sqlite3';
import type Parser from 'web-tree-sitter';

// web-tree-sitter types live in the Parser namespace
export type Tree = Parser.Tree;
export type SyntaxNode = Parser.SyntaxNode;

// ─── Symbol kinds ────────────────────────────────────────────────────────────

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
  | 'middleware'
  // Phase 5 additions
  | 'model'      // ORM models: Django Model, Rails ActiveRecord, Laravel Eloquent
  | 'view'       // Django views, Rails controllers (request handler entry points)
  | 'struct'     // C/C++ struct — distinct from class; plain data container
  | 'macro'      // C/C++ #define object-like macros; distinct from const
  | 'signal'     // Django signals, framework event emitters
  // Phase 6 additions
  | 'namespace'  // C++ named namespace; PHP namespace (retroactive enrichment); Kotlin package object
  | 'widget'     // Flutter StatelessWidget / StatefulWidget subclasses
  // Phase 36 additions
  | 'property';  // PHP class property declarations (public/protected instance variables)

// ─── Core records ─────────────────────────────────────────────────────────────

export interface ComplexityMetrics {
  lineCount: number;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  paramCount: number;
  returnCount: number;
  nestingDepth: number;
}

export interface SymbolRecord {
  /** Deterministic hash: SHA-256(filePath:name:kind).slice(0, 16) */
  id: string;
  name: string;
  kind: SymbolKind;
  /** Relative to repo root */
  filePath: string;
  startByte: number;
  endByte: number;
  /** One-line declaration signature, max 120 chars */
  signature: string;
  /** One-line description (from docstring, framework meta, or signature fallback) */
  summary: string;
  frameworkMeta?: Record<string, unknown>;
  /** Code quality metrics — populated at index time for functions, methods, and classes */
  metrics?: ComplexityMetrics;
  /**
   * First ~200 chars of the symbol's body, stripped of syntax noise.
   * Populated by language handlers at index time; not stored in the symbols table.
   * Used only to enrich FTS content so natural-language queries can match body words.
   */
  bodySnippet?: string;
  /**
   * FTS5 BM25 score from the FTS search that produced this symbol.
   * Negative (more negative = better match). Only set when symbol comes from ftsSearchSymbols.
   */
  ftsBm25?: number;
}

export interface ImportRecord {
  sourceFile: string;
  /** Raw import path as written in source */
  specifier: string;
  /** Resolved path relative to repo root, null for external packages */
  resolvedPath: string | null;
  importedNames: string[];
  isTypeOnly: boolean;
}

export interface DepEdge {
  repoId: string;
  sourceFile: string;
  sourceSymbolId: string | null;
  targetFile: string;
  targetSymbolId: string | null;
  /** 'import' | 'dynamic-import' | 're-export' */
  edgeType: string;
  specifier: string;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export interface RepoMetadata {
  id: string;
  rootPath: string;
  symbolCount: number;
  fileCount: number;
  /** JSON-serialized string[] */
  languages: string[];
  indexedAt: number;
  schemaVersion: number;
  /** Path to the cloned repo directory, null for locally-indexed repos. */
  clonePath: string | null;
  /** Owning tenant. Defaults to 'local' for single-tenant deployments. */
  tenantId?: string;
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

export interface AISummarizerService {
  summarizeBatch(symbols: SymbolRecord[]): Promise<Map<string, string>>;
}

export interface IndexOptions {
  fileLimit?: number;
  excludePatterns?: string[];
  watch?: boolean;
  watchDebounceMs?: number;
  /** Active framework adapters to apply during indexing. */
  adapters?: FrameworkAdapter[];
  /**
   * Optional AI summarizer for Stage 3 summaries. When provided, symbols
   * whose summaries are still the signature fallback after Stage 1/2 are
   * sent to the AI for a human-readable one-line description.
   */
  aiSummarizer?: AISummarizerService;
  /**
   * Path to the cloned repo directory. Set when indexing a remote repo
   * cloned by index_repo. Stored in the DB so deleteIndex can clean it up.
   */
  clonePath?: string;
  /**
   * Optional semantic indexer for Phase 11 HNSW embedding.
   * When provided, triggers semantic indexing after symbol extraction
   * if the repo meets the configured threshold.
   */
  semanticIndexer?: import('../semantic/semantic-indexer.js').SemanticIndexer;
  /**
   * Number of worker threads for parallel file parsing.
   * Default: min(cpuCount, 8). Set to 1 to disable (sequential mode).
   */
  concurrency?: number;
  /** Tenant/workspace ID to associate with this index operation. Defaults to 'local'. */
  tenantId?: string;
  /** Workspace plan — used to enforce free-tier limits. */
  workspacePlan?: 'free' | 'team' | 'enterprise';
  /** Current repo count for this workspace — used to enforce free-tier repo limit. */
  workspaceRepoCount?: number;
  /**
   * Context providers to run after indexing completes.
   * When absent, providers are auto-discovered from the global registry.
   * Pass an empty array to disable all providers.
   */
  providers?: ContextProvider[];
  /**
   * Skip git metadata capture entirely for this index run.
   * Useful in tests that need a repo indexed without any git history.
   */
  skipGit?: boolean;
  /**
   * Skip the test-mapper pass after indexing.
   * Use in benchmark runs to avoid the O(symbols×testFiles) cost on large repos.
   */
  skipTestMapper?: boolean;
  /**
   * Bare filenames (no extension) to discover and index.
   * e.g. ["functions"] to pick up dokku plugin `functions` files.
   * Routed to handlers via shebang detection in the file processor.
   */
  extensionlessFilenames?: string[];
  /**
   * Override the per-file size cap. Default: 1 MB.
   * Raise this when indexing repos containing large spec files (OpenAPI, GraphQL schemas).
   */
  maxFileSizeBytes?: number;
}

export interface IndexResult {
  repoId: string;
  filesIndexed: number;
  filesSkipped: number;
  symbolsFound: number;       // Symbols found in this run (incremental)
  totalSymbolsInDb: number;   // COUNT(*) from DB after indexing (authoritative total)
  totalFilesInDb: number;     // COUNT(*) from DB after indexing
  edgesFound: number;
  durationMs: number;
  errors: Array<{ file: string; message: string }>;
  /** Non-fatal issues that affect completeness (limit reached, parse errors, etc.). */
  warnings: string[];
  /**
   * True when discovery found more files than fileLimit allowed — the index is
   * a PARTIAL view of the project. Agents should surface this instead of
   * reasoning over a truncated index silently.
   */
  limitReached: boolean;
  /** Files discovery found before fileLimit was applied. */
  totalBeforeLimit: number;
}

export interface DiscoveredFile {
  path: string;
  size: number;
  priority: number;
}

// ─── Language handler interface ───────────────────────────────────────────────

export interface LanguageHandler {
  extensions(): string[];
  /**
   * Absolute path to the .wasm grammar file, or null for handlers that do not
   * use tree-sitter (e.g. OpenAPI, which parses YAML/JSON directly).
   * filePath hint allows per-extension grammar selection (e.g. .tsx vs .ts).
   */
  grammarPath(filePath?: string): string | null;
  extractSymbols(tree: Tree, source: Buffer, filePath: string): SymbolRecord[];
  extractImports(tree: Tree, source: Buffer): ImportRecord[];
  extractDocstring(node: SyntaxNode): string | null;
  /**
   * Optional: the package/namespace the file declares (e.g. Kotlin/Java
   * `package com.example.foo` → "com.example.foo"). Stored per file and used by
   * the JVM import resolver to map package-qualified imports to repo files.
   * `tree` is null for regex-only handlers. Return null when none is declared.
   */
  extractPackage?(tree: Tree | null, source: Buffer): string | null;
  /**
   * Optional content-based detection gate for handlers that claim ambiguous
   * extensions (e.g. .yaml/.yml/.json). When present, the file-processor calls
   * this before parsing; returning false skips the file silently.
   */
  detect?(content: Buffer): boolean;
}

// ─── Framework adapter interface ─────────────────────────────────────────────

export interface ProcessedBlock {
  content: Buffer;
  /** 'typescript' | 'javascript' | 'html' | 'css' */
  language: string;
  /** Byte offset where this block starts in the original file */
  offsetInOriginal: number;
}

export interface FrameworkAdapter {
  name: string;
  /** Additional file extensions this adapter handles (e.g. ['.vue']). Used by file discovery. */
  extensions(): string[];
  detect(projectRoot: string): Promise<boolean>;
  fileFilter(filePath: string): boolean;
  preProcess?(source: Buffer, filePath: string): ProcessedBlock[];
  /** tree is null when there is no parseable script block (e.g. template-only .vue files). */
  extractFrameworkSymbols(tree: Tree | null, source: Buffer, filePath: string): SymbolRecord[];
  enrichMetadata?(symbol: SymbolRecord): SymbolRecord;
}

// ─── Context provider interface ──────────────────────────────────────────────

export interface EnrichmentResult {
  symbolsEnriched: number;
  /** Provider-specific stats */
  metadataAdded: Record<string, unknown>;
}

export interface ContextProvider {
  name: string;
  description: string;
  /** Return true if this provider applies to the given project root */
  detect(projectRoot: string): Promise<boolean>;
  /** Called once after full indexing completes for a repo */
  enrich(repoId: string, projectRoot: string, db: Database.Database): Promise<EnrichmentResult>;
}

// ─── Services container ───────────────────────────────────────────────────────

export interface Services {
  db: Database.Database;
  repoId: string;
  rootPath: string;
}
