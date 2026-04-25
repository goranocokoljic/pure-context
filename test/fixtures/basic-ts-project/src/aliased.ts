// This file uses path aliases configured in tsconfig.json
import { clamp } from '@/lib/helpers';
import type { Diagnostic } from '@/src/types';

export function clampDiagnosticLine(d: Diagnostic): number {
  return clamp(d.line, 1, 9999);
}
