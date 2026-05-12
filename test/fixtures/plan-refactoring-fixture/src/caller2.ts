import { doWork } from './utils.js';

/** Second consumer of doWork. */
export function processInput2(input: string): string {
  return doWork(input);
}
