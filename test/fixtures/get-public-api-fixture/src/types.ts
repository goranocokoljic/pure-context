export interface ApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

export type UserId = string;

export type Timestamp = number;

export enum Role {
  Admin = 'admin',
  User = 'user',
  Guest = 'guest',
}

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
  Pending = 'pending',
}

interface InternalConfig {
  debug: boolean;
  logLevel: string;
}

type InternalState = 'idle' | 'loading' | 'error';
