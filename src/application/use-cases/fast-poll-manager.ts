import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';
import { LocationStock } from '../../app/types/stock';
import { scrapeSingleLocationFast } from '../../infrastructure/logammulia/http-stock-client';

/**
 * Adaptive fast-poll manager.
 *
 * Behavior:
 *  - When stock for a priority location appears, switch to fast polling (1.5-2s + jitter)
 *  - When stock disappears, or after a quiet timeout, return to normal mode
 *  - Webhook is fired with cooldown per (location|weight) to avoid spam
 */

interface FastPollState {
  startedAt: number;
  lastSeenStockAt: number;
  abortController: AbortController;
}

interface WebhookKey {
  lastWebhookAt: number;
  lastQty: number;
}

const fastPollActive = new Map<string, FastPollState>();
const webhookState = new Map<string, WebhookKey>();

/** True if any location is currently fast-polling. */
export function isAnyFastPollActive(): boolean {
  return fastPollActive.size > 0;
}

export function isFastPollActive(locationCode: string): boolean {
  return fastPollActive.has(locationCode);
}

/**
 * Should we trigger a webhook for this (location, weight) right now?
 * Implements rules: 0→>0 (yes), still >0 + cooldown elapsed (yes), else no.
 */
export function shouldFireWebhook(
  locationCode: string,
  weight: string,
  newQty: number,
  cooldownSeconds: number,
): boolean {
  const key = `${locationCode}|${weight}`;
  const now = Date.now();
  const state = webhookState.get(key);

  // Reset state when stock goes to 0 (so next non-zero will fire)
  if (newQty === 0) {
    if (state) {
      webhookState.set(key, { lastWebhookAt: 0, lastQty: 0 });
    }
    return false;
  }

  if (!state || state.lastQty === 0) {
    // Stock newly appeared
    webhookState.set(key, { lastWebhookAt: now, lastQty: newQty });
    return true;
  }

  // Stock still present — fire only if cooldown has elapsed
  const cooldownMs = cooldownSeconds * 1000;
  if (now - state.lastWebhookAt >= cooldownMs) {
    webhookState.set(key, { lastWebhookAt: now, lastQty: newQty });
    return true;
  }

  // Update tracked qty but don't fire
  webhookState.set(key, { ...state, lastQty: newQty });
  return false;
}

/**
 * Starts a fast-poll loop for `locationCode`. The loop:
 *  - polls every (intervalMs ± 300ms jitter)
 *  - filters items by `targetWeights` (gramasi kecil only)
 *  - calls `onResult` with each scraped result
 *  - stops when no target-weight stock seen for `timeoutSeconds`
 *  - stops when `stop()` is called externally
 */
export function startFastPoll(
  config: AppConfig,
  locationCode: string,
  locationLabel: string,
  onResult: (result: LocationStock) => void,
): void {
  if (fastPollActive.has(locationCode)) {
    logger.debug(`[FastPoll] Already active for "${locationLabel}"`);
    return;
  }

  const abortController = new AbortController();
  const state: FastPollState = {
    startedAt: Date.now(),
    lastSeenStockAt: Date.now(),
    abortController,
  };
  fastPollActive.set(locationCode, state);

  logger.info(`[FastPoll] ▶ Starting fast poll for "${locationLabel}" @ ${config.fastPollIntervalMs}ms (target weights: ${config.fastPollWeights.join(',')})`);

  void (async () => {
    while (!abortController.signal.aborted) {
      const start = Date.now();

      try {
        const result = await scrapeSingleLocationFast(
          locationCode,
          locationLabel,
          config.fastPollWeights,
        );

        const hasTargetStock = result.items.some(
          (i) => i.qty > 0 && config.fastPollWeights.some((w) => Math.abs(w - parseWeight(i.weight)) < 0.001),
        );

        if (hasTargetStock) {
          state.lastSeenStockAt = Date.now();
        }

        onResult(result);

        // Stop conditions
        const idleMs = Date.now() - state.lastSeenStockAt;
        if (idleMs > config.fastPollTimeoutSeconds * 1000) {
          logger.info(`[FastPoll] ◀ Timeout (${config.fastPollTimeoutSeconds}s no stock) — stopping fast poll for "${locationLabel}"`);
          break;
        }
      } catch (err) {
        logger.warn(`[FastPoll] Iteration error for "${locationLabel}":`, err);
      }

      // Jitter: ±300ms
      const jitter = (Math.random() * 600) - 300;
      const waitMs = Math.max(500, config.fastPollIntervalMs + jitter - (Date.now() - start));
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }

    fastPollActive.delete(locationCode);
    logger.info(`[FastPoll] ⏹ Fast poll stopped for "${locationLabel}"`);
  })();
}

export function stopFastPoll(locationCode: string): void {
  const state = fastPollActive.get(locationCode);
  if (state) {
    state.abortController.abort();
  }
}

export function stopAllFastPolls(): void {
  for (const state of fastPollActive.values()) {
    state.abortController.abort();
  }
}

function parseWeight(raw: string): number {
  const m = raw.match(/(\d+[,.]?\d*)/);
  return m ? parseFloat(m[1].replace(',', '.')) : 0;
}
