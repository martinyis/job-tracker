import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

/**
 * Shared stealth-enabled Chromium instance.
 * The stealth plugin is applied exactly ONCE here.
 * All modules that need a stealth browser should import from this file.
 */
chromium.use(StealthPlugin());

export { chromium };
