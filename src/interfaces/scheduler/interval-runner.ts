import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

/**
 * Runs `fn` in a safe infinite loop at the configured interval.
 *
 * The interval is measured from the *start* of each invocation, so the actual
 * wait time between runs is:  max(0, intervalSeconds * 1000 - elapsed)
 *
 * This prevents drift when a single run takes longer than the interval.
 */
export async function runWithInterval(
  fn: () => Promise<void>,
  intervalSeconds: number,
): Promise<void> {
  logger.info(`[Scheduler] Running every ${intervalSeconds}s`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const start = Date.now();

    try {
      await fn();
    } catch (err) {
      logger.error('[Scheduler] Task failed (will retry next interval):', err);
    }

    const elapsed = Date.now() - start;
    const waitMs = Math.max(0, intervalSeconds * 1_000 - elapsed);

    if (waitMs > 0) {
      logger.debug(`[Scheduler] Next run in ${(waitMs / 1_000).toFixed(1)}s`);
      await sleep(waitMs);
    }
  }
}
