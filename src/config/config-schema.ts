import { homedir } from 'os';
import { join } from 'path';

// ─── Config shape ─────────────────────────────────────────────────────────────

export interface PureContextConfig {
  /** Directory where SQLite index files are stored. */
  indexDir: string;
  /** Maximum number of source files to index per project (default 1000). */
  fileLimit: number;
  /** Debounce window in ms for the file watcher (default 2000). */
  watchDebounceMs: number;
  /** Additional glob patterns to exclude during file discovery. */
  excludePatterns: string[];
  /**
   * Which framework adapters to activate.
   *   'auto'   — detect from project config files (default)
   *   'none'   — disable all adapters
   *   string[] — explicit list (e.g. ['vue', 'nuxt'])
   */
  adapters: 'auto' | 'none' | string[];
  /** AI summarization settings. */
  ai: {
    /**
     * AI provider for symbol summarization.
     *   'none'               — disables AI (default)
     *   'anthropic'          — Anthropic Messages API (uses ANTHROPIC_API_KEY or ai.apiKey)
     *   'openai-compatible'  — any OpenAI-compatible /v1/chat/completions endpoint
     */
    provider: 'anthropic' | 'openai-compatible' | 'none';
    /** Allow the server to make outbound AI API calls (default false). */
    allowRemoteAI: boolean;
    /**
     * API key. Accepts a literal key or `'${ENV_VAR}'` notation (resolved from env at load time).
     * For 'anthropic', falls back to ANTHROPIC_API_KEY if not set.
     */
    apiKey: string;
    /**
     * Base URL for the OpenAI-compatible endpoint (e.g. 'http://localhost:11434').
     * Required when provider is 'openai-compatible'. Ignored for 'anthropic'.
     */
    endpoint: string | null;
    /** Model to use. Defaults to 'claude-haiku-4-5-20251001' for Anthropic, 'gpt-4o-mini' for openai-compatible. */
    model: string;
    /** Number of symbols per API batch (default 50). Lower values suit self-hosted models with small context windows. */
    batchSize: number;
    /**
     * Embedding model name for semantic search.
     * For 'voyage' provider: 'voyage-code-2' (default).
     * For 'openai-compatible': model supported by the endpoint (e.g. 'nomic-embed-text').
     * null = no embeddings.
     */
    embeddingModel: string | null;
    /**
     * Embedding provider for semantic search.
     * 'voyage'            — Voyage AI (Anthropic-recommended for code, uses ai.apiKey).
     * 'openai-compatible' — any /v1/embeddings endpoint (uses ai.endpoint and ai.apiKey).
     * null                — semantic search disabled (FTS5 keyword fallback only).
     */
    embeddingProvider: 'voyage' | 'openai-compatible' | null;
    /**
     * API key for OpenAI services (embeddings, etc.).
     * Accepts a literal key or '${ENV_VAR}' notation.
     * Falls back to OPENAI_API_KEY env var if not set.
     */
    openaiApiKey: string;
  };
  /** Phase 11 semantic search settings (HNSW + embeddings). */
  semantic: {
    /**
     * Whether semantic search is active.
     * When false (default), all search falls back to FTS keyword search.
     */
    enabled: boolean;
    /**
     * Embedding provider for Phase 11 HNSW semantic search.
     *   'anthropic' — Anthropic embedding endpoint (uses ai.apiKey / ANTHROPIC_API_KEY)
     *   'openai'    — OpenAI text-embedding-3-small (uses ai.openaiApiKey / OPENAI_API_KEY)
     *   'local'     — Local model via Ollama or similar (uses semantic.localEmbeddingEndpoint)
     *   'none'      — Semantic search disabled (default)
     */
    provider: 'anthropic' | 'openai' | 'local' | 'none';
    /**
     * Base URL for local embedding endpoint (e.g. 'http://localhost:11434').
     * Required when provider is 'local'.
     */
    localEmbeddingEndpoint: string | null;
    /**
     * Embedding vector dimension.
     * null = auto-detected from provider (1024 for Anthropic, 1536 for OpenAI, 384 for local).
     */
    dimension: number | null;
    /**
     * Minimum symbol count to trigger semantic indexing (default: 50000).
     * Repos below this threshold use FTS-only search.
     * Lower this value to test semantic indexing on small repos.
     */
    threshold: number;
    /**
     * Number of symbols per embedding batch (default: 500).
     * Balances API call overhead against memory usage.
     */
    batchSize: number;
    /**
     * Number of parallel embedding batches (default: 2).
     * Higher values improve throughput but increase API quota usage.
     */
    concurrency: number;
  };
  /** Maximum file size in bytes to index (default: 1 MB). Files larger than this are skipped. */
  maxFileSizeBytes: number;
  /**
   * When false (default), symlinks that resolve to a path outside the project root are blocked.
   * Set to true only if your project intentionally uses external symlinks.
   */
  allowSymlinks: boolean;
  /**
   * Which transport(s) to start.
   *   'stdio' — stdin/stdout (default; required for Claude Code)
   *   'http'  — HTTP + Streamable HTTP
   *   'both'  — stdio AND HTTP simultaneously
   */
  transport: 'stdio' | 'http' | 'both';
  /** HTTP server settings (used when transport is 'http' or 'both'). */
  http: {
    /** TCP port to listen on (default: 3000). */
    port: number;
    /** Interface to bind to (default: '127.0.0.1' — loopback only). */
    host: string;
    /**
     * Allowed CORS origins. Supports '*' wildcard within a segment.
     * Default: ['http://localhost:*'] — any localhost port.
     */
    corsOrigins: string[];
    /** Bearer token authentication for the HTTP transport. */
    auth: {
      /**
       * Enable bearer token authentication on all /mcp requests.
       * Default: false. Strongly recommended when host is not '127.0.0.1'.
       */
      enabled: boolean;
      /**
       * Bearer token to require. Supports '${ENV_VAR}' notation.
       * If enabled=true and this is empty, a random token is generated
       * at startup and printed to stderr.
       */
      token: string;
    };
  };
  /**
   * Rate limiting settings (HTTP transport only).
   * Ignored when transport is 'stdio'.
   */
  rateLimit: {
    /**
     * Enable rate limiting on all MCP tool calls.
     * Default: true (HTTP transport). Stdio transport never rate-limits.
     */
    enabled: boolean;
    /**
     * Maximum tokens a single client bucket can accumulate (burst capacity).
     * Default: 100.
     */
    maxTokens: number;
    /**
     * Tokens replenished per second for each client bucket.
     * Default: 10.
     */
    refillRate: number;
    /**
     * Token costs per MCP tool name. Tools not listed cost 1 token.
     * Expensive operations (e.g. indexing) should have higher costs.
     */
    perToolLimits: Record<string, number>;
  };
  /**
   * Architectural layer definitions and allowed dependency directions.
   * Used by the get_layer_violations tool.
   * null means no layer config — the tool will report an error if called without inline config.
   */
  layers: LayersConfig | null;
}

