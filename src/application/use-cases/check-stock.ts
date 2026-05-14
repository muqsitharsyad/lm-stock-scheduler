import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { scrapeAllLocationsHttp } from '../../infrastructure/logammulia/http-stock-client';
import { loadSnapshot, saveSnapshot } from '../../infrastructure/persistence/snapshot-repository';
import { loadTopics, saveTopics } from '../../infrastructure/persistence/topic-repository';
import { compareSnapshots } from '../../domain/services/compare-stock';
import { buildTelegramMessage } from '../../domain/services/build-telegram-message';
import { sendTelegramMessage, createForumTopic } from '../../infrastructure/telegram/telegram-client';
import { BotStatus } from '../../interfaces/web/status-server';

/**
 * Main orchestration use-case.
 * `status` is a shared mutable object updated after each run so the status
 * web page always reflects the latest state.
 */
export async function checkStock(config: AppConfig, status: BotStatus): Promise<void> {
  logger.info('[CheckStock] ════ Starting stock check ════');

  try {
    status.checkCount++;
    // Step 1 — scrape via HTTP (10-50× faster than Playwright)
    const newSnapshot = await scrapeAllLocationsHttp(config);

    // Step 2 — compare
    const oldSnapshot = await loadSnapshot(config.snapshotFile);
    const changes = compareSnapshots(oldSnapshot, newSnapshot);

    // Step 3 — persist FIRST so duplicate notifications cannot occur even if Telegram fails
    await saveSnapshot(config.snapshotFile, newSnapshot);

    // Step 4 — notify
    if (changes.length === 0) {
      logger.info('[CheckStock] No stock increases detected');
    } else {
      logger.info(`[CheckStock] Stock increase(s) detected for ${changes.length} location(s)`);

      // Load persisted topic map if topics mode is enabled
      let topicMap: Record<string, number> = {};
      if (config.telegramUseTopics) {
        topicMap = await loadTopics(config.topicsFile);
      }

      for (const change of changes) {
        try {
          const message = buildTelegramMessage(change);
          let messageThreadId: number | undefined;

          if (config.telegramUseTopics) {
            // Reuse existing topic or create a new one for this butik
            if (topicMap[change.location] !== undefined) {
              messageThreadId = topicMap[change.location];
            } else {
              messageThreadId = await createForumTopic(change.location, config);
              topicMap[change.location] = messageThreadId;
            }
          }

          logger.info(
            `[CheckStock] Sending notification for "${change.location}"` +
              (messageThreadId !== undefined ? ` (topic=${messageThreadId})` : ''),
          );
          await sendTelegramMessage(message, config, messageThreadId);
        } catch (err) {
          logger.error(
            `[CheckStock] Failed to send notification for "${change.location}" (skipped):`,
            err,
          );
        }
      }

      // Persist any newly created topics
      if (config.telegramUseTopics) {
        await saveTopics(config.topicsFile, topicMap);
      }
    }

    logger.info('[CheckStock] ════ Stock check complete ════');
    status.lastCheckAt = new Date();
    status.lastCheckSuccess = true;
  } catch (err) {
    status.lastCheckAt = new Date();
    status.lastCheckSuccess = false;
    status.errorCount++;
    logger.error('[CheckStock] Unhandled error during stock check:', err);
    throw err;
  }
}
