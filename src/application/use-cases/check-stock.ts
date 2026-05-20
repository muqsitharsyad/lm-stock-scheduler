import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';
import { LocationStock } from '../../app/types/stock';
import { scrapeAllLocationsHttp } from '../../infrastructure/logammulia/http-stock-client';
import { loadSnapshot, saveSnapshot } from '../../infrastructure/persistence/snapshot-repository';
import { loadTopics, saveTopics } from '../../infrastructure/persistence/topic-repository';
import { compareSnapshots } from '../../domain/services/compare-stock';
import { buildTelegramMessage } from '../../domain/services/build-telegram-message';
import { sendTelegramMessage, createForumTopic } from '../../infrastructure/telegram/telegram-client';
import { BotStatus } from '../../interfaces/web/status-server';
import {
  startFastPoll,
  isFastPollActive,
  shouldFireWebhook,
} from './fast-poll-manager';

/**
 * Main orchestration use-case.
 * `status` is a shared mutable object updated after each run so the status
 * web page always reflects the latest state.
 */
export async function checkStock(config: AppConfig, status: BotStatus): Promise<void> {
  logger.info('[CheckStock] ════ Starting stock check ════');

  try {
    status.checkCount++;

    // Load old snapshot BEFORE parallel scraping so every per-location callback
    // can compare against a consistent baseline.
    const oldSnapshot = await loadSnapshot(config.snapshotFile);

    // Load persisted topic map once; per-location callbacks may add to it.
    let topicMap: Record<string, number> = {};
    if (config.telegramUseTopics) {
      topicMap = await loadTopics(config.topicsFile);
    }

    // ── Topic creation mutex ─────────────────────────────────────────────────
    // Multiple locations can finish scraping simultaneously. Topic creation must
    // be serialized to stay under Telegram's createForumTopic rate limit.
    let topicCreationQueue: Promise<unknown> = Promise.resolve();
    let topicsCreatedThisRun = 0;

    function getOrCreateTopic(location: string): Promise<number | undefined> {
      if (!config.telegramUseTopics) return Promise.resolve(undefined);
      if (topicMap[location] !== undefined) {
        logger.debug(`[CheckStock] Reusing topic ${topicMap[location]} for "${location}"`);
        return Promise.resolve(topicMap[location]);
      }

      // Enqueue: wait for any in-progress creation before starting the next one.
      return new Promise<number | undefined>((resolve) => {
        topicCreationQueue = topicCreationQueue
          .then(async () => {
            // Re-check after waiting (another task may have created it while we waited)
            if (topicMap[location] !== undefined) { resolve(topicMap[location]); return; }
            if (topicsCreatedThisRun > 0) await sleep(1_500);
            topicsCreatedThisRun++;
            try {
              const tid = await createForumTopic(location, config);
              topicMap[location] = tid;
              await saveTopics(config.topicsFile, topicMap);
              resolve(tid);
            } catch (err) {
              logger.error(`[CheckStock] Topic creation failed for "${location}":`, err);
              resolve(undefined);
            }
          })
          .catch(() => resolve(undefined));
      });
    }

    // ── Realtime per-location notification ──────────────────────────────────
    // onResult is called by the scraper immediately when each location finishes,
    // running concurrently with ongoing scraping of other locations.
    const notificationPromises: Promise<void>[] = [];
    const allResults: LocationStock[] = [];

    /**
     * Lightweight handler used by the fast-poll loop. Only fires the webhook;
     * skips Telegram (avoids spam every 1.75s) and snapshot diff machinery.
     */
    const onFastPollResult = (result: LocationStock): void => {
      if (!config.checkoutWebhookUrl) return;
      const locCode = result.locationCode || result.location;
      const webhookItems = result.items.filter((i) => {
        if (i.qty <= 0) return false;
        return shouldFireWebhook(
          locCode,
          i.weight,
          i.qty,
          config.webhookCooldownSeconds,
        );
      });
      if (webhookItems.length > 0) {
        triggerCheckoutWebhook(config.checkoutWebhookUrl, result, webhookItems);
      }
    };

    const onResult = (result: LocationStock): void => {
      allResults.push(result);
      const p = (async () => {
        // Compare with notifyDecrease option from config
        const changes = compareSnapshots(oldSnapshot, [result], {
          notifyDecrease: config.notifyDecrease,
        });
        if (changes.length === 0) return;
        const change = changes[0];

        // Trigger auto-checkout webhook on stock increase, gated by per-(loc|weight) cooldown
        if (config.checkoutWebhookUrl) {
          const webhookItems = result.items.filter((i) => {
            if (i.qty <= 0) return false;
            return shouldFireWebhook(
              result.locationCode || result.location,
              i.weight,
              i.qty,
              config.webhookCooldownSeconds,
            );
          });
          if (webhookItems.length > 0) {
            triggerCheckoutWebhook(config.checkoutWebhookUrl, result, webhookItems);
          }
        }

        // Adaptive fast poll: if ABDH (or any priority location) just got target-weight stock,
        // switch to fast polling so subsequent restocks are caught within ~2s.
        // Fast-poll uses onFastPollResult (webhook-only, no Telegram spam).
        const locCode = result.locationCode || '';
        const isPriorityLocation = config.fastPollLocations.some(
          (l) => locCode === l || result.location.includes(l),
        );
        if (isPriorityLocation && !isFastPollActive(locCode)) {
          const hasTargetWeightStock = result.items.some((i) => {
            if (i.qty <= 0) return false;
            const w = parseFloat(i.weight.match(/(\d+[,.]?\d*)/)?.[1].replace(',', '.') || '0');
            return config.fastPollWeights.some((tw) => Math.abs(tw - w) < 0.001);
          });
          if (hasTargetWeightStock) {
            startFastPoll(config, locCode, result.location, onFastPollResult);
          }
        }

        try {
          const threadId = await getOrCreateTopic(change.location);
          logger.info(
            `[CheckStock] Sending notification for "${change.location}"` +
              (threadId !== undefined ? ` (topic=${threadId})` : ''),
          );
          await sendTelegramMessage(buildTelegramMessage(change), config, threadId);
        } catch (err) {
          logger.error(
            `[CheckStock] Failed to send notification for "${change.location}" (skipped):`,
            err,
          );
        }
      })();
      notificationPromises.push(p);
    };

    // ── Scrape all locations in parallel ────────────────────────────────────
    await scrapeAllLocationsHttp(config, onResult);

    // Wait for all in-flight notifications before persisting snapshot
    await Promise.allSettled(notificationPromises);

    // Safety net: if no results came back, treat as failure
    if (allResults.length === 0) {
      status.lastCheckAt = new Date();
      status.lastCheckSuccess = false;
      status.errorCount++;
      const msg = 'Scraping returned 0 results (tidak ada lokasi yang ter-scrape)';
      status.lastError = msg;
      logger.error(`[CheckStock] ${msg}`);
      return;
    }

    // Log summary
    const increased = notificationPromises.length;
    if (increased === 0) {
      logger.info('[CheckStock] No stock changes detected');
    }

    await saveSnapshot(config.snapshotFile, allResults);

    logger.info('[CheckStock] ════ Stock check complete ════');
    status.lastCheckAt = new Date();
    status.lastCheckSuccess = true;
    status.lastError = null;
  } catch (err) {
    status.lastCheckAt = new Date();
    status.lastCheckSuccess = false;
    status.errorCount++;
    const errMsg = err instanceof Error ? err.message : String(err);
    status.lastError = errMsg;
    logger.error('[CheckStock] Unhandled error during stock check:', err);
    throw err;
  }
}

