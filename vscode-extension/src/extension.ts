/**
 * PureContext VS Code Extension — entry point.
 *
 * Activation: onStartupFinished (loads after the editor is ready).
 *
 * Features registered:
 *  - Sidebar outline (TreeDataProvider)        — requires enableOutline: true
 *  - Hover provider                             — requires enableHover: true
 *  - "PureContext: Search Symbols" command      — always available
 *  - "PureContext: Show Symbol Details" command — internal, used by other providers
 *  - "PureContext: Refresh Outline" command     — button in view toolbar
 *  - Status bar item: shows online/offline state
 *
 * Graceful degradation: when the server is unreachable, features are silently
 * disabled and the status bar shows "PureContext: offline".
 */

import * as vscode from 'vscode';
import { RepoResolver } from './repo-resolver';
import { OutlineProvider, SymbolTreeItem } from './providers/outline';
import { HoverProvider } from './providers/hover';
import { showSymbolSearch, jumpToSymbol } from './providers/search';
import { showSymbolPanel } from './views/symbolPanel';
import { listRepos, PureContextClientError } from './client';

// ─── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Status bar ──────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '$(loading~spin) PureContext';
  statusBar.tooltip = 'PureContext — connecting…';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Shared services ─────────────────────────────────────────────────────────
  const resolver = new RepoResolver();

  // ── Outline provider ────────────────────────────────────────────────────────
  const outlineProvider = new OutlineProvider(resolver, statusBar);
  const treeView = vscode.window.createTreeView('purecontext.outline', {
    treeDataProvider: outlineProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // ── Hover provider ──────────────────────────────────────────────────────────
  const hoverDisposable = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    new HoverProvider(resolver),
  );
  context.subscriptions.push(hoverDisposable);

  // ── Commands ────────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('purecontext.searchSymbols', () =>
      showSymbolSearch(resolver),
    ),

    vscode.commands.registerCommand('purecontext.refreshOutline', () => {
      resolver.invalidate();
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) outlineProvider.loadFile(doc);
    }),

    vscode.commands.registerCommand('purecontext.showSymbolPanel', async (item: SymbolTreeItem) => {
      if (!(item instanceof SymbolTreeItem)) return;
      const config = vscode.workspace.getConfiguration('purecontext');
      const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';
      const resolved = await resolver.resolve(serverUrl, item.filePath);
      if (!resolved) return;
      await showSymbolPanel(context, serverUrl, resolved.repoId, item.symbol.id);
    }),

    // Internal command: jump to symbol from outline click or search selection
    vscode.commands.registerCommand(
      'purecontext.jumpToSymbol',
      async (absPath: string, symbol: { name: string; signature: string; filePath: string; repoId?: string; id: string; kind: string; summary: string; startByte: number; endByte: number }) => {
        const config = vscode.workspace.getConfiguration('purecontext');
        const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';
        const resolved = await resolver.resolve(serverUrl, absPath);
        if (!resolved) {
          await jumpToSymbol('', { ...symbol, filePath: absPath, repoId: '' } as Parameters<typeof jumpToSymbol>[1]);
          return;
        }
        await jumpToSymbol(resolved.rootPath, { ...symbol, repoId: resolved.repoId } as Parameters<typeof jumpToSymbol>[1]);
      },
    ),
  );

  // ── React to active editor changes ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) {
        outlineProvider.clear();
        return;
      }
      await outlineProvider.loadFile(editor.document);
    }),
  );

  // ── React to config changes ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('purecontext')) {
        resolver.invalidate();
        const doc = vscode.window.activeTextEditor?.document;
        if (doc) outlineProvider.loadFile(doc);
      }
    }),
  );

  // ── Initial connection check ────────────────────────────────────────────────
  await checkServerAndUpdateStatus(statusBar);

  // Check server health every 30 s
  const healthInterval = setInterval(
    () => checkServerAndUpdateStatus(statusBar),
    30_000,
  );
  context.subscriptions.push({ dispose: () => clearInterval(healthInterval) });

  // Load outline for the currently active file (if any)
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (activeDoc) {
    outlineProvider.loadFile(activeDoc).catch(() => undefined);
  }
}

// ─── Deactivation ─────────────────────────────────────────────────────────────

export function deactivate(): void {
  // VS Code disposes subscriptions automatically
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkServerAndUpdateStatus(statusBar: vscode.StatusBarItem): Promise<void> {
  const config = vscode.workspace.getConfiguration('purecontext');
  const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';

  try {
    const repos = await listRepos(serverUrl);
    statusBar.text = `$(circle-filled) PureContext`;
    statusBar.tooltip = `PureContext — online · ${repos.repos.length} repo${repos.repos.length === 1 ? '' : 's'} indexed`;
    statusBar.backgroundColor = undefined;
  } catch (err) {
    statusBar.text = '$(warning) PureContext: offline';
    statusBar.tooltip =
      err instanceof PureContextClientError
        ? `PureContext — server not reachable at ${serverUrl}`
        : `PureContext — ${String(err)}`;
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}
