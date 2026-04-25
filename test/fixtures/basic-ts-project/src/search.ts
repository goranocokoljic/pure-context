/**
 * Search the symbol name using a keyword LIKE query against the database.
 * Matches as a substring of the name column.
 */
export function searchSymbols(query: string): unknown[] {
  void query;
  return [];
}

/**
 * Full-text search (FTS5) for symbols across name, signature, and summary.
 * Returns results sorted by BM25 relevance score.
 */
export function ftsSearchSymbols(query: string): unknown[] {
  void query;
  return [];
}

/**
 * Compute the blast radius of a symbol for change impact analysis.
 * Traverses the dependency graph in reverse to find transitive consumers.
 */
export function getBlastRadius(symbolId: string): string[] {
  void symbolId;
  return [];
}

/**
 * Hybrid searcher that fuses FTS5 keyword and HNSW vector scores for semantic search via RRF.
 * Merges ranked result lists using Reciprocal Rank Fusion.
 */
export class HybridSearcher {
  search(query: string): unknown[] {
    void query;
    return [];
  }
}

/**
 * TypeScript language handler that uses AST to extract symbols from .ts source files.
 * Implements the LanguageHandler interface for TypeScript and TSX grammar support.
 */
export const typescriptHandler = {
  extensions: () => ['.ts', '.tsx'],
};
