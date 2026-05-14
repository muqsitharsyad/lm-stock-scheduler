import { getConfig } from '../../app/config/env';
import { setLogLevel, logger } from '../../app/utils/logger';
import { ensureDir } from '../../app/utils/file';
import { checkStock } from '../../application/use-cases/check-stock';
import { runWithInterval } from '../scheduler/interval-runner';

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
  logger.info(`Interval  : ${config.checkIntervalSeconds}s`);
  logger.info(`Log level : ${config.logLevel}`);

  // Ensure persistence directories are present before anything runs
  await ensureDir(config.dataDir);
  await ensureDir(config.debugDir);

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = (signal: string) => {
    logger.info(`[App] Received ${signal} — shutting down gracefully...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await runWithInterval(() => checkStock(config), config.checkIntervalSeconds);
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err);
  process.exit(1);
});
