export class PureContextError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack ?? ''}\nCaused by: ${cause.stack}`;
    }
  }
}

export class IndexError extends PureContextError {
  constructor(
    message: string,
    public readonly filePath?: string,
    cause?: unknown,
  ) {
    super(filePath ? `${message}: ${filePath}` : message, cause);
  }
}

export class ParseError extends PureContextError {
  constructor(
    message: string,
    public readonly filePath: string,
    cause?: unknown,
  ) {
    super(`${message}: ${filePath}`, cause);
  }
}

export class ConfigError extends PureContextError {}

export class StorageError extends PureContextError {
  constructor(
    message: string,
    public readonly operation?: string,
    cause?: unknown,
  ) {
    super(operation ? `[${operation}] ${message}` : message, cause);
  }
}

export class QuotaExceededError extends PureContextError {
  constructor(
    public readonly tenantId: string,
    public readonly quotaBytes: number,
    public readonly usedBytes: number,
    public readonly requestedBytes: number,
  ) {
    super(
      `Storage quota exceeded for tenant "${tenantId}": ` +
        `${usedBytes + requestedBytes} bytes needed, ${quotaBytes} bytes allowed`,
    );
  }
}
