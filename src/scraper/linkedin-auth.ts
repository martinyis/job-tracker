import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page, Cookie } from 'playwright-core';
import { config } from '../config';
import { logger } from '../logger';

const COOKIE_PATH = path.resolve('./data/linkedin-cookies.json');

/**
 * Loads saved LinkedIn session cookies from disk.
 * Returns null if the file doesn't exist or is malformed.
 */
export function loadCookies(): Cookie[] | null {
  try {
    if (!fs.existsSync(COOKIE_PATH)) return null;
    const raw = fs.readFileSync(COOKIE_PATH, 'utf-8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) return null;
    return cookies;
  } catch (error) {
    logger.warn('Failed to load LinkedIn cookies', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Saves LinkedIn session cookies to disk.
 */
export function saveCookies(cookies: Cookie[]): void {
  const dir = path.dirname(COOKIE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2), 'utf-8');
  logger.info('LinkedIn cookies saved', { count: cookies.length, path: COOKIE_PATH });
}

/**
 * Checks if the cookie array contains a valid (non-expired) li_at session cookie.
 * li_at is LinkedIn's primary session cookie.
 */
export function areCookiesValid(cookies: Cookie[]): boolean {
  const liAt = cookies.find((c) => c.name === 'li_at');
  if (!liAt) {
    logger.warn('No li_at cookie found — session is not authenticated');
    return false;
  }

  // li_at.expires is a Unix timestamp in seconds (-1 means session cookie with no expiry)
  if (liAt.expires > 0 && liAt.expires < Date.now() / 1000) {
    logger.warn('li_at cookie has expired', {
      expired: new Date(liAt.expires * 1000).toISOString(),
    });
    return false;
  }

  return true;
}

/**
 * Validates a LinkedIn session by navigating to /feed/ and checking
 * if we stay logged in (vs being redirected to login page).
 * This is the definitive check — LinkedIn can invalidate sessions server-side.
 */
export async function validateSession(page: Page): Promise<boolean> {
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    const currentUrl = page.url();
    const isLoggedIn =
      !currentUrl.includes('/login') &&
      !currentUrl.includes('/authwall') &&
      !currentUrl.includes('/checkpoint');

    if (isLoggedIn) {
      logger.info('LinkedIn session is valid');
    } else {
      logger.warn('LinkedIn session is invalid — redirected to login', { url: currentUrl });
    }

    return isLoggedIn;
  } catch (error) {
    logger.warn('Session validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
