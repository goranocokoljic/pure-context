/**
 * TreeDataProvider — PureContext file outline in the Explorer sidebar.
 *
 * Shows symbols of the currently active file, grouped by kind.
 * Click a symbol to jump to its line in the editor.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getFileOutline, type SymbolSummary, type SymbolKind, PureContextClientError } from '../client';
import type { RepoResolver } from '../repo-resolver';

// ─── Icons ────────────────────────────────────────────────────────────────────

const KIND_ICONS: Record<SymbolKind, vscode.ThemeIcon> = {
  function:    new vscode.ThemeIcon('symbol-function'),
  class:       new vscode.ThemeIcon('symbol-class'),
  method:      new vscode.ThemeIcon('symbol-method'),
  const:       new vscode.ThemeIcon('symbol-constant'),
  type:        new vscode.ThemeIcon('symbol-type-parameter'),
  interface:   new vscode.ThemeIcon('symbol-interface'),
  enum:        new vscode.ThemeIcon('symbol-enum'),
  component:   new vscode.ThemeIcon('symbol-module'),
  composable:  new vscode.ThemeIcon('symbol-module'),
  hook:        new vscode.ThemeIcon('symbol-event'),
  route:       new vscode.ThemeIcon('symbol-field'),
  decorator:   new vscode.ThemeIcon('symbol-property'),
  middleware:  new vscode.ThemeIcon('symbol-method'),
};

// ─── Tree items ───────────────────────────────────────────────────────────────

export class SymbolTreeItem extends vscode.TreeItem {
  constructor(
    public readonly symbol: SymbolSummary,
    public readonly filePath: string,
    public readonly repoRootPath: string,
  ) {
    super(symbol.name, vscode.TreeItemCollapsibleState.None);

    this.description = symbol.kind;
    this.tooltip = symbol.signature || symbol.summary || symbol.name;
    this.iconPath = KIND_ICONS[symbol.kind] ?? new vscode.ThemeIcon('symbol-misc');

    // Jump to file + approximate line on click
    const absPath = path.join(repoRootPath, filePath);
    this.command = {
      command: 'purecontext.jumpToSymbol',
      title: 'Go to Symbol',
      arguments: [absPath, symbol],
    };

    this.contextValue = 'purecontextSymbol';
  }
}

class GroupTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: SymbolTreeItem[],
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${children.length}`;
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
    this.contextValue = 'purecontextGroup';
  }
}

type OutlineNode = GroupTreeItem | SymbolTreeItem;

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<OutlineNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _items: OutlineNode[] = [];
  private _statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly resolver: RepoResolver,
    private readonly statusBarItem: vscode.StatusBarItem,
  ) {
    this._statusBarItem = statusBarItem;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: OutlineNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OutlineNode): vscode.ProviderResult<OutlineNode[]> {
    if (element instanceof GroupTreeItem) {
      return element.children;
    }
    if (element) return [];
    return this._items;
  }

  /**
   * Load symbols for the given file and notify the tree view.
   * Called when the active editor changes.
   */
  async loadFile(document: vscode.TextDocument): Promise<void> {
    const config = vscode.workspace.getConfiguration('purecontext');
    if (!config.get<boolean>('enableOutline')) {
      this._items = [];
      this.refresh();
      return;
    }

    const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';

    let repoId: string | null;
    let rootPath: string;
    try {
      const resolved = await this.resolver.resolve(serverUrl, document.uri.fsPath);
      if (!resolved) {
        this._items = [];
        this.refresh();
        return;
      }
      repoId = resolved.repoId;
      rootPath = resolved.rootPath;
    } catch {
      this._items = [];
      this.refresh();
      return;
    }

    // Compute file path relative to repo root
    const absPath = document.uri.fsPath;
    const relPath = path.relative(rootPath, absPath).replace(/\\/g, '/');

    try {
      const outline = await getFileOutline(serverUrl, repoId, relPath);
      this._items = buildGroups(outline.symbols, relPath, rootPath);
    } catch (err) {
      if (err instanceof PureContextClientError && err.status === 404) {
        // File not indexed — show empty outline
        this._items = [];
      } else {
        // Server offline or other error — keep previous state
        this._statusBarItem.text = '$(warning) PureContext: offline';
        this._statusBarItem.show();
      }
    }
    this.refresh();
  }

  clear(): void {
    this._items = [];
    this.refresh();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildGroups(symbols: SymbolSummary[], filePath: string, rootPath: string): OutlineNode[] {
  if (symbols.length === 0) return [];

  // Group by kind
  const groups = new Map<SymbolKind, SymbolSummary[]>();
  for (const sym of symbols) {
    const group = groups.get(sym.kind) ?? [];
    group.push(sym);
    groups.set(sym.kind, group);
  }

  // If only one group, flatten (no group header)
  if (groups.size === 1) {
    const [, syms] = [...groups.entries()][0]!;
    return syms.map((s) => new SymbolTreeItem(s, filePath, rootPath));
  }

  // Multiple kinds — group by kind
  const result: OutlineNode[] = [];
  for (const [kind, syms] of groups) {
    const items = syms.map((s) => new SymbolTreeItem(s, filePath, rootPath));
    const label = capitalize(kind) + 's';
    result.push(new GroupTreeItem(label, items));
  }
  return result;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
