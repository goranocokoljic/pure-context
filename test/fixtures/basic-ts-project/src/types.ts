/** Severity levels for diagnostics. */
export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  message: string;
  severity: Severity;
  file: string;
  line: number;
}

export enum Status {
  Pending = 'pending',
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
}
