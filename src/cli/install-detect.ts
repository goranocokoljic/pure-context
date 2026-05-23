/**
 * IDE/agent detection for `purecontext-mcp install all`.
 *
 * Each tool is detected by the presence of a characteristic directory or
 * config file in the project root or the user's home directory.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

// ─── Platform config paths ────────────────────────────────────────────────────

export function getClaudeDesktopConfigPath(): string | null {
  const p = platform();
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (p === 'win32') {
    const appdata = process.env['APPDATA'];
    if (!appdata) return null;
    return join(appdata, 'Claude', 'claude_desktop_config.json');
  }
  // Linux and others
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Return the list of AI coding tools detected in `projectRoot` or the user's
 * home directory.  Detection is based on characteristic directory/file signals.
 *
 * `cline` and `vscode` both trigger on `.vscode/` — intentional; they write
 * to different output files so there is no conflict.
 */
export async function detectInstalledIDEs(projectRoot: string): Promise<string[]> {
  const detected: string[] = [];

  // Claude Code — .claude/ directory in project or home
  if (existsSync(join(projectRoot, '.claude')) || existsSync(join(homedir(), '.claude'))) {
    detected.push('claude');
  }

  // Cursor — .cursor/ directory in project
  if (existsSync(join(projectRoot, '.cursor'))) {
    detected.push('cursor');
  }

  // Windsurf — .windsurf/ directory in project
  if (existsSync(join(projectRoot, '.windsurf'))) {
    detected.push('windsurf');
  }

  // Continue — .continue/ directory in project
  if (existsSync(join(projectRoot, '.continue'))) {
    detected.push('continue');
  }

  // Cline — .vscode/ directory exists (Cline runs inside VS Code)
  if (existsSync(join(projectRoot, '.vscode'))) {
    detected.push('cline');
  }

  // Roo Code — .roo/ directory in project
  if (existsSync(join(projectRoot, '.roo'))) {
    detected.push('roo-code');
  }

  // GitHub Copilot — .vscode/ directory exists
  if (existsSync(join(projectRoot, '.vscode'))) {
    detected.push('copilot');
  }

  // Claude Desktop — platform config path
  const claudeDesktopConfig = getClaudeDesktopConfigPath();
  if (claudeDesktopConfig && existsSync(claudeDesktopConfig)) {
    detected.push('claude-desktop');
  }

  return detected;
}
