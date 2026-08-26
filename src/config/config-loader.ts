import { readFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { logger } from '../core/logger.js';
import { ConfigValidationError } from '../core/errors.js';
import {
  DEFAULT_CONFIG,
  getConfigPath,
  validateConfig,
  type PureContextConfig,
} from './config-schema.js';

// ─── Module-level singleton ────────────────────────────────────────────────────

let _loaded: PureContextConfig | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the effective configuration.
 *
 * Resolution order (later values win):
 *   1. Built-in defaults
 *   2. `~/.purecontext/config.json` (if it exists)
 *
 * Result is cached after the first call. Call `reloadConfig()` to refresh.
 */
export function getConfig(): PureContextConfig {
  if (_loaded) return _loaded;
  _loaded = loadConfig();
  return _loaded;
}

/**
 * Clear the cached config so the next `getConfig()` call re-reads from disk.
 */
export function reloadConfig(): void {
  _loaded = null;
}

/**
 * Load and merge config without caching. Useful for `config --check`.
 */
export function loadConfig(configPath?: string): PureContextConfig {
  const path = configPath ?? getConfigPath();

  if (!existsSync(path)) {
    logger.debug(`No config file found at ${path} — using defaults`);
    return mergeConfig({});
  }

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf8');
    raw = JSON.parse(text);
  } catch (err) {
    logger.warn(`Failed to parse config at ${path}: ${err} — using defaults`);
    return mergeConfig({});
  }

  const { valid, errors } = validateConfig(raw);
  if (!valid) {
    const formatted = errors.map((e) => `  ${e}`).join('\n');
    const err = new ConfigValidationError(formatted, path);
    logger.warn(
      `${err.userMessage}\nRun 'purecontext-mcp config --check' for full validation.\n` +
      'Falling back to defaults.',
    );
    return { ...DEFAULT_CONFIG, ai: { ...DEFAULT_CONFIG.ai }, telemetry: { ...DEFAULT_CONFIG.telemetry } };
  }

  return mergeConfig(raw as Partial<PureContextConfig>);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve `'${ENV_VAR}'` notation in a string value.
 * Returns the environment variable value, or the original string if it doesn't
 * match the notation, or an empty string if the variable is unset.
 */
export function resolveEnvVar(value: string): string {
  const match = /^\$\{([^}]+)\}$/.exec(value);
  if (!match) return value;
  const resolved = process.env[match[1]] ?? '';
  if (!resolved) {
    logger.warn(`Config: env variable "${match[1]}" referenced in ai.apiKey is not set`);
  }
  return resolved;
}

