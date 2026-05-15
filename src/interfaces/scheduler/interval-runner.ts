import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

/** Parse "HH:MM" string into total minutes from midnight. Returns -1 if invalid. */
function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.trim().split(':');
  if (parts.length !== 2) return -1;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return -1;
  return h * 60 + m;
}

/** Returns current time in WIB as total minutes from midnight. */
function nowWibMinutes(): number {
  const wib = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }),
  );
  return wib.getHours() * 60 + wib.getMinutes();
}

/**
 * Checks whether the current WIB time is within the configured operating window.
 * Returns { active: true } if running, or { active: false, sleepMs } with time to wait.
 */
function checkActiveHours(
  activeStart: string,
  activeEnd: string,
): { active: true } | { active: false; sleepMs: number; until: string } {
  const startMin = parseTimeToMinutes(activeStart);
  const endMin = parseTimeToMinutes(activeEnd);

  if (startMin < 0 || endMin < 0) return { active: true }; // invalid config → always run

  const now = nowWibMinutes();

  if (now >= startMin && now < endMin) {
    return { active: true };
  }

  // Calculate minutes until next active window start
  const minutesUntilStart =
    now < startMin
      ? startMin - now
      : 24 * 60 - now + startMin;

  return {
    active: false,
    sleepMs: minutesUntilStart * 60 * 1_000,
    until: activeStart,
  };
}

/**
 * Runs `fn` in a safe infinite loop at the configured interval,
 * respecting operating hours (ACTIVE_START / ACTIVE_END in WIB).
 *
 * Outside active hours, the loop sleeps until the next start time
 * to free up CPU and network resources.
 */
export async function runWithInterval(
  fn: () => Promise<void>,
  config: AppConfig,
): Promise<void> {
  const { checkIntervalSeconds, activeStart, activeEnd } = config;
  const hasActiveHours = activeStart && activeEnd;

  if (hasActiveHours) {
    logger.info(`[Scheduler] Active hours: ${activeStart}–${activeEnd} WIB | Interval: ${checkIntervalSeconds}s`);
  } else {
    logger.info(`[Scheduler] Running 24/7 every ${checkIntervalSeconds}s`);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Check operating hours ────────────────────────────────────────────────
    if (hasActiveHours) {
      const hours = checkActiveHours(activeStart, activeEnd);
      if (!hours.active) {
        const sleepMin = Math.ceil(hours.sleepMs / 60_000);
        logger.info(
          `[Scheduler] Outside active hours — sleeping ${sleepMin}m until ${hours.until} WIB`,
        );
        await sleep(hours.sleepMs);
        continue;
      }
    }

    // ── Run task ─────────────────────────────────────────────────────────────
    const start = Date.now();

    try {
      await fn();
    } catch (err) {
      logger.error('[Scheduler] Task failed (will retry next interval):', err);
    }

    const elapsed = Date.now() - start;
    const waitMs = Math.max(0, checkIntervalSeconds * 1_000 - elapsed);

    if (waitMs > 0) {
      logger.debug(`[Scheduler] Next run in ${(waitMs / 1_000).toFixed(1)}s`);
      await sleep(waitMs);
    }
  }
}
