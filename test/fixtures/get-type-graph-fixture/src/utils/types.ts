/**
 * Utility types and enums.
 */

export type UserId = string;

export type Status = 'active' | 'inactive' | 'banned';

export type AdminPermission = 'read' | 'write' | 'admin' | 'superadmin';

export enum UserRole {
  Guest = 'guest',
  User = 'user',
  Admin = 'admin',
}

export enum EventType {
  Created = 'created',
  Updated = 'updated',
  Deleted = 'deleted',
}
