/**
 * Minimal Node.js version guard.
 *
 * This module is imported *first* — before any heavy or native modules
 * (notably `better-sqlite3`) are evaluated. On an unsupported Node runtime
 * those imports fail with a cryptic native-ABI or missing-API error that
 * surfaces to MCP hosts as the opaque "MCP error -32000: Connection closed".
 * Running the check first turns that into a clear, actionable message.
 *
 * Keep this file DEPENDENCY-FREE and written in syntax understood by very old
 * Node runtimes, so the friendly message still prints when someone runs the
 * server on, say, Node 14 or 16.
 */

const MIN_MAJOR = 18;

const current = process.versions.node;
const major = Number(current.split('.')[0]);

if (Number.isNaN(major) || major < MIN_MAJOR) {
  process.stderr.write(
    '\n' +
      `purecontext-mcp requires Node.js >= ${MIN_MAJOR}, but is running on v${current}.\n` +
      '\n' +
      'Its native dependency (better-sqlite3) and several runtime APIs are not\n' +
      `available below Node ${MIN_MAJOR}, so the server cannot start.\n` +
      '\n' +
      'How to fix:\n' +
      `  • Upgrade Node.js to ${MIN_MAJOR}+ (20 or 22 LTS recommended).\n` +
      '  • If you use a version manager (Volta/nvm/asdf), make sure the Node\n' +
      '    version active for THIS MCP server is >= ' + MIN_MAJOR + '. An MCP server\n' +
      '    should be pinned to a fixed Node, independent of the current project.\n' +
      '\n',
  );
  process.exit(1);
}

export {};
