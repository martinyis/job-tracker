import { chromium } from './stealth-browser';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { config } from '../config';
import { logger } from '../logger';
import { getBrowserLaunchOptions, randomDelay } from './anti-detection';
import { SELECTORS } from './selectors';

export class LoginBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginBlockedError';
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

const MAX_RETRIES = 4;

/**
 * Scrapes full data from LinkedIn job detail pages using public (unauthenticated) access.
 * Keeps the browser open across multiple jobs for efficiency.
 * Handles login modals/redirects with automatic retries.
 */
export class DetailScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * Launches browser with stealth config. No authentication required.
   */
  async launch(): Promise<void> {
    const launchOptions = getBrowserLaunchOptions();

    logger.info('DetailScraper: launching browser (unauthenticated)', {
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

    this.page = await this.context.newPage();

    logger.info('DetailScraper: browser ready (unauthenticated)');
  }

  /**
   * Scrapes a LinkedIn job detail page for full data.
   * Retries up to MAX_RETRIES times if blocked by login page/modal.
   */
  async scrapeJobDetail(linkedinId: string): Promise<JobDetail> {
    if (!this.context) {
      throw new Error('DetailScraper: browser not launched. Call launch() first.');
    }

    const url = `https://www.linkedin.com/jobs/view/${linkedinId}/`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Ensure we have a page
      if (!this.page) {
        this.page = await this.context.newPage();
      }

      logger.info('DetailScraper: navigating to job', { linkedinId, url, attempt });

      try {
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
      } catch (error) {
        logger.warn('DetailScraper: navigation failed', {
          linkedinId, attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        if (attempt < MAX_RETRIES) {
          await this.recyclePage();
          await new Promise((r) => setTimeout(r, randomDelay(2000, 5000)));
          continue;
        }
        throw error;
      }

      // Check if we landed on a login page (full redirect)
      const currentUrl = this.page.url();
      if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
        logger.warn('DetailScraper: redirected to login page, retrying', {
          linkedinId, attempt, currentUrl,
        });
        if (attempt < MAX_RETRIES) {
          await this.recyclePage();
          await new Promise((r) => setTimeout(r, randomDelay(2000, 5000)));
          continue;
        }
        throw new LoginBlockedError(
          `Job ${linkedinId}: blocked by login redirect after ${MAX_RETRIES} attempts`,
        );
      }

      // Dismiss any login/signup modals
      await this.dismissModals();

      // Wait for the main content to load
      try {
        await this.page.waitForSelector(
          '[componentkey^="JobDetails"], [data-view-name="job-detail-page"], .show-more-less-html__markup, .description__text, main',
          { timeout: 10_000 },
        );
      } catch {
        logger.warn('DetailScraper: job detail page did not load expected selectors', {
          linkedinId, attempt,
        });
      }

      // Dismiss modals again after content loads (they can appear late)
      await this.dismissModals();

      // Scroll to trigger lazy-loaded sections
      await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 2000));
      await this.page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((r) => setTimeout(r, 1000));

      // Dismiss modals one more time after scrolling
      await this.dismissModals();

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

      // Check if we got meaningful content — if not, the page might be blocked
      if (result.description.length < 30) {
        logger.warn('DetailScraper: no meaningful content extracted', {
          linkedinId, attempt, descLength: result.description.length,
        });
        if (attempt < MAX_RETRIES) {
          await this.recyclePage();
          await new Promise((r) => setTimeout(r, randomDelay(2000, 5000)));
          continue;
        }
        // On final attempt, return whatever we got
      }

      logger.info('DetailScraper: extracted job detail', {
        linkedinId,
        attempt,
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

    // Should not reach here, but just in case
    throw new LoginBlockedError(
      `Job ${linkedinId}: failed to scrape after ${MAX_RETRIES} attempts`,
    );
  }

  /**
   * Dismisses LinkedIn login/signup modals using the same approach as the scraper.
   */
  private async dismissModals(): Promise<void> {
    if (!this.page) return;

    try {
      // Strategy 1: Click any visible dismiss/close buttons (short timeout to skip invisible ones)
      const dismissBtns = await this.page.$$(SELECTORS.modals.dismissButton);
      for (const btn of dismissBtns) {
        try {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            await btn.click({ timeout: 2000 });
            await new Promise((r) => setTimeout(r, 300));
          }
        } catch {
          // Button might be hidden or detached
        }
      }

      // Strategy 2: Press Escape key
      await this.page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 200));

      // Strategy 3: Remove blocking overlays from DOM
      const removedOverlay = await this.page.evaluate((overlaySelector) => {
        const overlays = document.querySelectorAll(overlaySelector);
        let removed = 0;
        overlays.forEach((el) => {
          el.remove();
          removed++;
        });
        // Also remove full-screen auth walls
        const authWalls = document.querySelectorAll(
          '.authentication-outlet, [data-test="authwall-join-form"], .signup-modal, ' +
          '.join-form-container, div[class*="auth-wall"], div[class*="authwall"]'
        );
        authWalls.forEach((el) => {
          el.remove();
          removed++;
        });
        // Re-enable scrolling if blocked by a modal
        if (document.body.style.overflow === 'hidden') {
          document.body.style.overflow = '';
        }
        return removed;
      }, SELECTORS.modals.modalOverlay);

      if (removedOverlay > 0) {
        logger.debug(`DetailScraper: removed ${removedOverlay} modal overlay(s)`);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch {
      // Modal dismissal is best-effort
    }
  }

  /**
   * Closes the current page and creates a fresh one for retry.
   */
  private async recyclePage(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      this.page = await this.context.newPage();
    }
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
