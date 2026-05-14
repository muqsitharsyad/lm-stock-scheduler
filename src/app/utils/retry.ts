import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  /** Multiply delay by attempt number on each retry. Default: false */
  backoff?: boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  context = 'operation',
): Promise<T> {
  const { maxAttempts, delayMs, backoff = false } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
      const waitMs = backoff ? delayMs * attempt : delayMs;
      logger.warn(
        `[Retry] ${context} failed (attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs}ms...`,
      );
      await sleep(waitMs);
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`[Retry] ${context} exhausted all ${maxAttempts} attempts`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
