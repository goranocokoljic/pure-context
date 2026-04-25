import { useState, useCallback } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { useThemeStore } from '../stores/themeStore.js';

// ─── Language detection ───────────────────────────────────────────────────────

const EXT_TO_PRISM: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx',
  js: 'javascript', jsx: 'jsx',
  py: 'python',  rs: 'rust',   go: 'go',
  java: 'java',  cs: 'csharp', rb: 'ruby',
  css: 'css',    scss: 'scss', html: 'markup', xml: 'markup',
  json: 'json',  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', sh: 'bash', bash: 'bash',
  ex: 'elixir',  exs: 'elixir',
  hs: 'haskell', scala: 'scala', r: 'r',
  cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c',
  kt: 'kotlin', swift: 'swift', php: 'php',
};

export function detectPrismLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_PRISM[ext] ?? 'text';
}

// ─── CodeViewer ───────────────────────────────────────────────────────────────

export interface CodeViewerProps {
  code: string;
  /** Language hint from the server (e.g. 'typescript'). Falls back to filePath extension. */
  language?: string;
  filePath: string;
}

export function CodeViewer({ code, language, filePath }: CodeViewerProps) {
  const theme = useThemeStore((s) => s.theme);
  const [copied, setCopied] = useState(false);

  const prismLang = language ?? detectPrismLanguage(filePath);
  const highlightTheme = theme === 'dark' ? themes.vsDark : themes.vsLight;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [code]);

  return (
    <div className="relative group/viewer" data-testid="code-viewer">
      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy source code"
        className="absolute top-3 right-3 z-10 px-2.5 py-1 text-[11px] rounded bg-gray-700/90 text-gray-300 hover:bg-gray-600 transition-colors opacity-0 group-hover/viewer:opacity-100 focus:opacity-100"
        data-testid="copy-button"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <Highlight
        code={code.trimEnd()}
        language={prismLang}
        theme={highlightTheme}
      >
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} m-0 rounded-none overflow-x-auto text-sm leading-6`}
            style={{ ...style, padding: '1rem 0' }}
            data-testid="code-block"
          >
            {tokens.map((line, i) => (
              <div
                key={i}
                {...getLineProps({ line })}
                className="px-4"
              >
                {/* Line number */}
                <span
                  className="select-none inline-block w-9 text-right mr-5 shrink-0"
                  style={{ color: theme === 'dark' ? '#4b5563' : '#9ca3af' }}
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                {/* Tokens */}
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
