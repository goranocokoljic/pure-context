import type { Animal } from './animal.js';

export class Cat extends Animal {
  speak(): string {
    return 'Meow';
  }
}
