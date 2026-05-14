import { Browser, BrowserContext } from 'playwright';
// playwright-extra wraps playwright and adds plugin support (e.g. stealth)
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { loadSession } from './session-store';

// Apply stealth plugin once at module load.
// This patches browser fingerprints (user-agent, webdriver flags, plugins, etc.)
// so that reCAPTCHA is more likely to auto-pass without showing a challenge.
chromium.use(StealthPlugin());

export class PlaywrightClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async init(config: AppConfig): Promise<void> {
    logger.info('[Browser] Launching Chromium...');
    this.browser = await chromium.launch({
      headless: config.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    await this.createContext(config);
  }

  private async createContext(config: AppConfig): Promise<void> {
    if (!this.browser) throw new Error('[Browser] Browser not initialized');

    const storageState = await loadSession(config.sessionFile);
    if (storageState) {
      logger.info('[Browser] Restoring existing session into context...');
      this.context = await this.browser.newContext({ storageState });
    } else {
      logger.info('[Browser] Starting with a fresh browser context...');
      this.context = await this.browser.newContext();
    }
  }

  async getContext(): Promise<BrowserContext> {
    if (!this.context) throw new Error('[Browser] Context not initialized');
    return this.context;
  }

  async newPage() {
    if (!this.context) throw new Error('[Browser] Context not initialized');
    return this.context.newPage();
  }

  /** Tear down and recreate the context (e.g. after re-login) */
  async refreshContext(config: AppConfig): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    await this.createContext(config);
    logger.info('[Browser] Context refreshed');
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    logger.info('[Browser] Browser closed');
  }
}
