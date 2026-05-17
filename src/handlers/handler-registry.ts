import { extname } from 'path';
import type { LanguageHandler } from '../core/types.js';

// ─── Registry state ───────────────────────────────────────────────────────────

const byExtension = new Map<string, LanguageHandler>();
const handlers: LanguageHandler[] = [];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a language handler. Each extension it claims maps to this handler.
 * If two handlers claim the same extension, the last registration wins.
 */
export function registerHandler(handler: LanguageHandler): void {
  for (const ext of handler.extensions()) {
    byExtension.set(ext.toLowerCase(), handler);
  }
  if (!handlers.includes(handler)) {
    handlers.push(handler);
  }
}

/** Resolve the handler for a given file path by its extension. Returns null if unsupported. */
export function getHandler(filePath: string): LanguageHandler | null {
  const ext = extname(filePath).toLowerCase();
  return byExtension.get(ext) ?? null;
}

/** All registered handlers, in registration order. */
export function getAllHandlers(): LanguageHandler[] {
  return [...handlers];
}

/** All file extensions currently supported across all registered handlers. */
export function getSupportedExtensions(): string[] {
  return [...byExtension.keys()];
}

/**
 * Resolve a handler by language name ('typescript' → .ts handler, 'javascript' → .js handler).
 * Used by the adapter pipeline to route pre-processed blocks.
 */
export function getHandlerByLanguage(language: string): LanguageHandler | null {
  const langToExt: Record<string, string> = {
    typescript: '.ts',
    javascript: '.js',
    python: '.py',
    go: '.go',
    rust: '.rs',
    java: '.java',
    csharp: '.cs',
    php: '.php',
    ruby: '.rb',
    kotlin: '.kt',
    c: '.c',
    cpp: '.cpp',
    lua: '.lua',
    dart: '.dart',
    swift: '.swift',
    elixir: '.ex',
    elixir_script: '.exs',
    haskell: '.hs',
    lhs: '.lhs',
    scala: '.scala',
    scala_script: '.sc',
    r: '.r',
    rmd: '.Rmd',
    bash: '.sh',
    shell: '.sh',
    perl: '.pl',
    terraform: '.tf',
    hcl: '.tf',
    nix: '.nix',
    protobuf: '.proto',
    proto: '.proto',
    graphql: '.graphql',
    gql: '.graphql',
    groovy: '.groovy',
    gradle: '.gradle',
    erlang: '.erl',
    erl: '.erl',
    gleam: '.gleam',
    gdscript: '.gd',
    gd: '.gd',
    xml: '.xml',
    xul: '.xul',
    scss: '.scss',
    sass: '.sass',
    less: '.less',
    css: '.css',
    'objective-c': '.m',
    objc: '.m',
    objectivecpp: '.mm',
    'objective-c++': '.mm',
    fortran: '.f90',
    f90: '.f90',
    f95: '.f95',
    f03: '.f03',
    f08: '.f08',
    for: '.for',
  };
  const ext = langToExt[language.toLowerCase()];
  return ext ? (byExtension.get(ext) ?? null) : null;
}

/** Remove all registrations (use only in tests). */
export function _resetForTesting(): void {
  byExtension.clear();
  handlers.length = 0;
}
