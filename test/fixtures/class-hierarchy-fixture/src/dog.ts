import type { Animal } from './animal.js';

export class Dog extends Animal {
  speak(): string {
    return 'Woof';
  }
}
