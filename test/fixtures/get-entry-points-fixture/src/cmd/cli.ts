/**
 * CLI entry point.
 */

/** Run the CLI with the given argument list. */
export async function runCli(args: string[]): Promise<void> {
  const command = args[0];
  switch (command) {
    case 'build':
      await buildCommand(args.slice(1));
      break;
    case 'deploy':
      await deployCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

/** Handles the "build" sub-command. Not a top-level entry point. */
async function buildCommand(args: string[]): Promise<void> {
  console.log('Building...', args);
}

/** Handles the "deploy" sub-command. Not a top-level entry point. */
async function deployCommand(args: string[]): Promise<void> {
  console.log('Deploying...', args);
}
