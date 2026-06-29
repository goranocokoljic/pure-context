#!/usr/bin/env node
/**
 * Sync the install-managed agent-rules block in this repo's own docs from the
 * single source of truth (`assets/agent-rules.md`).
 *
 * The compact always-on agent rules live in `assets/agent-rules.md`. The install
 * command reads that file directly when writing IDE rule files for users. This
 * script keeps the repo's OWN dogfood copies in sync — the managed block,
 * delimited by the `<!-- purecontext-mcp-start/end -->` markers, is regenerated
 * rather than hand-edited.
 *
 *   node scripts/sync-agent-rules.mjs
 *   npm run sync:rules
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const START = '<!-- purecontext-mcp-start -->';
const END = '<!-- purecontext-mcp-end -->';

const rules = readFileSync(join(root, 'assets', 'agent-rules.md'), 'utf-8').trimEnd();
const block = `${START}\n${rules}\n${END}`;

// Files in this repo that carry the install-managed block.
const targets = ['CLAUDE.md'];

let changed = 0;
for (const rel of targets) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    console.warn(`skip: ${rel} not found`);
    continue;
  }
  const text = readFileSync(file, 'utf-8');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    console.warn(`skip: ${rel} has no managed block markers`);
    continue;
  }
  const updated = text.slice(0, s) + block + text.slice(e + END.length);
  if (updated !== text) {
    writeFileSync(file, updated, 'utf-8');
    console.log(`synced: ${rel}`);
    changed++;
  } else {
    console.log(`up to date: ${rel}`);
  }
}

console.log(changed ? `\nDone — ${changed} file(s) updated.` : '\nAll managed blocks already current.');