/**
 * Tracks the last webhook trigger per location for the legacy 5s debounce
 * (a coarser guard on top of the per-(loc|weight) cooldown in fast-poll-manager).
 */
const lastWebhookTriggerByLocation = new Map<string, number>();
const WEBHOOK_DEBOUNCE_MS = 5_000;

/**
 * Triggers the auto-checkout webhook (fire-and-forget).
 * `webhookItems` contains only the items eligible per cooldown logic.
 */
function triggerCheckoutWebhook(
  webhookUrl: string,
  location: LocationStock,
  webhookItems: { weight: string; qty: number }[],
): void {
  const now = Date.now();
  const last = lastWebhookTriggerByLocation.get(location.location) ?? 0;
  if (now - last < WEBHOOK_DEBOUNCE_MS) {
    logger.debug(`[CheckStock] Webhook debounced for "${location.location}" (last trigger ${now - last}ms ago)`);
    return;
  }
  lastWebhookTriggerByLocation.set(location.location, now);

  logger.info(
    `[CheckStock] 🛒 Triggering auto-checkout webhook for "${location.location}" (${webhookItems.length} item(s))`,
  );

  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trigger: 'stock-available',
      timestamp: new Date().toISOString(),
      location: location.location,
      locationCode: location.locationCode,
      items: webhookItems.map((i) => ({ weight: i.weight, qty: i.qty })),
    }),
  })
    .then((res) => {
      if (res.ok) {
        logger.info('[CheckStock] ✓ Checkout webhook accepted');
      } else {
        logger.warn(`[CheckStock] Checkout webhook returned ${res.status}`);
      }
    })
    .catch((err) => {
      logger.error('[CheckStock] Failed to trigger checkout webhook:', err);
    });
}
