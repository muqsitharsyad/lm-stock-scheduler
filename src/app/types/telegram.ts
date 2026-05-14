export interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

export interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}