// ─── Layers config ────────────────────────────────────────────────────────────

export interface LayerDefinition {
  /** Layer name (e.g. 'core', 'handlers'). */
  name: string;
  /** Glob patterns for files belonging to this layer (relative to repo root). */
  paths: string[];
}

export interface LayerRule {
  from: string;
  to: string;
  allowed: boolean;
}

export interface LayersConfig {
  definitions: LayerDefinition[];
  rules: LayerRule[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: PureContextConfig = {
  indexDir: join(homedir(), '.purecontext', 'indexes'),
  fileLimit: 1000,
  watchDebounceMs: 2000,
  excludePatterns: [],
  adapters: 'auto',
  ai: {
    provider: 'none',
    allowRemoteAI: false,
    apiKey: '',
    endpoint: null,
    model: 'claude-haiku-4-5-20251001',
    batchSize: 50,
    embeddingModel: null,
    embeddingProvider: null,
    openaiApiKey: '',
  },
  semantic: {
    enabled: false,
    provider: 'none',
    localEmbeddingEndpoint: null,
    dimension: null,
    threshold: 50_000,
    batchSize: 500,
    concurrency: 2,
  },
  maxFileSizeBytes: 1_048_576,
  allowSymlinks: false,
  transport: 'stdio',
  http: {
    port: 3000,
    host: '127.0.0.1',
    corsOrigins: ['http://localhost:*'],
    auth: {
      enabled: false,
      token: '',
    },
  },
  rateLimit: {
    enabled: true,
    maxTokens: 100,
    refillRate: 10,
    perToolLimits: {
      index_folder: 10,
      index_repo: 10,
      get_context_bundle: 3,
      get_blast_radius: 3,
      get_repo_outline: 2,
      find_dead_code: 5,
      search_symbols: 1,
      search_text: 1,
      search_semantic: 1,
      get_symbol_source: 1,
      get_file_outline: 1,
      get_file_tree: 1,
      list_repos: 1,
      resolve_repo: 1,
      find_importers: 1,
      get_layer_violations: 2,
      get_savings_stats: 1,
    },
  },
  layers: {
    definitions: [
      { name: 'core',     paths: ['src/core/**'] },
      { name: 'handlers', paths: ['src/handlers/**'] },
      { name: 'adapters', paths: ['src/adapters/**'] },
      { name: 'server',   paths: ['src/server/**'] },
    ],
    rules: [
      { from: 'adapters', to: 'handlers', allowed: true },
      { from: 'adapters', to: 'core',     allowed: true },
      { from: 'handlers', to: 'core',     allowed: true },
      { from: 'server',   to: 'core',     allowed: true },
      { from: 'server',   to: 'handlers', allowed: true },
      { from: 'server',   to: 'adapters', allowed: true },
      { from: 'core',     to: 'handlers', allowed: false },
      { from: 'core',     to: 'adapters', allowed: false },
      { from: 'handlers', to: 'adapters', allowed: false },
    ],
  },
};

// ─── Config file location ─────────────────────────────────────────────────────

export function getConfigPath(): string {
  return join(homedir(), '.purecontext', 'config.json');
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConfig(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['Config must be a JSON object'] };
  }

  const cfg = raw as Record<string, unknown>;

  if ('indexDir' in cfg && typeof cfg['indexDir'] !== 'string') {
    errors.push('indexDir must be a string');
  }
  if ('fileLimit' in cfg) {
    const v = cfg['fileLimit'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      errors.push('fileLimit must be a positive integer');
    }
  }
  if ('watchDebounceMs' in cfg) {
    const v = cfg['watchDebounceMs'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      errors.push('watchDebounceMs must be a non-negative integer');
    }
  }
  if ('excludePatterns' in cfg) {
    const v = cfg['excludePatterns'];
    if (!Array.isArray(v) || v.some((p) => typeof p !== 'string')) {
      errors.push('excludePatterns must be an array of strings');
    }
  }
  if ('adapters' in cfg) {
    const v = cfg['adapters'];
    if (
      v !== 'auto' &&
      v !== 'none' &&
      !(Array.isArray(v) && v.every((a) => typeof a === 'string'))
    ) {
      errors.push("adapters must be 'auto', 'none', or an array of strings");
    }
  }
  if ('ai' in cfg) {
    const ai = cfg['ai'];
    if (typeof ai !== 'object' || ai === null || Array.isArray(ai)) {
      errors.push('ai must be an object');
    } else {
      const a = ai as Record<string, unknown>;
      if ('provider' in a && !['anthropic', 'openai-compatible', 'none'].includes(a['provider'] as string)) {
        errors.push("ai.provider must be 'anthropic', 'openai-compatible', or 'none'");
      }
      if ('allowRemoteAI' in a && typeof a['allowRemoteAI'] !== 'boolean') {
        errors.push('ai.allowRemoteAI must be a boolean');
      }
      if ('apiKey' in a && typeof a['apiKey'] !== 'string') {
        errors.push('ai.apiKey must be a string');
      }
      if ('endpoint' in a && a['endpoint'] !== null && typeof a['endpoint'] !== 'string') {
        errors.push('ai.endpoint must be a string or null');
      }
      if ('model' in a && typeof a['model'] !== 'string') {
        errors.push('ai.model must be a string');
      }
      if ('batchSize' in a) {
        const bs = a['batchSize'];
        if (typeof bs !== 'number' || !Number.isInteger(bs) || bs < 1) {
          errors.push('ai.batchSize must be a positive integer');
        }
      }
      if ('embeddingProvider' in a) {
        const ep = a['embeddingProvider'];
        if (ep !== null && ep !== 'voyage' && ep !== 'openai-compatible') {
          errors.push("ai.embeddingProvider must be 'voyage', 'openai-compatible', or null");
        }
      }
      if ('embeddingModel' in a && a['embeddingModel'] !== null && typeof a['embeddingModel'] !== 'string') {
        errors.push('ai.embeddingModel must be a string or null');
      }
      if ('openaiApiKey' in a && typeof a['openaiApiKey'] !== 'string') {
        errors.push('ai.openaiApiKey must be a string');
      }
    }
  }
  if ('semantic' in cfg) {
    const s = cfg['semantic'];
    if (typeof s !== 'object' || s === null || Array.isArray(s)) {
      errors.push('semantic must be an object');
    } else {
      const sem = s as Record<string, unknown>;
      if ('enabled' in sem && typeof sem['enabled'] !== 'boolean') {
        errors.push('semantic.enabled must be a boolean');
      }
      if ('provider' in sem) {
        const p = sem['provider'];
        if (!['anthropic', 'openai', 'local', 'none'].includes(p as string)) {
          errors.push("semantic.provider must be 'anthropic', 'openai', 'local', or 'none'");
        }
      }
      if ('localEmbeddingEndpoint' in sem) {
        const ep = sem['localEmbeddingEndpoint'];
        if (ep !== null && typeof ep !== 'string') {
          errors.push('semantic.localEmbeddingEndpoint must be a string or null');
        }
      }
      if ('dimension' in sem) {
        const d = sem['dimension'];
        if (d !== null && (typeof d !== 'number' || !Number.isInteger(d) || d < 1)) {
          errors.push('semantic.dimension must be a positive integer or null');
        }
      }
      if ('threshold' in sem) {
        const t = sem['threshold'];
        if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) {
          errors.push('semantic.threshold must be a non-negative integer');
        }
      }
      if ('batchSize' in sem) {
        const bs = sem['batchSize'];
        if (typeof bs !== 'number' || !Number.isInteger(bs) || bs < 1) {
          errors.push('semantic.batchSize must be a positive integer');
        }
      }
      if ('concurrency' in sem) {
        const c = sem['concurrency'];
        if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) {
          errors.push('semantic.concurrency must be a positive integer');
        }
      }
    }
  }
  if ('maxFileSizeBytes' in cfg) {
    const v = cfg['maxFileSizeBytes'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      errors.push('maxFileSizeBytes must be a positive integer');
    }
  }
  if ('allowSymlinks' in cfg && typeof cfg['allowSymlinks'] !== 'boolean') {
    errors.push('allowSymlinks must be a boolean');
  }
  if ('transport' in cfg) {
    const v = cfg['transport'];
    if (!['stdio', 'http', 'both'].includes(v as string)) {
      errors.push("transport must be 'stdio', 'http', or 'both'");
    }
  }
  if ('http' in cfg) {
    const h = cfg['http'];
    if (typeof h !== 'object' || h === null || Array.isArray(h)) {
      errors.push('http must be an object');
    } else {
      const http = h as Record<string, unknown>;
      if ('port' in http) {
        const p = http['port'];
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
          errors.push('http.port must be an integer between 1 and 65535');
        }
      }
      if ('host' in http && typeof http['host'] !== 'string') {
        errors.push('http.host must be a string');
      }
      if ('corsOrigins' in http) {
        const o = http['corsOrigins'];
        if (!Array.isArray(o) || o.some((x) => typeof x !== 'string')) {
          errors.push('http.corsOrigins must be an array of strings');
        }
      }
      if ('auth' in http) {
        const auth = http['auth'];
        if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
          errors.push('http.auth must be an object');
        } else {
          const a = auth as Record<string, unknown>;
          if ('enabled' in a && typeof a['enabled'] !== 'boolean') {
            errors.push('http.auth.enabled must be a boolean');
          }
          if ('token' in a && typeof a['token'] !== 'string') {
            errors.push('http.auth.token must be a string');
          }
        }
      }
    }
  }

  if ('rateLimit' in cfg) {
    const rl = cfg['rateLimit'];
    if (typeof rl !== 'object' || rl === null || Array.isArray(rl)) {
      errors.push('rateLimit must be an object');
    } else {
      const r = rl as Record<string, unknown>;
      if ('enabled' in r && typeof r['enabled'] !== 'boolean') {
        errors.push('rateLimit.enabled must be a boolean');
      }
      if ('maxTokens' in r) {
        const v = r['maxTokens'];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          errors.push('rateLimit.maxTokens must be a positive integer');
        }
      }
      if ('refillRate' in r) {
        const v = r['refillRate'];
        if (typeof v !== 'number' || v <= 0) {
          errors.push('rateLimit.refillRate must be a positive number');
        }
      }
      if ('perToolLimits' in r) {
        const v = r['perToolLimits'];
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          errors.push('rateLimit.perToolLimits must be an object');
        } else {
          for (const [tool, cost] of Object.entries(v as Record<string, unknown>)) {
            if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 1) {
              errors.push(`rateLimit.perToolLimits["${tool}"] must be a positive integer`);
            }
          }
        }
      }
    }
  }

  if ('layers' in cfg) {
    const l = cfg['layers'];
    if (l !== null) {
      if (typeof l !== 'object' || Array.isArray(l)) {
        errors.push('layers must be an object or null');
      } else {
        const layers = l as Record<string, unknown>;
        if ('definitions' in layers) {
          const defs = layers['definitions'];
          if (!Array.isArray(defs)) {
            errors.push('layers.definitions must be an array');
          } else {
            for (const d of defs) {
              if (
                typeof d !== 'object' ||
                d === null ||
                typeof (d as Record<string, unknown>)['name'] !== 'string' ||
                !Array.isArray((d as Record<string, unknown>)['paths'])
              ) {
                errors.push('each layers.definitions entry must have name (string) and paths (array)');
                break;
              }
            }
          }
        }
        if ('rules' in layers) {
          const rules = layers['rules'];
          if (!Array.isArray(rules)) {
            errors.push('layers.rules must be an array');
          } else {
            for (const r of rules) {
              const rr = r as Record<string, unknown>;
              if (
                typeof r !== 'object' ||
                r === null ||
                typeof rr['from'] !== 'string' ||
                typeof rr['to'] !== 'string' ||
                typeof rr['allowed'] !== 'boolean'
              ) {
                errors.push('each layers.rules entry must have from (string), to (string), allowed (boolean)');
                break;
              }
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
