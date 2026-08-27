/**
 * File processing pipeline: parse a source file, extract symbols and imports.
 *
 * Extracted from index-manager.ts so it can be imported by both the main thread
 * and worker threads (indexing-worker.ts) without pulling in the full indexing
 * pipeline (DB, watcher, etc.).
 */

import type { ImportRecord, FrameworkAdapter, SymbolRecord, Tree } from './types.js';
import { parseFile } from './parse-dispatcher.js';
import { getHandler, getHandlerByLanguage } from '../handlers/handler-registry.js';
import { enrichSymbols } from '../summarizer/summarizer.js';
import { calculateComplexity, shouldCalculateMetrics } from './metrics/complexity-calculator.js';
import { buildOffsetConverter, convertSymbolSpans } from './offsets.js';

/**
 * Offset conventions at the storage boundary (see src/core/offsets.ts):
 *   - Tree-sitter handlers emit node.startIndex — UTF-16 CHAR indices.
 *     Converted to true byte offsets here, once per file.
 *   - Framework adapters emit char indices over the full decoded file
 *     (regex match.index / node indices). Converted here too.
 *   - Regex-only handlers (grammarPath() === null) compute TRUE BYTE offsets
 *     themselves (Buffer.byteLength line accumulation) — NOT converted.
 * Stored start_byte/end_byte are therefore always true byte offsets.
 */

export interface ProcessedResult {
  symbols: SymbolRecord[];
  imports: ImportRecord[];
  /**
   * Package/namespace the file declares (JVM languages), null when the file
   * declares none or the handler does not implement extractPackage.
   */
  declaredPackage: string | null;
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
  let declaredPackage: string | null = null;

  if (adapter) {
    const result = await processWithAdapter(relPath, content, adapter);
    symbols = result.symbols;
    imports = result.imports;
    declaredPackage = result.declaredPackage;
  } else {
    // Normal handler path
    let handler = getHandler(relPath);
    // Extensionless file fallback: detect bash/sh scripts by shebang
    if (!handler && !relPath.includes('.')) {
      const firstLine = content.slice(0, 256).toString('utf8').split('\n')[0] ?? '';
      if (/^#!.*\b(bash|sh|zsh)\b/.test(firstLine)) {
        handler = getHandlerByLanguage('bash');
      }
    }
    if (!handler) return { symbols: [], imports: [], declaredPackage: null };

    // Content-based detection gate: handlers with detect() may claim ambiguous
    // extensions (.yaml, .json) but only want to process matching files.
    if (handler.detect && !handler.detect(content)) {
      return { symbols: [], imports: [], declaredPackage: null };
    }

    if (handler.grammarPath() === null) {
      // No tree-sitter grammar — handler parses the content directly.
      symbols = handler.extractSymbols(null as unknown as Tree, content, relPath);
      imports = handler.extractImports(null as unknown as Tree, content).map((imp) => ({
        ...imp,
        sourceFile: relPath,
      }));
      declaredPackage = handler.extractPackage?.(null, content) ?? null;
    } else {
      const tree = await parseFile(content, handler);
      symbols = convertSymbolSpans(
        handler.extractSymbols(tree, content, relPath),
        buildOffsetConverter(content),
      );
      imports = handler.extractImports(tree, content).map((imp) => ({
        ...imp,
        sourceFile: relPath,
      }));
      declaredPackage = handler.extractPackage?.(tree, content) ?? null;
    }

    // C/ObjC header fallback: the ObjC handler returns 0 symbols for pure-C headers
    // (its detection guard skips files without @interface/@protocol markers). When
    // that happens, re-process the file with the C handler so that #define macros,
    // typedef structs, and forward declarations in C headers are still indexed.
    if (symbols.length === 0 && relPath.endsWith('.h')) {
      const cFallback = getHandlerByLanguage('c');
      if (cFallback && cFallback !== handler) {
        const cTree = await parseFile(content, cFallback);
        const cSymbols = convertSymbolSpans(
          cFallback.extractSymbols(cTree, content, relPath),
          buildOffsetConverter(content),
        );
        if (cSymbols.length > 0) {
          symbols = cSymbols;
          imports = cFallback.extractImports(cTree, content).map((imp) => ({
            ...imp,
            sourceFile: relPath,
          }));
        }
      }
    }
  }

