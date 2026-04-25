/**
 * File processing pipeline: parse a source file, extract symbols and imports.
 *
 * Extracted from index-manager.ts so it can be imported by both the main thread
 * and worker threads (indexing-worker.ts) without pulling in the full indexing
 * pipeline (DB, watcher, etc.).
 */

import type { ImportRecord, FrameworkAdapter, SymbolRecord } from './types.js';
import { parseFile } from './parse-dispatcher.js';
import { getHandler, getHandlerByLanguage } from '../handlers/handler-registry.js';
import { enrichSymbols } from '../summarizer/summarizer.js';

export interface ProcessedResult {
  symbols: SymbolRecord[];
  imports: ImportRecord[];
}

/**
 * Process a single file through either the normal handler path or the adapter
 * pipeline (preProcess → block parsing → framework symbol extraction → enrichment).
 *
 * Returns extracted symbols and imports. The caller is responsible for
 * persisting results to the database.
 */
export async function processFile(
  relPath: string,
  content: Buffer,
  adapters: FrameworkAdapter[],
): Promise<ProcessedResult> {
  // Find the first adapter whose fileFilter matches this path
  const adapter = adapters.find((a) => a.fileFilter(relPath));

  let symbols: SymbolRecord[];
  let imports: ImportRecord[];

  if (adapter) {
    const result = await processWithAdapter(relPath, content, adapter);
    symbols = result.symbols;
    imports = result.imports;
  } else {
    // Normal handler path
    const handler = getHandler(relPath);
    if (!handler) return { symbols: [], imports: [] };

    const tree = await parseFile(content, handler);
    symbols = handler.extractSymbols(tree, content, relPath);
    imports = handler.extractImports(tree, content).map((imp) => ({
      ...imp,
      sourceFile: relPath,
    }));
  }

  // Apply enrichMetadata from ALL active adapters — not just the one that handled
  // the file. This enables cross-adapter enrichment (e.g. Nuxt adapter adds route
  // path metadata to component symbols emitted by the Vue adapter).
  for (const a of adapters) {
    if (a.enrichMetadata) {
      symbols = symbols.map((s) => a.enrichMetadata!(s));
    }
  }

  // enrichSymbols runs AFTER enrichMetadata so Stage 2 (framework-derived
  // summaries) has access to the frameworkMeta set by adapters.
  return { symbols: enrichSymbols(symbols), imports };
}

async function processWithAdapter(
  relPath: string,
  content: Buffer,
  adapter: FrameworkAdapter,
): Promise<ProcessedResult> {
  let blockSymbols: SymbolRecord[] = [];
  const imports: ImportRecord[] = [];
  let primaryTree = null;

  if (adapter.preProcess) {
    // Split the file into typed blocks (e.g. .vue → <script> + <template>)
    const blocks = adapter.preProcess(content, relPath);

    for (const block of blocks) {
      if (block.language !== 'typescript' && block.language !== 'javascript') continue;

      const handler = getHandlerByLanguage(block.language);
      if (!handler) continue;

      const tree = await parseFile(block.content, handler);
      primaryTree = tree;

      // Extract symbols from this block and shift byte offsets back into the
      // original file so get-symbol-source returns the correct slice.
      const rawSymbols = handler.extractSymbols(tree, block.content, relPath);
      for (const sym of rawSymbols) {
        blockSymbols.push({
          ...sym,
          startByte: sym.startByte + block.offsetInOriginal,
          endByte: sym.endByte + block.offsetInOriginal,
        });
      }

      // Imports — source paths are relative to the original file location
      imports.push(
        ...handler.extractImports(tree, block.content).map((imp) => ({
          ...imp,
          sourceFile: relPath,
        })),
      );
    }
  } else {
    // No preProcess — let the normal handler parse, then adapter enriches
    const handler = getHandler(relPath);
    if (handler) {
      const tree = await parseFile(content, handler);
      primaryTree = tree;
      blockSymbols = handler.extractSymbols(tree, content, relPath);
      imports.push(
        ...handler.extractImports(tree, content).map((imp) => ({
          ...imp,
          sourceFile: relPath,
        })),
      );
    }
  }

  // Extract framework-specific symbols (may use tree or derive from file path alone)
  const frameworkSymbols = adapter.extractFrameworkSymbols(primaryTree, content, relPath);

  // Merge: framework symbols override block symbols with the same id
  const merged = new Map<string, SymbolRecord>();
  for (const sym of blockSymbols) merged.set(sym.id, sym);
  for (const sym of frameworkSymbols) merged.set(sym.id, sym);

  // Return raw merged symbols — processFile runs enrichSymbols after all
  // adapters' enrichMetadata so Stage 2 has access to the final frameworkMeta.
  const symbols = Array.from(merged.values());
  return { symbols, imports };
}
