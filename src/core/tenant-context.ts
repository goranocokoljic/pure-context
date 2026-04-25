/**
 * TenantContext — identifies the current tenant for a request.
 *
 * In single-tenant (stdio) mode, the context is always DEFAULT_TENANT_CONTEXT.
 * In multi-tenant HTTP mode, the context is derived from the authenticated API key
 * and attached to each request before calling any service method.
 *
 * All data-store operations accept an optional TenantContext. When provided,
 * queries are scoped with `AND tenant_id = ?` to prevent cross-tenant data access.
 */

export const DEFAULT_TENANT_ID = 'local';

export interface TenantContext {
  /** Identifies the owning tenant for data isolation. */
  tenantId: string;
  /** Permissions granted to the current request (from API key). */
  permissions?: string[];
  /** Rate limit tier identifier (from API key). */
  rateLimitTier?: string;
}

/** Context used in single-tenant / local CLI mode — no auth, no isolation. */
export const DEFAULT_TENANT_CONTEXT: TenantContext = {
  tenantId: DEFAULT_TENANT_ID,
};
