import { alphaHelper } from './alpha.js';

/** Beta — mutually imports alpha, completing the circular dependency. */
export function betaHelper(): string {
  return `beta:${alphaHelper()}`;
}
