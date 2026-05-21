import fs from 'fs/promises';
import path from 'path';
import { Browser, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { LocationStock, StockItem } from '../../app/types/stock';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { withRetry, sleep } from '../../app/utils/retry';
import { ensureDir } from '../../app/utils/file';
import { formatIsoWithJakarta } from '../../app/utils/time';
import { SELECTORS } from './selectors';

import { FALLBACK_LOCATIONS } from './http-stock-client';

// ---------------------------------------------------------------------------
// Persistent browser singleton — reused across check intervals to eliminate
// the 2-3s startup overhead and keep Akamai session cookies alive.
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;

async function getOrCreateBrowser(config: AppConfig): Promise<Browser> {
  if (_browser && _browser.isConnected()) {
    return _browser;
  }
  logger.info('[Browser] Launching Chromium (stealth)...');
  _browser = await chromium.launch({
    headless: config.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  // Auto-clear reference when browser disconnects unexpectedly
  _browser.on('disconnected', () => {
    logger.warn('[Browser] Browser disconnected unexpectedly — will relaunch on next check');
    _browser = null;
  });
  return _browser;
}

/** Call this on app shutdown to cleanly close the browser. */
export async function closePersistentBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => undefined);
    _browser = null;
    logger.info('[Browser] Persistent browser closed');
  }
}
import { createStockItem } from './parsers';
import { STOCK_URL } from './auth-client';

const CHANGE_LOCATION_URL = 'https://www.logammulia.com/do-change-location';

/** A butik option from the change-location dropdown. */
export interface LocationOption {
  /** Short code used in form submission, e.g. "ABDH" */
  value: string;
  /** Full display label, e.g. "BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta" */
  label: string;
}

/**
 * Creates a new browser context with standard desktop headers.
 * Stealth is already applied at the browser level via chromium.use(StealthPlugin()).
 */
function newContext(browser: Browser) {
  return browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'id-ID',
  });
}

/**
 * Runs a full stock scrape using a persistent Playwright browser.
 *
 * Parallel strategy:
 *  1. One context discovers the available location list (from popup or fallback).
 *  2. Each target location is scraped in its OWN context, in parallel batches.
 *     Separate contexts = separate cookie jars = independent session-based
 *     location changes without race conditions.
 *
 * With SCRAPE_CONCURRENCY=5 and 21 locations this completes in ~40-50s
 * instead of the sequential ~150s.
 */
