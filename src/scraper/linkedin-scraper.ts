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
  private isAuthenticated: boolean = false;

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
      // f_TPR=rN means "posted within last N seconds". Use maxMinutesAgo * 60 to match config.
      // Clamp to at least 3600 (1 hour) since LinkedIn may not support very short intervals.
      const timeFilterSeconds = Math.max(config.scraper.maxMinutesAgo * 60, 3600);
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&f_TPR=r${timeFilterSeconds}${locationParam}${geoParam}&sortBy=DD`;

      logger.info(`Scanning ALL cards for "${keyword}"`, { url: searchUrl });

      await this.page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitNavigation();

      // Dismiss any login/signup modals
      await this.dismissModals();

      // Wait for job cards to render (authenticated LinkedIn is a React SPA that loads async)
      try {
        await this.page.waitForSelector(SELECTORS.search.jobCard, { timeout: 10_000 });
        logger.debug("Job cards detected on page");
      } catch {
        // Cards didn't appear — could be empty results or selector mismatch
        logger.debug("No job cards appeared within timeout");
      }

      // Scroll to load all cards (list order is random, recent jobs can be anywhere)
      await this.scrollToLoadAllCards();

      // Count total cards (including occluded placeholders)
      const totalCardCount = await this.page.$$eval(
        SELECTORS.search.jobCard,
        (cards) => cards.length,
      );
      logger.info(`Total cards loaded for "${keyword}": ${totalCardCount}`);

      if (totalCardCount === 0) {
        // Diagnostic: log page state to help debug selector issues
        const diagnostics = await this.page.evaluate(() => {
          const body = document.body?.innerText?.slice(0, 500) || "";
          const containers = [
            '.jobs-search-results-list',
            '.scaffold-layout__list',
            '.jobs-search-results__list',
            'ul.jobs-search__results-list',
            '[class*="job"]',
          ];
          const found: Record<string, number> = {};
          for (const sel of containers) {
            try { found[sel] = document.querySelectorAll(sel).length; } catch {}
          }
          return { bodyPreview: body.slice(0, 300), containers: found };
        });
        logger.warn("No job cards found", {
          keyword,
          url: this.page.url(),
          ...diagnostics,
        });
        return allJobs;
      }

      // LinkedIn authenticated uses "occludable" virtual scrolling:
      // Only cards visible in the viewport have rendered content.
      // Cards outside the viewport are empty placeholders.
      // Solution: scroll each card into view one at a time, then extract it.
      let extractionStats = { noTitle: 0, noCompany: 0, noLink: 0, noId: 0, success: 0 };
      for (let i = 0; i < totalCardCount; i++) {
        try {
          // Scroll this specific card into view to force LinkedIn to render it
          const cardSelector = SELECTORS.search.jobCard;
          await this.page.evaluate(({ selector, index }: { selector: string; index: number }) => {
            const cards = document.querySelectorAll(selector);
            if (cards[index]) {
              cards[index].scrollIntoView({ block: 'center', behavior: 'instant' });
            }
          }, { selector: cardSelector, index: i });
          // Brief wait for LinkedIn to render the card content
          await new Promise((r) => setTimeout(r, 200));

          // Re-query the card after scroll (DOM reference may have been updated)
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
    }

    return allJobs;
  }

  /**
   * Scrolls the page to load ALL job cards as fast as possible.
   * LinkedIn loads ~25 cards at a time. For 100-170 cards that's ~4-7 scrolls.
   *
   * The list is NOT sorted by time, so recent jobs can be anywhere —
   * we must load everything before filtering.
   */
  private async scrollToLoadAllCards(): Promise<void> {
    if (!this.page) return;

    const maxScrollAttempts = 12; // Safety limit (~300 cards worth)
    let previousCardCount = 0;
    let staleRounds = 0;

    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      const currentCount = await this.page.$$eval(
        SELECTORS.search.jobCard,
        (cards) => cards.length,
      );

      if (currentCount === previousCardCount) {
        staleRounds++;
        // Be more patient when we haven't found any cards yet (SPA may still be loading)
        const staleThreshold = currentCount === 0 ? 4 : 2;
        if (staleRounds >= staleThreshold) {
          logger.info(`All cards loaded: ${currentCount} total`);
          break;
        }
      } else {
        staleRounds = 0;
        logger.debug(`Scroll ${attempt + 1}: ${previousCardCount} → ${currentCount} cards`);
      }

      previousCardCount = currentCount;

      // Scroll to bottom
      await this.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await new Promise((r) => setTimeout(r, 800));

      // Dismiss any modals that appeared
      await this.dismissModals();

      // Click "See more jobs" if present
      try {
        const seeMoreBtn = await this.page.$(
          'button[aria-label="See more jobs"], button.infinite-scroller__show-more-button',
        );
        if (seeMoreBtn) {
          await seeMoreBtn.click();
          logger.debug("Clicked 'See more jobs'");
          await new Promise((r) => setTimeout(r, 800));
        }
      } catch {
        // Button might not exist — that's fine
      }
    }
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

    // When authenticated, cards lack date info — skip parsing and trust the URL time filter.
    let postedDate = "";
    let minutesAgo = 0;

    if (!this.isAuthenticated) {
      const postedDateAttr = dateEl
        ? (await dateEl.getAttribute("datetime"))?.trim() || ""
        : "";
      const postedDateText = dateEl
        ? (await dateEl.textContent())?.trim() || ""
        : "";

      postedDate = postedDateText || postedDateAttr;
      minutesAgo = this.parseMinutesAgo(postedDateText, postedDateAttr);
    }

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

    // Could not parse — when authenticated, cards lack time info so assume recent (URL filter handles it).
    // When unauthenticated, treat as old to be safe.
    if (this.isAuthenticated) {
      return 0;
    }
    logger.warn("Could not parse job posting time", { text, datetimeAttr });
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
   */
  private async dismissModals(): Promise<void> {
    if (!this.page) return;

    try {
      const dismissBtn = await this.page.$(SELECTORS.modals.dismissButton);
      if (dismissBtn) {
        await dismissBtn.click();
        logger.debug("Dismissed modal/popup");
        await new Promise((r) => setTimeout(r, 500));
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
   * Closes the browser.
   */
  async close(): Promise<void> {
    try {
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
    }
  }
}
