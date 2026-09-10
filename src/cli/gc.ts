/**
 * `purecontext-mcp index gc [--yes] [--blobs] [--repo <path>]` (Phase 100, Task 622).
 *
 * Dry-run by default: prints every orphan index (no repo row, or a root path
 * that no longer exists and no re-index running) and, with `--blobs`, every
 * unreferenced blob in `<dataDir>/blobs.db`. `--yes` deletes exactly that
 * list. A live index is never touched.
 */
import { resolve } from 'node:path';
import { applyGc, planGc, formatGcPlan, formatBytes } from '../core/index-gc.js';

export interface GcCliOptions {
  yes: boolean;
  blobs: boolean;
  scopeRoot?: string;
  json: boolean;
}

export function parseGcArgs(args: string[]): GcCliOptions {
  const opts: GcCliOptions = { yes: false, blobs: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--blobs') opts.blobs = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--repo' || a === '--path') {
      const v = args[++i];
      if (!v) throw new Error(`${a} needs a path`);
      opts.scopeRoot = resolve(v);
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    }
  }
  return opts;
}

export function cmdIndexGc(args: string[]): number {
  let opts: GcCliOptions;
  try {
    opts = parseGcArgs(args);
  } catch (err) {
    process.stderr.write(`${String((err as Error).message ?? err)}\n`);
    process.stderr.write('Usage: purecontext-mcp index gc [--yes] [--blobs] [--repo <path>] [--json]\n');
    return 1;
  }

  if (!opts.yes) {
    const plan = planGc({ blobs: opts.blobs, scopeRoot: opts.scopeRoot });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ dryRun: true, ...plan }, null, 2) + '\n');
      return 0;
    }
    for (const line of formatGcPlan(plan, { blobsRequested: opts.blobs })) process.stdout.write(line + '\n');
    if (plan.reclaimableBytes > 0) {
      process.stdout.write('\nDry run — nothing deleted. Re-run with --yes to delete the list above.\n');
    } else {
      process.stdout.write('\nNothing to collect.\n');
    }
    return 0;
  }

  const result = applyGc({ blobs: opts.blobs, scopeRoot: opts.scopeRoot });
  if (opts.json) {
    process.stdout.write(JSON.stringify({ dryRun: false, ...result }, null, 2) + '\n');
    return result.failedIndexes.length > 0 ? 1 : 0;
  }
  for (const d of result.deletedIndexes) {
    process.stdout.write(`Deleted ${d.file}  (${formatBytes(d.bytes)}, ${d.reason})\n`);
  }
  for (const f of result.failedIndexes) {
    process.stdout.write(`FAILED  ${f.file}  ${f.error}\n`);
  }
  if (opts.blobs) {
    process.stdout.write(
      `Blobs swept: ${result.blobsDeleted} (${formatBytes(result.blobBytesFreed)}); ` +
        `blobs.db ${formatBytes(result.blobFileBytesBefore)} → ${formatBytes(result.blobFileBytesAfter)}\n`,
    );
  }
  const freed = result.deletedIndexes.reduce((n, d) => n + d.bytes, 0) + result.blobBytesFreed;
  process.stdout.write(`Freed ${formatBytes(freed)}.\n`);
  return result.failedIndexes.length > 0 ? 1 : 0;
}
