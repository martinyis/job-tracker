import { chromium } from './stealth-browser';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { config } from '../config';
import { logger } from '../logger';
import { getBrowserLaunchOptions, randomDelay } from './anti-detection';
import { loadCookies, areCookiesValid, validateSession } from './linkedin-auth';

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export interface JobDetail {
  description: string;
  companyInfo: string;
  contactPeople: Array<{ name: string; title: string; profileUrl: string }>;
  postedBy: string;
  postedByTitle: string;
  postedByProfile: string;
  applicantCount: string;
  seniorityLevel: string;
  employmentType: string;
  jobFunction: string;
}

/**
 * Scrapes full data from LinkedIn job detail pages.
 * Keeps the browser open across multiple jobs for efficiency.
 * Requires an authenticated LinkedIn session.
 */
export class DetailScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * Launches browser with stealth config, loads LinkedIn cookies, validates session.
   * Throws if session is invalid — the enricher requires authentication.
   */
  async launch(): Promise<void> {
    const launchOptions = getBrowserLaunchOptions();

    logger.info('DetailScraper: launching browser', {
      headless: config.scraper.headless,
    });

    this.browser = await chromium.launch({
      headless: config.scraper.headless,
      args: launchOptions.args,
    });

    this.context = await this.browser.newContext({
      viewport: launchOptions.viewport,
      userAgent: launchOptions.userAgent,
    });

    const cookies = loadCookies();
    if (!cookies || !areCookiesValid(cookies)) {
      await this.close();
      throw new SessionExpiredError(
        'No valid LinkedIn cookies found. Run `npm run login` to authenticate.',
      );
    }

    await this.context.addCookies(cookies);
    this.page = await this.context.newPage();

    const isValid = await validateSession(this.page);
    if (!isValid) {
      await this.close();
      throw new SessionExpiredError(
        'LinkedIn session expired. Run `npm run login` to re-authenticate.',
      );
    }

    logger.info('DetailScraper: browser ready with valid session');
  }

  /**
   * Scrapes a LinkedIn job detail page for full data.
   * Returns partial data if some sections are missing.
   */
  async scrapeJobDetail(linkedinId: string): Promise<JobDetail> {
    if (!this.page) {
      throw new Error('DetailScraper: browser not launched. Call launch() first.');
    }

    const url = `https://www.linkedin.com/jobs/view/${linkedinId}/`;
    logger.info('DetailScraper: navigating to job', { linkedinId, url });

    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Check for auth redirect
    const currentUrl = this.page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      throw new SessionExpiredError('Redirected to login page — session expired');
    }

    // Wait for the main content to load — use stable LinkedIn SDUI attributes
    try {
      await this.page.waitForSelector('[componentkey^="JobDetails"], [data-view-name="job-detail-page"], main', {
        timeout: 10_000,
      });
    } catch {
      logger.warn('DetailScraper: job detail page did not load expected selectors', { linkedinId });
    }

    // Scroll to trigger lazy-loaded sections
    await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 2000));
    await this.page.evaluate(() => window.scrollTo(0, 0));
    await new Promise((r) => setTimeout(r, 1000));

    // Click "Show more" / "See more" buttons to expand truncated content
    try {
      const showMoreButtons = await this.page.$$('button[aria-label*="Show more"], button[aria-label*="See more"], button[aria-label*="show more"], .show-more-less-html__button--more');
      for (const btn of showMoreButtons) {
        try {
          await btn.click();
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          // Button may not be interactive
        }
      }
    } catch {
      // No show more buttons
    }

    // Extract all data in one evaluate call.
    // IMPORTANT: tsx injects __name() wrappers for ANY named function or const
    // arrow function. This helper does NOT exist in the browser evaluate context.
    // Therefore: NO function declarations, NO const arrow functions inside evaluate.
    // Use only inline expressions.
    const result = await this.page.evaluate(() => {
      // 1. Job description — use LinkedIn SDUI componentkey attributes first,
      //    then fall back to content-length heuristic
      let description = '';

      // Strategy A: SDUI componentkey (most reliable)
      {
        const el = document.querySelector('[componentkey^="JobDetails_AboutTheJob"]');
        if (el) description = (el as HTMLElement).innerText?.trim() || '';
      }

      // Strategy B: data-sdui-component attribute
      if (!description) {
        const el = document.querySelector('[data-sdui-component*="aboutTheJob"]');
        if (el) description = (el as HTMLElement).innerText?.trim() || '';
      }

      // Strategy C: Legacy class-based selectors (older LinkedIn UI)
      if (!description) {
        const selectors = [
          '.jobs-description__content',
          '.jobs-description-content__text',
          '.show-more-less-html__markup',
          '.jobs-box__html-content',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const t = (el as HTMLElement)?.innerText?.trim() || '';
          if (t.length > 50) {
            description = t;
            break;
          }
        }
      }

      // Strategy D: Heuristic — find the largest text block in main content
      if (!description) {
        let bestLen = 0;
        document.querySelectorAll('main div, main section, main article').forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim() || '';
          if (t.length > 200 && t.length < 15000 && t.length > bestLen) {
            const p = el.parentElement;
            const pLen = p ? ((p as HTMLElement).innerText?.trim() || '').length : t.length * 2;
            if (pLen > t.length * 1.3) {
              description = t;
              bestLen = t.length;
            }
          }
        });
      }

      // Strip common header prefixes (multi-locale)
      description = description
        .replace(/^(About the job|Об этой вакансии|About this job)\s*/i, '')
        .trim();

      // 2. Company info — SDUI componentkey, then link-based fallback
      let companyInfo = '';
      {
        const el = document.querySelector('[componentkey^="JobDetails_AboutTheCompany"]');
        if (el) companyInfo = (el as HTMLElement).innerText?.trim() || '';
      }
      if (!companyInfo) {
        const el = document.querySelector('a[href*="/company/"]');
        if (el) companyInfo = (el as HTMLElement).innerText?.trim() || '';
      }

      // 3. Contact people / hiring team
      const contactPeople: Array<{ name: string; title: string; profileUrl: string }> = [];
      const seen = new Set<string>();
      const hiringSection = document.querySelector(
        '[componentkey*="HiringTeam"], [componentkey*="hiringTeam"], [componentkey*="MeetTheHiringTeam"]'
      );
      const searchRoot = hiringSection || document.querySelector('main') || document.body;

      searchRoot.querySelectorAll('a[href*="/in/"]').forEach((link) => {
        const href = (link as HTMLAnchorElement).href || '';
        const m = href.match(/linkedin\.com\/in\/([^/?]+)/);
        if (!m) return;
        if (seen.has(m[1])) return;
        seen.add(m[1]);

        const name = (link as HTMLElement).innerText?.trim() || '';
        if (!name || name.length > 100) return;

        // Title: look in parent container for subtitle-like text
        const container = link.closest('li, div, section') || link.parentElement;
        let title = '';
        if (container) {
          const ct = (container as HTMLElement).innerText?.trim() || '';
          const idx = ct.indexOf(name);
          if (idx >= 0) {
            const line = ct.substring(idx + name.length).trim().split('\n')[0]?.trim() || '';
            if (line.length > 0 && line.length < 200) title = line;
          }
        }

        contactPeople.push({ name, title, profileUrl: `https://www.linkedin.com/in/${m[1]}/` });
      });

      // 4. Poster info — first contact person is usually the poster
      const postedBy = contactPeople.length > 0 ? contactPeople[0].name : '';
      const postedByTitle = contactPeople.length > 0 ? contactPeople[0].title : '';
      const postedByProfile = contactPeople.length > 0 ? contactPeople[0].profileUrl : '';

      // 5. Applicant count — scan text nodes for "applicant" keyword
      let applicantCount = '';
      const tw = document.createTreeWalker(
        document.querySelector('main') || document.body,
        NodeFilter.SHOW_TEXT,
      );
      let nd: Node | null;
      while ((nd = tw.nextNode())) {
        const t = nd.textContent?.trim() || '';
        if (t.length > 3 && t.length < 100 && /applicant/i.test(t)) {
          applicantCount = t;
          break;
        }
      }

      // 6. Metadata (seniority, employment type, job function)
      let seniorityLevel = '';
      let employmentType = '';
      let jobFunction = '';

      // Strategy A: SDUI componentkey for job criteria
      {
        const el = document.querySelector('[componentkey*="JobCriteria"], [componentkey*="jobCriteria"]');
        if (el) {
          const lines = ((el as HTMLElement).innerText?.trim() || '').split('\n').map((l: string) => l.trim()).filter(Boolean);
          for (let i = 0; i < lines.length - 1; i++) {
            const label = lines[i].toLowerCase();
            if (/seniority/i.test(label)) seniorityLevel = lines[i + 1];
            else if (/employment/i.test(label)) employmentType = lines[i + 1];
            else if (/job function|function/i.test(label)) jobFunction = lines[i + 1];
          }
        }
      }

      // Strategy B: Legacy criteria list items
      if (!seniorityLevel && !employmentType) {
        document.querySelectorAll('li').forEach((li) => {
          const t = (li as HTMLElement).innerText?.trim() || '';
          if (t.length > 200) return;
          const lower = t.toLowerCase();
          const lines = t.split('\n').map((l: string) => l.trim()).filter(Boolean);
          const last = lines[lines.length - 1] || '';
          if (/seniority.*level/i.test(lower) && !seniorityLevel) seniorityLevel = last;
          else if (/employment.*type/i.test(lower) && !employmentType) employmentType = last;
          else if (/job function/i.test(lower) && !jobFunction) jobFunction = last;
        });
      }

      // Strategy C: Text-pattern matching on short elements
      if (!seniorityLevel || !employmentType) {
        document.querySelectorAll('span, div, li').forEach((el) => {
          const t = (el as HTMLElement).innerText?.trim() || '';
          if (t.length > 50) return;
          if (!seniorityLevel && /^(entry.level|mid.senior|senior|associate|director|executive|internship)$/i.test(t)) {
            seniorityLevel = t;
          }
          if (!employmentType && /^(full.time|part.time|contract|temporary|volunteer|other)$/i.test(t)) {
            employmentType = t;
          }
        });
      }

      return {
        description: description.substring(0, 10000),
        companyInfo,
        contactPeople,
        postedBy,
        postedByTitle,
        postedByProfile,
        applicantCount,
        seniorityLevel,
        employmentType,
        jobFunction,
      };
    });

    logger.info('DetailScraper: extracted job detail', {
      linkedinId,
      descLength: result.description.length,
      hasCompanyInfo: result.companyInfo.length > 0,
      contactCount: result.contactPeople.length,
      hasPoster: result.postedBy.length > 0,
      applicantCount: result.applicantCount,
      seniorityLevel: result.seniorityLevel,
      employmentType: result.employmentType,
    });

    return result;
  }

  /**
   * Closes the browser and cleans up.
   */
  async close(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close().catch(() => {});
        this.page = null;
      }
      if (this.context) {
        await this.context.close().catch(() => {});
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }
      logger.info('DetailScraper: browser closed');
    } catch (error) {
      logger.warn('DetailScraper: error closing browser', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get isOpen(): boolean {
    return this.browser !== null;
  }
}
