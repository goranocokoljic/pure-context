import type ParserType from 'web-tree-sitter';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { LanguageHandler } from './types.js';
import type { Tree } from './types.js';
import { GrammarNotFoundError, ParseError } from './errors.js';
export { GRAMMARS_DIR } from './grammar-paths.js';

// web-tree-sitter is CJS. ESM interop varies between Node.js native ESM and
// bundler/test-runner transforms (e.g. vitest). Handle both shapes defensively:
// - Node native ESM: default import IS the constructor
// - vitest/rollup transform: default import has a `.default` sub-property
type _ParserModule = typeof ParserType & { default?: typeof ParserType };

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Module state ─────────────────────────────────────────────────────────────

let initialized = false;
let sharedParser: ParserType | null = null;
let Parser: typeof ParserType | null = null;
const languageCache = new Map<string, ParserType.Language>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize web-tree-sitter. Must be called once before parseFile().
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * web-tree-sitter is imported dynamically here so that merely importing this
 * module does NOT execute the Emscripten bootstrap code (which reads
 * `document.currentScript` and crashes in Node.js environments).
 */
export async function initParser(): Promise<void> {
  if (initialized) return;

  // web-tree-sitter is compiled with Emscripten and reads `document.currentScript`
  // at module-load time to auto-detect its script URL (browser idiom). In Node.js
  // there is no `document`, so the access throws. Stub it before importing so the
  // module loads cleanly. The actual WASM path is always supplied via locateFile().
  const g = global as unknown as Record<string, unknown>;
  if (g['document'] === undefined) {
    g['document'] = { currentScript: null };
  }

  // Dynamic import defers web-tree-sitter's module-level Emscripten bootstrap
  // until this function is actually called.
  const _ParserImport = (await import('web-tree-sitter')).default;
  Parser = ((_ParserImport as _ParserModule).default ?? _ParserImport) as typeof ParserType;

  // Locate tree-sitter.wasm next to the web-tree-sitter package entry point
  const wasmPath = resolve(
    dirname(_require.resolve('web-tree-sitter')),
    'tree-sitter.wasm',
  );

  await Parser.init({
    locateFile: () => wasmPath,
  });

  sharedParser = new Parser();
  initialized = true;
}

/**
 * Parse source bytes using the grammar provided by the given handler.
 *
 * IMPORTANT: the returned Tree's node startIndex/endIndex are UTF-16
 * code-unit indices into `source.toString('utf8')` — NOT byte offsets.
 * See the comment on the parse callback below. The processing pipeline
 * (file-processor.ts) converts spans to true byte offsets at the storage
 * boundary via src/core/offsets.ts.
 */
export async function parseFile(source: Buffer, handler: LanguageHandler): Promise<Tree> {
  if (!initialized || !sharedParser || !Parser) {
    throw new ParseError('Parser not initialized — call initParser() first', '<unknown>');
  }

  const grammarPath = handler.grammarPath();
  if (grammarPath === null) {
    throw new ParseError(
      'parseFile called on a handler with no grammar (grammarPath is null). ' +
        'Use the null-grammar path in file-processor instead.',
      '<unknown>',
    );
  }
  const language = await loadLanguage(grammarPath);
  sharedParser.setLanguage(language);

  // Decode the buffer once to a JS string for character-indexed parsing.
  //
  // web-tree-sitter's callback mode advances its internal cursor by the
  // JavaScript character count of each returned chunk, NOT by byte count.
  // For files containing multibyte UTF-8 sequences (e.g. accented letters,
  // CJK, emoji), this means the WASM cursor is a CHARACTER index, not a byte
  // offset. The callback must therefore also use character indices so that
  // multi-chunk reads (triggered during complex grammar parsing, e.g. PHP
  // qualified namespaces) return the correct text.
  //
  // Consequence: node.startIndex / node.endIndex are JavaScript CHARACTER
  // indices into source.toString('utf8'), NOT raw byte offsets.
  // Always extract node text via sourceStr.slice(node.startIndex, node.endIndex)
  // — NEVER source.toString('utf8', startIndex, endIndex), which treats
  // character indices as byte offsets and produces garbled text for multibyte
  // files.
  const sourceStr = source.toString('utf8');
  const tree = sharedParser.parse((startIndex: number): string | null => {
    if (startIndex >= sourceStr.length) return null;
    return sourceStr.slice(startIndex);
  });

  return tree;
}

/** True once initParser() has completed successfully. */
export function isInitialized(): boolean {
  return initialized;
}

/** Exposed for testing — resets all state. Use only in tests. */
export function _resetForTesting(): void {
  initialized = false;
  sharedParser = null;
  Parser = null;
  languageCache.clear();
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function loadLanguage(grammarPath: string): Promise<ParserType.Language> {
  if (!Parser) throw new ParseError('Parser not initialized', '<unknown>');
  const cached = languageCache.get(grammarPath);
  if (cached) return cached;

  try {
    const language = await Parser.Language.load(grammarPath);
    languageCache.set(grammarPath, language);
    return language;
  } catch (err) {
    throw new GrammarNotFoundError(grammarPath, err);
  }
}
