/**
 * User domain interfaces.
 */

import type { BaseEntity } from './base.js';
import type { Status } from '../utils/types.js';

export interface User extends BaseEntity {
  name: string;
  email: string;
  status: Status;
}

export interface AdminUser extends User {
  permissions: string[];
  adminLevel: number;
}
