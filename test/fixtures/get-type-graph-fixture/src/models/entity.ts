/**
 * Abstract base entity class.
 */

import type { Identifiable } from '../types/base.js';

export abstract class Entity implements Identifiable {
  id: string = '';

  abstract validate(): boolean;

  toJSON(): Record<string, unknown> {
    return { id: this.id };
  }
}
