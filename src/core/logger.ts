export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function formatMessage(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const upper = level.toUpperCase().padEnd(5);
  const base = `[${ts}] ${upper} ${message}`;
  return context ? `${base} ${JSON.stringify(context)}` : base;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  // Always write to stderr — stdout is reserved for MCP stdio transport
  process.stderr.write(formatMessage(level, message, context) + '\n');
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    write('debug', message, context);
  },
  info(message: string, context?: Record<string, unknown>): void {
    write('info', message, context);
  },
  warn(message: string, context?: Record<string, unknown>): void {
    write('warn', message, context);
  },
  error(message: string, context?: Record<string, unknown>): void {
    write('error', message, context);
  },
};
