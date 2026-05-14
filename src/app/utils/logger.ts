type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: string): void {
  if (level in LEVELS) {
    currentLevel = level as LogLevel;
  }
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, message: string): string {
  const now = new Date().toISOString();
  return `[${now}] [${level.toUpperCase().padEnd(5)}] ${message}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog('debug')) console.debug(formatMessage('debug', message), ...args);
  },
  info(message: string, ...args: unknown[]): void {
    if (shouldLog('info')) console.info(formatMessage('info', message), ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(formatMessage('warn', message), ...args);
  },
  error(message: string, ...args: unknown[]): void {
    if (shouldLog('error')) console.error(formatMessage('error', message), ...args);
  },
};
