import { doWork } from './utils.js';

/** Second consumer of doWork — contributes to coupling on utils.ts. */
export function processB(input: string): string {
  return doWork(input);
}