export async function scrapeAllLocationsPlaywright(
  config: AppConfig,
  onResult?: (result: LocationStock) => void,
): Promise<LocationStock[]> {
  const browser = await getOrCreateBrowser(config);

  // ── Step 1: Discover available locations ────────────────────────────────
  const available = await getAvailableLocations(browser, config);

  // ── Step 2: Filter by target locations if configured ────────────────────
  let targets = available;
  if (config.lmTargetLocations.length > 0) {
    const filtered = available.filter((loc) =>
      config.lmTargetLocations.some(
        (t) =>
          loc.value.toLowerCase() === t.toLowerCase() ||
          loc.label.toLowerCase().includes(t.toLowerCase()),
      ),
    );
    if (filtered.length > 0) {
      targets = filtered;
      logger.info(`[Scraper] Filtered to ${targets.length} target location(s)`);
    } else {
      logger.warn('[Scraper] None of LM_TARGET_LOCATIONS matched — scraping all.');
    }
  }

  logger.info(
    `[Scraper] Scraping ${targets.length} location(s) in parallel (concurrency=${config.scrapeConcurrency})`,
  );

  // ── Step 3: Parallel scrape with concurrency-limited batching ───────────
  const { scrapeConcurrency } = config;
  const results: LocationStock[] = [];

  for (let i = 0; i < targets.length; i += scrapeConcurrency) {
    const batch = targets.slice(i, i + scrapeConcurrency);
    const batchResults = await Promise.all(
      batch.map((loc) => scrapeLocationParallel(browser, loc, config, onResult)),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Discovers available butik locations by visiting the stock page once.
 * Falls back to the hardcoded FALLBACK_LOCATIONS list if the popup fails.
 */
async function getAvailableLocations(
  browser: Browser,
  config: AppConfig,
): Promise<LocationOption[]> {
  const context = await newContext(browser);
  const page = await context.newPage();
  try {
    await page.goto(STOCK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1_500);
    await handleTransactionPurposePopup(page);
    await openLocationPopup(page);
    const available = await readSelectOptions(page);
    await closePopup(page);
    if (available.length > 0) {
      logger.info(`[Scraper] ${available.length} location(s) found in dropdown`);
      return available;
    }
  } catch (err) {
    logger.warn('[Scraper] Error reading location list — will use fallback:', err);
  } finally {
    await context.close().catch(() => undefined);
  }
  logger.warn('[Scraper] Using hardcoded fallback location list');
  return [...FALLBACK_LOCATIONS];
}

/**
 * Scrapes a single location in its own browser context.
 * Safe to call in parallel — each context has an isolated cookie jar,
 * so the session-based location change does not interfere with other contexts.
 */
/**
 * Persistent page for fast-polling a single location.
 * Created once per location; subsequent polls reload the existing page,
 * which is faster than fresh navigation and re-uses the Akamai-warmed session.
 */
let _fastPollPage: Page | null = null;
let _fastPollLocation: string | null = null;
let _fastPollContext: import('playwright').BrowserContext | null = null;

/**
 * Scrapes a single location via Playwright (browser-based).
 * Uses a persistent page that is reloaded on each call — much faster than
 * `scrapeLocationParallel` (which creates a fresh context every time).
 * Akamai trusts browser fingerprints, so this avoids 403s that plague HTTP fast poll.
 */
export async function scrapeSingleLocationPlaywrightFast(
  config: AppConfig,
  locationCode: string,
  locationLabel: string,
  targetWeights: number[],
): Promise<LocationStock> {
  const browser = await getOrCreateBrowser(config);

  // (Re)init persistent page when first called or location changed
  if (!_fastPollPage || _fastPollPage.isClosed() || _fastPollLocation !== locationCode) {
    if (_fastPollContext) {
      await _fastPollContext.close().catch(() => undefined);
    }
    _fastPollContext = await newContext(browser);
    _fastPollPage = await _fastPollContext.newPage();
    _fastPollLocation = locationCode;

    // Initial navigate + set location
    await _fastPollPage.goto(STOCK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1_000);
    await handleTransactionPurposePopup(_fastPollPage).catch(() => undefined);
    const csrfToken = await getCsrfToken(_fastPollPage);
    await changeLocation(_fastPollPage, locationCode, csrfToken);
    await sleep(800);
  } else {
    // Just reload the stock page (faster than full nav, keeps cookies warm)
    await _fastPollPage.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    await sleep(300);
  }

  const items = await extractStockItems(_fastPollPage, config);
  // Filter by target weights
  const filtered = targetWeights.length > 0
    ? items.filter((i) => {
        const m = i.weight.match(/(\d+[,.]?\d*)/);
        if (!m) return false;
        const w = parseFloat(m[1].replace(',', '.'));
        return targetWeights.some((t) => Math.abs(t - w) < 0.001);
      })
    : items;

  return {
    location: locationLabel,
    locationCode,
    items: filtered,
    scrapedAt: formatIsoWithJakarta(),
  };
}

async function scrapeLocationParallel(
  browser: Browser,
  loc: LocationOption,
  config: AppConfig,
  onResult?: (result: LocationStock) => void,
): Promise<LocationStock> {
  const context = await newContext(browser);
  const page = await context.newPage();
  try {
    logger.info(`[Scraper] ── Scraping: ${loc.label} (${loc.value})`);
    const result = await withRetry(
      async () => {
        // Navigate to get the per-session CSRF token (each context has its own token)
        await page.goto(STOCK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(500);
        const csrfToken = await page.evaluate(() => {
          const el = document.querySelector('meta[name="_token"]') as HTMLMetaElement | null;
          return el ? el.content : null;
        });
        return scrapeLocation(page, loc, csrfToken, config);
      },
      { maxAttempts: 2, delayMs: 3_000 },
      `scrape "${loc.label}"`,
    );
    logger.info(`[Scraper] "${loc.label}" → ${result.items.length} item(s)`);
    onResult?.(result);
    return result;
  } catch (err) {
    logger.error(`[Scraper] Failed to scrape "${loc.label}":`, err);
    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, `scrape-error-${slugify(loc.value)}`);
    }
    const empty: LocationStock = { location: loc.label, items: [], scrapedAt: formatIsoWithJakarta() };
    onResult?.(empty);
    return empty;
  } finally {
    await context.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Popup handling
// ---------------------------------------------------------------------------

/**
 * Auto-confirms the "Konfirmasi Tujuan Transaksi" popup if it appears.
 *
 * This popup is AJAX-loaded by the page's JavaScript when the session does not yet have
 * a confirmed transaction purpose (tujuanTransaksi). We pre-select "Investasi" (the
 * server-default) and submit so the popup is dismissed and won't reappear this session.
 */
async function handleTransactionPurposePopup(page: Page): Promise<void> {
  try {
    const popup = await page
      .waitForSelector(SELECTORS.stock.transactionPurposePopup, {
        state: 'attached',
        timeout: 3_000,
      })
      .catch(() => null);

    if (!popup) return; // Not triggered — tujuanTransaksi already confirmed in session

    logger.info('[Scraper] Transaction purpose popup detected — auto-confirming "Investasi"...');

    // "Investasi" is pre-selected server-side; confirm explicitly for safety
    const select = page.locator(SELECTORS.stock.transactionPurposeSelect);
    if ((await select.count()) > 0) {
      await select.first().selectOption({ value: 'Investasi' });
    }
    await sleep(200);
    await page.click(SELECTORS.stock.transactionPurposeSubmit);
    await page.waitForSelector(SELECTORS.stock.stockContainer, { timeout: 10_000 }).catch(() => null);
    await sleep(500);
    logger.info('[Scraper] Transaction purpose confirmed.');
  } catch (err) {
    logger.warn('[Scraper] Error handling transaction purpose popup (ignoring):', err);
  }
}

/** Dismisses the currently open Fancybox popup via close button or Escape key. */
async function closePopup(page: Page): Promise<void> {
  try {
    const closeBtn = page.locator(SELECTORS.stock.fancyboxClose);
    if ((await closeBtn.count()) > 0) {
      await closeBtn.first().click();
    } else {
      await page.keyboard.press('Escape');
    }
    await sleep(200);
  } catch {
    // Suppress — popup may already be closed
  }
}

// ---------------------------------------------------------------------------
// Location discovery
// ---------------------------------------------------------------------------

async function readSelectOptions(page: Page): Promise<LocationOption[]> {
  try {
    const result = await page.evaluate(() => {
      const sel = document.querySelector('select#location') as HTMLSelectElement | null;
      if (!sel) return null;
      return Array.from(sel.options)
        .filter((o) => o.value !== '')
        .map((o) => ({ value: o.value, label: o.text.trim() }));
    });
    return result ?? [];
  } catch {
    return [];
  }
}

async function openLocationPopup(page: Page): Promise<void> {
  try {
    const trigger = page.locator(SELECTORS.stock.locationPopupTrigger);
    if ((await trigger.count()) === 0) return;

    // Use JS dispatch to bypass any overlay that blocks Playwright's actionability click
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) el.click();
    }, SELECTORS.stock.locationPopupTrigger.split(',')[0].trim());

    // Wait until the select is attached to the DOM (popup loads async via AJAX)
    await page.waitForSelector(SELECTORS.stock.locationSelect, {
      state: 'attached',
      timeout: 8_000,
    });
    await sleep(500);
  } catch (err) {
    logger.warn('[Scraper] Could not open location popup:', err);
  }
}

async function getCsrfToken(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector(
        '#change-location input[name="_token"]',
      ) as HTMLInputElement | null;
      return el ? el.value : null;
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-location scraping
// ---------------------------------------------------------------------------

async function scrapeLocation(
  page: Page,
  location: LocationOption,
  csrfToken: string | null,
  config: AppConfig,
): Promise<LocationStock> {
  await changeLocation(page, location.value, csrfToken);
  await waitForStockLoad(page);
  const items = await extractStockItems(page, config);
  return {
    location: location.label,
    items,
    scrapedAt: formatIsoWithJakarta(),
  };
}

/**
 * Changes the active butik location.
 *
 * Strategy 1 — direct fetch POST to /do-change-location using the browser's
 *              session cookies. Fast and no UI interaction needed.
 * Strategy 2 — open the popup, select the option, submit the form via UI.
 *              Used as fallback if Strategy 1 fails (e.g. token mismatch).
 */
async function changeLocation(
  page: Page,
  locationValue: string,
  csrfToken: string | null,
): Promise<void> {
  // Strategy 1: POST directly with browser session credentials
  if (csrfToken) {
    try {
      const ok = await page.evaluate(
        async ([locVal, token, url]) => {
          const fd = new FormData();
          fd.append('_token', token);
          fd.append('location', locVal);
          const resp = await fetch(url, {
            method: 'POST',
            body: fd,
            credentials: 'include',
          });
          return resp.ok || resp.status < 400;
        },
        [locationValue, csrfToken, CHANGE_LOCATION_URL] as [string, string, string],
      );
      if (ok) {
        logger.debug(`[Scraper] Location changed to "${locationValue}" via POST`);
        await page.goto(STOCK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(1_000);
        return;
      }
    } catch (err) {
      logger.debug('[Scraper] Direct POST failed, falling back to UI:', err);
    }
  }

  // Strategy 2: UI — navigate fresh, open popup, select, submit
  logger.debug(`[Scraper] Changing to "${locationValue}" via UI`);
  await page.goto(STOCK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await sleep(1_000);
  await openLocationPopup(page);
  const select = page.locator(SELECTORS.stock.locationSelect);
  if ((await select.count()) > 0) {
    await select.first().selectOption({ value: locationValue });
    await sleep(300);
    await page.click(SELECTORS.stock.changeLocationSubmit);
    await page.waitForSelector(SELECTORS.stock.pageLoadIndicator, { timeout: 15_000 }).catch(() => null);
    await sleep(1_000);
  } else {
    logger.warn(`[Scraper] Could not change to "${locationValue}" — scraping current view`);
  }
}

/**
 * Waits for the stock container to appear after a location change.
 * Falls back to a timed delay if the selector isn't found.
 */
async function waitForStockLoad(page: Page): Promise<void> {
  try {
    await page.waitForSelector(SELECTORS.stock.pageLoadIndicator, { timeout: 15_000 });
  } catch {
    logger.warn('[Scraper] Page load indicator not found, using fallback delay');
    await page.waitForLoadState('domcontentloaded');
    await sleep(2_000);
  }

  // After the table is visible, give JS up to 4s to populate `max` attributes on qty inputs.
  // The website's JS may set max="N" (actual stock count) via AJAX after the initial render.
  // If it never sets them, we fall back to binary detection (disabled=0 / not-disabled=1).
  const maxPopulated = await page
    .waitForFunction(() => document.querySelectorAll('input.qty[max]').length > 0, {
      timeout: 4_000,
    })
    .then(() => true)
    .catch(() => false);

  if (maxPopulated) {
    logger.debug('[Scraper] Qty max attributes populated by JS — will use actual stock counts');
  } else {
    logger.debug('[Scraper] Qty max attributes not set — using binary available/unavailable detection');
  }
}

/**
 * Extracts all stock items from the current page view using a single page.evaluate call
 * for efficiency (one round-trip to the browser instead of per-element calls).
 *
 * Confirmed DOM structure (from checkout.html):
 *   .cart-table .ct-body       — wrapper containing all product rows
 *   .ctr                       — each product row
 *   .ctr.disabled              — row has no stock (qty = 0)
 *   .ngc-text (text node)      — "Emas Batangan - 5 gr" (first text node of .ngc-text)
 *   span.no-stock              — "Belum tersedia" badge inside .ngc-text
 *   input.qty[type="number"]   — `max` attribute set by JS when stock is available
 */
async function extractStockItems(page: Page, config: AppConfig): Promise<StockItem[]> {
  const items: StockItem[] = [];

  try {
    const rawItems = await page.evaluate(() => {
      const rows = document.querySelectorAll('.cart-table .ct-body .ctr');
      if (rows.length === 0) return null;

      return Array.from(rows).map((row) => {
        const ngcText = row.querySelector('.ngc-text');
        const qtyInput = row.querySelector('input.qty') as HTMLInputElement | null;
        const noStockEl = row.querySelector('span.no-stock');
        const isDisabled = row.classList.contains('disabled');

        // Extract weight from the first text node of .ngc-text, e.g. "Emas Batangan - 5 gr"
        const rawWeight = ngcText
          ? Array.from(ngcText.childNodes)
              .filter((n) => n.nodeType === 3) // Node.TEXT_NODE
              .map((n) => n.textContent?.trim() ?? '')
              .filter(Boolean)
              .join(' ')
              .trim()
          : '';

        // `max` attribute may be set by page JS to indicate how many units are available
        const maxAttr = qtyInput?.getAttribute('max') ?? '';
        const qty = isDisabled ? 0 : maxAttr ? parseInt(maxAttr, 10) : 1;

        return { rawWeight, qty, isDisabled, hasSoldOut: !!noStockEl };
      });
    });

    if (rawItems === null) {
      logger.warn(
        '[Scraper] .cart-table .ct-body .ctr rows not found — selectors may need updating.',
      );
      if (config.debugScreenshotOnError) {
        await saveDebugSnapshot(page, config, 'no-rows');
      }
      return items;
    }

    logger.debug(`[Scraper] Found ${rawItems.length} product row(s)`);

    for (const { rawWeight, qty, isDisabled, hasSoldOut } of rawItems) {
      if (!rawWeight.trim()) continue;
      const soldOut = isDisabled || hasSoldOut;
      const item = createStockItem(rawWeight, soldOut ? 0 : qty, soldOut ? 'belum tersedia' : undefined);

      // Apply gramasi filter — skip items not in LM_TARGET_WEIGHTS (empty = allow all)
      if (config.lmTargetWeights.length > 0) {
        const match = item.weight.match(/(\d+[,.]?\d*)/);
        if (match) {
          const numeric = parseFloat(match[1].replace(',', '.'));
          if (!config.lmTargetWeights.some((t) => Math.abs(t - numeric) < 0.001)) continue;
        } else {
          continue; // unparseable weight — skip if filter active
        }
      }

      items.push(item);
    }

    if (items.length === 0) {
      logger.warn('[Scraper] No items extracted after parsing. Page structure may have changed.');
    }
  } catch (err) {
    logger.error('[Scraper] Error during item extraction:', err);
    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, 'extract-error');
    }
  }

  return items;
}

async function saveDebugSnapshot(page: Page, config: AppConfig, prefix: string): Promise<void> {
  try {
    await ensureDir(config.debugDir);
    const ts = Date.now();
    const screenshotPath = path.join(config.debugDir, `${prefix}-${ts}.png`);
    const htmlPath = path.join(config.debugDir, `${prefix}-${ts}.html`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.writeFile(htmlPath, await page.content(), 'utf-8');
    logger.info(`[Debug] Screenshot → ${screenshotPath}`);
    logger.info(`[Debug] HTML dump  → ${htmlPath}`);
  } catch (e) {
    logger.warn('[Debug] Failed to save debug snapshot:', e);
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

