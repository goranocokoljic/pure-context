import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, setLogLevel, getLogLevel } from '../../src/core/logger.js';

describe('logger', () => {
  let stderrOutput: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrOutput = [];
    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    setLogLevel('debug');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    setLogLevel('info');
  });

  it('writes to stderr, not stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    logger.info('test message');
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('formats output with timestamp, level, and message', () => {
    logger.info('hello world');
    expect(stderrOutput).toHaveLength(1);
    const line = stderrOutput[0];
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(line).toMatch(/INFO /);
    expect(line).toMatch(/hello world/);
  });

  it('includes context as JSON when provided', () => {
    logger.debug('with context', { file: 'foo.ts', count: 3 });
    expect(stderrOutput[0]).toMatch(/"file":"foo\.ts"/);
    expect(stderrOutput[0]).toMatch(/"count":3/);
  });

  it('respects log level — suppresses below current level', () => {
    setLogLevel('warn');
    logger.debug('suppressed');
    logger.info('also suppressed');
    logger.warn('visible');
    logger.error('also visible');
    expect(stderrOutput).toHaveLength(2);
    expect(stderrOutput[0]).toMatch(/WARN/);
    expect(stderrOutput[1]).toMatch(/ERROR/);
  });

  it('passes all messages when level is debug', () => {
    setLogLevel('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(stderrOutput).toHaveLength(4);
  });

  it('getLogLevel returns current level', () => {
    setLogLevel('error');
    expect(getLogLevel()).toBe('error');
  });

  it('pads level label to consistent width', () => {
    setLogLevel('debug');
    logger.info('msg');
    logger.warn('msg');
    // Both "INFO " and "WARN " should be 5 chars + space
    expect(stderrOutput[0]).toMatch(/INFO {1}/);
    expect(stderrOutput[1]).toMatch(/WARN {1}/);
  });
});
