import { betaHelper } from './beta.js';

/** Alpha — mutually imports beta, creating an alpha ↔ beta cycle. */
export function alphaHelper(): string {
  return `alpha:${betaHelper()}`;
}
