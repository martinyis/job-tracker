import { chromium } from "./stealth-browser";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { config } from "../config";
import { logger } from "../logger";
import { SELECTORS } from "./selectors";
import {
  getBrowserLaunchOptions,
  waitNavigation,
} from "./anti-detection";

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

    this.page = await this.context.newPage();
    logger.info("Browser page created and ready");
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
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&f_TPR=r60${locationParam}${geoParam}&sortBy=DD`;

      logger.info(`Scanning ALL cards for "${keyword}"`, { url: searchUrl });

      await this.page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitNavigation();

      // Dismiss any login/signup modals
      await this.dismissModals();

      // Scroll to load all cards (list order is random, recent jobs can be anywhere)
      await this.scrollToLoadAllCards();

      // Now extract data from every card
      const jobCards = await this.page.$$(SELECTORS.search.jobCard);
      logger.info(`Total cards loaded for "${keyword}": ${jobCards.length}`);

      if (jobCards.length === 0) {
        const bodyText = await this.page.evaluate(
          () => document.body?.innerText?.slice(0, 500) || "",
        );
        logger.warn("No job cards found", {
          keyword,
          url: this.page.url(),
          bodyPreview: bodyText.slice(0, 300),
        });
        return allJobs;
      }

      for (let i = 0; i < jobCards.length; i++) {
        try {
          const cardData = await this.extractCardData(jobCards[i]);
          if (!cardData) continue;
          allJobs.push(cardData);
        } catch (error) {
          logger.warn(`Card ${i + 1} extraction failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Sort by most recent first
      allJobs.sort((a, b) => a.minutesAgo - b.minutesAgo);

      logger.info(
        `Scan complete for "${keyword}": ${allJobs.length} cards extracted from ${jobCards.length} total`,
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
        if (staleRounds >= 2) {
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
  private async extractCardData(card: any): Promise<ScrapedJob | null> {
    const titleEl = await card.$(SELECTORS.search.jobTitle);
    const companyEl = await card.$(SELECTORS.search.companyName);
    const linkEl = await card.$(SELECTORS.search.jobLink);
    const dateEl = await card.$(SELECTORS.search.datePosted);

    const title = titleEl ? (await titleEl.textContent())?.trim() || "" : "";
    const company = companyEl
      ? (await companyEl.textContent())?.trim() || ""
      : "";
    const rawLink = linkEl ? (await linkEl.getAttribute("href")) || "" : "";

    // Get both the datetime attribute and the visible text for posted time
    const postedDateAttr = dateEl
      ? (await dateEl.getAttribute("datetime"))?.trim() || ""
      : "";
    const postedDateText = dateEl
      ? (await dateEl.textContent())?.trim() || ""
      : "";

    // Use visible text for recency parsing, fall back to datetime attr for display
    const postedDate = postedDateText || postedDateAttr;
    const minutesAgo = this.parseMinutesAgo(postedDateText || postedDateAttr);

    if (!title || !company) {
      return null;
    }

    // Extract LinkedIn job ID from the link
    const linkedinId = this.extractJobId(rawLink);
    if (!linkedinId) {
      logger.warn("Could not extract LinkedIn job ID", { rawLink });
      return null;
    }

    const link = rawLink.startsWith("http")
      ? rawLink.split("?")[0] // Clean tracking params
      : `https://www.linkedin.com${rawLink.split("?")[0]}`;

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
   * Examples: "37 minutes ago" -> 37, "1 hour ago" -> 60, "2 days ago" -> 2880
   */
  private parseMinutesAgo(text: string): number {
    const cleaned = text.toLowerCase().trim();

    // "just now" or "moments ago"
    if (cleaned.includes("just now") || cleaned.includes("moment")) return 0;

    // "X seconds ago"
    const secMatch = cleaned.match(/(\d+)\s*second/);
    if (secMatch) return 0;

    // "X minutes ago" or "X minute ago"
    const minMatch = cleaned.match(/(\d+)\s*minute/);
    if (minMatch) return parseInt(minMatch[1], 10);

    // "X hours ago" or "X hour ago"
    const hourMatch = cleaned.match(/(\d+)\s*hour/);
    if (hourMatch) return parseInt(hourMatch[1], 10) * 60;

    // "X days ago" or "X day ago"
    const dayMatch = cleaned.match(/(\d+)\s*day/);
    if (dayMatch) return parseInt(dayMatch[1], 10) * 1440;

    // "X weeks ago" or "X week ago"
    const weekMatch = cleaned.match(/(\d+)\s*week/);
    if (weekMatch) return parseInt(weekMatch[1], 10) * 10080;

    // Could not parse — treat as old
    return 9999;
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
