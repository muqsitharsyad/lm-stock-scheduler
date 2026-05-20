import { getConfig } from '../../app/config/env';
import { setLogLevel, logger } from '../../app/utils/logger';
import { ensureDir } from '../../app/utils/file';
import { checkStock } from '../../application/use-cases/check-stock';
import { runWithInterval } from '../scheduler/interval-runner';
import { startStatusServer, BotStatus } from '../web/status-server';
import { startScheduledFastPoll, shouldFireWebhook } from '../../application/use-cases/fast-poll-manager';
import { LocationStock } from '../../app/types/stock';
import { loadSnapshot, saveSnapshot } from '../../infrastructure/persistence/snapshot-repository';
import { loadTopics } from '../../infrastructure/persistence/topic-repository';
import { compareSnapshots } from '../../domain/services/compare-stock';
import { buildTelegramMessage } from '../../domain/services/build-telegram-message';
import { sendTelegramMessage } from '../../infrastructure/telegram/telegram-client';

async function main(): Promise<void> {
  const config = getConfig();
  setLogLevel(config.logLevel);

  logger.info('╔══════════════════════════════════════╗');
  logger.info('║   Logam Mulia Stock Scheduler  🟡    ║');
  logger.info('╚══════════════════════════════════════╝');
  logger.info(
    `Locations : ${
      config.lmTargetLocations.length > 0 ? config.lmTargetLocations.join(', ') : 'ALL (auto-discover)'
    }`,
  );
  logger.info(
    `Weights   : ${
      config.lmTargetWeights.length > 0 ? config.lmTargetWeights.map((w) => `${w} gr`).join(', ') : 'ALL'
    }`,
  );
  logger.info(`Interval  : ${config.checkIntervalSeconds}s`);
  logger.info(
    `Jam aktif : ${config.activeStart && config.activeEnd ? `${config.activeStart}–${config.activeEnd} WIB` : '24/7'}`,
  );
  logger.info(`Topics    : ${config.telegramUseTopics ? 'ENABLED (per-butik topics)' : 'DISABLED (single chat)'}`);
  logger.info(`Notify    : stock naik${config.notifyDecrease ? ' + turun/habis' : ' saja'}`);
  logger.info(`Status    : http://localhost:${config.statusPort}`);
  logger.info(`Fast poll : ${config.fastPollLocations.join(',')} @ ${config.fastPollIntervalMs}ms (weights: ${config.fastPollWeights.join(',')})`);
  logger.info(`Log level : ${config.logLevel}`);

  await ensureDir(config.dataDir);
  await ensureDir(config.debugDir);

  // Shared status object — updated by checkStock, read by status server
  const status: BotStatus = {
    startedAt: new Date(),
    lastCheckAt: null,
    lastCheckSuccess: false,
    checkCount: 0,
    errorCount: 0,
    lastError: null,
  };

  if (config.statusPort > 0) {
    startStatusServer(status, config);
  }

  // ── Scheduled fast poll for priority locations (ABDH ekspedisi) ────────────
  // Runs 4s+jitter during 06:50-17:00 WIB, independent of normal check cycle.
  // Fires webhook on stock transitions AND sends Telegram notifications.
  if (config.fastPollLocations.length > 0) {
    const FALLBACK_LOCATIONS: Record<string, string> = {
      ABDH: 'BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta',
    };

    // Load topic map once for Telegram topic routing
    let topicMap: Record<string, number> = {};
    if (config.telegramUseTopics) {
      topicMap = await loadTopics(config.topicsFile);
    }

    for (const locCode of config.fastPollLocations) {
      const locLabel = FALLBACK_LOCATIONS[locCode] || locCode;
      startScheduledFastPoll(
        config,
        locCode,
        locLabel,
        async (result: LocationStock) => {
          // Compare with saved snapshot to detect changes
          const oldSnapshot = await loadSnapshot(config.snapshotFile);
          const changes = compareSnapshots(oldSnapshot, [result], {
            notifyDecrease: config.notifyDecrease,
          });

          if (changes.length === 0) return;
          const change = changes[0];

          // Save updated snapshot (merge with existing)
          const merged = oldSnapshot
            ? oldSnapshot.map((l) => (l.location === result.location ? result : l))
            : [result];
          if (!merged.find((l) => l.location === result.location)) merged.push(result);
          await saveSnapshot(config.snapshotFile, merged);

          // Fire webhook on stock increase (with cooldown)
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
              logger.info(
                `[ScheduledFastPoll] 🛒 Stock detected! Triggering webhook for "${locLabel}" (${webhookItems.length} item(s))`,
              );
              fetch(config.checkoutWebhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  trigger: 'stock-available',
                  timestamp: new Date().toISOString(),
                  location: result.location,
                  locationCode: result.locationCode,
                  items: webhookItems.map((i) => ({ weight: i.weight, qty: i.qty })),
                }),
              })
                .then((r) => {
                  if (r.ok) logger.info('[ScheduledFastPoll] ✓ Webhook accepted');
                  else logger.warn(`[ScheduledFastPoll] Webhook returned ${r.status}`);
                })
                .catch((e) => logger.error('[ScheduledFastPoll] Webhook failed:', e));
            }
          }

          // Send Telegram notification
          try {
            const threadId = config.telegramUseTopics ? topicMap[change.location] : undefined;
            await sendTelegramMessage(buildTelegramMessage(change), config, threadId);
          } catch (err) {
            logger.error(`[ScheduledFastPoll] Telegram failed for "${locLabel}":`, err);
          }
        },
      );
    }
  }

  const shutdown = (signal: string) => {
    logger.info(`[App] Received ${signal} — shutting down gracefully...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await runWithInterval(() => checkStock(config, status), config);
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err);
  process.exit(1);
});
