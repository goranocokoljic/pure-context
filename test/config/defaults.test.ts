/**
 * Task 123: Verify default config values after the Phase 17 changes.
 */

import { describe, it, expect } from 'vitest';
import { cpus } from 'os';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config/config-schema.js';

describe('DEFAULT_CONFIG values', () => {
  it('fileLimit default is 10000', () => {
    expect(DEFAULT_CONFIG.fileLimit).toBe(10000);
  });

  it('maxFileSizeBytes default is 512 KB', () => {
    expect(DEFAULT_CONFIG.maxFileSizeBytes).toBe(524_288);
  });

  it('concurrency default is min(cpuCount, 8)', () => {
    const expected = Math.min(cpus().length, 8);
    expect(DEFAULT_CONFIG.concurrency).toBe(expected);
  });

  it('empty config object ({}) validates successfully — all fields have defaults', () => {
    const { valid, errors } = validateConfig({});
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('fileLimit=0 is valid (means unlimited)', () => {
    expect(validateConfig({ fileLimit: 0 }).valid).toBe(true);
  });

  it('fileLimit=-1 is invalid', () => {
    expect(validateConfig({ fileLimit: -1 }).valid).toBe(false);
  });

  it('concurrency must be a positive integer', () => {
    expect(validateConfig({ concurrency: 4 }).valid).toBe(true);
    expect(validateConfig({ concurrency: 0 }).valid).toBe(false);
    expect(validateConfig({ concurrency: -1 }).valid).toBe(false);
    expect(validateConfig({ concurrency: 1.5 }).valid).toBe(false);
  });
});
