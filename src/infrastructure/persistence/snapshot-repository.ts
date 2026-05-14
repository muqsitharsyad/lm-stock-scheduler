import { StockSnapshot } from '../../app/types/stock';
import { readJson, writeJson } from '../../app/utils/file';
import { logger } from '../../app/utils/logger';

export async function loadSnapshot(snapshotFile: string): Promise<StockSnapshot | null> {
  const snapshot = await readJson<StockSnapshot>(snapshotFile);
  if (snapshot) {
    logger.debug('[Snapshot] Previous snapshot loaded');
  } else {
    logger.debug('[Snapshot] No previous snapshot — treating all as first-run');
  }
  return snapshot;
}

export async function saveSnapshot(
  snapshotFile: string,
  snapshot: StockSnapshot,
): Promise<void> {
  await writeJson(snapshotFile, snapshot);
  logger.debug(`[Snapshot] Snapshot saved → ${snapshotFile}`);
}
