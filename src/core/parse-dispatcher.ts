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
 * The returned Tree's node startIndex/endIndex are byte offsets into `source`.
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

  // Pass a callback so tree-sitter operates on the raw Buffer bytes.
  // Node startIndex/endIndex are byte offsets into the original source Buffer.
  const tree = sharedParser.parse((startByte: number): string | null => {
    if (startByte >= source.length) return null;
    return source.toString('utf8', startByte);
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
