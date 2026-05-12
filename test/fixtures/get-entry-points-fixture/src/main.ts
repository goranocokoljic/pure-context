/**
 * Application entry point.
 * Bootstraps the server and CLI.
 */

import { startServer } from './services/server.js';
import { runCli } from './cmd/cli.js';

/** Main entry point — starts the application. */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--cli')) {
    await runCli(args);
  } else {
    await startServer();
  }
}

/** Internal helper — not an entry point. */
function parseFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      map.set(args[i].slice(2), args[i + 1] ?? 'true');
    }
  }
  return map;
}
