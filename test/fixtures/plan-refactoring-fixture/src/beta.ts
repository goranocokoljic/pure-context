import { alphaHelper } from './alpha.js';

/** Beta base function — no circular call, only the import creates the cycle. */
export function betaHelper(): string {
  return 'beta';
}

/** Uses alphaHelper — keeps the alpha → beta → alpha import cycle alive. */
export function betaRound(): string {
  return `round:${alphaHelper()}`;
}
