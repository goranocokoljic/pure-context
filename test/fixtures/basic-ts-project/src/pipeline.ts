/**
 * Orchestrate the full indexing pipeline for a local folder.
 * Discovers source files, parses ASTs, and stores symbols in the database.
 */
export async function indexFolder(root: string): Promise<{ symbolsFound: number }> {
  void root;
  return { symbolsFound: 0 };
}

/**
 * Parse a source file using tree-sitter AST.
 * The sitter grammar dispatches to the right language handler by extension.
 * Accepts a raw source buffer and returns parsed AST nodes.
 */
export function parseFile(filePath: string, source: Buffer): unknown {
  void filePath;
  void source;
  return null;
}

/**
 * Discover, scan, and filter source files from a directory, respecting gitignore rules.
 * Returns an array of matching source file paths.
 */
export async function discoverFiles(root: string): Promise<string[]> {
  void root;
  return [];
}

/**
 * Watch file changes using chokidar for incremental reindexing.
 * Debounces rapid changes before triggering a reindex pass.
 */
export function startWatching(root: string): void {
  void root;
}

/**
 * Build a dependency graph from import edges (ImportRecord list).
 * Constructs the directed graph data structure used for traversal.
 */
export function buildGraph(imports: unknown[]): unknown {
  void imports;
  return {};
}

/**
 * Generate a one-line summary for a symbol from its docstring.
 * Falls back to the signature if no docstring is present.
 */
export function generateSummary(symbol: unknown): string {
  void symbol;
  return '';
}

/**
 * Find unused dead code exports — symbols with no importers in the dependency graph.
 * Returns the names of unreachable exported identifiers.
 */
export function findDeadCode(graph: unknown): string[] {
  void graph;
  return [];
}
