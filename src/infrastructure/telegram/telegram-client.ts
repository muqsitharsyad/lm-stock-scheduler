import { AppConfig } from '../../app/config/env';
import { TelegramSendMessagePayload, TelegramApiResponse } from '../../app/types/telegram';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

export async function sendTelegramMessage(message: string, config: AppConfig): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  const payload: TelegramSendMessagePayload = {
    chat_id: config.telegramChatId,
    text: message,
    parse_mode: 'HTML',
  };

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // Handle 429 Too Many Requests — Telegram tells us exactly how long to wait
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
