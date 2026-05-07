/**
 * QuickPick symbol search — "PureContext: Search Symbols".
 *
 * Opens a VS Code QuickPick, debounces input, calls the REST API,
 * and jumps to the selected symbol's file + line.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
  searchSymbols,
  PureContextClientError,
  type SearchResult,
  type SymbolKind,
} from '../client';
import type { RepoResolver } from '../repo-resolver';

const DEBOUNCE_MS = 200;

// ─── Kind → VS Code SymbolKind mapping (for QuickPick icon) ──────────────────

const KIND_ICON: Record<SymbolKind, string> = {
  function:   '$(symbol-function)',
  class:      '$(symbol-class)',
  method:     '$(symbol-method)',
  const:      '$(symbol-constant)',
  type:       '$(symbol-type-parameter)',
  interface:  '$(symbol-interface)',
  enum:       '$(symbol-enum)',
  component:  '$(symbol-module)',
  composable: '$(symbol-module)',
  hook:       '$(symbol-event)',
  route:      '$(symbol-field)',
  decorator:  '$(symbol-property)',
  middleware: '$(symbol-method)',
};

// ─── QuickPick item ───────────────────────────────────────────────────────────

interface SymbolQuickPickItem extends vscode.QuickPickItem {
  result: SearchResult;
  rootPath: string;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export async function showSymbolSearch(resolver: RepoResolver): Promise<void> {
  const config = vscode.workspace.getConfiguration('purecontext');
  const serverUrl = config.get<string>('serverUrl') ?? 'http://localhost:3000';

  // Resolve repo from active editor, or prompt
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  let repoId: string;
  let rootPath: string;

  try {
    const resolved = await resolver.resolve(serverUrl, activeFile);
    if (!resolved) {
      vscode.window.showWarningMessage(
        'PureContext: no indexed repo found for this workspace. Make sure the PureContext server is running.',
      );
      return;
    }
    repoId = resolved.repoId;
    rootPath = resolved.rootPath;
  } catch {
    vscode.window.showErrorMessage(
      'PureContext: could not connect to server. Is it running at ' + serverUrl + '?',
    );
    return;
  }

  const qp = vscode.window.createQuickPick<SymbolQuickPickItem>();
  qp.placeholder = 'Search PureContext symbols…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  let currentController: AbortController | null = null;

  qp.onDidChangeValue((query) => {
    if (debounceHandle) clearTimeout(debounceHandle);
    if (!query.trim()) {
      qp.items = [];
      qp.busy = false;
      return;
    }

    debounceHandle = setTimeout(async () => {
      // Cancel any in-flight request
      currentController?.abort();
      currentController = new AbortController();
      const signal = currentController.signal;

      qp.busy = true;
      try {
        const response = await searchSymbols(
          serverUrl,
          repoId,
          query,
          { limit: 30 },
          signal,
        );
        if (signal.aborted) return;
        qp.items = response.results.map((r) => toQuickPickItem(r, rootPath));
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof PureContextClientError && err.status === 0) {
          qp.items = [
            {
              label: '$(warning) PureContext server offline',
              alwaysShow: true,
              result: undefined as unknown as SearchResult,
              rootPath,
            },
          ];
        }
      } finally {
        if (!signal.aborted) qp.busy = false;
      }
    }, DEBOUNCE_MS);
  });

  qp.onDidAccept(async () => {
    const selected = qp.selectedItems[0];
    if (!selected?.result) return;
    qp.hide();
    await jumpToSymbol(selected.rootPath, selected.result);
  });

  qp.onDidHide(() => {
    currentController?.abort();
    if (debounceHandle) clearTimeout(debounceHandle);
    qp.dispose();
  });

  qp.show();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toQuickPickItem(result: SearchResult, rootPath: string): SymbolQuickPickItem {
  const icon = KIND_ICON[result.kind] ?? '$(symbol-misc)';
  return {
    label: `${icon} ${result.name}`,
    description: result.kind,
    detail: result.filePath + (result.summary ? '  —  ' + result.summary : ''),
    result,
    rootPath,
    alwaysShow: false,
  };
}

export async function jumpToSymbol(rootPath: string, symbol: SearchResult): Promise<void> {
  const absPath = path.join(rootPath, symbol.filePath);
  const uri = vscode.Uri.file(absPath);

  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    vscode.window.showErrorMessage(`PureContext: could not open file: ${absPath}`);
    return;
  }

  const editor = await vscode.window.showTextDocument(document);

  // Find the symbol by scanning for its name from the top of the file.
  // This is an approximation: byte offsets from the server would require
  // a binary-to-line conversion. Scanning for the name is fast and accurate
  // for most cases.
  const text = document.getText();
  const nameIdx = findSymbolPosition(text, symbol.name, symbol.signature);
  if (nameIdx !== -1) {
    const pos = document.positionAt(nameIdx);
    const range = new vscode.Range(pos, pos.translate(0, symbol.name.length));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

/**
 * Locate the best position for a symbol in raw source text.
 * Tries to match by signature first, then falls back to bare name.
 */
function findSymbolPosition(text: string, name: string, signature: string): number {
  // Try to find the signature (trimmed to first 40 chars to handle multiline)
  if (signature) {
    const sigPrefix = signature.slice(0, 40).trim();
    if (sigPrefix.length > 5) {
      const idx = text.indexOf(sigPrefix);
      if (idx !== -1) return idx;
    }
  }

  // Fall back: find first occurrence of name as a word boundary
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
  const m = re.exec(text);
  return m ? m.index : -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
