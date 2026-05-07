export class PureContextError extends Error {
  /** Human-readable message for the end user — no internal paths or stack traces. */
  userMessage?: string;
  /** Specific, actionable command or config change the user should try. */
  suggestion?: string;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack ?? ''}\nCaused by: ${cause.stack}`;
    }
  }
}

// ─── User-facing error classes ────────────────────────────────────────────────

export class NativeDependencyError extends PureContextError {
  override userMessage = 'PureContext could not load its SQLite driver.';
  override suggestion =
    'This is usually a Node.js version mismatch. Try: npm rebuild better-sqlite3\n' +
    'Still broken? https://github.com/gococ/purecontext-mcp/issues';

  constructor(cause?: unknown) {
    super('Failed to load better-sqlite3 native addon', cause);
  }
}

export class GrammarNotFoundError extends PureContextError {
  override userMessage: string;
  override suggestion = 'Try reinstalling: npm install -g purecontext-mcp@latest';

  constructor(public readonly language: string, cause?: unknown) {
    super(`Grammar file not found for language: ${language}`, cause);
    this.userMessage = `Grammar file not found for language: ${language}`;
  }
}

export class ProjectTooLargeError extends PureContextError {
  override userMessage: string;
  override suggestion: string;

  constructor(public readonly fileCount: number, public readonly limit: number) {
    super(`Project has ${fileCount} files, which exceeds fileLimit (${limit})`);
    this.userMessage = `Project has ${fileCount} files, which exceeds fileLimit (${limit}).`;
    this.suggestion = `Raise fileLimit in ~/.purecontext/config.json:\n  { "fileLimit": ${fileCount + 1000} }`;
  }
}

export class ConfigValidationError extends PureContextError {
  override userMessage: string;
  override suggestion = "Run 'purecontext-mcp config --check' to validate your config file.";

  constructor(formattedErrors: string, configPath?: string) {
    const location = configPath ? ` in ${configPath}` : '';
    const msg = `Config error${location}:\n${formattedErrors}`;
    super(msg);
    this.userMessage = msg;
  }
}

// ─── Error box formatter ──────────────────────────────────────────────────────

/**
 * Format a PureContextError as a bordered box for stderr display.
 *
 * Example output:
 *   ┌─ PureContext Error ───────────────────────────────────────────────────────┐
 *   │ Could not load SQLite driver.                                             │
 *   │                                                                           │
 *   │ Try: npm rebuild better-sqlite3                                           │
 *   └───────────────────────────────────────────────────────────────────────────┘
 */
export function formatErrorBox(userMessage: string, suggestion: string): string {
  const INNER = 73; // characters between │ and │ margins (including the 1-space padding on each side)
  const pad = (s: string) => `│ ${s.padEnd(INNER)} │`;
  const blank = pad('');

  const msgLines = userMessage.split('\n').map(pad);
  const sugLines = suggestion ? suggestion.split('\n').map(pad) : [];

  const top = '┌─ PureContext Error ' + '─'.repeat(INNER - 17) + '┐';
  const bottom = '└' + '─'.repeat(INNER + 2) + '┘';

  const parts: string[] = [top, ...msgLines];
  if (sugLines.length > 0) {
    parts.push(blank, ...sugLines);
  }
  parts.push(bottom);
  return parts.join('\n');
}

export class IndexError extends PureContextError {
  constructor(
    message: string,
    public readonly filePath?: string,
    cause?: unknown,
  ) {
    super(filePath ? `${message}: ${filePath}` : message, cause);
  }
}

export class ParseError extends PureContextError {
  constructor(
    message: string,
    public readonly filePath: string,
    cause?: unknown,
  ) {
    super(`${message}: ${filePath}`, cause);
  }
}

export class ConfigError extends PureContextError {}

export class StorageError extends PureContextError {
  constructor(
    message: string,
    public readonly operation?: string,
    cause?: unknown,
  ) {
    super(operation ? `[${operation}] ${message}` : message, cause);
  }
}

export class QuotaExceededError extends PureContextError {
  constructor(
    public readonly tenantId: string,
    public readonly quotaBytes: number,
    public readonly usedBytes: number,
    public readonly requestedBytes: number,
  ) {
    super(
      `Storage quota exceeded for tenant "${tenantId}": ` +
        `${usedBytes + requestedBytes} bytes needed, ${quotaBytes} bytes allowed`,
    );
  }
}

export class FileNotCachedError extends PureContextError {
  override userMessage: string;
  override suggestion = 'Run index_folder on the repository first so the file is indexed.';

  constructor(public readonly filePath: string, detail?: string) {
    const msg = detail ?? `File not in cache: "${filePath}"`;
    super(msg);
    this.userMessage = msg;
  }
}

export class TooManySymbolsError extends PureContextError {
  override userMessage: string;
  override suggestion: string;

  constructor(public readonly requested: number, public readonly limit: number) {
    super(`Requested ${requested} symbols, exceeds per-call limit of ${limit}`);
    this.userMessage = `Requested ${requested} symbol IDs, but the per-call limit is ${limit}. Split into smaller batches.`;
    this.suggestion = `Call get_symbols with at most ${limit} IDs per request.`;
  }
}

export class GitHubApiError extends PureContextError {
  override userMessage: string;
  override suggestion: string;

  constructor(
    public readonly statusCode: number,
    message: string,
    cause?: unknown,
  ) {
    super(`GitHub API error ${statusCode}: ${message}`, cause);
    this.userMessage = `GitHub API error (HTTP ${statusCode}): ${message}`;
    this.suggestion =
      statusCode === 401 || statusCode === 404
        ? 'For private repositories, provide a GitHub token via the githubToken parameter or GITHUB_TOKEN env var.'
        : statusCode === 403 || statusCode === 429
          ? 'Rate limit exceeded. Wait a moment and retry, or provide a GITHUB_TOKEN for higher limits (5000 req/hr).'
          : 'Check the repository URL and try again.';
  }

  get isRateLimit(): boolean { return this.statusCode === 403 || this.statusCode === 429; }
  get isUnauthorized(): boolean { return this.statusCode === 401; }
  get isNotFound(): boolean { return this.statusCode === 404; }
}

export class WorkspaceLimitError extends PureContextError {
  override userMessage: string;
  override suggestion: string;

  constructor(
    public readonly limitType: 'repos' | 'files',
    public readonly limit: number,
    public readonly current: number,
  ) {
    const msg =
      limitType === 'repos'
        ? `Free plan is limited to ${limit} repos (you have ${current}). Upgrade to Team at purecontext.dev/pricing.`
        : `Free plan repos are limited to ${limit} files (project has more). Upgrade to Team at purecontext.dev/pricing.`;
    super(msg);
    this.userMessage = msg;
    this.suggestion =
      'Upgrade to Team plan at purecontext.dev/pricing for unlimited repos and files.';
  }
}
