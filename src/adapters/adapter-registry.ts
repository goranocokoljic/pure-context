/**
 * Adapter registry — registration and auto-discovery of framework adapters.
 *
 * Adapters self-register by calling `registerAdapter(myAdapter)` at module level.
 * The pipeline calls `discoverAdapters()` at indexing time to get the active set.
 */

import type { FrameworkAdapter } from '../core/types.js';
import type { PureContextConfig } from '../config/config-schema.js';
import { logger } from '../core/logger.js';

// ─── Registry store ───────────────────────────────────────────────────────────

const _registry: Map<string, FrameworkAdapter> = new Map();

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a framework adapter. Adapters call this at module load time.
 * Re-registering the same name overwrites the previous entry.
 */
export function registerAdapter(adapter: FrameworkAdapter): void {
  _registry.set(adapter.name, adapter);
}

/**
 * Return all registered adapters (in registration order).
 */
export function getRegisteredAdapters(): FrameworkAdapter[] {
  return Array.from(_registry.values());
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Resolve which adapters are active for a given project root, honouring the
 * `adapters` config setting:
 *   'auto'   — call detect() on every registered adapter
 *   'none'   — return []
 *   string[] — activate named adapters only (skip detect(), assume active)
 */
export async function discoverAdapters(
  projectRoot: string,
  config: Pick<PureContextConfig, 'adapters'>,
): Promise<FrameworkAdapter[]> {
  if (config.adapters === 'none') {
    return [];
  }

  const candidates =
    config.adapters === 'auto'
      ? getRegisteredAdapters()
      : (config.adapters as string[])
          .map((name) => {
            const adapter = _registry.get(name);
            if (!adapter) {
              logger.warn(`Adapter '${name}' is listed in config but not registered — skipping`);
            }
            return adapter;
          })
          .filter((a): a is FrameworkAdapter => a !== undefined);

  if (config.adapters === 'auto') {
    // Run all detect() calls concurrently
    const results = await Promise.all(
      candidates.map(async (adapter) => {
        try {
          const active = await adapter.detect(projectRoot);
          if (active) {
            logger.info(`Adapter '${adapter.name}' detected and activated`);
          }
          return active ? adapter : null;
        } catch (err) {
          logger.warn(`Adapter '${adapter.name}' detect() failed: ${err} — skipping`);
          return null;
        }
      }),
    );
    return results.filter((a): a is FrameworkAdapter => a !== null);
  }

  // Named list — trust the config, no detect() call needed
  return candidates;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Collect all additional file extensions declared by a set of active adapters.
 * Used by file discovery to expand the extension allowlist beyond what language
 * handlers cover.
 */
export function getAdapterExtensions(adapters: FrameworkAdapter[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const adapter of adapters) {
    for (const ext of adapter.extensions()) {
      const lower = ext.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(lower);
      }
    }
  }
  return result;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Reset registry to empty — for use in tests only. */
export function _resetForTesting(): void {
  _registry.clear();
}
