/**
 * PureContext Edit Guard hook (soft warning, PreToolUse).
 *
 * Before Edit, Write, or MultiEdit, emits a gentle reminder to stderr
 * suggesting the agent consult PureContext read tools first.
 * Never blocks — always exits 0.
 *
 * Set PURECONTEXT_ALLOW_RAW_WRITE=1 to silence warnings.
 *
 * Claude Code settings.json entry:
 *   "PreToolUse": [{ "matcher": "Edit|Write|MultiEdit",
 *                    "hooks": [{ "type": "command",
 *                                "command": "node ~/.claude/hooks/purecontext-edit-guard.mjs" }] }]
 */

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

export function shouldWarn(toolName) {
  return toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
}

export function buildWarning(filePath) {
  const target = filePath ? ` ${filePath}` : '';
  return [
    `PureContext: before editing${target}, consider:`,
    '  get_symbol_source   → confirm you are editing the right implementation',
    '  get_blast_radius    → understand what breaks if you change this',
    '  find_references     → find all call sites that may need updating',
  ].join('\n');
}

async function main() {
  if (process.env.PURECONTEXT_ALLOW_RAW_WRITE === '1') {
    process.exit(0);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const toolName = input.tool_name ?? '';

    if (!shouldWarn(toolName)) {
      process.exit(0);
    }

    const filePath = input.tool_input?.file_path ?? '';
    process.stderr.write(buildWarning(filePath) + '\n');
  } catch { /* never block */ }

  process.exit(0);
}

if (process.argv[1] === __filename) main();
