export interface TelegramSendMessagePayload {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  /** Forum topic thread ID — required when sending to a specific topic. */
  message_thread_id?: number;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
  icon_color: number;
}

export interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}
