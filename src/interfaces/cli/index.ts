import { getConfig } from '../../app/config/env';
import { setLogLevel, logger } from '../../app/utils/logger';
import { ensureDir } from '../../app/utils/file';
import { checkStock } from '../../application/use-cases/check-stock';
import { runWithInterval } from '../scheduler/interval-runner';
import { startStatusServer, BotStatus } from '../web/status-server';

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
  logger.info(`Status    : http://localhost:${config.statusPort}`);
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
  };

  if (config.statusPort > 0) {
    startStatusServer(status, config);
  }

  const shutdown = (signal: string) => {
    logger.info(`[App] Received ${signal} — shutting down gracefully...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await runWithInterval(() => checkStock(config, status), config.checkIntervalSeconds);
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err);
  process.exit(1);
});
