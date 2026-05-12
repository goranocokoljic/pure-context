/**
 * Base type definitions - foundational interfaces for the domain model.
 */

export interface Identifiable {
  id: string;
}

export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}

export interface BaseEntity extends Identifiable, Timestamped {
  version: number;
}