  // Apply enrichMetadata from ALL active adapters — not just the one that handled
  // the file. This enables cross-adapter enrichment (e.g. Nuxt adapter adds route
  // path metadata to component symbols emitted by the Vue adapter).
  for (const a of adapters) {
    if (a.enrichMetadata) {
      symbols = symbols.map((s) => a.enrichMetadata!(s));
    }
  }

  // Calculate complexity metrics for measurable symbol kinds.
  // We slice the source bytes for each symbol and run token-based analysis.
  symbols = symbols.map((s) => {
    if (!shouldCalculateMetrics(s.kind)) return s;
    const source = content.slice(s.startByte, s.endByte).toString('utf8');
    return { ...s, metrics: calculateComplexity(source) };
  });

  // enrichSymbols runs AFTER enrichMetadata so Stage 2 (framework-derived
  // summaries) has access to the frameworkMeta set by adapters.
  return { symbols: enrichSymbols(symbols), imports, declaredPackage };
}

async function processWithAdapter(
  relPath: string,
  content: Buffer,
  adapter: FrameworkAdapter,
): Promise<ProcessedResult> {
  let blockSymbols: SymbolRecord[] = [];
  const imports: ImportRecord[] = [];
  let primaryTree = null;
  let declaredPackage: string | null = null;

  if (adapter.preProcess) {
    // Split the file into typed blocks (e.g. .vue → <script> + <template>)
    const blocks = adapter.preProcess(content, relPath);

    for (const block of blocks) {
      if (block.language !== 'typescript' && block.language !== 'javascript' && block.language !== 'tsx') continue;

      const handler = getHandlerByLanguage(block.language);
      if (!handler) continue;

      const tree = await parseFile(block.content, handler);
      primaryTree = tree;

      // Extract symbols from this block. Node indices are CHAR indices into
      // the block — convert to block-local byte offsets first, THEN shift by
      // offsetInOriginal (which preprocessors compute as a true byte offset).
      // Mixing char indices with the byte shift corrupted spans in SFC files
      // with non-ASCII text before the script block.
      const rawSymbols = convertSymbolSpans(
        handler.extractSymbols(tree, block.content, relPath),
        buildOffsetConverter(block.content),
      );
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
    // Content-based detection gate — mirror of the normal handler path.
    if (handler && (!handler.detect || handler.detect(content))) {
      if (handler.grammarPath() === null) {
        // Regex-only handler (XML, SCSS, …) — no tree-sitter parse. The android
        // adapter routes AndroidManifest.xml here; parseFile would throw on a
        // null grammar and drop the whole file.
        blockSymbols = handler.extractSymbols(null as unknown as Tree, content, relPath);
        imports.push(
          ...handler.extractImports(null as unknown as Tree, content).map((imp) => ({
            ...imp,
            sourceFile: relPath,
          })),
        );
        declaredPackage = handler.extractPackage?.(null, content) ?? null;
      } else {
        const tree = await parseFile(content, handler);
        primaryTree = tree;
        blockSymbols = convertSymbolSpans(
          handler.extractSymbols(tree, content, relPath),
          buildOffsetConverter(content),
        );
        imports.push(
          ...handler.extractImports(tree, content).map((imp) => ({
            ...imp,
            sourceFile: relPath,
          })),
        );
        // JVM framework adapters (Spring, Ktor, …) route .java/.kt files through
        // this branch — the package must still be captured for import resolution.
        declaredPackage = handler.extractPackage?.(tree, content) ?? null;
      }
    }
  }

  // Extract framework-specific symbols (may use tree or derive from file path
  // alone). Adapters emit CHAR indices over the full decoded file — convert to
  // true byte offsets before merging with the already-byte block symbols.
  const frameworkSymbols = convertSymbolSpans(
    adapter.extractFrameworkSymbols(primaryTree, content, relPath),
    buildOffsetConverter(content),
  );

  // Merge: framework symbols override block symbols with the same id
  const merged = new Map<string, SymbolRecord>();
  for (const sym of blockSymbols) merged.set(sym.id, sym);
  for (const sym of frameworkSymbols) merged.set(sym.id, sym);

  // Return raw merged symbols — processFile runs enrichSymbols after all
  // adapters' enrichMetadata so Stage 2 has access to the final frameworkMeta.
  const symbols = Array.from(merged.values());
  return { symbols, imports, declaredPackage };
}
