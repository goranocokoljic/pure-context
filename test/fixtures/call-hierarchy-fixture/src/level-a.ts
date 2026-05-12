import { levelB } from './level-b.js';

/** Top-level function — calls levelB which calls levelC */
export function levelA(): string {
  return levelB();
}
