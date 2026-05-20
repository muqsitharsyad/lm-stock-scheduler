/**
 * HTTP-based stock scraper — replaces Playwright browser automation.
 *
 * The /id/purchase/gold page is publicly accessible (no login required).
 * Stock data is server-rendered HTML: we use axios + tough-cookie for session
 * management and cheerio for HTML parsing.
 *
 * Speed: ~2-5s for ALL 21 locations (parallel) vs ~10-15s sequential.
 * Each location gets its own HTTP session to avoid cookie conflicts.
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { LocationStock, StockItem } from '../../app/types/stock';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { formatIsoWithJakarta } from '../../app/utils/time';
import { createStockItem } from './parsers';
import { readJson, writeJson } from '../../app/utils/file';

const BASE_URL = 'https://www.logammulia.com';
const STOCK_URL = `${BASE_URL}/id/purchase/gold`;
const LOCATIONS_URL = `${BASE_URL}/change-location`;
const CHANGE_LOCATION_URL = `${BASE_URL}/do-change-location`;

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'max-age=0',
  Referer: STOCK_URL,
  'sec-ch-ua': '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

/**
 * Override headers specifically for the /change-location AJAX endpoint.
 * This is a Fancybox AJAX popup — the server (Akamai WAF) expects AJAX headers,
 * not full-page navigation headers.
 */
const AJAX_HEADERS = {
  ...REQUEST_HEADERS,
  Accept: '*/*',
  'X-Requested-With': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

interface LocationOption {
  value: string;
  label: string;
}

/**
 * Creates a fresh axios instance with its own cookie jar.
 * The jar persists cookies across requests (acts like a browser session).
 */
function createClient() {
  const jar = new CookieJar();
  return wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 20_000,
      headers: REQUEST_HEADERS,
    }),
  );
}

/**
 * Persistent client for fast-polling a single location.
 * Loads cookies from session file (if available) to inherit Akamai _abck cookies,
 * reducing chance of WAF block during aggressive polling.
 */
let _fastClient: ReturnType<typeof createClient> | null = null;
let _fastClientLocation: string | null = null;

/**
 * Creates a client pre-loaded with cookies from session.json (if exists).
 * This gives the HTTP client Akamai sensor cookies from a real browser session.
 */
async function createClientWithSession(): Promise<ReturnType<typeof createClient>> {
  const client = createClient();
  try {
    const sessionPath = 'data/session.json';
    const raw = await import('fs/promises').then(fs => fs.readFile(sessionPath, 'utf-8'));
    const sessionData = JSON.parse(raw);
    const jar = (client.defaults as any).jar as CookieJar;
    for (const c of sessionData.cookies || []) {
      try {
        const cleanDomain = (c.domain || '').replace(/^\./, '');
        const cookieStr = `${c.name}=${c.value}; Domain=${cleanDomain}; Path=${c.path || '/'}`;
        jar.setCookieSync(cookieStr, `https://${cleanDomain}${c.path || '/'}`);
      } catch { /* skip */ }
    }
  } catch {
    // No session file or parse error — use fresh client
  }
  return client;
}

/**
 * Scrapes a single location at high frequency, reusing a cached session client.
 * Used by the adaptive fast-poll loop. Falls back to fresh session on errors.
 */
