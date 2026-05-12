/**
 * UserService - implements Service<User>.
 */

import type { User } from '../types/user.js';
import type { Service } from './service.js';

export class UserService implements Service<User> {
  async getById(id: string): Promise<User | null> {
    void id;
    return null;
  }

  async list(): Promise<User[]> {
    return [];
  }

  async create(data: Partial<User>): Promise<User> {
    void data;
    throw new Error('Not implemented');
  }

  async update(id: string, data: Partial<User>): Promise<User | null> {
    void id;
    void data;
    return null;
  }

  async remove(id: string): Promise<boolean> {
    void id;
    return false;
  }
}
