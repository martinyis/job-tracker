import { config } from '../config';

/**
 * Rotating list of real user agents from popular browsers.
 * Updated periodically to match current browser versions.
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

/**
 * Common viewport sizes to rotate for fingerprint randomization.
 */
const VIEWPORT_SIZES = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
];

/**
 * Mobile user agents for unauthenticated search.
 * LinkedIn's mobile web shows results without login and respects URL time filters,
 * unlike desktop which blocks unauthenticated users or ignores time filters when authenticated.
 */
const MOBILE_USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.90 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.90 Mobile Safari/537.36',
];

const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },   // iPhone 14
  { width: 393, height: 852 },   // iPhone 15
  { width: 412, height: 915 },   // Pixel 8
  { width: 360, height: 780 },   // Samsung Galaxy S24
];

/**
 * Returns a random user agent string.
 */
export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Returns a random viewport size.
 */
export function getRandomViewport(): { width: number; height: number } {
  return VIEWPORT_SIZES[Math.floor(Math.random() * VIEWPORT_SIZES.length)];
}

/**
 * Generates a random delay in milliseconds within the given range.
 */
export function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Waits for a random navigation delay (2-5s by default).
 */
export async function waitNavigation(): Promise<void> {
  const delay = randomDelay(
    config.scraper.navigationDelay.min,
    config.scraper.navigationDelay.max,
  );
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Returns mobile browser context options for unauthenticated job searching.
 * LinkedIn mobile web shows results without login and respects time filters.
 */
export function getMobileContextOptions() {
  const viewport = MOBILE_VIEWPORTS[Math.floor(Math.random() * MOBILE_VIEWPORTS.length)];
  const userAgent = MOBILE_USER_AGENTS[Math.floor(Math.random() * MOBILE_USER_AGENTS.length)];
  return {
    viewport,
    userAgent,
    isMobile: true,
    hasTouch: true,
  };
}

/**
 * Browser launch options with stealth settings applied.
 */
export function getBrowserLaunchOptions() {
  const viewport = getRandomViewport();

  return {
    headless: config.scraper.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      `--window-size=${viewport.width},${viewport.height}`,
    ],
    viewport,
    userAgent: getRandomUserAgent(),
  };
}
