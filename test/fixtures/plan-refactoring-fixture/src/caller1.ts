import { doWork } from './utils.js';

/** First consumer of doWork. */
export function processInput1(input: string): string {
  return doWork(input);
}