function mergeConfig (partial: Partial<PureContextConfig>): PureContextConfig {
  // Environment variable overrides (priority: env var > config file > default)
  const pctxDataDir = process.env['PCTX_DATA_DIR'];
  const pctxPort = process.env['PCTX_PORT'] ? parseInt(process.env['PCTX_PORT'], 10) : undefined;
  const pctxHost = process.env['PCTX_HOST'];

  const rawApiKey = partial.ai?.apiKey ?? DEFAULT_CONFIG.ai.apiKey;
  const resolvedApiKey = resolveEnvVar(rawApiKey);

  // Resolve auth token (supports ${ENV_VAR} notation)
  const authEnabled = partial.http?.auth?.enabled ?? DEFAULT_CONFIG.http.auth.enabled;
  const rawAuthToken = partial.http?.auth?.token ?? DEFAULT_CONFIG.http.auth.token;
  let resolvedAuthToken = resolveEnvVar(rawAuthToken);

  // Generate a random token if auth is enabled but no token is configured
  if (authEnabled && !resolvedAuthToken) {
    resolvedAuthToken = randomBytes(32).toString('hex');
    process.stderr.write(`PureContext MCP auth token: ${resolvedAuthToken}\n`);
  }

  const cfg: PureContextConfig = {
    indexDir: pctxDataDir
      ? join(pctxDataDir, 'indexes')
      : (partial.indexDir ?? DEFAULT_CONFIG.indexDir),
    fileLimit: partial.fileLimit ?? DEFAULT_CONFIG.fileLimit,
    watchDebounceMs: partial.watchDebounceMs ?? DEFAULT_CONFIG.watchDebounceMs,
    concurrency: partial.concurrency ?? DEFAULT_CONFIG.concurrency,
    excludePatterns: partial.excludePatterns ?? DEFAULT_CONFIG.excludePatterns,
    adapters: partial.adapters ?? DEFAULT_CONFIG.adapters,
    ai: {
      provider: partial.ai?.provider ?? DEFAULT_CONFIG.ai.provider,
      allowRemoteAI: partial.ai?.allowRemoteAI ?? DEFAULT_CONFIG.ai.allowRemoteAI,
      apiKey: resolvedApiKey,
      endpoint: partial.ai?.endpoint !== undefined ? partial.ai.endpoint : DEFAULT_CONFIG.ai.endpoint,
      model: partial.ai?.model ?? DEFAULT_CONFIG.ai.model,
      batchSize: partial.ai?.batchSize ?? DEFAULT_CONFIG.ai.batchSize,
      embeddingModel: partial.ai?.embeddingModel !== undefined
        ? partial.ai.embeddingModel
        : DEFAULT_CONFIG.ai.embeddingModel,
      embeddingProvider: partial.ai?.embeddingProvider !== undefined
        ? partial.ai.embeddingProvider
        : DEFAULT_CONFIG.ai.embeddingProvider,
      openaiApiKey: resolveEnvVar(partial.ai?.openaiApiKey ?? DEFAULT_CONFIG.ai.openaiApiKey),
    },
    semantic: {
      enabled: partial.semantic?.enabled ?? DEFAULT_CONFIG.semantic.enabled,
      provider: partial.semantic?.provider ?? DEFAULT_CONFIG.semantic.provider,
      localEmbeddingEndpoint: partial.semantic?.localEmbeddingEndpoint !== undefined
        ? partial.semantic.localEmbeddingEndpoint
        : DEFAULT_CONFIG.semantic.localEmbeddingEndpoint,
      dimension: partial.semantic?.dimension !== undefined
        ? partial.semantic.dimension
        : DEFAULT_CONFIG.semantic.dimension,
      threshold: partial.semantic?.threshold ?? DEFAULT_CONFIG.semantic.threshold,
      batchSize: partial.semantic?.batchSize ?? DEFAULT_CONFIG.semantic.batchSize,
      concurrency: partial.semantic?.concurrency ?? DEFAULT_CONFIG.semantic.concurrency,
    },
    maxFileSizeBytes: partial.maxFileSizeBytes ?? DEFAULT_CONFIG.maxFileSizeBytes,
    allowSymlinks: partial.allowSymlinks ?? DEFAULT_CONFIG.allowSymlinks,
    indexing: {
      cssVariables: partial.indexing?.cssVariables ?? DEFAULT_CONFIG.indexing.cssVariables,
      commitBatchSize:
        partial.indexing?.commitBatchSize ?? DEFAULT_CONFIG.indexing.commitBatchSize,
    },
    git: {
      coChangeDepth: partial.git?.coChangeDepth ?? DEFAULT_CONFIG.git.coChangeDepth,
      fileHistoryDepth: partial.git?.fileHistoryDepth ?? DEFAULT_CONFIG.git.fileHistoryDepth,
      megaCommitThreshold:
        partial.git?.megaCommitThreshold ?? DEFAULT_CONFIG.git.megaCommitThreshold,
    },
    risk: {
      weights: {
        churn: partial.risk?.weights?.churn ?? DEFAULT_CONFIG.risk.weights.churn,
        centrality: partial.risk?.weights?.centrality ?? DEFAULT_CONFIG.risk.weights.centrality,
        complexity: partial.risk?.weights?.complexity ?? DEFAULT_CONFIG.risk.weights.complexity,
        testGap: partial.risk?.weights?.testGap ?? DEFAULT_CONFIG.risk.weights.testGap,
        coChange: partial.risk?.weights?.coChange ?? DEFAULT_CONFIG.risk.weights.coChange,
      },
    },
    changeSynthesis: {
      coChangeConfidenceThreshold:
        partial.changeSynthesis?.coChangeConfidenceThreshold ??
        DEFAULT_CONFIG.changeSynthesis.coChangeConfidenceThreshold,
      maxSymbolsScored:
        partial.changeSynthesis?.maxSymbolsScored ?? DEFAULT_CONFIG.changeSynthesis.maxSymbolsScored,
      maxCoChangeGaps:
        partial.changeSynthesis?.maxCoChangeGaps ?? DEFAULT_CONFIG.changeSynthesis.maxCoChangeGaps,
      maxRecommendedTests:
        partial.changeSynthesis?.maxRecommendedTests ??
        DEFAULT_CONFIG.changeSynthesis.maxRecommendedTests,
    },
    refactoring: {
      maxCandidates:
        partial.refactoring?.maxCandidates ?? DEFAULT_CONFIG.refactoring.maxCandidates,
    },
    consistency: {
      maxDuplicates:
        partial.consistency?.maxDuplicates ?? DEFAULT_CONFIG.consistency.maxDuplicates,
      maxPatternFit:
        partial.consistency?.maxPatternFit ?? DEFAULT_CONFIG.consistency.maxPatternFit,
      maxApiPointer:
        partial.consistency?.maxApiPointer ?? DEFAULT_CONFIG.consistency.maxApiPointer,
    },
    taskContext: {
      seedCount:
        partial.taskContext?.seedCount ?? DEFAULT_CONFIG.taskContext.seedCount,
      expansionDepth:
        partial.taskContext?.expansionDepth ?? DEFAULT_CONFIG.taskContext.expansionDepth,
      maxPool:
        partial.taskContext?.maxPool ?? DEFAULT_CONFIG.taskContext.maxPool,
      maxCoChangePartners:
        partial.taskContext?.maxCoChangePartners ?? DEFAULT_CONFIG.taskContext.maxCoChangePartners,
      maxSymbolsPerPartner:
        partial.taskContext?.maxSymbolsPerPartner ?? DEFAULT_CONFIG.taskContext.maxSymbolsPerPartner,
    },
    graph: {
      maxWildcardFanout:
        partial.graph?.maxWildcardFanout ?? DEFAULT_CONFIG.graph.maxWildcardFanout,
      reservedNamespaces:
        partial.graph?.reservedNamespaces ?? DEFAULT_CONFIG.graph.reservedNamespaces,
    },
    transport: partial.transport ?? DEFAULT_CONFIG.transport,
    http: {
      port: pctxPort ?? partial.http?.port ?? DEFAULT_CONFIG.http.port,
      host: pctxHost ?? partial.http?.host ?? DEFAULT_CONFIG.http.host,
      corsOrigins: partial.http?.corsOrigins ?? DEFAULT_CONFIG.http.corsOrigins,
      auth: {
        enabled: authEnabled,
        token: resolvedAuthToken,
      },
    },
    rateLimit: {
      enabled: partial.rateLimit?.enabled ?? DEFAULT_CONFIG.rateLimit.enabled,
      maxTokens: partial.rateLimit?.maxTokens ?? DEFAULT_CONFIG.rateLimit.maxTokens,
      refillRate: partial.rateLimit?.refillRate ?? DEFAULT_CONFIG.rateLimit.refillRate,
      perToolLimits: partial.rateLimit?.perToolLimits !== undefined
        ? { ...DEFAULT_CONFIG.rateLimit.perToolLimits, ...partial.rateLimit.perToolLimits }
        : { ...DEFAULT_CONFIG.rateLimit.perToolLimits },
    },
    layers: partial.layers !== undefined ? partial.layers : DEFAULT_CONFIG.layers,
    providers: partial.providers !== undefined
      ? { ...DEFAULT_CONFIG.providers, ...partial.providers }
      : { ...DEFAULT_CONFIG.providers },
    server: {
      requireAuth: partial.server?.requireAuth ?? DEFAULT_CONFIG.server.requireAuth,
      adminKey: process.env['PCTX_ADMIN_KEY'] ?? partial.server?.adminKey ?? DEFAULT_CONFIG.server.adminKey,
    },
    telemetry: {
      enabled: partial.telemetry?.enabled ?? DEFAULT_CONFIG.telemetry.enabled,
      endpoint: partial.telemetry?.endpoint ?? DEFAULT_CONFIG.telemetry.endpoint,
    },
    webhooks: {
      enabled: partial.webhooks?.enabled ?? DEFAULT_CONFIG.webhooks.enabled,
      secret: resolveEnvVar(partial.webhooks?.secret ?? DEFAULT_CONFIG.webhooks.secret),
      allowedRepos: partial.webhooks?.allowedRepos ?? DEFAULT_CONFIG.webhooks.allowedRepos,
      autoIndex:
        (process.env['AUTO_INDEX_ON_WEBHOOK'] === 'true') ||
        (partial.webhooks?.autoIndex ?? DEFAULT_CONFIG.webhooks.autoIndex),
    },
  };

  // Warn if remote AI is enabled but no key is available
  if (cfg.ai.allowRemoteAI && cfg.ai.provider !== 'none' && !cfg.ai.apiKey) {
    logger.warn(
      'ai.allowRemoteAI is true but ai.apiKey is empty — AI summarization will be skipped',
    );
  }

  // Warn if host is not loopback and auth is disabled
  if (cfg.transport !== 'stdio' && cfg.http.host !== '127.0.0.1' && !cfg.http.auth.enabled) {
    logger.warn(
      `HTTP server bound to ${cfg.http.host} without auth — consider enabling http.auth.enabled`,
    );
  }

  return cfg;
}
