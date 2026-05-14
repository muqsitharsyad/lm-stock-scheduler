import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { scrapeAllLocationsHttp } from '../../infrastructure/logammulia/http-stock-client';
import { loadSnapshot, saveSnapshot } from '../../infrastructure/persistence/snapshot-repository';
import { compareSnapshots } from '../../domain/services/compare-stock';
import { buildTelegramMessage } from '../../domain/services/build-telegram-message';
import { sendTelegramMessage } from '../../infrastructure/telegram/telegram-client';

/**
 * Main orchestration use-case:
 *   1. Scrape all target locations via direct HTTP (no browser needed)
 *   2. Compare against the previous snapshot
 *   3. Persist the new snapshot (BEFORE notifications to prevent duplicates on error)
 *   4. Send Telegram notifications for any stock increases
 */
export async function checkStock(config: AppConfig): Promise<void> {
  logger.info('[CheckStock] ════ Starting stock check ════');

  try {
    // Step 1 — scrape via HTTP (10-50× faster than Playwright)
    const newSnapshot = await scrapeAllLocationsHttp(config);

    // Step 2 — compare
    const oldSnapshot = await loadSnapshot(config.snapshotFile);
    const changes = compareSnapshots(oldSnapshot, newSnapshot);

    // Step 3 — persist FIRST so duplicate notifications cannot occur even if Telegram fails
    await saveSnapshot(config.snapshotFile, newSnapshot);

    // Step 4 — notify (errors per-location caught so one failure won't skip the rest)
    if (changes.length === 0) {
      logger.info('[CheckStock] No stock increases detected');
    } else {
      logger.info(`[CheckStock] Stock increase(s) detected for ${changes.length} location(s)`);
      for (const change of changes) {
        try {
          const message = buildTelegramMessage(change);
          logger.info(`[CheckStock] Sending Telegram notification for "${change.location}"`);
          await sendTelegramMessage(message, config);
        } catch (err) {
          logger.error(
            `[CheckStock] Failed to send notification for "${change.location}" (skipped):`,
            err,
          );
        }
      }
    }

    logger.info('[CheckStock] ════ Stock check complete ════');
  } catch (err) {
    logger.error('[CheckStock] Unhandled error during stock check:', err);
    throw err;
  }
}
