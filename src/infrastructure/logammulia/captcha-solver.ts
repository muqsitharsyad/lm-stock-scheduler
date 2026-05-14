import { Page } from 'playwright';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

// ---------------------------------------------------------------------------
// reCAPTCHA v2 solver — three-tier strategy (all free)
//
//  Tier 1 — Stealth plugin (configured in playwright-client.ts):
//    Makes the browser fingerprint appear human. reCAPTCHA often auto-checks
//    the box without showing any image/audio challenge.
//
//  Tier 2 — Audio challenge + Wit.ai (free Meta speech API):
//    If a challenge appears, click the audio button, download the MP3,
//    transcribe via Wit.ai, and submit the answer programmatically.
//    Requires a free account at https://wit.ai — no credit card needed.
//
//  Tier 3 — Manual fallback (HEADLESS=false):
//    If WIT_AI_ACCESS_TOKEN is not set and a challenge appears, the app
//    waits (up to 2 minutes) for the user to solve it in the visible browser.
// ---------------------------------------------------------------------------

const RECAPTCHA_ANCHOR = '#recaptcha-anchor';
const RECAPTCHA_CHECKED = '#recaptcha-anchor[aria-checked="true"]';
const AUDIO_BTN = '#recaptcha-audio-button';
const AUDIO_DOWNLOAD_LINK = '.rc-audiochallenge-tdownload-link';
const AUDIO_RESPONSE_INPUT = '#audio-response';
const VERIFY_BTN = '#recaptcha-verify-button';
const CAPTCHA_RESPONSE_TEXTAREA = '#g-recaptcha-response';

/**
 * Attempts to solve the reCAPTCHA on the current page (if present).
 *
 * @param page         - Active Playwright page
 * @param witAiToken   - Optional Wit.ai Server Access Token for audio bypass
 * @param headless     - Whether the browser is running headless (affects fallback behaviour)
 */
export async function solveRecaptchaIfPresent(
  page: Page,
  witAiToken: string | undefined,
  headless: boolean,
): Promise<void> {
  // Fast-path: check if reCAPTCHA iframe exists on this page at all
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  if ((await recaptchaFrame.locator(RECAPTCHA_ANCHOR).count()) === 0) {
    return; // No reCAPTCHA — nothing to do
  }

  logger.info('[CAPTCHA] reCAPTCHA detected — attempting auto-solve...');

  // ── Tier 1: click the checkbox and hope stealth gets a free pass ──────────
  try {
    await recaptchaFrame.locator(RECAPTCHA_ANCHOR).click({ timeout: 10_000 });
  } catch (err) {
    logger.warn('[CAPTCHA] Could not click reCAPTCHA anchor:', err);
    return;
  }

  await sleep(2_500);

  if ((await recaptchaFrame.locator(RECAPTCHA_CHECKED).count()) > 0) {
    logger.info('[CAPTCHA] ✓ Solved without challenge (stealth auto-pass)');
    return;
  }

  // ── Tier 2: audio challenge via Wit.ai ───────────────────────────────────
  if (witAiToken) {
    try {
      await solveAudioChallenge(page, witAiToken);

      await sleep(2_000);
      if ((await recaptchaFrame.locator(RECAPTCHA_CHECKED).count()) > 0) {
        logger.info('[CAPTCHA] ✓ Solved via audio challenge + Wit.ai');
        return;
      }
      logger.warn('[CAPTCHA] Audio challenge submitted but checkbox not checked — may need retry');
    } catch (err) {
      logger.error('[CAPTCHA] Audio challenge failed:', err);
    }
  } else {
    logger.warn('[CAPTCHA] WIT_AI_ACCESS_TOKEN not set — skipping audio bypass');
  }

  // ── Tier 3: manual fallback ───────────────────────────────────────────────
  if (headless) {
    logger.error(
      '[CAPTCHA] Running headless with no Wit.ai token — cannot solve reCAPTCHA automatically.\n' +
        '          Options:\n' +
        '          1. Set HEADLESS=false for the first run and solve manually.\n' +
        '          2. Set WIT_AI_ACCESS_TOKEN (free at https://wit.ai) for auto-solve.',
    );
    throw new Error('[CAPTCHA] Unsolvable in headless mode without WIT_AI_ACCESS_TOKEN');
  }

  logger.info('[CAPTCHA] Waiting up to 2 minutes for manual CAPTCHA solve in the open browser...');
  try {
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector) as HTMLTextAreaElement | null;
        return el !== null && el.value.length > 0;
      },
      CAPTCHA_RESPONSE_TEXTAREA,
      { timeout: 120_000 },
    );
    logger.info('[CAPTCHA] ✓ reCAPTCHA solved manually');
  } catch {
    throw new Error('[CAPTCHA] Timed out waiting for manual reCAPTCHA solve');
  }
}

// ---------------------------------------------------------------------------
// Audio challenge implementation
// ---------------------------------------------------------------------------

async function solveAudioChallenge(page: Page, witAiToken: string): Promise<void> {
  // The challenge popup appears in a different iframe
  const challengeFrame = page.frameLocator('iframe[title*="recaptcha challenge"]');

  // Switch to the audio challenge tab
  try {
    await challengeFrame.locator(AUDIO_BTN).click({ timeout: 10_000 });
    await sleep(1_500);
  } catch {
    // May already be on audio tab
  }

  // Get the MP3 download URL
  const audioUrl = await challengeFrame
    .locator(AUDIO_DOWNLOAD_LINK)
    .getAttribute('href', { timeout: 10_000 });

  if (!audioUrl) {
    throw new Error('[CAPTCHA] Audio challenge download link not found');
  }

  logger.debug(`[CAPTCHA] Downloading audio challenge from ${audioUrl}`);
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error(`[CAPTCHA] Failed to download audio: ${audioRes.status}`);
  }
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // Transcribe using Wit.ai Speech API (free, unlimited with a free account)
  // Docs: https://wit.ai/docs/http/20220622/#post__speech_link
  logger.debug('[CAPTCHA] Sending audio to Wit.ai for transcription...');
  const witRes = await fetch('https://api.wit.ai/speech?v=20220622', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${witAiToken}`,
      'Content-Type': 'audio/mpeg3',
      Accept: 'application/json',
    },
    body: audioBuffer,
  });

  if (!witRes.ok) {
    throw new Error(`[CAPTCHA] Wit.ai error ${witRes.status}: ${witRes.statusText}`);
  }

  // Wit.ai response is a series of JSON objects separated by \r\n.
  // The last object contains the final (most accurate) transcription.
  const rawBody = await witRes.text();
  const chunks = rawBody.split('\r\n').filter(Boolean);
  const lastChunk = chunks[chunks.length - 1];
  const witData = JSON.parse(lastChunk) as { text?: string };
  const transcription = witData.text?.toLowerCase().trim();

  if (!transcription) {
    throw new Error('[CAPTCHA] Wit.ai returned an empty transcription');
  }

  logger.debug(`[CAPTCHA] Transcription received: "${transcription}"`);

  // Submit the answer
  await challengeFrame.locator(AUDIO_RESPONSE_INPUT).fill(transcription);
  await challengeFrame.locator(VERIFY_BTN).click();
}
