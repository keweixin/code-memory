/**
 * Code Memory Graph — Logger
 *
 * All output goes to stderr. In MCP stdio mode, stdout is reserved
 * for JSON-RPC protocol messages. Using console.log() would break
 * the MCP server.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

let currentLevel: LogLevel = 'info';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(level: string, message: string, context?: string): string {
  const timestamp = new Date().toISOString();
  const prefix = context ? `[${context}]` : '';
  return `${timestamp} ${level.toUpperCase()} ${prefix} ${message}`;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function debug(message: string, context?: string): void {
  if (shouldLog('debug')) {
    process.stderr.write(formatMessage('debug', message, context) + '\n');
  }
}

export function info(message: string, context?: string): void {
  if (shouldLog('info')) {
    process.stderr.write(formatMessage('info', message, context) + '\n');
  }
}

export function warn(message: string, context?: string): void {
  if (shouldLog('warn')) {
    process.stderr.write(formatMessage('warn', message, context) + '\n');
  }
}

export function error(message: string, context?: string, err?: unknown): void {
  if (shouldLog('error')) {
    const formatted = formatMessage('error', message, context);
    process.stderr.write(formatted + '\n');
    if (err instanceof Error) {
      process.stderr.write(`  Cause: ${err.message}\n`);
      if (err.stack) {
        process.stderr.write(`  Stack: ${err.stack}\n`);
      }
    } else if (err) {
      process.stderr.write(`  Cause: ${String(err)}\n`);
    }
  }
}

/**
 * Create a scoped logger that automatically prefixes all messages
 * with the given context name.
 */
export function createLogger(context: string) {
  return {
    debug: (message: string) => debug(message, context),
    info: (message: string) => info(message, context),
    warn: (message: string) => warn(message, context),
    error: (message: string, err?: unknown) => error(message, context, err),
  };
}
