/**
 * Generic service interface.
 */

export interface Service<T> {
  getById(id: string): Promise<T | null>;
  list(): Promise<T[]>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T | null>;
  remove(id: string): Promise<boolean>;
}
