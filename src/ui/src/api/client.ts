import type {
  ListReposResponse,
  GetFileTreeResponse,
  GetRepoOutlineResponse,
  SearchSymbolsParams,
  SearchSymbolsResponse,
  GetSymbolSourceResponse,
  GetFileOutlineResponse,
  FindImportersResponse,
  GetGraphResponse,
  GetBlastRadiusResponse,
} from './types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = '/api';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

// ─── Error class ──────────────────────────────────────────────────────────────

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  attempt = 0,
): Promise<T> {
  const url = new URL(BASE_URL + path, window.location.origin);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    // Retry on network errors (not on abort)
    if (attempt < MAX_RETRIES && !(err instanceof DOMException && err.name === 'AbortError')) {
      return apiFetch<T>(path, params, attempt + 1);
    }
    throw new ApiClientError(0, `Network error: ${err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore parse error
    }
    // Retry on 5xx (server errors), not on 4xx (client errors)
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      return apiFetch<T>(path, params, attempt + 1);
    }
    throw new ApiClientError(res.status, message);
  }

  return res.json() as Promise<T>;
}

// ─── API methods ──────────────────────────────────────────────────────────────

export const api = {
  /** List all indexed repositories. */
  listRepos(): Promise<ListReposResponse> {
    return apiFetch<ListReposResponse>('/repos');
  },

  /** Get the file tree for a repository. */
  getFileTree(repoId: string): Promise<GetFileTreeResponse> {
    return apiFetch<GetFileTreeResponse>(`/repos/${encodeURIComponent(repoId)}/tree`);
  },

  /** Get the structural outline for a repository. */
  getRepoOutline(repoId: string, limit?: number): Promise<GetRepoOutlineResponse> {
    return apiFetch<GetRepoOutlineResponse>(
      `/repos/${encodeURIComponent(repoId)}/outline`,
      limit !== undefined ? { limit } : undefined,
    );
  },

  /** Search for symbols within a repository. */
  searchSymbols(repoId: string, params: SearchSymbolsParams): Promise<SearchSymbolsResponse> {
    return apiFetch<SearchSymbolsResponse>(
      `/repos/${encodeURIComponent(repoId)}/search`,
      params as unknown as Record<string, string | number | boolean | undefined>,
    );
  },

  /** Get the source code of a symbol. */
  getSymbolSource(symbolId: string, repoId: string): Promise<GetSymbolSourceResponse> {
    return apiFetch<GetSymbolSourceResponse>(
      `/symbols/${encodeURIComponent(symbolId)}`,
      { repoId },
    );
  },

  /** Get all symbols defined in a specific file. */
  getFileOutline(repoId: string, filePath: string): Promise<GetFileOutlineResponse> {
    return apiFetch<GetFileOutlineResponse>(
      `/repos/${encodeURIComponent(repoId)}/file-outline`,
      { filePath },
    );
  },

  /** Find files that import the given file. */
  findImporters(repoId: string, filePath: string): Promise<FindImportersResponse> {
    return apiFetch<FindImportersResponse>(
      `/repos/${encodeURIComponent(repoId)}/importers`,
      { filePath },
    );
  },

  /** Get the dependency graph for a repository. */
  getGraph(
    repoId: string,
    params?: { filePath?: string; depth?: number; limit?: number },
  ): Promise<GetGraphResponse> {
    return apiFetch<GetGraphResponse>(
      `/repos/${encodeURIComponent(repoId)}/graph`,
      params as Record<string, string | number | boolean | undefined> | undefined,
    );
  },

  /** Get blast radius (reverse dependency walk) for a symbol. */
  getBlastRadius(
    repoId: string,
    symbolId: string,
    depth?: number,
  ): Promise<GetBlastRadiusResponse> {
    return apiFetch<GetBlastRadiusResponse>(
      `/repos/${encodeURIComponent(repoId)}/blast-radius`,
      { symbolId, ...(depth !== undefined ? { depth } : {}) },
    );
  },
};
