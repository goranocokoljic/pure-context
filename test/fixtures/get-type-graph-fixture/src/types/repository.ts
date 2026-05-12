/**
 * Repository interfaces - data access contracts.
 */

import type { BaseEntity } from './base.js';
import type { User } from './user.js';

export interface Repository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>;
  save(entity: T): Promise<T>;
  delete(id: string): Promise<void>;
}

export interface UserRepository extends Repository<User> {
  findByEmail(email: string): Promise<User | null>;
  findActive(): Promise<User[]>;
}
