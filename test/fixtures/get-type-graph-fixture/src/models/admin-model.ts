/**
 * AdminModel - extends UserModel to add admin capabilities.
 */

import { UserModel } from './user-model.js';
import type { AdminUser } from '../types/user.js';

export class AdminModel extends UserModel implements AdminUser {
  permissions: string[] = [];
  adminLevel: number = 1;
}
