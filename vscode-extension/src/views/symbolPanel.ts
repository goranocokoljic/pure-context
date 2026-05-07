/**
 * WebviewPanel — detailed symbol view.
 *
 * Opened via the "PureContext: Show Symbol Details" command or by clicking a
 * symbol in the outline when you want the full source + blast radius.
 */

import * as vscode from 'vscode';
import {
  getSymbolSource,
  getBlastRadius,
  PureContextClientError,
  type SymbolSource,
  type BlastRadiusResult,
} from '../client';

// ─── Panel manager ────────────────────────────────────────────────────────────

// Reuse a single panel per window
let currentPanel: vscode.WebviewPanel | undefined;

export async function showSymbolPanel(
  context: vscode.ExtensionContext,
  serverUrl: string,
  repoId: string,
  symbolId: string,
): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      'purecontextSymbol',
      'PureContext Symbol',
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    currentPanel.onDidDispose(() => {
      currentPanel = undefined;
    });
  }

  currentPanel.webview.html = renderLoading();

  try {
    const [sourceResult, blastResult] = await Promise.allSettled([
      getSymbolSource(serverUrl, repoId, symbolId),
      getBlastRadius(serverUrl, repoId, symbolId),
    ]);

    const symbol =
      sourceResult.status === 'fulfilled' ? sourceResult.value.symbol : null;
    const blast =
      blastResult.status === 'fulfilled' ? blastResult.value : null;

    if (!symbol) {
      currentPanel.webview.html = renderError('Symbol not found.');
      return;
    }

    currentPanel.title = symbol.name;
    currentPanel.webview.html = renderSymbolHtml(symbol, blast, serverUrl, repoId);
  } catch (err) {
    if (err instanceof PureContextClientError) {
      currentPanel.webview.html = renderError(`Error ${err.status}: ${err.message}`);
    } else {
      currentPanel.webview.html = renderError(String(err));
    }
  }
}

// ─── HTML templates ───────────────────────────────────────────────────────────

function renderLoading(): string {
  return wrapHtml('<p style="color:var(--vscode-foreground)">Loading…</p>');
}

function renderError(message: string): string {
  return wrapHtml(`<p style="color:var(--vscode-errorForeground)">⚠ ${esc(message)}</p>`);
}

function renderSymbolHtml(
  symbol: SymbolSource,
  blast: BlastRadiusResult | null,
  serverUrl: string,
  repoId: string,
): string {
  const blastSection = blast
    ? `
    <section>
      <h2>Blast Radius</h2>
      <p><strong>${blast.totalAffected}</strong> file${blast.totalAffected === 1 ? '' : 's'} affected</p>
      ${
        blast.transitivePaths.length > 0
          ? `<ul>${blast.transitivePaths
              .slice(0, 20)
              .map((p) => `<li><code>${esc(p.file)}</code> <span class="depth">depth ${p.depth}</span></li>`)
              .join('')}${blast.transitivePaths.length > 20 ? `<li>… and ${blast.transitivePaths.length - 20} more</li>` : ''}</ul>`
          : '<p>No transitive dependents found.</p>'
      }
      <p><a href="${esc(serverUrl)}/repos/${esc(repoId)}/blast-radius?symbolId=${esc(symbol.id)}">Open in Web UI →</a></p>
    </section>`
    : '';

  const body = `
    <header>
      <span class="kind">${esc(symbol.kind)}</span>
      <h1>${esc(symbol.name)}</h1>
      <p class="file">${esc(symbol.filePath)}</p>
    </header>

    <section>
      <h2>Signature</h2>
      <pre><code>${esc(symbol.signature || symbol.name)}</code></pre>
    </section>

    ${symbol.summary ? `<section><h2>Summary</h2><p>${esc(symbol.summary)}</p></section>` : ''}

    <section>
      <h2>Source</h2>
      <pre><code>${esc(symbol.source)}</code></pre>
    </section>

    ${blastSection}
  `;

  return wrapHtml(body);
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PureContext Symbol</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px;
      line-height: 1.5;
    }
    h1 { font-size: 1.4em; margin: 4px 0; }
    h2 { font-size: 1em; text-transform: uppercase; letter-spacing: .06em;
         color: var(--vscode-descriptionForeground); margin-top: 20px; }
    pre {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 10px 14px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-all;
    }
    code { font-family: var(--vscode-editor-font-family); }
    .kind {
      font-size: 0.75em;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .file { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    ul { padding-left: 20px; }
    li { margin: 2px 0; }
    .depth { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    a { color: var(--vscode-textLink-foreground); }
    section { margin-top: 16px; }
    header { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
