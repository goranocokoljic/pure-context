/**
 * HTTP client for the PureContext REST API.
 *
 * All methods accept a `serverUrl` and return typed responses.
 * They throw `PureContextClientError` on HTTP / network failures.
 * The server URL is passed on every call so callers can re-read it from VS Code
 * config without rebuilding the client.
 */

// ─── Types (mirror of src/ui/src/api/types.ts) ───────────────────────────────

export interface Meta {
  timingMs: number;
  version?: string;
}

export interface RepoMeta {
  repoId: string;
  rootPath: string;
  symbolCount: number;
  fileCount: number;
  lastIndexed: string;
}

export interface ListReposResponse {
  repos: RepoMeta[];
  _meta: Meta;
}

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'const' | 'type'
  | 'interface' | 'enum' | 'component' | 'composable'
  | 'hook' | 'route' | 'decorator' | 'middleware';

export interface SymbolSummary {
  id: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  summary: string;
  startByte: number;
  endByte: number;
}

export interface FileSummary {
  filePath: string;
  symbols: SymbolSummary[];
}

export interface GetFileOutlineResponse {
  repoId: string;
  filePath: string;
  symbols: SymbolSummary[];
  _meta: Meta;
}

export interface SearchResult extends SymbolSummary {
  filePath: string;
  repoId: string;
  repoName?: string;
}

export interface SearchSymbolsResponse {
  results: SearchResult[];
  _meta: Meta;
}

export interface SymbolSource {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  signature: string;
  summary: string;
  source: string;
  startLine: number;
  endLine: number;
}

export interface GetSymbolSourceResponse {
  symbol: SymbolSource;
  _meta: Meta;
}

export interface BlastRadiusResult {
  symbolId: string;
  name: string;
  directImporters: string[];
  transitivePaths: Array<{ file: string; depth: number }>;
  totalAffected: number;
  _meta: Meta;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class PureContextClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PureContextClientError';
  }
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 8_000;

async function apiFetch<T>(
  serverUrl: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const base = serverUrl.replace(/\/$/, '');
  const url = new URL(base + path);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  // Merge caller's signal with our timeout signal
  const combinedSignal = signal
    ? (() => {
        signal.addEventListener('abort', () => controller.abort());
        return controller.signal;
      })()
    : controller.signal;

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: combinedSignal });
  } catch (err) {
    clearTimeout(timer);
    throw new PureContextClientError(0, `Network error: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new PureContextClientError(res.status, message);
  }

  return res.json() as Promise<T>;
}

// ─── API methods ──────────────────────────────────────────────────────────────

export async function listRepos(serverUrl: string): Promise<ListReposResponse> {
  return apiFetch<ListReposResponse>(serverUrl, '/api/repos');
}

export async function getFileOutline(
  serverUrl: string,
  repoId: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<GetFileOutlineResponse> {
  return apiFetch<GetFileOutlineResponse>(
    serverUrl,
    `/api/repos/${repoId}/file-outline`,
    { filePath },
    signal,
  );
}

export async function searchSymbols(
  serverUrl: string,
  repoId: string,
  query: string,
  options?: { limit?: number; kind?: SymbolKind },
  signal?: AbortSignal,
): Promise<SearchSymbolsResponse> {
  return apiFetch<SearchSymbolsResponse>(
    serverUrl,
    `/api/repos/${repoId}/search`,
    { query, limit: options?.limit ?? 20, kind: options?.kind },
    signal,
  );
}

export async function getSymbolSource(
  serverUrl: string,
  repoId: string,
  symbolId: string,
  signal?: AbortSignal,
): Promise<GetSymbolSourceResponse> {
  return apiFetch<GetSymbolSourceResponse>(
    serverUrl,
    `/api/symbols/${symbolId}`,
    { repoId },
    signal,
  );
}

export async function getBlastRadius(
  serverUrl: string,
  repoId: string,
  symbolId: string,
  signal?: AbortSignal,
): Promise<BlastRadiusResult> {
  return apiFetch<BlastRadiusResult>(
    serverUrl,
    `/api/repos/${repoId}/blast-radius`,
    { symbolId },
    signal,
  );
}
