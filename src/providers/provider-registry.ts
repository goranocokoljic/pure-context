/**
 * Provider registry — registration and auto-discovery of context providers.
 *
 * Providers self-register by calling `registerProvider(myProvider)` at module level.
 * The pipeline calls `discoverProviders()` at the end of indexing to enrich symbols
 * with ecosystem-specific metadata (dbt, Terraform, OpenAPI, etc.).
 */

import type { ContextProvider } from '../core/types.js';
import { logger } from '../core/logger.js';

// ─── Registry store ───────────────────────────────────────────────────────────

const _registry: Map<string, ContextProvider> = new Map();

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a context provider. Providers call this at module load time.
 * Re-registering the same name overwrites the previous entry.
 */
export function registerProvider(provider: ContextProvider): void {
  _registry.set(provider.name, provider);
}

/**
 * Return all registered providers (in registration order).
 */
export function getRegisteredProviders(): ContextProvider[] {
  return Array.from(_registry.values());
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Per-provider config from the `providers` block in config.json.
 *   enabled: false → always skip this provider
 *   enabled: true  → force-activate (skip detect())
 *   absent/undefined → call detect() to decide
 */
export interface ProviderConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

/**
 * Resolve which providers are active for a given project root.
 *
 * @param projectRoot  Absolute path to the project being indexed.
 * @param config       Optional per-provider config from config.json `providers` block.
 *                     When absent, all registered providers are auto-detected.
 */
export async function discoverProviders(
  projectRoot: string,
  config?: Record<string, ProviderConfig>,
): Promise<ContextProvider[]> {
  const candidates = getRegisteredProviders();
  if (candidates.length === 0) return [];

  const results = await Promise.all(
    candidates.map(async (provider): Promise<ContextProvider | null> => {
      const providerCfg = config?.[provider.name];

      // Explicitly disabled in config
      if (providerCfg?.enabled === false) {
        logger.debug(`Provider '${provider.name}' disabled in config — skipping`);
        return null;
      }

      // Force-enabled in config — skip detect()
      if (providerCfg?.enabled === true) {
        logger.info(`Provider '${provider.name}' force-enabled in config`);
        return provider;
      }

      // Auto-detect
      try {
        const active = await provider.detect(projectRoot);
        if (active) {
          logger.info(`Provider '${provider.name}' detected and activated`);
        } else {
          logger.debug(`Provider '${provider.name}' not applicable to this project`);
        }
        return active ? provider : null;
      } catch (err) {
        logger.warn(`Provider '${provider.name}' detect() failed: ${err} — skipping`);
        return null;
      }
    }),
  );

  return results.filter((p): p is ContextProvider => p !== null);
}

/**
 * Get the config block for a specific provider (for use inside provider.enrich()).
 * Returns an empty object if no config is set for this provider.
 */
export function getProviderConfig(
  providerName: string,
  config?: Record<string, ProviderConfig>,
): ProviderConfig {
  return config?.[providerName] ?? {};
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Reset registry to empty — for use in tests only. */
export function _resetForTesting(): void {
  _registry.clear();
}
