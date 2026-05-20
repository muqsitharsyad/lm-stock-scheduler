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
  /** Optional — login no longer required for HTTP scraping (page is public). */
  lmEmail: string | undefined;
  lmPassword: string | undefined;
  lmTargetLocations: string[];
  /**
   * Numeric gramasi to monitor (e.g. [0.5, 1, 2, 3]).
   * Empty array means monitor ALL gramasi.
   */
  lmTargetWeights: number[];
  telegramBotToken: string;
  telegramChatId: string;
  /**
   * When true, each butik is sent to its own Telegram Forum Topic.
   * The group must have Topics enabled.
   * Topic IDs are persisted in topicsFile.
   */
  telegramUseTopics: boolean;
  /**
   * When true, send notifications when stock decreases or becomes sold out.
   * Default: true (matches competitor behavior — notify on all changes).
   */
  notifyDecrease: boolean;
  /** Port for the built-in HTTP status page. 0 = disabled. */
  statusPort: number;
  /**
   * Operating hours in WIB (Asia/Jakarta). Format: "HH:MM".
   * Outside these hours the scheduler sleeps. Empty = run 24/7.
   */
  activeStart: string;
  activeEnd: string;
  checkIntervalSeconds: number;
  /** Number of locations scraped in parallel. Default 5. */
  scrapeConcurrency: number;
  timezone: string;
  headless: boolean;
  logLevel: string;
  debugScreenshotOnError: boolean;
  /** Wit.ai Server Access Token for automated reCAPTCHA audio bypass. Optional. */
  witAiToken: string | undefined;
  /** URL to POST when stock becomes available (triggers auto-checkout). */
  checkoutWebhookUrl: string | undefined;
  /** Fast poll interval in ms for priority locations (default 1750). */
  fastPollIntervalMs: number;
  /** Location codes that get fast polling when stock appears (e.g. ["ABDH"]). */
  fastPollLocations: string[];
  /** Gramasi that trigger fast polling (e.g. [0.5, 1, 2, 3, 5]). */
  fastPollWeights: number[];
  /** Stop fast poll after this many seconds without stock (default 300). */
  fastPollTimeoutSeconds: number;
  /** Min seconds between webhook fires for same location+weight (default 15). */
  webhookCooldownSeconds: number;
  dataDir: string;
  sessionFile: string;
  snapshotFile: string;
  /** Persisted map of location name → Telegram message_thread_id. */
  topicsFile: string;
  debugDir: string;
}

export function loadConfig(): AppConfig {
  // LM_EMAIL and LM_PASSWORD are no longer required — stock page is public.
  const lmEmail = process.env['LM_EMAIL'] || undefined;
  const lmPassword = process.env['LM_PASSWORD'] || undefined;
  const telegramBotToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');

  // Empty string (default) means "scrape ALL available locations".
  // Set to comma-separated values/labels to restrict, e.g. "ABDH,AJK2"
  const lmTargetLocationsRaw = optionalEnv('LM_TARGET_LOCATIONS', '');
  const lmTargetLocations = lmTargetLocationsRaw
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const lmTargetWeightsRaw = optionalEnv('LM_TARGET_WEIGHTS', '');
  const lmTargetWeights = lmTargetWeightsRaw
    .split(',')
    .map((w) => parseFloat(w.trim().replace(',', '.')))
    .filter((w) => !isNaN(w) && w > 0);

  const telegramUseTopics =
    optionalEnv('TELEGRAM_USE_TOPICS', 'false').toLowerCase() === 'true';

  const notifyDecrease =
    optionalEnv('NOTIFY_DECREASE', 'true').toLowerCase() !== 'false';

  const statusPort = parseInt(optionalEnv('STATUS_PORT', '3200'), 10);

  const activeStart = optionalEnv('ACTIVE_START', '');
  const activeEnd = optionalEnv('ACTIVE_END', '');

  const checkIntervalSeconds = parseInt(optionalEnv('CHECK_INTERVAL_SECONDS', '15'), 10);
  const scrapeConcurrency = Math.max(1, parseInt(optionalEnv('SCRAPE_CONCURRENCY', '10'), 10));
  const timezone = optionalEnv('TZ', 'Asia/Jakarta');
  const headless = optionalEnv('HEADLESS', 'true').toLowerCase() !== 'false';
  const logLevel = optionalEnv('LOG_LEVEL', 'info');
  const debugScreenshotOnError =
    optionalEnv('DEBUG_SCREENSHOT_ON_ERROR', 'true').toLowerCase() !== 'false';

  const witAiToken = process.env['WIT_AI_ACCESS_TOKEN'] || undefined;
  const checkoutWebhookUrl = process.env['CHECKOUT_WEBHOOK_URL'] || undefined;

  const fastPollIntervalMs = parseInt(optionalEnv('FAST_POLL_INTERVAL_MS', '1750'), 10);
  const fastPollLocationsRaw = optionalEnv('FAST_POLL_LOCATIONS', 'ABDH');
  const fastPollLocations = fastPollLocationsRaw
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const fastPollWeightsRaw = optionalEnv('FAST_POLL_WEIGHTS', '0.5,1,2,3,5');
  const fastPollWeights = fastPollWeightsRaw
    .split(',')
    .map((w) => parseFloat(w.trim().replace(',', '.')))
    .filter((w) => !isNaN(w) && w > 0);
  const fastPollTimeoutSeconds = parseInt(optionalEnv('FAST_POLL_TIMEOUT_SECONDS', '300'), 10);
  const webhookCooldownSeconds = parseInt(optionalEnv('WEBHOOK_COOLDOWN_SECONDS', '15'), 10);

  const dataDir = 'data';

  return {
    lmEmail,
    lmPassword,
    lmTargetLocations,
    lmTargetWeights,
    telegramBotToken,
    telegramChatId,
    telegramUseTopics,
    notifyDecrease,
    statusPort,
    activeStart,
    activeEnd,
    checkIntervalSeconds,
    scrapeConcurrency,
    timezone,
    headless,
    logLevel,
    debugScreenshotOnError,
    witAiToken,
    checkoutWebhookUrl,
    fastPollIntervalMs,
    fastPollLocations,
    fastPollWeights,
    fastPollTimeoutSeconds,
    webhookCooldownSeconds,
    dataDir,
    sessionFile: `${dataDir}/session.json`,
    snapshotFile: `${dataDir}/last-stock.json`,
    topicsFile: `${dataDir}/topics.json`,
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
