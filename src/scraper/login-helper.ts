import readline from 'readline';
import { chromium } from './stealth-browser';
import { getBrowserLaunchOptions } from './anti-detection';
import { saveCookies, validateSession } from './linkedin-auth';

/**
 * Interactive CLI script for LinkedIn login.
 *
 * Opens a visible browser window where the user logs in manually,
 * then captures and saves the session cookies for the scraper to reuse.
 *
 * Usage: npm run login
 */
async function main() {
  console.log('\n=== LinkedIn Login Helper ===\n');
  console.log('A browser window will open. Please log in to LinkedIn.');
  console.log('Handle any captchas, 2FA, or security prompts as needed.');
  console.log('When you are fully logged in (see your feed), come back here and press Enter.\n');

  const launchOptions = getBrowserLaunchOptions();

  const browser = await chromium.launch({
    headless: false, // Must be visible for manual login
    args: launchOptions.args,
  });

  const context = await browser.newContext({
    viewport: launchOptions.viewport,
    userAgent: launchOptions.userAgent,
  });

  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  // Wait for user to press Enter
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('Press Enter after you have logged in... ', () => {
      rl.close();
      resolve();
    });
  });

  // Capture cookies
  console.log('\nCapturing session cookies...');
  const cookies = await context.cookies();
  saveCookies(cookies);

  // Validate
  console.log('Validating session...');
  const valid = await validateSession(page);

  if (valid) {
    console.log('\nLogin successful! Cookies saved.');
    console.log('The scraper will use these cookies for authenticated access.');
  } else {
    console.log('\nWarning: Session validation failed.');
    console.log('Cookies were saved but may not work. Try running this script again.');
  }

  await browser.close();
  process.exit(valid ? 0 : 1);
}

main().catch((error) => {
  console.error('Login helper failed:', error);
  process.exit(1);
});
