import { AppConfig } from '../../app/config/env';
import {
  TelegramSendMessagePayload,
  TelegramApiResponse,
  TelegramForumTopic,
} from '../../app/types/telegram';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

/**
 * Sends a message to a Telegram chat (or a specific forum topic if messageThreadId is provided).
 * Handles 429 rate-limiting automatically by waiting the retry_after duration from the response.
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
        description?: string;
      };
      const retryAfter = body.parameters?.retry_after ?? 30;
      logger.warn(
        `[Telegram] Rate limited (429). Waiting ${retryAfter}s before retry ${attempt}/${MAX_ATTEMPTS}...`,
      );
      await sleep(retryAfter * 1_000);
      continue;
    }

    if (!response.ok) {
      throw new Error(`[Telegram] HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as TelegramApiResponse;
    if (!data.ok) {
      throw new Error(
        `[Telegram] API error ${data.error_code ?? '?'}: ${data.description ?? 'unknown'}`,
      );
    }

    logger.info('[Telegram] Message sent successfully');
    return;
  }

  throw new Error(`[Telegram] Failed to send message after ${MAX_ATTEMPTS} attempts (rate limited)`);
}

/**
 * Creates a new Forum Topic in the configured Telegram group.
 * The chat must be a supergroup with Topics feature enabled.
 *
 * @returns The message_thread_id of the newly created topic.
 */
export async function createForumTopic(
  topicName: string,
  config: AppConfig,
): Promise<number> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/createForumTopic`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, name: topicName }),
  });

  if (!response.ok) {
    throw new Error(`[Telegram] Failed to create forum topic "${topicName}": HTTP ${response.status}`);
  }

  const data = (await response.json()) as { ok: boolean; result?: TelegramForumTopic; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(`[Telegram] API error creating topic "${topicName}": ${data.description ?? 'unknown'}`);
  }

  logger.info(`[Telegram] Created forum topic "${topicName}" (thread_id=${data.result.message_thread_id})`);
  return data.result.message_thread_id;
}
