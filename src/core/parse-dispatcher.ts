import _ParserImport from 'web-tree-sitter';
import type ParserType from 'web-tree-sitter';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { LanguageHandler } from './types.js';
import type { Tree } from './types.js';
import { ParseError } from './errors.js';

// web-tree-sitter is CJS. ESM interop varies between Node.js native ESM and
// bundler/test-runner transforms (e.g. vitest). Handle both shapes defensively:
// - Node native ESM: default import IS the constructor
// - vitest/rollup transform: default import has a `.default` sub-property
type _ParserModule = typeof _ParserImport & { default?: typeof _ParserImport };
const Parser = ((_ParserImport as _ParserModule).default ?? _ParserImport) as typeof _ParserImport;

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve grammars/ relative to the compiled output location (dist/core/ → ../../grammars/)
export const GRAMMARS_DIR = resolve(__dirname, '../../grammars');

// ─── Module state ─────────────────────────────────────────────────────────────

let initialized = false;
let sharedParser: ParserType | null = null;
const languageCache = new Map<string, ParserType.Language>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize web-tree-sitter. Must be called once before parseFile().
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initParser(): Promise<void> {
  if (initialized) return;

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
  if (!initialized || !sharedParser) {
    throw new ParseError('Parser not initialized — call initParser() first', '<unknown>');
  }

  const language = await loadLanguage(handler.grammarPath());
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
  languageCache.clear();
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function loadLanguage(grammarPath: string): Promise<ParserType.Language> {
  const cached = languageCache.get(grammarPath);
  if (cached) return cached;

  const language = await Parser.Language.load(grammarPath);
  languageCache.set(grammarPath, language);
  return language;
}
