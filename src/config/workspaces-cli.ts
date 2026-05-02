import { openAuthDatabase } from '../core/db/api-keys.js';
import { TenantStore } from '../core/db/tenants.js';

export function runWorkspacesCommand(args: string[]): void {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printWorkspacesHelp();
    process.exit(0);
  }
  if (sub === 'list') {
    cmdWorkspacesList();
    process.exit(0);
  }
  if (sub === 'create') {
    const nameIdx = args.indexOf('--name');
    const name = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1]! : null;
    if (!name) {
      process.stderr.write('Error: --name is required\n');
      process.exit(1);
    }
    const planIdx = args.indexOf('--plan');
    const plan =
      planIdx >= 0 && args[planIdx + 1]
        ? (args[planIdx + 1] as 'free' | 'team' | 'enterprise')
        : 'team';
    cmdWorkspacesCreate({ name, plan });
    process.exit(0);
  }
  process.stderr.write(`Unknown workspaces subcommand: ${sub}\n`);
  printWorkspacesHelp();
  process.exit(1);
}

function printWorkspacesHelp(): void {
  process.stdout.write(`
purecontext-mcp workspaces — manage workspaces for team/cloud deployments

Usage:
  purecontext-mcp workspaces list
  purecontext-mcp workspaces create --name <name> [--plan free|team|enterprise]

Commands:
  list                   List all workspaces with member and repo counts
  create --name <name>   Create a new workspace

Examples:
  purecontext-mcp workspaces list
  purecontext-mcp workspaces create --name "My Team"
  purecontext-mcp workspaces create --name "Enterprise" --plan enterprise
`.trimStart());
}

function cmdWorkspacesList(): void {
  const db = openAuthDatabase();
  try {
    const store = new TenantStore(db);
    const workspaces = store.list();
    if (workspaces.length === 0) {
      console.log('No workspaces found. Use "purecontext-mcp workspaces create" to add one.');
      return;
    }
    console.log('\nWorkspaces:\n');
    for (const ws of workspaces) {
      const memberStr = ws.memberCount !== undefined ? `${ws.memberCount} member(s)` : '';
      console.log(`  ${ws.id}  "${ws.name}"  plan: ${ws.plan}  ${memberStr}  created: ${ws.createdAt}`);
    }
    console.log();
  } finally {
    db.close();
  }
}

function cmdWorkspacesCreate(opts: { name: string; plan: 'free' | 'team' | 'enterprise' }): void {
  const db = openAuthDatabase();
  try {
    const store = new TenantStore(db);
    const ws = store.create(opts.name, { plan: opts.plan });
    console.log('\nWorkspace created successfully.\n');
    console.log(`  ID:    ${ws.id}`);
    console.log(`  Name:  ${ws.name}`);
    console.log(`  Plan:  ${ws.plan}`);
    console.log();
  } finally {
    db.close();
  }
}