export async function scrapeSingleLocationFast(
  locationCode: string,
  locationLabel: string,
  targetWeights: number[],
): Promise<LocationStock> {
  // (Re)init persistent client if needed (location change or first call)
  if (!_fastClient || _fastClientLocation !== locationCode) {
    _fastClient = await createClientWithSession();
    _fastClientLocation = locationCode;
    try {
      const initResp = await _fastClient.get<string>(STOCK_URL);
      const $init = cheerio.load(initResp.data);
      const csrf = $init('meta[name="_token"]').attr('content') ?? null;
      if (csrf) {
        await _fastClient.post(
          CHANGE_LOCATION_URL,
          new URLSearchParams({ _token: csrf, location: locationCode }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        );
      }
    } catch (err) {
      logger.warn(`[FastPoll] Init failed for "${locationLabel}":`, err);
      _fastClient = null;
      _fastClientLocation = null;
      throw err;
    }
  }

  try {
    const stockResp = await _fastClient.get<string>(STOCK_URL);
    const items = parseStockHtml(stockResp.data, locationLabel, targetWeights);
    return {
      location: locationLabel,
      locationCode,
      items,
      scrapedAt: formatIsoWithJakarta(),
    };
  } catch (err) {
    // On error, invalidate client so next call rebuilds session
    _fastClient = null;
    _fastClientLocation = null;
    logger.warn(`[FastPoll] Scrape failed for "${locationLabel}":`, err);
    return {
      location: locationLabel,
      locationCode,
      items: [],
      scrapedAt: formatIsoWithJakarta(),
    };
  }
}

/**
 * Scrapes stock for all (or configured) butik locations using direct HTTP requests.
 *
 * Flow per run:
 *  1. GET /id/purchase/gold  → obtain session cookie + CSRF token
 *  2. GET /change-location   → parse all available butik options
 *  3. For each location:
 *       POST /do-change-location  → set active location in session
 *       GET  /id/purchase/gold    → get stock HTML for that location
 *       Parse .ctr rows           → extract weight + availability
 */
/**
 * Hardcoded fallback location list (exported for use by Playwright scraper too).
 * Used when /change-location returns 403 or the popup fails to load.
 * Update this list if Logam Mulia adds / removes butik locations.
 */
export const FALLBACK_LOCATIONS: LocationOption[] = [
  { value: 'ABDH',  label: 'BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta' },
  { value: 'AGDP',  label: 'BELM - Graha Dipta (Pengambilan Di Butik) Pulo Gadung, Jakarta' },
  { value: 'AJK2',  label: 'BELM - Gedung Antam (pengambilan Di Butik), Jakarta' },
  { value: 'AJK4',  label: 'BELM - Setiabudi One (pengambilan Di Butik), Jakarta' },
  { value: 'JKT05', label: 'BELM - Juanda, Jakarta' },
  { value: 'JKT06', label: 'BELM - Puri Indah, Jakarta' },
  { value: 'ABDG',  label: 'BELM - Bandung, Bandung' },
  { value: 'ASMG',  label: 'BELM - Semarang, Semarang' },
  { value: 'AJOG',  label: 'BELM - Yogyakarta, Yogyakarta' },
  { value: 'ASB1',  label: 'BELM - Surabaya Darmo, Surabaya' },
  { value: 'ASB2',  label: 'BELM - Surabaya Pakuwon, Surabaya' },
  { value: 'ADPS',  label: 'BELM - Denpasar Bali, Bali' },
  { value: 'ABPN',  label: 'BELM - Balikpapan, Balikpapan' },
  { value: 'AMKS',  label: 'BELM - Makassar, Makassar' },
  { value: 'AKNO',  label: 'BELM - Medan, Medan' },
  { value: 'APLG',  label: 'BELM - Palembang, Palembang' },
  { value: 'APKU',  label: 'BELM - Pekanbaru, Pekanbaru' },
  { value: 'ABSD',  label: 'BELM - Serpong (pengambilan Di Butik), Tangerang' },
  { value: 'BTR01', label: 'BELM - Bintaro, Tangerang Selatan' },
  { value: 'BGR01', label: 'BELM - Bogor, Bogor' },
  { value: 'BKS01', label: 'BELM - Bekasi, Bekasi' },
];

const LOCATIONS_CACHE_FILE = 'data/locations-cache.json';

/**
 * Load cached location list from disk (saved after last successful fetch).
 * Returns null if cache doesn't exist yet.
 */
async function loadCachedLocations(): Promise<LocationOption[] | null> {
  return readJson<LocationOption[]>(LOCATIONS_CACHE_FILE);
}

/**
 * Save freshly fetched location list to disk so it can be used as fallback.
 */
async function saveCachedLocations(locations: LocationOption[]): Promise<void> {
  try {
    await writeJson(LOCATIONS_CACHE_FILE, locations);
    logger.debug(`[HTTP] Location cache saved (${locations.length} entries) → ${LOCATIONS_CACHE_FILE}`);
  } catch (err) {
    logger.warn('[HTTP] Failed to save location cache:', err);
  }
}

export async function scrapeAllLocationsHttp(
  config: AppConfig,
  /** Called immediately when each location finishes — enables realtime per-butik notifications. */
  onResult?: (result: LocationStock) => void,
): Promise<LocationStock[]> {
  // Single shared client — reused for all requests so Akamai sees ONE session, not N fresh ones.
  const client = createClient();

  // ── Step 1: Initialise session + extract CSRF ─────────────────────────────
  logger.debug('[HTTP] Initialising session...');
  let csrfToken: string | null = null;
  try {
    const initResp = await client.get<string>(STOCK_URL);
    const $init = cheerio.load(initResp.data);
    csrfToken = $init('meta[name="_token"]').attr('content') ?? null;
    logger.debug(`[HTTP] Session ready, CSRF: ${csrfToken ? 'found' : 'not found'}`);
  } catch (err) {
    const httpStatus = (err as { response?: { status?: number } }).response?.status;
    const msg = httpStatus
      ? `HTTP ${httpStatus} dari ${STOCK_URL} — halaman utama diblok (Akamai WAF atau server down)`
      : `Network error saat akses ${STOCK_URL}: ${(err as Error).message}`;
    logger.error(`[HTTP] Failed to initialise session: ${msg}`);
    throw new Error(msg);
  }

  // ── Step 2: Get all available locations ───────────────────────────────────
  let available: LocationOption[] = [];
  try {
    const locResp = await client.get<string>(LOCATIONS_URL, { headers: AJAX_HEADERS });
    const $loc = cheerio.load(locResp.data);
    $loc('select#location option').each((_, el) => {
      const value = $loc(el).attr('value')?.trim() ?? '';
      const label = $loc(el).text().trim();
      if (value) available.push({ value, label });
    });
    if (available.length > 0) {
      logger.info(`[HTTP] ${available.length} location(s) found from server`);
      // Persist the fresh list — used as fallback on next 403
      void saveCachedLocations(available);
    } else {
      logger.warn('[HTTP] Location list empty from server — using fallback list');
      available = (await loadCachedLocations()) ?? FALLBACK_LOCATIONS;
    }
  } catch (err) {
    const httpStatus = (err as { response?: { status?: number } }).response?.status;
    const cached = await loadCachedLocations();
    if (cached && cached.length > 0) {
      if (httpStatus === 403) {
        logger.warn(
          `[HTTP] /change-location returned 403 (IP blocked by Akamai WAF) — using cached location list (${cached.length} locations, last saved to ${LOCATIONS_CACHE_FILE})`,
        );
      } else {
        logger.warn(
          `[HTTP] Failed to fetch location list (${httpStatus ?? 'network error'}) — using cached list (${cached.length} locations)`,
        );
      }
      available = cached;
    } else {
      if (httpStatus === 403) {
        logger.warn(
          `[HTTP] /change-location returned 403 — no cache found, using hardcoded fallback (${FALLBACK_LOCATIONS.length} locations). Run once without 403 to build a fresh cache.`,
        );
      } else {
        logger.warn(
          `[HTTP] Failed to fetch location list (${httpStatus ?? 'network error'}) — no cache, using hardcoded fallback`,
        );
      }
      available = FALLBACK_LOCATIONS;
    }
  }

  // ── Step 3: Filter by target locations if configured ─────────────────────
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
      logger.warn('[HTTP] None of LM_TARGET_LOCATIONS matched — scraping all');
      targets = available;
    } else {
      logger.info(`[HTTP] Filtered to ${targets.length} target location(s)`);
    }
  }

  // ── Step 4: Parallel scraping — each location gets its own session ────────
  // Parallel independent sessions avoid the sequential bottleneck.
  // Each location creates its own client+session to avoid cookie conflicts.
  const concurrency = config.scrapeConcurrency;
  logger.info(`[HTTP] Scraping ${targets.length} location(s) in parallel (concurrency=${concurrency})`);

  const results: LocationStock[] = [];

  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((loc) => scrapeLocationWithOwnSession(loc, config, onResult)),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Scrapes a single location using its own independent HTTP session.
 * This allows full parallelism without cookie/session conflicts.
 */
