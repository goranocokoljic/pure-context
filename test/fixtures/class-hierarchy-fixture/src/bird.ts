import type { Animal } from './animal.js';
import type { Flyable } from './flyable.js';

export class Bird extends Animal implements Flyable {
  speak(): string {
    return 'Tweet';
  }
  fly(): void {}
}
