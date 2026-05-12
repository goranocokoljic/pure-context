import { doWork } from './utils.js';

/** First consumer of doWork — contributes to coupling on utils.ts. */
export function processA(input: string): string {
  return doWork(input);
}
