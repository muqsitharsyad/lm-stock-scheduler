import fs from 'fs/promises';
import path from 'path';
import { Page, BrowserContext } from 'playwright';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { withRetry } from '../../app/utils/retry';
import { ensureDir } from '../../app/utils/file';
import { saveSession, deleteSession } from '../browser/session-store';
import { SELECTORS } from './selectors';
import { solveRecaptchaIfPresent } from './captcha-solver';

const LOGIN_URL = 'https://www.logammulia.com/id/login';
export const STOCK_URL = 'https://www.logammulia.com/id/purchase/gold';

/**
 * Checks whether the current page state reflects a logged-in user.
 * Heuristic: if the current URL contains '/login', the user is not logged in.
 * Secondary check: look for a known logged-in DOM indicator.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();

  // Definitive check: if we're on the login page, session is gone
  if (url.includes(SELECTORS.stock.loginRedirectUrl)) {
    return false;
  }

  // Secondary check: login form present on page → still on login page somehow
  try {
    const loginForm = await page.$(SELECTORS.login.loginForm);
    if (loginForm) return false;
  } catch { /* ignore */ }

  // Tertiary check: look for a known logged-in indicator element
  try {
    const indicator = await page.$(SELECTORS.login.loggedInIndicator);
    return indicator !== null;
  } catch {
    return !url.includes('/login');
  }
}

/**
 * Performs a full login using credentials from config.
 * Throws if login fails after filling the form.
 */
export async function login(page: Page, config: AppConfig): Promise<void> {
  logger.info('[Auth] Navigating to login page...');
  await withRetry(
    () => page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30_000 }),
    { maxAttempts: 3, delayMs: 2_000 },
    'navigate to login page',
  );

  if (!config.lmEmail || !config.lmPassword) {
    throw new Error('[Auth] LM_EMAIL and LM_PASSWORD are required for login but are not set');
  }

  logger.info('[Auth] Filling login credentials...');
  try {
    await page.waitForSelector(SELECTORS.login.emailInput, { timeout: 15_000 });
    await page.fill(SELECTORS.login.emailInput, config.lmEmail);
    await page.fill(SELECTORS.login.passwordInput, config.lmPassword);

    // Solve reCAPTCHA before submitting (stealth auto-pass → audio → manual fallback)
    await solveRecaptchaIfPresent(page, config.witAiToken, config.headless);

    await page.click(SELECTORS.login.submitButton);

    // Wait for the page to navigate away from the login page
    await page.waitForLoadState('networkidle', { timeout: 60_000 });

    if (page.url().includes('/login')) {
      throw new Error('[Auth] Login appears to have failed — still on the login page after submit');
    }

    logger.info('[Auth] Login successful');
  } catch (err) {
    logger.error('[Auth] Login failed:', err);
    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, 'login-error');
    }
    throw err;
  }
}

/**
 * Ensures the browser session is authenticated.
 * If the stock page redirects to login, this function re-authenticates,
 * saves the new session, and navigates back to the stock page.
 */
export async function ensureLoggedIn(
  page: Page,
  context: BrowserContext,
  config: AppConfig,
): Promise<void> {
  logger.info('[Auth] Checking session validity...');

  await withRetry(
    () => page.goto(STOCK_URL, { waitUntil: 'networkidle', timeout: 30_000 }),
    { maxAttempts: 3, delayMs: 2_000 },
    'navigate to stock page',
  );

  if (await isLoggedIn(page)) {
    logger.info('[Auth] Session is valid ✓');
    return;
  }

  logger.warn('[Auth] Session invalid or expired — performing re-login...');
  await deleteSession(config.sessionFile);

  await login(page, config);

  // Persist the fresh session so the next scheduler run re-uses it
  await saveSession(context, config.sessionFile);

  // Return to the stock page ready for scraping
  await page.goto(STOCK_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  logger.info('[Auth] Re-authentication complete, back on stock page');
}

// ---------------------------------------------------------------------------
// Internal debug helpers
// ---------------------------------------------------------------------------

async function saveDebugSnapshot(page: Page, config: AppConfig, prefix: string): Promise<void> {
  try {
    await ensureDir(config.debugDir);
    const ts = Date.now();
    const screenshotPath = path.join(config.debugDir, `${prefix}-${ts}.png`);
    const htmlPath = path.join(config.debugDir, `${prefix}-${ts}.html`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    await fs.writeFile(htmlPath, html, 'utf-8');
    logger.info(`[Debug] Screenshot → ${screenshotPath}`);
    logger.info(`[Debug] HTML dump → ${htmlPath}`);
  } catch (e) {
    logger.warn('[Debug] Failed to save debug snapshot:', e);
  }
}
