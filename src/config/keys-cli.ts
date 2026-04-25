import { ApiKeyValidator } from '../server/auth/api-key.js';
import {
  openAuthDatabase,
  getTenant,
  listTenants,
  type Permission,
} from '../core/db/api-keys.js';

// ─── Public commands ──────────────────────────────────────────────────────────

/**
 * `purecontext-mcp keys create --tenant <id> [--permissions read,write] [--test]`
 *
 * Generate and print a new API key.  The raw key is only shown once.
 */
export function cmdKeysCreate(opts: {
  tenantId: string;
  tenantName?: string;
  permissions: Permission[];
  isTest?: boolean;
  rateLimitTier?: string;
}): void {
  const validator = new ApiKeyValidator();
  try {
    const key = validator.generate(opts.tenantId, opts.permissions, {
      isTest: opts.isTest ?? false,
      rateLimitTier: opts.rateLimitTier ?? 'default',
      tenantName: opts.tenantName ?? opts.tenantId,
    });

    console.log('\nAPI key created successfully.\n');
    console.log(`  Key:         ${key}`);
    console.log(`  Tenant ID:   ${opts.tenantId.slice(0, 8).padEnd(8, '0')}`);
    console.log(`  Permissions: ${opts.permissions.join(', ')}`);
    console.log(`  Tier:        ${opts.rateLimitTier ?? 'default'}`);
    console.log(`  Test key:    ${opts.isTest ? 'yes' : 'no'}`);
    console.log('\nStore this key securely — it cannot be retrieved again.\n');
  } finally {
    validator.close();
  }
}

/**
 * `purecontext-mcp keys list [--tenant <id>]`
 *
 * List API keys (hashes only — raw keys are never stored).
 */
export async function cmdKeysList(opts: { tenantId?: string } = {}): Promise<void> {
  const db = openAuthDatabase();
  try {
    if (opts.tenantId) {
      // List for a specific tenant
      const { ApiKeyStore } = await importApiKeyStore();
      const store = new ApiKeyStore(db);
      const keys = store.listByTenant(opts.tenantId);

      if (keys.length === 0) {
        console.log(`No API keys found for tenant '${opts.tenantId}'.`);
        return;
      }

      console.log(`\nAPI keys for tenant '${opts.tenantId}':\n`);
      for (const k of keys) {
        const status = k.revokedAt ? `REVOKED (${k.revokedAt})` : 'active';
        console.log(`  ${k.keyHash.slice(0, 12)}...  [${k.permissions.join(', ')}]  ${k.rateLimitTier}  ${status}`);
        console.log(`    Created:   ${k.createdAt}`);
        if (k.lastUsedAt) console.log(`    Last used: ${k.lastUsedAt}`);
      }
      console.log();
    } else {
      // List all tenants with key counts
      const tenants = listTenants(db);

      if (tenants.length === 0) {
        console.log('No tenants found. Use "purecontext-mcp keys create" to add one.');
        return;
      }

      const { ApiKeyStore } = await importApiKeyStore();
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
 * `purecontext-mcp keys revoke <key-prefix>`
 *
 * Revoke an API key by its full raw value or by hash prefix.
 */
export function cmdKeysRevoke(keyOrPrefix: string): void {
  const validator = new ApiKeyValidator();
  try {
    validator.revoke(keyOrPrefix);
    console.log(`Revoked key matching '${keyOrPrefix.slice(0, 20)}...'`);
  } finally {
    validator.close();
  }
}

/**
 * Print usage for the `keys` subcommand.
 */
export function printKeysHelp(): void {
  process.stdout.write(`
purecontext-mcp keys — manage API keys for multi-tenant HTTP access

Usage:
  purecontext-mcp keys create --tenant <id> [options]
  purecontext-mcp keys list [--tenant <id>]
  purecontext-mcp keys revoke <key-or-hash-prefix>

Create options:
  --tenant <id>          Tenant identifier (8 hex chars or a short slug)
  --name <name>          Human-readable tenant name (default: tenant id)
  --permissions <list>   Comma-separated: read,write,admin (default: read)
  --tier <tier>          Rate-limit tier name (default: default)
  --test                 Generate a cl_test_ key instead of cl_live_

Examples:
  purecontext-mcp keys create --tenant acme --permissions read,write
  purecontext-mcp keys list
  purecontext-mcp keys list --tenant acme
  purecontext-mcp keys revoke cl_live_61636d650_...
`.trimStart());
}

// ─── Internal ─────────────────────────────────────────────────────────────────

// Lazy import to avoid circular deps (ApiKeyStore is in core/db)
async function importApiKeyStore() {
  const { ApiKeyStore } = await import('../core/db/api-keys.js');
  return { ApiKeyStore };
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
    const tenantIdx = args.indexOf('--tenant');
    if (tenantIdx < 0 || !args[tenantIdx + 1]) {
      process.stderr.write('Error: --tenant <id> is required\n');
      process.exit(1);
    }
    const tenantId = args[tenantIdx + 1];

    const nameIdx = args.indexOf('--name');
    const tenantName = nameIdx >= 0 ? args[nameIdx + 1] : tenantId;

    const permIdx = args.indexOf('--permissions');
    const permRaw = permIdx >= 0 ? args[permIdx + 1] : 'read';
    const permissions = parsePermissions(permRaw);

    const tierIdx = args.indexOf('--tier');
    const rateLimitTier = tierIdx >= 0 ? args[tierIdx + 1] : 'default';

    const isTest = args.includes('--test');

    cmdKeysCreate({ tenantId, tenantName, permissions, isTest, rateLimitTier });
    process.exit(0);
  }

  if (sub === 'list') {
    const tenantIdx = args.indexOf('--tenant');
    const tenantId = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
    // cmdKeysList is async due to dynamic import — run it
    cmdKeysList({ tenantId }).then(() => process.exit(0)).catch((err) => {
      process.stderr.write(`Error: ${err}\n`);
      process.exit(1);
    });
    return; // don't exit synchronously — let the Promise resolve
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
