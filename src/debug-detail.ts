import { chromium } from './scraper/stealth-browser';
import { getBrowserLaunchOptions } from './scraper/anti-detection';
import { loadCookies, areCookiesValid, validateSession } from './scraper/linkedin-auth';

async function main() {
  const jobId = process.argv[2] || '4376183423';
  const opts = getBrowserLaunchOptions();

  const browser = await chromium.launch({ headless: true, args: opts.args });
  const context = await browser.newContext({ viewport: opts.viewport, userAgent: opts.userAgent });

  const cookies = loadCookies();
  if (cookies && areCookiesValid(cookies)) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();
  await validateSession(page);

  const url = `https://www.linkedin.com/jobs/view/${jobId}/`;
  console.log('Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for content
  await page.waitForTimeout(3000);

  // Scroll down to load lazy content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  // Take screenshot
  await page.screenshot({ path: 'data/screenshots/debug-detail.png', fullPage: true });
  console.log('Screenshot saved to data/screenshots/debug-detail.png');

  // Dump the main content area HTML structure (class names and tag structure)
  const structure = await page.evaluate(() => {
    // Get all elements with their class names, focusing on main content
    const main = document.querySelector('main') || document.body;

    // Find any element containing "About the job" or description-like text
    const allElements = main.querySelectorAll('*');
    const interesting: string[] = [];

    for (const el of allElements) {
      const text = (el as HTMLElement).innerText?.trim() || '';
      const classes = el.className || '';
      const tag = el.tagName.toLowerCase();

      // Look for description sections
      if (text.length > 200 && text.length < 15000 && tag !== 'main' && tag !== 'body' && tag !== 'html') {
        interesting.push(`[DESC CANDIDATE] <${tag} class="${classes}"> textLen=${text.length} preview="${text.substring(0, 100)}..."`);
      }

      // Look for "About" sections
      if (text.startsWith('About the') || text.startsWith('About The')) {
        interesting.push(`[ABOUT] <${tag} class="${classes}"> "${text.substring(0, 150)}"`);
      }

      // Look for applicant text
      if (text.toLowerCase().includes('applicant')) {
        interesting.push(`[APPLICANT] <${tag} class="${classes}"> "${text.substring(0, 100)}"`);
      }

      // Look for seniority/employment metadata
      if (/seniority|employment type|job function/i.test(text) && text.length < 200) {
        interesting.push(`[META] <${tag} class="${classes}"> "${text}"`);
      }
    }

    return interesting.slice(0, 50);
  });

  console.log('\n=== Interesting elements found ===');
  structure.forEach(s => console.log(s));

  // Also dump the outer HTML of the first big text block
  const descHtml = await page.evaluate(() => {
    const allElements = document.querySelectorAll('article, section, div');
    for (const el of allElements) {
      const text = (el as HTMLElement).innerText?.trim() || '';
      if (text.length > 300 && text.length < 10000) {
        // Check it's not the whole page
        const parent = el.parentElement;
        const parentText = (parent as HTMLElement)?.innerText?.trim() || '';
        if (parentText.length > text.length * 1.5) {
          return {
            tag: el.tagName,
            class: el.className,
            id: el.id,
            textLen: text.length,
            preview: text.substring(0, 300),
            outerHtmlPreview: (el as HTMLElement).outerHTML.substring(0, 500),
          };
        }
      }
    }
    return null;
  });

  console.log('\n=== First description-like block ===');
  console.log(JSON.stringify(descHtml, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
