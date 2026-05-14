import dotenv from 'dotenv';

// Load .env file at module initialization (no-op if file doesn't exist)
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export interface AppConfig {
  lmEmail: string;
  lmPassword: string;
  lmTargetLocations: string[];
  telegramBotToken: string;
  telegramChatId: string;
  checkIntervalSeconds: number;
  timezone: string;
  headless: boolean;
  logLevel: string;
  debugScreenshotOnError: boolean;
  /** Wit.ai Server Access Token for automated reCAPTCHA audio bypass. Optional. */
  witAiToken: string | undefined;
  dataDir: string;
  sessionFile: string;
  snapshotFile: string;
  debugDir: string;
}

export function loadConfig(): AppConfig {
  const lmEmail = requireEnv('LM_EMAIL');
  const lmPassword = requireEnv('LM_PASSWORD');
  const telegramBotToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');

  // Empty string (default) means "scrape ALL available locations".
  // Set to comma-separated values/labels to restrict, e.g. "ABDH,AJK2"
  const lmTargetLocationsRaw = optionalEnv('LM_TARGET_LOCATIONS', '');
  const lmTargetLocations = lmTargetLocationsRaw
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const checkIntervalSeconds = parseInt(optionalEnv('CHECK_INTERVAL_SECONDS', '60'), 10);
  const timezone = optionalEnv('TZ', 'Asia/Jakarta');
  const headless = optionalEnv('HEADLESS', 'true').toLowerCase() !== 'false';
  const logLevel = optionalEnv('LOG_LEVEL', 'info');
  const debugScreenshotOnError =
    optionalEnv('DEBUG_SCREENSHOT_ON_ERROR', 'true').toLowerCase() !== 'false';

  const witAiToken = process.env['WIT_AI_ACCESS_TOKEN'] || undefined;

  const dataDir = 'data';

  return {
    lmEmail,
    lmPassword,
    lmTargetLocations,
    telegramBotToken,
    telegramChatId,
    checkIntervalSeconds,
    timezone,
    headless,
    logLevel,
    debugScreenshotOnError,
    witAiToken,
    dataDir,
    sessionFile: `${dataDir}/session.json`,
    snapshotFile: `${dataDir}/last-stock.json`,
    debugDir: `${dataDir}/debug`,
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
