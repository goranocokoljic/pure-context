import { betaHelper } from './beta.js';

/** Alpha — mutually imports beta, creating a circular dependency. */
export function alphaHelper(): string {
  return `alpha:${betaHelper()}`;
}
