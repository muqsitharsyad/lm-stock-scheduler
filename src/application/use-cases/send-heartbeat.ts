import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { formatTime } from '../../app/utils/time';
import { sendTelegramMessage } from '../../infrastructure/telegram/telegram-client';

/**
 * Sends a heartbeat message to Telegram to confirm the bot is still running.
 *
 * Format:
 *   ✅ Bot Aktif
 *
 *   Jam     : 11:08:40 WIB
 *   Interval: 60s
 *   Uptime  : 2j 15m
 */
export async function sendHeartbeat(config: AppConfig, startedAt: Date): Promise<void> {
  const now = new Date();
  const uptimeMs = now.getTime() - startedAt.getTime();
  const uptimeHours = Math.floor(uptimeMs / 3_600_000);
  const uptimeMinutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
  const uptimeStr =
    uptimeHours > 0 ? `${uptimeHours}j ${uptimeMinutes}m` : `${uptimeMinutes}m`;

  const locations =
    config.lmTargetLocations.length > 0
      ? config.lmTargetLocations.join(', ')
      : 'Semua butik';

  const weights =
    config.lmTargetWeights.length > 0
      ? config.lmTargetWeights.map((w) => `${w} gr`).join(', ')
      : 'Semua gramasi';

  const message = [
    '✅ <b>Bot Aktif</b>',
    '',
    `Jam     : ${formatTime(now)} WIB`,
    `Interval: ${config.checkIntervalSeconds}s`,
    `Uptime  : ${uptimeStr}`,
    `Lokasi  : ${locations}`,
    `Gramasi : ${weights}`,
  ].join('\n');

  await sendTelegramMessage(message, config);
  logger.info(`[Heartbeat] Sent (uptime: ${uptimeStr})`);
}