async function scrapeLocationWithOwnSession(
  loc: LocationOption,
  config: AppConfig,
  onResult?: (result: LocationStock) => void,
): Promise<LocationStock> {
  const client = createClient();
  try {
    // Step A: Init session + get CSRF
    const initResp = await client.get<string>(STOCK_URL);
    const $init = cheerio.load(initResp.data);
    const csrfToken = $init('meta[name="_token"]').attr('content') ?? null;

    // Step B: Switch location
    if (csrfToken) {
      await client.post(
        CHANGE_LOCATION_URL,
        new URLSearchParams({ _token: csrfToken, location: loc.value }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
    }

    // Step C: Fetch stock page for this location (no delay — speed is priority)
    const stockResp = await client.get<string>(STOCK_URL);
    const items = parseStockHtml(stockResp.data, loc.label, config.lmTargetWeights);
    logger.info(`[HTTP] "${loc.label}" → ${items.length} item(s)`);

    const result: LocationStock = {
      location: loc.label,
      locationCode: loc.value,
      items,
      scrapedAt: formatIsoWithJakarta(),
    };
    onResult?.(result);
    return result;
  } catch (err) {
    logger.error(`[HTTP] Failed to scrape "${loc.label}":`, err);
    const failed: LocationStock = {
      location: loc.label,
      locationCode: loc.value,
      items: [],
      scrapedAt: formatIsoWithJakarta(),
    };
    onResult?.(failed);
    return failed;
  }
}

/**
 * Parses stock HTML page and returns stock items, optionally filtered to target weights.
 *
 * DOM structure (confirmed from checkout.html):
 *   .cart-table .ct-body .ctr         — each product row
 *   .ctr.disabled                     — no stock (qty = 0)
 *   .ngc-text (first text node)       — "Emas Batangan - 5 gr"
 *   span.no-stock                     — "Belum tersedia" badge
 *
 * Note: The website does NOT expose actual stock count anywhere in the HTML or
 * via JavaScript. Only binary availability (has stock / no stock) is available.
 */
function parseStockHtml(
  html: string,
  locationLabel: string,
  targetWeights: number[],
): StockItem[] {
  const $ = cheerio.load(html);
  const items: StockItem[] = [];

  $('.cart-table .ct-body .ctr').each((_, row) => {
    const $row = $(row);
    const isDisabled = $row.hasClass('disabled');
    const hasSoldOut = $row.find('span.no-stock').length > 0;

    // Extract weight from first text node of .ngc-text ("Emas Batangan - 5 gr")
    const ngcText = $row.find('.ngc-text').first();
    const rawWeight = ngcText
      .contents()
      .filter((_, n) => n.type === 'text')
      .first()
      .text()
      .trim();

    if (!rawWeight) return;

    // Filter by target weights if configured
    if (targetWeights.length > 0 && !matchesTargetWeight(rawWeight, targetWeights)) return;

    const soldOut = isDisabled || hasSoldOut;
    items.push(
      createStockItem(rawWeight, soldOut ? 0 : 1, soldOut ? 'belum tersedia' : undefined),
    );
  });

  if (items.length === 0) {
    logger.warn(
      `[HTTP] No stock rows found for "${locationLabel}" — page structure may have changed or all gramasi filtered out`,
    );
  }

  return items;
}

/**
 * Returns true if the weight string (e.g. "5 gr" or "0,5 gr") matches any of the target values.
 * Handles both dot and comma as decimal separator.
 */
function matchesTargetWeight(weightStr: string, targets: number[]): boolean {
  const match = weightStr.match(/(\d+[,.]?\d*)/);
  if (!match) return false;
  const numeric = parseFloat(match[1].replace(',', '.'));
  return targets.some((t) => Math.abs(t - numeric) < 0.001);
}
