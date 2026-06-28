import { describe, it, expect } from 'vitest';
import { validateConfig, DEFAULT_CONFIG } from '../../src/config/config-schema.js';

describe('validateConfig', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(validateConfig({}).valid).toBe(true);
  });

  it('accepts a full valid config', () => {
    const { valid } = validateConfig({
      indexDir: '/tmp/indexes',
      fileLimit: 500,
      watchDebounceMs: 3000,
      excludePatterns: ['**/*.generated.ts'],
      adapters: 'auto',
      ai: { provider: 'none', allowRemoteAI: false },
    });
    expect(valid).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateConfig(null).valid).toBe(false);
    expect(validateConfig('string').valid).toBe(false);
    expect(validateConfig([]).valid).toBe(false);
  });

  it('rejects non-string indexDir', () => {
    const { valid, errors } = validateConfig({ indexDir: 123 });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('indexDir');
  });

  it('rejects non-integer or negative fileLimit', () => {
    expect(validateConfig({ fileLimit: 'lots' }).valid).toBe(false);
    expect(validateConfig({ fileLimit: 1.5 }).valid).toBe(false);
    expect(validateConfig({ fileLimit: -1 }).valid).toBe(false);
    // 0 means unlimited — valid
    expect(validateConfig({ fileLimit: 0 }).valid).toBe(true);
  });

  it('rejects negative watchDebounceMs', () => {
    expect(validateConfig({ watchDebounceMs: -1 }).valid).toBe(false);
  });

  it('accepts watchDebounceMs of 0', () => {
    expect(validateConfig({ watchDebounceMs: 0 }).valid).toBe(true);
  });

  it('rejects invalid excludePatterns', () => {
    expect(validateConfig({ excludePatterns: 'not-array' }).valid).toBe(false);
    expect(validateConfig({ excludePatterns: [1, 2] }).valid).toBe(false);
  });

  it('rejects invalid adapters value', () => {
    expect(validateConfig({ adapters: 'unknown' }).valid).toBe(false);
    expect(validateConfig({ adapters: 42 }).valid).toBe(false);
  });

  it('accepts adapters as array of strings', () => {
    expect(validateConfig({ adapters: ['vue', 'nuxt'] }).valid).toBe(true);
  });

  it('rejects invalid ai.provider', () => {
    expect(validateConfig({ ai: { provider: 'invalid-provider' } }).valid).toBe(false);
  });

  it('rejects non-boolean ai.allowRemoteAI', () => {
    expect(validateConfig({ ai: { allowRemoteAI: 'yes' } }).valid).toBe(false);
  });

  it('rejects ai as non-object', () => {
    expect(validateConfig({ ai: 'none' }).valid).toBe(false);
  });

  it('DEFAULT_CONFIG passes validation', () => {
    const { valid } = validateConfig(DEFAULT_CONFIG);
    expect(valid).toBe(true);
  });

  it('accepts valid changeSynthesis config', () => {
    const { valid } = validateConfig({
      changeSynthesis: {
        coChangeConfidenceThreshold: 0.5,
        maxSymbolsScored: 10,
        maxCoChangeGaps: 5,
        maxRecommendedTests: 8,
      },
    });
    expect(valid).toBe(true);
  });

  it('rejects invalid changeSynthesis values', () => {
    expect(validateConfig({ changeSynthesis: 'no' }).valid).toBe(false);
    expect(validateConfig({ changeSynthesis: { coChangeConfidenceThreshold: 1.5 } }).valid).toBe(false);
    expect(validateConfig({ changeSynthesis: { coChangeConfidenceThreshold: -0.1 } }).valid).toBe(false);
    expect(validateConfig({ changeSynthesis: { maxSymbolsScored: -1 } }).valid).toBe(false);
    expect(validateConfig({ changeSynthesis: { maxCoChangeGaps: 1.5 } }).valid).toBe(false);
  });

  it('accepts valid taskContext config', () => {
    const { valid } = validateConfig({
      taskContext: {
        seedCount: 4,
        expansionDepth: 2,
        maxPool: 40,
        maxCoChangePartners: 3,
        maxSymbolsPerPartner: 0,
      },
    });
    expect(valid).toBe(true);
  });

  it('rejects invalid taskContext values', () => {
    expect(validateConfig({ taskContext: 'no' }).valid).toBe(false);
    // seedCount/expansionDepth/maxPool must be positive integers.
    expect(validateConfig({ taskContext: { seedCount: 0 } }).valid).toBe(false);
    expect(validateConfig({ taskContext: { expansionDepth: 0 } }).valid).toBe(false);
    expect(validateConfig({ taskContext: { maxPool: 1.5 } }).valid).toBe(false);
    // partner caps must be non-negative integers.
    expect(validateConfig({ taskContext: { maxCoChangePartners: -1 } }).valid).toBe(false);
    expect(validateConfig({ taskContext: { maxSymbolsPerPartner: 2.5 } }).valid).toBe(false);
  });
});
