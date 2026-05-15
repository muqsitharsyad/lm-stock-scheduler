import { AppConfig } from '../../app/config/env';
import {
  TelegramSendMessagePayload,
  TelegramApiResponse,
  TelegramForumTopic,
} from '../../app/types/telegram';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

const MAX_TOPIC_NAME_LENGTH = 128;

/**
 * Sends a message to a Telegram chat (or a specific forum topic if messageThreadId is provided).
 * Handles 429 rate-limiting automatically using retry_after from response.
 */
export async function sendTelegramMessage(
  message: string,
  config: AppConfig,
  messageThreadId?: number,
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  const payload: TelegramSendMessagePayload = {
    chat_id: config.telegramChatId,
    text: message,
    parse_mode: 'HTML',
    ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
  };

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      const retryAfter = body.parameters?.retry_after ?? 30;
      logger.warn(`[Telegram] Rate limited (429). Waiting ${retryAfter}s (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(retryAfter * 1_000);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`[Telegram] HTTP ${response.status}: ${body || response.statusText}`);
    }

    const data = (await response.json()) as TelegramApiResponse;
    if (!data.ok) {
      throw new Error(`[Telegram] API error ${data.error_code ?? '?'}: ${data.description ?? 'unknown'}`);
    }

    logger.info('[Telegram] Message sent successfully');
    return;
  }

  throw new Error(`[Telegram] Failed after ${MAX_ATTEMPTS} attempts (rate limited)`);
}

/**
 * Creates a new Forum Topic in the configured Telegram group.
 *
 * Requirements:
 *   - Chat must be a supergroup (not a regular group)
 *   - "Topics" must be enabled in the group settings
 *   - Bot must have "Manage Topics" admin permission
 *
 * @returns The message_thread_id of the created topic.
 */
export async function createForumTopic(
  locationName: string,
  config: AppConfig,
): Promise<number> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/createForumTopic`;

  // Telegram enforces max 128 characters for topic names
  const name =
    locationName.length > MAX_TOPIC_NAME_LENGTH
      ? locationName.substring(0, MAX_TOPIC_NAME_LENGTH - 3) + '...'
      : locationName;

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, name }),
    });

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      const retryAfter = body.parameters?.retry_after ?? 10;
      logger.warn(`[Telegram] Rate limited creating topic "${name}". Waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1_000);
      continue;
    }

    const data = (await response.json()) as {
      ok: boolean;
      result?: TelegramForumTopic;
      description?: string;
      error_code?: number;
    };

    if (!data.ok || !data.result) {
      const msg = data.description ?? 'unknown';
      const code = data.error_code ?? response.status;
      throw new Error(
        `[Telegram] Failed to create topic "${name}" (${code}): ${msg}. ` +
          'Ensure the group is a Supergroup, Topics are enabled, and the bot has "Manage Topics" admin right.',
      );
    }

    logger.info(`[Telegram] Created topic "${name}" → thread_id=${data.result.message_thread_id}`);
    return data.result.message_thread_id;
  }

  throw new Error(`[Telegram] Could not create topic "${name}" after ${MAX_ATTEMPTS} attempts`);
}
