import { chromium } from "./stealth-browser";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { config } from "../config";
import { logger } from "../logger";
import { SELECTORS } from "./selectors";
import {
  getBrowserLaunchOptions,
  waitNavigation,
} from "./anti-detection";
import { loadCookies, areCookiesValid, validateSession } from "./linkedin-auth";

/** Minimal job card data extracted from the search results list */
export interface ScrapedJob {
  linkedinId: string;
  title: string;
  company: string;
  link: string;
  postedDate: string;
  /** How many minutes ago this job was posted (parsed from card text) */
  minutesAgo: number;
}

/**
 * LinkedIn scraper that scrolls the full search results page,
 * extracts basic card data (title, company, time, link) from ALL cards,
 * and returns them for downstream filtering.
 *
 * No detail-page visits. No description scraping. Just card-level data.
 */
export class LinkedInScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Clean (no-cookie) context for job searching — public pages respect URL time filters */
  private searchContext: BrowserContext | null = null;
  private searchPage: Page | null = null;
  private isAuthenticated: boolean = false;
  private hasCookies: boolean = false;

  /** Whether the scraper has a valid authenticated LinkedIn session */
  get authenticated(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Launches the browser with stealth configuration.
   */
  async launch(): Promise<void> {
    const launchOptions = getBrowserLaunchOptions();

    logger.info("Launching browser", {
      headless: config.scraper.headless,
      viewport: `${launchOptions.viewport.width}x${launchOptions.viewport.height}`,
    });

    const launchStart = Date.now();
    this.browser = await chromium.launch({
      headless: config.scraper.headless,
      args: launchOptions.args,
    });
    logger.info("Chromium process started", {
      elapsed: `${Date.now() - launchStart}ms`,
    });

    this.context = await this.browser.newContext({
      viewport: launchOptions.viewport,
      userAgent: launchOptions.userAgent,
    });

    // Load LinkedIn session cookies if available
    const cookies = loadCookies();
    if (cookies && areCookiesValid(cookies)) {
      await this.context.addCookies(cookies);
      this.hasCookies = true;
      logger.info("LinkedIn cookies loaded into browser context");
    }

    this.page = await this.context.newPage();

    // Validate the session if cookies were loaded
    if (cookies && areCookiesValid(cookies)) {
      this.isAuthenticated = await validateSession(this.page);
      if (!this.isAuthenticated) {
        logger.warn(
          "LinkedIn session expired or invalid. Run `npm run login` to re-authenticate. " +
          "Continuing without authentication — apply links will not be extracted."
        );
      }
    } else {
      logger.info(
        "No LinkedIn cookies found. Run `npm run login` to enable apply link extraction."
      );
    }

    // Create a separate clean desktop context for job searching (no cookies).
    // Authenticated LinkedIn ignores URL time filters (f_TPR), returning stale results.
    // Unauthenticated desktop LinkedIn respects f_TPR (including r600) AND shows time info on cards.
    if (this.hasCookies) {
      const searchLaunchOpts = getBrowserLaunchOptions();
      this.searchContext = await this.browser.newContext({
        viewport: searchLaunchOpts.viewport,
        userAgent: searchLaunchOpts.userAgent,
      });
      this.searchPage = await this.searchContext.newPage();
      logger.info("Clean desktop search context created (unauthenticated respects time filters)", {
        viewport: `${searchLaunchOpts.viewport.width}x${searchLaunchOpts.viewport.height}`,
      });
    }

    logger.info("Browser page created and ready", { authenticated: this.isAuthenticated });
  }

  /**
   * Scrolls the LinkedIn public job search page for a keyword,
   * loading ALL cards since the list order is random w.r.t. time.
   *
   * - Navigates to search page (past hour, with geoId)
   * - Scrolls to load all cards (recent jobs can be anywhere in the list)
   * - Extracts basic data from each card
   * - Returns all cards for downstream time + relevance filtering
   */
  async scanAllCards(keyword: string): Promise<ScrapedJob[]> {
    if (!this.page) throw new Error("Browser not launched");

    // Use clean (no-cookie) page for search when available.
    // Authenticated LinkedIn ignores URL time filters, serving stale results.
    const useCleanSearch = !!this.searchPage && this.hasCookies;
    const savedPage = this.page;
    if (useCleanSearch) {
      this.page = this.searchPage!;
      logger.debug("Using clean search context (authenticated session bypasses time filters)");
    }

    const allJobs: ScrapedJob[] = [];

    try {
      // Build search URL: past hour, sorted by most recent, with geoId
      const locationParam =
        config.search.locations.length > 0
          ? `&location=${encodeURIComponent(config.search.locations[0])}`
          : "";
      const geoParam = config.search.geoId
        ? `&geoId=${config.search.geoId}`
        : "";
      // f_TPR=rN means "posted within last N seconds".
      // Unauthenticated desktop LinkedIn respects short intervals like r600 (10 min).
      const timeFilterSeconds = config.scraper.maxMinutesAgo * 60;
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&f_TPR=r${timeFilterSeconds}${locationParam}${geoParam}&sortBy=DD`;

      logger.info(`Scanning ALL cards for "${keyword}"`, { url: searchUrl });

      // LinkedIn's r600 filter is flaky — sometimes returns "no match" then works on reload.
      // Retry up to 3 times with the same URL before giving up.
      let totalCardCount = 0;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        await this.page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await waitNavigation();

        // Dismiss any login/signup modals that block content
        await this.dismissModals();

        // Wait for job cards to render
        try {
          await this.page.waitForSelector(SELECTORS.search.jobCard, { timeout: 10_000 });
          logger.debug("Job cards detected on page");
        } catch {
          logger.debug("No job cards appeared within timeout");
        }

        // Dismiss modals again (can appear after page settles)
        await this.dismissModals();

        // Scroll to load all cards — jobs are randomly ordered, recent ones can be anywhere.
        await this.scrollToLoadAllCards();

        totalCardCount = await this.page.$$eval(
          SELECTORS.search.jobCard,
          (cards) => cards.length,
        );

        if (totalCardCount > 0) {
          if (attempt > 1) logger.info(`Retry ${attempt} succeeded: ${totalCardCount} cards found`);
          break;
        }

        // Log diagnostics on failure
        const bodyPreview = await this.page.evaluate(() =>
          document.body?.innerText?.slice(0, 300) || ""
        );
        logger.warn(`Attempt ${attempt}/${maxRetries}: 0 cards for "${keyword}"`, {
          url: this.page.url(),
          bodyPreview,
        });

        if (attempt < maxRetries) {
          const retryDelay = attempt * 3000; // 3s, 6s
          logger.info(`Retrying in ${retryDelay / 1000}s...`);
          await new Promise((r) => setTimeout(r, retryDelay));
        }
      }

      logger.info(`Total cards loaded for "${keyword}": ${totalCardCount}`);

      if (totalCardCount === 0) {
        return allJobs;
      }

      // Extract card data — two strategies depending on page type:
      // Mobile/public: bulk extract all cards in ONE evaluate (fast, no virtual scrolling)
      // Authenticated SPA: per-card scroll-into-view (required for virtual scrolling)
      let extractionStats = { noTitle: 0, noCompany: 0, noLink: 0, noId: 0, success: 0 };

      if (useCleanSearch) {
        // BULK EXTRACTION: Single page.evaluate() grabs all card data at once.
        // ~700x fewer Playwright round-trips than per-card extraction.
        const rawCards = await this.page.evaluate((sels) => {
          const cards = document.querySelectorAll(sels.jobCard);
          return Array.from(cards).map((card) => {
            const el = card as HTMLElement;
            const titleEl = el.querySelector(sels.jobTitle) as HTMLElement | null;
            const companyEl = el.querySelector(sels.companyName) as HTMLElement | null;
            const linkEl = el.querySelector(sels.jobLink) as HTMLElement | null;
            const dateEl = el.querySelector(sels.datePosted) as HTMLElement | null;

            const rawTitle = titleEl?.innerText?.trim() || "";
            const rawCompany = companyEl?.innerText?.trim() || "";
            let link = linkEl?.getAttribute("href") || "";
            if (!link) {
              const altA = el.querySelector('a[href*="jobs"]');
              link = altA?.getAttribute("href") || "";
            }
            const dateText = dateEl?.textContent?.trim() || "";
            const dateAttr = dateEl?.getAttribute("datetime")?.trim() || "";

            // Fallback: scan card text for time patterns
            let cardTimeText = dateText;
            if (!cardTimeText && !dateAttr) {
              const text = el.innerText || "";
              const timeMatch = text.match(
                /(\d+\s*(?:second|minute|hour|day|week|month|min|hr|sec)s?\s*ago|just now|moments?\s*ago)/i
              );
              cardTimeText = timeMatch ? timeMatch[0] : "";
            }

            return { rawTitle, rawCompany, link, dateText, dateAttr, cardTimeText };
          });
        }, {
          jobCard: SELECTORS.search.jobCard,
          jobTitle: SELECTORS.search.jobTitle,
          companyName: SELECTORS.search.companyName,
          jobLink: SELECTORS.search.jobLink,
          datePosted: SELECTORS.search.datePosted,
        });

        // Process raw data in Node.js (no more Playwright calls needed)
        for (const raw of rawCards) {
          // Clean title (handle LinkedIn's doubled text)
          let title = raw.rawTitle.split('\n')[0].trim();
          if (title.length > 6) {
            const half = Math.floor(title.length / 2);
            if (title.slice(0, half) === title.slice(half)) {
              title = title.slice(0, half);
            }
          }
          const company = raw.rawCompany.split('\n')[0].trim();

          if (!title || !company || !raw.link) {
            if (!title) extractionStats.noTitle++;
            if (!company) extractionStats.noCompany++;
            if (!raw.link) extractionStats.noLink++;
            continue;
          }

          const linkedinId = this.extractJobId(raw.link);
          if (!linkedinId) { extractionStats.noId++; continue; }

          const link = raw.link.startsWith("http")
            ? raw.link.split("?")[0]
            : `https://www.linkedin.com${raw.link.split("?")[0]}`;

          const postedDate = raw.dateText || raw.dateAttr || raw.cardTimeText;
          const minutesAgo = this.parseMinutesAgo(raw.cardTimeText || raw.dateText, raw.dateAttr);

          allJobs.push({ linkedinId, title, company, link, postedDate, minutesAgo });
          extractionStats.success++;
        }
      } else {
        // PER-CARD EXTRACTION: Authenticated SPA with virtual scrolling.
        // Must scroll each card into view to force LinkedIn to render it.
        for (let i = 0; i < totalCardCount; i++) {
          try {
            const cardSelector = SELECTORS.search.jobCard;
            await this.page.evaluate(({ selector, index }: { selector: string; index: number }) => {
              const cards = document.querySelectorAll(selector);
              if (cards[index]) {
                cards[index].scrollIntoView({ block: 'center', behavior: 'instant' });
              }
            }, { selector: cardSelector, index: i });
            await new Promise((r) => setTimeout(r, 200));

            const jobCards = await this.page.$$(SELECTORS.search.jobCard);
            if (i >= jobCards.length) break;

            const cardData = await this.extractCardData(jobCards[i], i, extractionStats);
            if (!cardData) continue;
            allJobs.push(cardData);
            extractionStats.success++;
          } catch (error) {
            logger.warn(`Card ${i + 1} extraction failed`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      logger.info(`Card extraction stats for "${keyword}"`, extractionStats);

      // Sort by most recent first
      allJobs.sort((a, b) => a.minutesAgo - b.minutesAgo);

      // Log time distribution for debugging
      if (allJobs.length > 0) {
        const timeBuckets = {
          "≤10m": allJobs.filter(j => j.minutesAgo <= 10).length,
          "11-60m": allJobs.filter(j => j.minutesAgo > 10 && j.minutesAgo <= 60).length,
          ">1h": allJobs.filter(j => j.minutesAgo > 60 && j.minutesAgo < 9999).length,
          "unparsed": allJobs.filter(j => j.minutesAgo === 9999).length,
        };
        logger.debug(`Time distribution for "${keyword}"`, timeBuckets);
      }

      logger.info(
        `Scan complete for "${keyword}": ${allJobs.length} cards extracted from ${totalCardCount} total`,
      );
    } catch (error) {
      logger.error(`Scan failed for "${keyword}"`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        currentUrl: this.page.url(),
      });
    } finally {
      // Restore authenticated page for detail-page access (apply links)
      if (useCleanSearch) {
        this.page = savedPage;
      }
    }

    return allJobs;
  }

  /**
   * Loads all job cards by calling LinkedIn's internal seeMoreJobPostings API.
   *
   * LinkedIn's public search page renders ~60 cards on initial page load.
   * Its infinite scroller uses an IntersectionObserver on a hidden sentinel
   * button, but Playwright's scroll doesn't reliably trigger it. Instead,
   * we call the same API endpoint the scroller uses internally:
   *
   *   /jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=...&start=N
   *
   * This returns HTML fragments of job cards that we inject into the DOM,
   * so the existing card extraction code works unchanged.
   */
  private async scrollToLoadAllCards(targetPage?: Page): Promise<void> {
    const page = targetPage || this.page;
    if (!page) return;

    const initialCount = await page.$$eval(
      SELECTORS.search.jobCard,
      (cards) => cards.length,
    );

    if (initialCount === 0) {
      logger.debug("No initial cards on page");
      return;
    }

    logger.debug(`Initial cards on page: ${initialCount}`);

    // Human-like pause before fetching more (3-5 seconds)
    const humanPause = 3000 + Math.floor(Math.random() * 2000);
    await new Promise((r) => setTimeout(r, humanPause));

    // Extract the search query params from the current page URL
    // so the API call uses the exact same filters (keywords, f_TPR, geoId, etc.)
    const searchParams = await page.evaluate(() => {
      const url = new URL(window.location.href);
      // Remove start= if present (we control it ourselves)
      url.searchParams.delete("start");
      url.searchParams.delete("currentJobId");
      url.searchParams.delete("position");
      url.searchParams.delete("pageNum");
      return url.searchParams.toString();
    });

    // LinkedIn's API returns ~10 cards per batch at each start offset.
    // Using BATCH_SIZE=10 ensures we don't skip results between batches.
    const BATCH_SIZE = 10;
    let start = initialCount; // begin after the SSR-rendered cards
    let totalCards = initialCount;
    let consecutiveEmpty = 0;
    let rateLimitRetries = 0;
    const MAX_EMPTY = 3; // stop after 3 consecutive empty/error responses
    const MAX_BATCHES = 30; // safety limit (~300 additional cards max)
    const MAX_RATE_LIMIT_RETRIES = 5; // give up after 5 consecutive 429s

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      // Random delay between API calls (1-2.5s) to avoid rate limiting
      const delay = 1000 + Math.floor(Math.random() * 1500);
      await new Promise((r) => setTimeout(r, delay));

      const result = await page.evaluate(async (params: { searchParams: string; start: number }) => {
        const apiUrl = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.searchParams}&start=${params.start}`;
        try {
          const response = await fetch(apiUrl);

          // 429 = rate limited, treat as transient error
          if (response.status === 429) {
            return { ok: false, cardsAdded: 0, rateLimited: true };
          }

          const html = await response.text();

          // Empty or error response
          if (!html.trim() || html.trim().length < 100 || !html.includes("base-card")) {
            return { ok: false, cardsAdded: 0, rateLimited: false };
          }

          // Count cards in the response HTML
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const newCards = doc.querySelectorAll("li");
          const count = newCards.length;

          // Inject into the page's job list
          if (count > 0) {
            const jobList = document.querySelector("ul.jobs-search__results-list");
            if (jobList) {
              jobList.insertAdjacentHTML("beforeend", html);
            }
          }

          return { ok: true, cardsAdded: count, rateLimited: false };
        } catch {
          return { ok: false, cardsAdded: 0, rateLimited: false };
        }
      }, { searchParams, start });

      if (result.rateLimited) {
        rateLimitRetries++;
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          logger.warn(`Too many rate limits (${rateLimitRetries}), stopping API pagination at ${totalCards} cards`);
          break;
        }
        // Back off on 429 — wait 3-5s and retry same offset.
        logger.debug(`API rate limited at start=${start}, backing off (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`);
        await new Promise((r) => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)));
        continue; // retry same start offset
      }
      rateLimitRetries = 0; // reset on successful non-429 response

      if (result.ok && result.cardsAdded > 0) {
        totalCards += result.cardsAdded;
        logger.debug(`API batch ${batch + 1}: start=${start} → +${result.cardsAdded} cards (total: ${totalCards})`);
        start += BATCH_SIZE;
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
        logger.debug(`API batch ${batch + 1}: start=${start} → 0 cards (empty ${consecutiveEmpty}/${MAX_EMPTY})`);
        if (consecutiveEmpty >= MAX_EMPTY) {
          logger.info(`All cards loaded via API: ${totalCards} total`);
          break;
        }
        start += BATCH_SIZE; // skip ahead in case of a gap
      }
    }
  }

  /**
   * Retries a job search with a clean browser context (no cookies).
   * Stale LinkedIn cookies can cause empty search results — this creates a
   * fresh context, performs the search, and returns the jobs found.
   * The authenticated context is preserved for detail-page access (apply links).
   */
  private async retrySearchWithoutCookies(keyword: string, searchUrl: string): Promise<ScrapedJob[]> {
    if (!this.browser) return [];

    const retryOpts = getBrowserLaunchOptions();
    const cleanContext = await this.browser.newContext({
      viewport: retryOpts.viewport,
      userAgent: retryOpts.userAgent,
    });
    const cleanPage = await cleanContext.newPage();

    // Temporarily swap to clean page so helper methods (dismissModals, scrollToLoadAllCards) work
    const authPage = this.page;
    const authContext = this.context;
    this.page = cleanPage;

    const allJobs: ScrapedJob[] = [];

    try {
      await this.page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitNavigation();
      await this.dismissModals();

      try {
        await this.page.waitForSelector(SELECTORS.search.jobCard, { timeout: 10_000 });
      } catch {
        // No cards appeared
      }

      await this.scrollToLoadAllCards();

      const totalCardCount = await this.page.$$eval(
        SELECTORS.search.jobCard,
        (cards) => cards.length,
      );
      logger.info(`Clean context loaded ${totalCardCount} cards for "${keyword}"`);

      if (totalCardCount === 0) return allJobs;

      // Bulk extraction — unauthenticated desktop renders all cards in DOM (no virtual scrolling)
      let extractionStats = { noTitle: 0, noCompany: 0, noLink: 0, noId: 0, success: 0 };
      const rawCards = await this.page.evaluate((sels) => {
        const cards = document.querySelectorAll(sels.jobCard);
        return Array.from(cards).map((card) => {
          const el = card as HTMLElement;
          const titleEl = el.querySelector(sels.jobTitle) as HTMLElement | null;
          const companyEl = el.querySelector(sels.companyName) as HTMLElement | null;
          const linkEl = el.querySelector(sels.jobLink) as HTMLElement | null;
          const dateEl = el.querySelector(sels.datePosted) as HTMLElement | null;
          const rawTitle = titleEl?.innerText?.trim() || "";
          const rawCompany = companyEl?.innerText?.trim() || "";
          let link = linkEl?.getAttribute("href") || "";
          if (!link) { const altA = el.querySelector('a[href*="jobs"]'); link = altA?.getAttribute("href") || ""; }
          const dateText = dateEl?.textContent?.trim() || "";
          const dateAttr = dateEl?.getAttribute("datetime")?.trim() || "";
          let cardTimeText = dateText;
          if (!cardTimeText && !dateAttr) {
            const text = el.innerText || "";
            const timeMatch = text.match(/(\d+\s*(?:second|minute|hour|day|week|month|min|hr|sec)s?\s*ago|just now|moments?\s*ago)/i);
            cardTimeText = timeMatch ? timeMatch[0] : "";
          }
          return { rawTitle, rawCompany, link, dateText, dateAttr, cardTimeText };
        });
      }, {
        jobCard: SELECTORS.search.jobCard,
        jobTitle: SELECTORS.search.jobTitle,
        companyName: SELECTORS.search.companyName,
        jobLink: SELECTORS.search.jobLink,
        datePosted: SELECTORS.search.datePosted,
      });

      for (const raw of rawCards) {
        let title = raw.rawTitle.split('\n')[0].trim();
        if (title.length > 6) {
          const half = Math.floor(title.length / 2);
          if (title.slice(0, half) === title.slice(half)) title = title.slice(0, half);
        }
        const company = raw.rawCompany.split('\n')[0].trim();
        if (!title || !company || !raw.link) {
          if (!title) extractionStats.noTitle++;
          if (!company) extractionStats.noCompany++;
          if (!raw.link) extractionStats.noLink++;
          continue;
        }
        const linkedinId = this.extractJobId(raw.link);
        if (!linkedinId) { extractionStats.noId++; continue; }
        const link = raw.link.startsWith("http") ? raw.link.split("?")[0] : `https://www.linkedin.com${raw.link.split("?")[0]}`;
        const postedDate = raw.dateText || raw.dateAttr || raw.cardTimeText;
        const minutesAgo = this.parseMinutesAgo(raw.cardTimeText || raw.dateText, raw.dateAttr);
        allJobs.push({ linkedinId, title, company, link, postedDate, minutesAgo });
        extractionStats.success++;
      }
      logger.info(`Clean context extraction stats for "${keyword}"`, extractionStats);

      allJobs.sort((a, b) => a.minutesAgo - b.minutesAgo);
    } catch (error) {
      logger.error(`Clean context retry failed for "${keyword}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Restore authenticated page/context for detail-page access (apply links)
      this.page = authPage;
      this.context = authContext;
      await cleanContext.close();
    }

    return allJobs;
  }

  /**
   * Extracts basic data from a single job card on the search results page.
   * Only grabs: title, company, posted time, link, and linkedinId.
   */
  private async extractCardData(
    card: any,
    cardIndex: number,
    stats: { noTitle: number; noCompany: number; noLink: number; noId: number; success: number },
  ): Promise<ScrapedJob | null> {
    const titleEl = await card.$(SELECTORS.search.jobTitle);
    const companyEl = await card.$(SELECTORS.search.companyName);
    const linkEl = await card.$(SELECTORS.search.jobLink);
    const dateEl = await card.$(SELECTORS.search.datePosted);

    // Use innerText (not textContent) to skip hidden/aria-hidden duplicates,
    // then take only the first line to strip "with verification" badge text.
    const rawTitle = titleEl
      ? await titleEl.evaluate((el: HTMLElement) => el.innerText?.trim() || "")
      : "";
    // LinkedIn sometimes doubles the title text (visible + hidden duplicate) — detect and fix
    let title = rawTitle.split('\n')[0].trim();
    if (title.length > 6) {
      const half = Math.floor(title.length / 2);
      if (title.slice(0, half) === title.slice(half)) {
        title = title.slice(0, half);
      }
    }
    const rawCompany = companyEl
      ? await companyEl.evaluate((el: HTMLElement) => el.innerText?.trim() || "")
      : "";
    const company = rawCompany.split('\n')[0].trim();
    const rawLink = linkEl ? (await linkEl.getAttribute("href")) || "" : "";

    // Also try to get jobId from the card's data attributes or other link patterns
    let alternateLink = "";
    if (!rawLink) {
      // Try getting href from any anchor in the card
      alternateLink = await card.evaluate((el: HTMLElement) => {
        const a = el.querySelector('a[href*="jobs"]');
        return a?.getAttribute("href") || "";
      });
    }
    const linkToUse = rawLink || alternateLink;

    // Log diagnostic info for cards that will fail extraction
    if (!title || !company || !linkToUse) {
      const cardHtml = await card.evaluate((el: HTMLElement) => el.innerHTML.slice(0, 500));
      const cardClasses = await card.evaluate((el: HTMLElement) => el.className);
      logger.debug(`Card ${cardIndex + 1} missing data`, {
        hasTitle: !!title,
        rawTitle: rawTitle.slice(0, 80),
        hasCompany: !!company,
        hasLink: !!linkToUse,
        rawLink,
        alternateLink,
        cardClasses,
        cardHtmlPreview: cardHtml,
      });
      if (!title) stats.noTitle++;
      if (!company) stats.noCompany++;
      if (!linkToUse) stats.noLink++;
      return null;
    }

    // Always try to extract date info, regardless of auth status.
    let postedDate = "";
    let minutesAgo = 0;

    const postedDateAttr = dateEl
      ? (await dateEl.getAttribute("datetime"))?.trim() || ""
      : "";
    const postedDateText = dateEl
      ? (await dateEl.textContent())?.trim() || ""
      : "";

    // If standard date selectors found nothing, scan the card's full text for time patterns
    let cardTimeText = postedDateText;
    if (!cardTimeText && !postedDateAttr) {
      cardTimeText = await card.evaluate((el: HTMLElement) => {
        const text = el.innerText || "";
        const timeMatch = text.match(
          /(\d+\s*(?:second|minute|hour|day|week|month|min|hr|sec)s?\s*ago|just now|moments?\s*ago)/i,
        );
        return timeMatch ? timeMatch[0] : "";
      });
      if (cardTimeText) {
        logger.debug(`Card ${cardIndex + 1}: extracted time from card text: "${cardTimeText}"`);
      }
    }

    postedDate = postedDateText || postedDateAttr || cardTimeText;
    minutesAgo = this.parseMinutesAgo(cardTimeText || postedDateText, postedDateAttr);

    // Extract LinkedIn job ID from the link
    const linkedinId = this.extractJobId(linkToUse);
    if (!linkedinId) {
      logger.warn(`Card ${cardIndex + 1}: Could not extract LinkedIn job ID`, { rawLink: linkToUse, title });
      stats.noId++;
      return null;
    }

    const link = linkToUse.startsWith("http")
      ? linkToUse.split("?")[0] // Clean tracking params
      : `https://www.linkedin.com${linkToUse.split("?")[0]}`;

    // Log the cleaned title vs raw for debugging
    if (rawTitle !== title) {
      logger.debug(`Title cleaned: "${rawTitle.slice(0, 60)}" → "${title}"`);
    }

    return {
      linkedinId,
      title,
      company,
      link,
      postedDate,
      minutesAgo,
    };
  }

  /**
   * Parses relative time text from LinkedIn cards into minutes.
   * Handles both full ("37 minutes ago") and abbreviated ("37m", "2h", "3d") formats,
   * as well as ISO datetime attributes.
   */
  private parseMinutesAgo(text: string, datetimeAttr?: string): number {
    const cleaned = text.toLowerCase().trim();

    // Try parsing the visible text first
    const fromText = this.parseRelativeTime(cleaned);
    if (fromText !== null) return fromText;

    // Fall back to the datetime attribute (ISO format like "2026-02-19T16:25:00.000Z")
    if (datetimeAttr) {
      const fromAttr = this.parseRelativeTime(datetimeAttr.toLowerCase().trim());
      if (fromAttr !== null) return fromAttr;

      // Try parsing as ISO date/datetime
      const fromIso = this.parseIsoDatetime(datetimeAttr.trim());
      if (fromIso !== null) return fromIso;
    }

    // Could not parse — treat as old to be safe so it gets filtered out.
    // This prevents week-old jobs from sneaking through when LinkedIn's URL time filter is unreliable.
    logger.warn("Could not parse job posting time — treating as old", { text, datetimeAttr });
    return 9999;
  }

  /**
   * Parses relative time from text, supporting both full and abbreviated formats.
   * Returns null if it can't parse the text.
   */
  private parseRelativeTime(text: string): number | null {
    // "just now" or "moments ago"
    if (text.includes("just now") || text.includes("moment")) return 0;

    // "X seconds ago" or "Xs"
    const secMatch = text.match(/(\d+)\s*(?:second|sec|s\b)/);
    if (secMatch) return 0;

    // "X minutes ago" or "X minute ago" or "Xm" or "X min"
    const minMatch = text.match(/(\d+)\s*(?:minute|min|m\b)/);
    if (minMatch) return parseInt(minMatch[1], 10);

    // "X hours ago" or "X hour ago" or "Xh" or "X hr"
    const hourMatch = text.match(/(\d+)\s*(?:hour|hr|h\b)/);
    if (hourMatch) return parseInt(hourMatch[1], 10) * 60;

    // "X days ago" or "X day ago" or "Xd"
    const dayMatch = text.match(/(\d+)\s*(?:day|d\b)/);
    if (dayMatch) return parseInt(dayMatch[1], 10) * 1440;

    // "X weeks ago" or "X week ago" or "Xw"
    const weekMatch = text.match(/(\d+)\s*(?:week|w\b)/);
    if (weekMatch) return parseInt(weekMatch[1], 10) * 10080;

    // "X months ago" or "Xmo"
    const monthMatch = text.match(/(\d+)\s*(?:month|mo\b)/);
    if (monthMatch) return parseInt(monthMatch[1], 10) * 43200;

    return null;
  }

  /**
   * Parses an ISO datetime string and returns how many minutes ago it was.
   * Handles: "2026-02-19T16:25:00.000Z", "2026-02-19", etc.
   */
  private parseIsoDatetime(isoStr: string): number | null {
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return null;

    const diffMs = Date.now() - date.getTime();
    if (diffMs < 0) return 0; // Future dates treated as "just now"

    return Math.round(diffMs / 60_000);
  }

  /**
   * Extracts the LinkedIn job ID from a job URL.
   * Example: linkedin.com/jobs/view/1234567890/ -> "1234567890"
   */
  private extractJobId(url: string): string | null {
    const match = url.match(/\/jobs\/view\/(\d+)/);
    if (match) return match[1];

    // Try alternate pattern from job cards
    const altMatch = url.match(/currentJobId=(\d+)/);
    if (altMatch) return altMatch[1];

    // Try data attribute pattern
    const idMatch = url.match(/(\d{8,})/);
    return idMatch ? idMatch[1] : null;
  }

  /**
   * Dismisses any login/signup modals that LinkedIn shows on public pages.
   * Tries multiple strategies: click dismiss buttons, press Escape, nuke overlay from DOM.
   */
  private async dismissModals(targetPage?: Page): Promise<void> {
    const page = targetPage || this.page;
    if (!page) return;

    try {
      // Strategy 1: Click any dismiss/close button (try ALL matches, not just first)
      const dismissBtns = await page.$$(SELECTORS.modals.dismissButton);
      for (const btn of dismissBtns) {
        try {
          await btn.click();
          logger.debug("Dismissed modal via button click");
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          // Button might be hidden or detached
        }
      }

      // Strategy 2: Press Escape key (catches modals with keyboard handlers)
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 200));

      // Strategy 3: If a blocking overlay is still present, remove it from the DOM
      const removedOverlay = await page.evaluate((overlaySelector) => {
        const overlays = document.querySelectorAll(overlaySelector);
        let removed = 0;
        overlays.forEach((el) => {
          el.remove();
          removed++;
        });
        // Also remove any full-screen auth walls
        const authWalls = document.querySelectorAll(
          '.authentication-outlet, [data-test="authwall-join-form"], .signup-modal, ' +
          '.join-form-container, div[class*="auth-wall"], div[class*="authwall"]'
        );
        authWalls.forEach((el) => {
          el.remove();
          removed++;
        });
        // Re-enable scrolling if it was blocked by a modal
        if (document.body.style.overflow === 'hidden') {
          document.body.style.overflow = '';
        }
        return removed;
      }, SELECTORS.modals.modalOverlay);

      if (removedOverlay > 0) {
        logger.debug(`Removed ${removedOverlay} modal overlay(s) from DOM`);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch {
      // Modal dismissal is best-effort
    }
  }

  /**
   * Extracts the external apply link from a job's detail page.
   * Requires an authenticated session. Returns empty string for Easy Apply jobs.
   *
   * Detection is URL-pattern based (not CSS classes or text), so it works
   * regardless of LinkedIn UI language or obfuscated class names:
   *   - Easy Apply: <a href="/jobs/view/{id}/apply/?openSDUIApplyFlow=true...">
   *   - External:   <a href="/redir/redirect/?url=https%3A%2F%2Fexternal.com...">
   */
  async extractApplyLink(job: ScrapedJob): Promise<string> {
    if (!this.isAuthenticated || !this.page || !this.context) return "";

    try {
      const detailUrl = `https://www.linkedin.com/jobs/view/${job.linkedinId}/`;
      logger.info(`Extracting apply link for "${job.title}"`, { url: detailUrl });

      await this.page.goto(detailUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });

      // Wait for the SPA to render the job detail content
      await this.page.waitForSelector('[data-view-name="job-detail-page"]', { timeout: 8_000 }).catch(() => null);
      // Brief extra wait for apply link to render
      await new Promise((r) => setTimeout(r, 1500));

      // Check if we got redirected to login (session expired mid-cycle)
      const currentUrl = this.page.url();
      if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
        logger.warn("Session expired mid-cycle — disabling apply link extraction");
        this.isAuthenticated = false;
        return "";
      }

      // Scan all <a> tags on the page for apply-related URL patterns.
      // This is language-independent and ignores obfuscated CSS classes.
      const result = await this.page.evaluate((linkedinId: string) => {
        const links = Array.from(document.querySelectorAll("a[href]"));

        for (const link of links) {
          const href = link.getAttribute("href") || "";

          // Pattern 1: External apply via LinkedIn redirect wrapper
          // e.g. /redir/redirect/?url=https%3A%2F%2Fjobs.lever.co%2F...
          if (href.includes("/redir/redirect")) {
            try {
              const url = new URL(href, window.location.origin);
              const target = url.searchParams.get("url");
              if (target) {
                return { type: "external", url: decodeURIComponent(target) };
              }
            } catch { /* ignore malformed URLs */ }
          }

          // Pattern 2: Easy Apply link
          // e.g. /jobs/view/4353485271/apply/?openSDUIApplyFlow=true
          if (href.includes(`/jobs/view/${linkedinId}/apply`)) {
            return { type: "easy_apply", url: "" };
          }
        }

        return { type: "not_found", url: "" };
      }, job.linkedinId);

      if (result.type === "external" && result.url) {
        logger.info(`  External apply link extracted`, { linkedinId: job.linkedinId, applyLink: result.url });
        await waitNavigation();
        return result.url;
      }

      if (result.type === "easy_apply") {
        logger.info(`  Easy Apply job — keeping LinkedIn link`, { linkedinId: job.linkedinId });
        await waitNavigation();
        return "";
      }

      logger.info(`  No apply link pattern found on page`, { linkedinId: job.linkedinId });
      await waitNavigation();
      return "";
    } catch (error) {
      logger.warn(`  Apply link extraction failed for "${job.title}"`, {
        linkedinId: job.linkedinId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    }
  }

  /**
   * Scans a single keyword with no experience level filter (catches all jobs including untagged).
   * Creates a separate browser context, extracts cards, and cleans up.
   *
   * @param keyword - The search keyword to scan
   * @returns Array of scraped jobs
   */
  async scanKeyword(keyword: string): Promise<ScrapedJob[]> {
    if (!this.browser) throw new Error("Browser not launched");

    const opts = getBrowserLaunchOptions();
    const ctx = await this.browser.newContext({
      viewport: opts.viewport,
      userAgent: opts.userAgent,
    });
    const page = await ctx.newPage();

    logger.info(`[${keyword}] Scanning (no experience level filter)`);

    let jobs: ScrapedJob[] = [];
    try {
      jobs = await this.scanSingleKeywordOnPage(page, keyword, 0, 1);
      logger.info(`[${keyword}] Scan complete: ${jobs.length} cards`);
    } catch (error) {
      logger.error(`[${keyword}] Scan failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try { await ctx.close(); } catch { /* ignore */ }

    return jobs;
  }

  /**
   * Scans all keywords in parallel using separate browser contexts with staggered starts.
   * Each keyword gets its own unauthenticated page (clean context, no cookies).
   * The stagger delay prevents rate limiting by spacing out initial requests.
   *
   * @param keywords - Array of search keywords
   * @param staggerMs - Delay between each keyword's start (default 5000ms)
   * @returns Map of keyword → scraped jobs
   */
  async scanAllKeywordsParallel(
    keywords: string[],
    staggerMs: number = 5000,
    onKeywordReady?: (keyword: string, jobs: ScrapedJob[]) => Promise<void>,
  ): Promise<Map<string, ScrapedJob[]>> {
    if (!this.browser) throw new Error("Browser not launched");

    const results = new Map<string, ScrapedJob[]>();

    if (keywords.length === 0) return results;

    // One scan per keyword — no experience level filter (catches all jobs including untagged)
    type ScanTask = { ctx: BrowserContext; page: Page; keyword: string; index: number };
    const scanTasks: ScanTask[] = [];

    for (let i = 0; i < keywords.length; i++) {
      const opts = getBrowserLaunchOptions();
      const ctx = await this.browser.newContext({
        viewport: opts.viewport,
        userAgent: opts.userAgent,
      });
      const page = await ctx.newPage();
      scanTasks.push({ ctx, page, keyword: keywords[i], index: i });
    }

    const totalTasks = scanTasks.length;
    logger.info(`Created ${totalTasks} parallel search pages (${keywords.length} keywords)`);

    const callbackPromises: Promise<void>[] = [];

    const scanPromises = scanTasks.map((task) => {
      return (async () => {
        // Stagger start — first task starts immediately, rest wait
        if (task.index > 0) {
          const delay = task.index * staggerMs;
          logger.info(
            `[parallel ${task.index + 1}/${totalTasks}] "${task.keyword}" waiting ${delay / 1000}s before start`,
          );
          await new Promise((r) => setTimeout(r, delay));
        }

        logger.info(
          `[parallel ${task.index + 1}/${totalTasks}] Starting scan for "${task.keyword}"`,
        );

        let jobs: ScrapedJob[] = [];
        try {
          jobs = await this.scanSingleKeywordOnPage(
            task.page, task.keyword, task.index, totalTasks,
          );
          logger.info(
            `[parallel ${task.index + 1}/${totalTasks}] Completed "${task.keyword}": ${jobs.length} cards`,
          );
        } catch (error) {
          logger.error(
            `[parallel ${task.index + 1}/${totalTasks}] Failed for "${task.keyword}"`,
            {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          );
        }

        results.set(task.keyword, jobs);

        // Close scan context (free memory early)
        try { await task.ctx.close(); } catch { /* ignore */ }

        // Fire callback if provided (errors isolated per keyword)
        if (onKeywordReady) {
          const cbPromise = onKeywordReady(task.keyword, jobs).catch((error) => {
            logger.error(`Processing callback failed for keyword "${task.keyword}"`, {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          callbackPromises.push(cbPromise);
        }
      })();
    });

    await Promise.all(scanPromises);
    // Wait for all processing callbacks to complete
    await Promise.all(callbackPromises);

    const totalCards = [...results.values()].reduce((sum, jobs) => sum + jobs.length, 0);
    logger.info(
      `Parallel scan complete: ${totalCards} total cards across ${keywords.length} keywords`,
    );

    return results;
  }

  /**
   * Scans a single keyword on a provided page (unauthenticated bulk extraction).
   * Used by scanAllKeywordsParallel for concurrent scanning.
   */
  private async scanSingleKeywordOnPage(
    page: Page,
    keyword: string,
    ki: number,
    total: number,
    experienceLevel?: string,
  ): Promise<ScrapedJob[]> {
    const allJobs: ScrapedJob[] = [];
    const label = `[parallel ${ki + 1}/${total}]`;

    // Build search URL
    const locationParam =
      config.search.locations.length > 0
        ? `&location=${encodeURIComponent(config.search.locations[0])}`
        : "";
    const geoParam = config.search.geoId
      ? `&geoId=${config.search.geoId}`
      : "";
    const expParam = experienceLevel ? `&f_E=${experienceLevel}` : "";
    const timeFilterSeconds = config.scraper.maxMinutesAgo * 60;
    const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&f_TPR=r${timeFilterSeconds}${locationParam}${geoParam}${expParam}&sortBy=DD`;

    logger.info(`${label} Navigating to search for "${keyword}"`, { url: searchUrl });

    // Navigate with retries (LinkedIn's filter is flaky)
    let totalCardCount = 0;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitNavigation();
      await this.dismissModals(page);

      try {
        await page.waitForSelector(SELECTORS.search.jobCard, { timeout: 10_000 });
      } catch {
        /* no cards appeared */
      }

      await this.dismissModals(page);
      await this.scrollToLoadAllCards(page);

      totalCardCount = await page.$$eval(
        SELECTORS.search.jobCard,
        (cards) => cards.length,
      );

      if (totalCardCount > 0) {
        if (attempt > 1)
          logger.info(`${label} Retry ${attempt} succeeded: ${totalCardCount} cards`);
        break;
      }

      const bodyPreview = await page.evaluate(
        () => document.body?.innerText?.slice(0, 300) || "",
      );
      logger.warn(`${label} Attempt ${attempt}/${maxRetries}: 0 cards for "${keyword}"`, {
        url: page.url(),
        bodyPreview,
      });

      if (attempt < maxRetries) {
        const retryDelay = attempt * 3000;
        logger.info(`${label} Retrying in ${retryDelay / 1000}s...`);
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }

    logger.info(`${label} Total cards loaded for "${keyword}": ${totalCardCount}`);
    if (totalCardCount === 0) return allJobs;

    // Bulk extraction (always unauthenticated — no virtual scrolling)
    let extractionStats = { noTitle: 0, noCompany: 0, noLink: 0, noId: 0, success: 0 };

    const rawCards = await page.evaluate(
      (sels) => {
        const cards = document.querySelectorAll(sels.jobCard);
        return Array.from(cards).map((card) => {
          const el = card as HTMLElement;
          const titleEl = el.querySelector(sels.jobTitle) as HTMLElement | null;
          const companyEl = el.querySelector(sels.companyName) as HTMLElement | null;
          const linkEl = el.querySelector(sels.jobLink) as HTMLElement | null;
          const dateEl = el.querySelector(sels.datePosted) as HTMLElement | null;

          const rawTitle = titleEl?.innerText?.trim() || "";
          const rawCompany = companyEl?.innerText?.trim() || "";
          let link = linkEl?.getAttribute("href") || "";
          if (!link) {
            const altA = el.querySelector('a[href*="jobs"]');
            link = altA?.getAttribute("href") || "";
          }
          const dateText = dateEl?.textContent?.trim() || "";
          const dateAttr = dateEl?.getAttribute("datetime")?.trim() || "";

          let cardTimeText = dateText;
          if (!cardTimeText && !dateAttr) {
            const text = el.innerText || "";
            const timeMatch = text.match(
              /(\d+\s*(?:second|minute|hour|day|week|month|min|hr|sec)s?\s*ago|just now|moments?\s*ago)/i,
            );
            cardTimeText = timeMatch ? timeMatch[0] : "";
          }

          return { rawTitle, rawCompany, link, dateText, dateAttr, cardTimeText };
        });
      },
      {
        jobCard: SELECTORS.search.jobCard,
        jobTitle: SELECTORS.search.jobTitle,
        companyName: SELECTORS.search.companyName,
        jobLink: SELECTORS.search.jobLink,
        datePosted: SELECTORS.search.datePosted,
      },
    );

    // Process raw data in Node.js
    for (const raw of rawCards) {
      let title = raw.rawTitle.split("\n")[0].trim();
      if (title.length > 6) {
        const half = Math.floor(title.length / 2);
        if (title.slice(0, half) === title.slice(half)) {
          title = title.slice(0, half);
        }
      }
      const company = raw.rawCompany.split("\n")[0].trim();

      if (!title || !company || !raw.link) {
        if (!title) extractionStats.noTitle++;
        if (!company) extractionStats.noCompany++;
        if (!raw.link) extractionStats.noLink++;
        continue;
      }

      const linkedinId = this.extractJobId(raw.link);
      if (!linkedinId) {
        extractionStats.noId++;
        continue;
      }

      const link = raw.link.startsWith("http")
        ? raw.link.split("?")[0]
        : `https://www.linkedin.com${raw.link.split("?")[0]}`;

      const postedDate = raw.dateText || raw.dateAttr || raw.cardTimeText;
      const minutesAgo = this.parseMinutesAgo(raw.cardTimeText || raw.dateText, raw.dateAttr);

      allJobs.push({ linkedinId, title, company, link, postedDate, minutesAgo });
      extractionStats.success++;
    }

    logger.info(`${label} Card extraction stats for "${keyword}"`, extractionStats);

    // Sort by most recent first
    allJobs.sort((a, b) => a.minutesAgo - b.minutesAgo);

    if (allJobs.length > 0) {
      const timeBuckets = {
        "≤10m": allJobs.filter((j) => j.minutesAgo <= 10).length,
        "11-60m": allJobs.filter((j) => j.minutesAgo > 10 && j.minutesAgo <= 60).length,
        ">1h": allJobs.filter((j) => j.minutesAgo > 60 && j.minutesAgo < 9999).length,
        unparsed: allJobs.filter((j) => j.minutesAgo === 9999).length,
      };
      logger.debug(`${label} Time distribution for "${keyword}"`, timeBuckets);
    }

    logger.info(
      `${label} Scan complete for "${keyword}": ${allJobs.length} cards extracted from ${totalCardCount} total`,
    );

    return allJobs;
  }

  /**
   * Closes the browser.
   */
  async close(): Promise<void> {
    try {
      if (this.searchContext) {
        await this.searchContext.close();
      }
      if (this.context) {
        await this.context.close();
      }
      if (this.browser) {
        await this.browser.close();
      }
      logger.info("Browser closed");
    } catch (error) {
      logger.error("Error closing browser", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.searchContext = null;
      this.searchPage = null;
    }
  }
}
