import type { Permission } from '../core/db/api-keys.js';

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * `purecontext-mcp keys create --label "Alice's machine" [options]`
 *
 * Generate and print a new API key.  The raw key is only shown once.
 */
export function cmdKeysCreate(opts: {
  label: string | null;
  tenantId?: string;
  permissions: Permission[];
  isTest?: boolean;
  rateLimitTier?: string;
}): void {
  const { createApiKey, openAuthDatabase } = require_db_helpers();
  const db = openAuthDatabase();
  try {
    const tenantId = opts.tenantId ?? 'default';
    const key = createApiKey(db, tenantId, opts.label ?? null, opts.permissions, {
      rateLimitTier: opts.rateLimitTier ?? 'default',
    });

    console.log('\nAPI key created successfully.\n');
    console.log(`  Key:         ${key}`);
    if (opts.label) console.log(`  Label:       ${opts.label}`);
    console.log(`  Tenant ID:   ${tenantId}`);
    console.log(`  Permissions: ${opts.permissions.join(', ')}`);
    console.log(`  Tier:        ${opts.rateLimitTier ?? 'default'}`);
    console.log('\nStore this key securely — it cannot be retrieved again.\n');
  } finally {
    db.close();
  }
}

/**
 * `purecontext-mcp keys list [--tenant <id>]`
 *
 * List API keys (hashes only — raw keys are never stored).
 */
export function cmdKeysList(opts: { tenantId?: string } = {}): void {
  const { openAuthDatabase, ApiKeyStore, listTenants } = require_db_helpers();
  const db = openAuthDatabase();
  try {
    if (opts.tenantId) {
      const store = new ApiKeyStore(db);
      const keys = store.listByTenant(opts.tenantId);

      if (keys.length === 0) {
        console.log(`No API keys found for tenant '${opts.tenantId}'.`);
        return;
      }

      console.log(`\nAPI keys for tenant '${opts.tenantId}':\n`);
      for (const k of keys) {
        const status = k.revokedAt ? `REVOKED (${k.revokedAt})` : 'active';
        const labelStr = k.label ? `  "${k.label}"` : '';
        console.log(`  ${k.keyHash.slice(0, 12)}...${labelStr}  [${k.permissions.join(', ')}]  ${k.rateLimitTier}  ${status}`);
        console.log(`    Created:   ${k.createdAt}`);
        if (k.lastUsedAt) console.log(`    Last used: ${k.lastUsedAt}`);
      }
      console.log();
    } else {
      const tenants = listTenants(db);

      if (tenants.length === 0) {
        console.log('No tenants found. Use "purecontext-mcp keys create" to add one.');
        return;
      }

      const store = new ApiKeyStore(db);

      console.log('\nTenants and API keys:\n');
      for (const t of tenants) {
        const keys = store.listByTenant(t.id);
        const active = keys.filter((k) => !k.revokedAt).length;
        const revoked = keys.length - active;
        console.log(`  ${t.id}  "${t.name}"  (${active} active, ${revoked} revoked)  created: ${t.createdAt}`);
      }
      console.log();
    }
  } finally {
    db.close();
  }
}

/**
 * `purecontext-mcp keys revoke <key-or-prefix>`
 *
 * Revoke an API key by its full raw value or by hash prefix.
 */
export function cmdKeysRevoke(keyOrPrefix: string): void {
  const { revokeApiKey, openAuthDatabase } = require_db_helpers();
  const db = openAuthDatabase();
  try {
    revokeApiKey(db, keyOrPrefix);
    console.log(`Revoked key matching '${keyOrPrefix.slice(0, 20)}...'`);
  } finally {
    db.close();
  }
}

/**
 * Print usage for the `keys` subcommand.
 */
export function printKeysHelp(): void {
  process.stdout.write(`
purecontext-mcp keys — manage API keys for multi-tenant HTTP access

Usage:
  purecontext-mcp keys create --label <description> [options]
  purecontext-mcp keys list [--tenant <id>]
  purecontext-mcp keys revoke <key-or-hash-prefix>

Create options:
  --label <description>  Human-readable label (e.g. "Alice's machine")
  --tenant <id>          Tenant to associate the key with (default: "default")
  --permissions <list>   Comma-separated: read,write,admin (default: read)
  --tier <tier>          Rate-limit tier name (default: default)

Examples:
  purecontext-mcp keys create --label "Alice's machine" --permissions read,write
  purecontext-mcp keys create --label "CI runner" --permissions read --tenant acme
  purecontext-mcp keys list
  purecontext-mcp keys list --tenant acme
  purecontext-mcp keys revoke pctx_abc123...
`.trimStart());
}

// ─── Internal ─────────────────────────────────────────────────────────────────

// Inline require for synchronous access — avoids dynamic import in a synchronous CLI flow.
// ESM note: these are synchronous top-level imports; the function just bundles them for convenience.
import {
  openAuthDatabase,
  ApiKeyStore,
  listTenants,
  createApiKey,
  revokeApiKey,
} from '../core/db/api-keys.js';

function require_db_helpers() {
  return { openAuthDatabase, ApiKeyStore, listTenants, createApiKey, revokeApiKey };
}

// ─── CLI argument parser ──────────────────────────────────────────────────────

/**
 * Parse `process.argv` for the `keys` subcommand and dispatch.
 * Called from `src/index.ts` when `args[0] === 'keys'`.
 */
export function runKeysCommand(args: string[]): void {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printKeysHelp();
    process.exit(0);
  }

  if (sub === 'create') {
    const labelIdx = args.indexOf('--label');
    const label = labelIdx >= 0 && args[labelIdx + 1] ? args[labelIdx + 1]! : null;

    const tenantIdx = args.indexOf('--tenant');
    const tenantId = tenantIdx >= 0 && args[tenantIdx + 1] ? args[tenantIdx + 1] : undefined;

    const permIdx = args.indexOf('--permissions');
    const permRaw = permIdx >= 0 && args[permIdx + 1] ? args[permIdx + 1]! : 'read';
    const permissions = parsePermissions(permRaw);

    const tierIdx = args.indexOf('--tier');
    const rateLimitTier = tierIdx >= 0 && args[tierIdx + 1] ? args[tierIdx + 1] : 'default';

    cmdKeysCreate({ label, tenantId, permissions, rateLimitTier });
    process.exit(0);
  }

  if (sub === 'list') {
    const tenantIdx = args.indexOf('--tenant');
    const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
    cmdKeysList({ tenantId });
    process.exit(0);
  }

  if (sub === 'revoke') {
    const keyOrPrefix = args[1];
    if (!keyOrPrefix) {
      process.stderr.write('Error: key or hash prefix required\n');
      process.exit(1);
    }
    cmdKeysRevoke(keyOrPrefix);
    process.exit(0);
  }

  process.stderr.write(`Unknown keys subcommand: ${sub}\n`);
  printKeysHelp();
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePermissions(raw: string): Permission[] {
  const valid = new Set<Permission>(['read', 'write', 'admin']);
  const parts = raw.split(',').map((p) => p.trim().toLowerCase() as Permission);
  const invalid = parts.filter((p) => !valid.has(p));
  if (invalid.length > 0) {
    process.stderr.write(`Error: invalid permissions: ${invalid.join(', ')}. Valid: read, write, admin\n`);
    process.exit(1);
  }
  return parts;
}
