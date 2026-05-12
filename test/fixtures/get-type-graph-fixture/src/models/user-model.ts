/**
 * UserModel - concrete implementation of the User interface.
 */

import { Entity } from './entity.js';
import type { User } from '../types/user.js';
import type { Status } from '../utils/types.js';

export class UserModel extends Entity implements User {
  name: string = '';
  email: string = '';
  status: Status = 'active';
  createdAt: Date = new Date();
  updatedAt: Date = new Date();
  version: number = 1;

  validate(): boolean {
    return !!this.name && !!this.email;
  }
}
