import { formatDiagnostic, filterBySeverity } from './utils.js';
import { Status } from './types.js';
import type { Diagnostic } from './types.js';

export class DiagnosticRunner {
  private status: Status = Status.Pending;
  private diagnostics: Diagnostic[] = [];

  run(input: Diagnostic[]): void {
    this.status = Status.Running;
    this.diagnostics = filterBySeverity(input, 'warning');
    this.status = Status.Done;
  }

  getReport(): string {
    return this.diagnostics.map(formatDiagnostic).join('\n');
  }

  getStatus(): Status {
    return this.status;
  }
}

export function createRunner(): DiagnosticRunner {
  return new DiagnosticRunner();
}
