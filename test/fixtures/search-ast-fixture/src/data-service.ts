/** Data service with class declarations, interface, and various patterns. */

export interface Repository<T> {
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  save(item: T): Promise<T>;
  delete(id: string): Promise<void>;
}

export type FilterFn<T> = (item: T) => boolean;

export class DataService<T extends { id: string }> implements Repository<T> {
  private items: Map<string, T> = new Map();

  async findById(id: string): Promise<T | null> {
    try {
      return this.items.get(id) ?? null;
    } catch (err) {
      throw new Error(`findById failed: ${(err as Error).message}`);
    }
  }

  async findAll(): Promise<T[]> {
    return Array.from(this.items.values());
  }

  async findWhere(filter: FilterFn<T>): Promise<T[]> {
    const results = await this.findAll();
    return results.filter(filter);
  }

  async save(item: T): Promise<T> {
    this.items.set(item.id, item);
    return item;
  }

  async delete(id: string): Promise<void> {
    try {
      this.items.delete(id);
    } catch (err) {
      throw new Error(`delete failed: ${(err as Error).message}`);
    }
  }

  // Arrow method property
  readonly count = (): number => this.items.size;
}

// Standalone arrow function
export const createFilter = <T>(key: keyof T, value: T[keyof T]): FilterFn<T> =>
  (item) => item[key] === value;

// Async IIFE pattern
const warmup = async () => {
  try {
    await Promise.resolve();
  } catch {
    // ignore
  }
};

warmup();
