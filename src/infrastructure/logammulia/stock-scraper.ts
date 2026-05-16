import fs from 'fs/promises';
import path from 'path';
import { Page } from 'playwright';
import { LocationStock, StockItem } from '../../app/types/stock';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { withRetry, sleep } from '../../app/utils/retry';
import { ensureDir } from '../../app/utils/file';
import { formatIsoWithJakarta } from '../../app/utils/time';
import { SELECTORS } from './selectors';
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
 * Scrapes stock data for all (or configured) butik locations.
 *
 * - If LM_TARGET_LOCATIONS is empty → scrapes every location found in the dropdown.
 * - If LM_TARGET_LOCATIONS is set   → filters by value code (e.g. "ABDH") or
 *                                     substring of the full label (case-insensitive).
 *
 * Errors for individual locations are caught — the run continues for the rest.
 */
export async function scrapeAllLocations(
  page: Page,
  config: AppConfig,
): Promise<LocationStock[]> {
  // Step 1: Navigate to the purchase/stock page
  await page.goto(STOCK_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  // Step 2: Auto-confirm the "Konfirmasi Tujuan Transaksi" popup if it appears on first visit
  await handleTransactionPurposePopup(page);

  // Step 3: Open the change-location popup (AJAX-loaded) to discover all butik + get CSRF token
  await openLocationPopup(page);
  const available = await readSelectOptions(page);
  const csrfToken = await getCsrfToken(page);
  await closePopup(page);

  if (available.length === 0) {
    logger.error(
      '[Scraper] No locations found in dropdown — stock.locationSelect selector may need updating.',
    );
    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, 'no-locations');
    }
    return [];
  }
  logger.info(`[Scraper] ${available.length} location(s) found in dropdown`);

  // Step 4: Filter by target locations if configured (empty = scrape all)
  let targets = available;
  if (config.lmTargetLocations.length > 0) {
    targets = available.filter((loc) =>
      config.lmTargetLocations.some(
        (t) =>
          loc.value.toLowerCase() === t.toLowerCase() ||
          loc.label.toLowerCase().includes(t.toLowerCase()),
      ),
    );
    if (targets.length === 0) {
      logger.warn(
        '[Scraper] None of LM_TARGET_LOCATIONS matched available options — scraping all.',
      );
      targets = available;
    } else {
      logger.info(`[Scraper] Filtered to ${targets.length} target location(s)`);
    }
  }

  if (!csrfToken) {
    logger.warn('[Scraper] CSRF token not found — location change via POST may fail.');
  }

  const results: LocationStock[] = [];

  // Step 5: Scrape each target location
  for (const loc of targets) {
    logger.info(`[Scraper] ── Scraping: ${loc.label} (${loc.value})`);
    try {
      const locationStock = await withRetry(
        () => scrapeLocation(page, loc, csrfToken, config),
        { maxAttempts: 2, delayMs: 3_000 },
        `scrape "${loc.label}"`,
      );
      results.push(locationStock);
      logger.info(`[Scraper] "${loc.label}" → ${locationStock.items.length} item(s)`);
    } catch (err) {
      logger.error(`[Scraper] Failed to scrape "${loc.label}":`, err);
      if (config.debugScreenshotOnError) {
        await saveDebugSnapshot(page, config, `scrape-error-${slugify(loc.value)}`);
      }
      results.push({ location: loc.label, items: [], scrapedAt: formatIsoWithJakarta() });
    }
  }

  return results;
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
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
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
    if ((await trigger.count()) > 0) {
      await trigger.first().click();
      // Wait until the select is attached to the DOM (popup may load async)
      await page.waitForSelector(SELECTORS.stock.locationSelect, {
        state: 'attached',
        timeout: 5_000,
      });
      await sleep(500);
    }
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
        await page.goto(STOCK_URL, { waitUntil: 'networkidle', timeout: 30_000 });
        return;
      }
    } catch (err) {
      logger.debug('[Scraper] Direct POST failed, falling back to UI:', err);
    }
  }

  // Strategy 2: UI — navigate fresh, open popup, select, submit
  logger.debug(`[Scraper] Changing to "${locationValue}" via UI`);
  await page.goto(STOCK_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await openLocationPopup(page);
  const select = page.locator(SELECTORS.stock.locationSelect);
  if ((await select.count()) > 0) {
    await select.first().selectOption({ value: locationValue });
    await sleep(300);
    await page.click(SELECTORS.stock.changeLocationSubmit);
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
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
      items.push(
        createStockItem(rawWeight, soldOut ? 0 : qty, soldOut ? 'belum tersedia' : undefined),
      );
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

