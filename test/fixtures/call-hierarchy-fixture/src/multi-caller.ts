import { levelB } from './level-b.js';

/** First function that calls levelB */
export function callerOne(): string {
  return levelB();
}

/** Second function that calls levelB */
export function callerTwo(): string {
  return levelB();
}
