import { readJson, writeJson } from '../../app/utils/file';

/** Maps location name → Telegram message_thread_id */
type TopicMap = Record<string, number>;

export async function loadTopics(filePath: string): Promise<TopicMap> {
  return (await readJson<TopicMap>(filePath)) ?? {};
}

export async function saveTopics(filePath: string, topics: TopicMap): Promise<void> {
  await writeJson(filePath, topics);
}
