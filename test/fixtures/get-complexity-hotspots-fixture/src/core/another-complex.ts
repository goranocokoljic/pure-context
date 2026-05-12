/**
 * another-complex.ts — second high-complexity file in src/core/.
 * This makes src/core/ the directory with the highest aggregate complexity.
 */

// Complex state machine (CC ≈ 14)
export function processEvent(
  state: string,
  event: string,
  payload: Record<string, unknown>,
): string {
  switch (state) {
    case 'idle':
      if (event === 'start') {
        if (!payload['id']) throw new Error('id required');
        if (payload['mode'] === 'fast') return 'running_fast';
        if (payload['mode'] === 'slow') return 'running_slow';
        return 'running';
      }
      if (event === 'abort') return 'idle';
      throw new Error(`invalid event in idle: ${event}`);

    case 'running':
    case 'running_fast':
    case 'running_slow':
      if (event === 'pause') return 'paused';
      if (event === 'complete') {
        if (payload['error']) return 'error';
        return 'done';
      }
      if (event === 'abort') return 'idle';
      throw new Error(`invalid event in running: ${event}`);

    case 'paused':
      if (event === 'resume') return state.replace('paused', 'running');
      if (event === 'abort') return 'idle';
      throw new Error(`invalid event in paused: ${event}`);

    case 'done':
    case 'error':
      if (event === 'reset') return 'idle';
      throw new Error(`invalid event in terminal state: ${event}`);

    default:
      throw new Error(`unknown state: ${state}`);
  }
}

// Deeply nested async handler (CC ≈ 8, nesting ≈ 4)
export async function fetchWithRetry(
  url: string,
  maxRetries: number,
  timeoutMs: number,
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
          return await res.text();
        }
        if (res.status >= 500) {
          lastError = new Error(`server error: ${res.status}`);
          continue;
        }
        throw new Error(`client error: ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        lastError = new Error(`timeout after ${timeoutMs}ms`);
      } else {
        lastError = err as Error;
      }
    }
  }
  throw lastError ?? new Error('unknown fetch error');
}
