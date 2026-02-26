import { config, reloadConfig } from './config';
import { logger } from './logger';
import { LinkedInScraper, ScrapedJob } from './scraper/linkedin-scraper';
import { getOrCreateProfileSummary } from './ai/resume-processor';
import { filterRelevantJobs, ProfilePreferences } from './ai/job-matcher';
import {
  jobExistsBatch,
  saveJobMinimal,
  markScraperRunning,
  markScraperSuccess,
  markScraperError,
} from './database/queries';
import { getProfileForAI } from './database/profile-queries';

/** Flag to prevent new cycles from starting during graceful shutdown */
export let shutdownRequested = false;

export function requestShutdown(): void {
  shutdownRequested = true;
}

// ─── KeywordRunner ──────────────────────────────────────────────────────────

/**
 * Manages an independent scrape cycle for a single keyword.
 * Each cycle: launch browser → scan (Entry + Internship) → filter → save → close browser.
 * Runs on its own interval, fully independent of other keywords.
 */
class KeywordRunner {
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private cyclePromise: Promise<void> | null = null;
  private consecutiveErrors = 0;
  private lastErrorPauseAt: Date | null = null;

  constructor(readonly keyword: string) {}

  /** Start the runner with an optional initial delay (for staggering). */
  start(intervalMs: number, initialDelayMs: number = 0): void {
    if (this.intervalId) return;
    this.stopping = false;

    // First run after initial delay
    const firstRunTimeout = setTimeout(() => {
      if (this.stopping || shutdownRequested) return;
      this.triggerCycle();

      // Then repeat on interval
      this.intervalId = setInterval(() => {
        if (this.stopping || shutdownRequested) return;
        this.triggerCycle();
      }, intervalMs);
    }, initialDelayMs);

    // Store the timeout so we can clear it on stop
    this.intervalId = firstRunTimeout as unknown as NodeJS.Timeout;

    logger.info(`[${this.keyword}] Runner started`, {
      intervalMs,
      initialDelayMs,
    });
  }

  /** Stop the runner. Does not wait for in-progress cycle. */
  stop(): void {
    this.stopping = true;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
    logger.info(`[${this.keyword}] Runner stopped`);
  }

  /** Wait for any in-progress cycle to finish. Call after stop(). */
  async waitForCompletion(): Promise<void> {
    if (this.cyclePromise) {
      await this.cyclePromise;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private triggerCycle(): void {
    if (this.running) {
      logger.info(`[${this.keyword}] Cycle still running, skipping`);
      return;
    }
    this.cyclePromise = this.runCycle().catch((error) => {
      logger.error(`[${this.keyword}] Unhandled cycle error`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
  }

  private async runCycle(): Promise<void> {
    if (shutdownRequested || this.stopping) return;

    // Check error pause
    if (this.consecutiveErrors >= config.scraper.maxConsecutiveErrors) {
      const pauseMs = config.scraper.errorPauseMinutes * 60_000;
      if (this.lastErrorPauseAt && Date.now() - this.lastErrorPauseAt.getTime() < pauseMs) {
        logger.warn(`[${this.keyword}] Paused due to ${this.consecutiveErrors} consecutive errors`, {
          resumesIn: `${Math.round((pauseMs - (Date.now() - this.lastErrorPauseAt.getTime())) / 1000)}s`,
        });
        return;
      }
      logger.info(`[${this.keyword}] Error pause expired, resuming`);
      this.consecutiveErrors = 0;
    }

    this.running = true;
    const cycleStart = Date.now();
    logger.info(`[${this.keyword}] === CYCLE START ===`);

    await markScraperRunning();

    const scraper = new LinkedInScraper();

    try {
      // Reload config for fresh settings
      await reloadConfig();

      // Load profile data for AI filtering
      const profileSummary = await getOrCreateProfileSummary();
      const profileData = await getProfileForAI();
      const preferences: ProfilePreferences = {
        excludeTitleKeywords: profileData.excludeTitleKeywords,
        includeTitlePatterns: profileData.includeTitlePatterns,
        targetSeniority: profileData.targetSeniority,
        preferredTechStack: profileData.preferredTechStack,
        jobSearchDescription: profileData.jobSearchDescription,
      };

      // Launch browser
      await scraper.launch();

      // Scan keyword (both Entry + Internship exp levels in parallel)
      const allCards = await scraper.scanKeyword(this.keyword);

      let totalScanned = allCards.length;
      let totalAfterTimeFilter = 0;
      let totalAfterAiFilter = 0;
      let totalNew = 0;
      let totalSaved = 0;

      if (allCards.length > 0) {
        logger.info(`[${this.keyword}] Extracted ${allCards.length} cards`, {
          cards: allCards.map(j => ({ id: j.linkedinId, title: j.title, company: j.company, minutesAgo: j.minutesAgo })),
        });
      }

      if (allCards.length > 0) {
        // Time filter
        const recentCards = allCards.filter(
          (job) => job.minutesAgo <= config.scraper.maxMinutesAgo,
        );
        totalAfterTimeFilter = recentCards.length;
        logger.info(`[${this.keyword}] Time filter: ${allCards.length} → ${recentCards.length} (≤${config.scraper.maxMinutesAgo}m)`);

        // Company blacklist filter (zero cost, before AI)
        const BLACKLISTED_COMPANIES = ['lensa', 'jobs via dice'];
        const afterCompanyFilter = recentCards.filter((job) => {
          const companyLower = (job.company || '').toLowerCase().trim();
          return !BLACKLISTED_COMPANIES.some((bl) => companyLower.includes(bl));
        });
        if (afterCompanyFilter.length < recentCards.length) {
          logger.info(`[${this.keyword}] Company blacklist: ${recentCards.length} → ${afterCompanyFilter.length} (removed ${recentCards.length - afterCompanyFilter.length})`);
        }

        if (afterCompanyFilter.length > 0) {
          // AI filter
          const relevantIds = await filterRelevantJobs(profileSummary, afterCompanyFilter, preferences);
          const relevantCards = afterCompanyFilter.filter((job) => relevantIds.has(job.linkedinId));
          totalAfterAiFilter = relevantCards.length;
          logger.info(`[${this.keyword}] AI filter: ${afterCompanyFilter.length} → ${relevantCards.length} relevant`);

          if (relevantCards.length > 0) {
            // DB dedup
            const existingIds = await jobExistsBatch(relevantCards.map((j) => j.linkedinId));
            const newCards = relevantCards.filter((job) => !existingIds.has(job.linkedinId));
            totalNew = newCards.length;
            logger.info(`[${this.keyword}] DB dedup: ${relevantCards.length} → ${newCards.length} new`);

            // Extract apply links and save
            for (const job of newCards) {
              try {
                const externalApplyLink = await scraper.extractApplyLink(job);
                const applyLink = externalApplyLink || job.link;

                await saveJobMinimal({
                  linkedinId: job.linkedinId,
                  title: job.title,
                  company: job.company,
                  link: job.link,
                  applyLink,
                  postedDate: job.postedDate,
                });
                totalSaved++;
                logger.info(`[${this.keyword}]   SAVED: "${job.title}" at ${job.company} (${job.minutesAgo}m ago)`);
              } catch (error) {
                logger.error(`[${this.keyword}]   Failed to save "${job.title}"`, {
                  linkedinId: job.linkedinId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      }

      await markScraperSuccess();
      this.consecutiveErrors = 0;

      const elapsed = Date.now() - cycleStart;
      logger.info(`[${this.keyword}] === CYCLE COMPLETE ===`, {
        totalScanned,
        totalAfterTimeFilter,
        totalAfterAiFilter,
        totalNew,
        totalSaved,
        elapsed: `${elapsed}ms`,
        elapsedReadable: `${Math.round(elapsed / 1000)}s`,
      });
    } catch (error) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= config.scraper.maxConsecutiveErrors) {
        this.lastErrorPauseAt = new Date();
      }
      await markScraperError();
      const elapsed = Date.now() - cycleStart;
      logger.error(`[${this.keyword}] === CYCLE FAILED ===`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        consecutiveErrors: this.consecutiveErrors,
        elapsed: `${elapsed}ms`,
      });
    } finally {
      await scraper.close();
      this.running = false;
    }
  }
}

// ─── PerKeywordScheduler ────────────────────────────────────────────────────

/**
 * Manages independent KeywordRunners for each configured keyword.
 * Handles staggered starts, config reconciliation, and graceful shutdown.
 */
class PerKeywordScheduler {
  private runners = new Map<string, KeywordRunner>();
  private reconcileTimerId: NodeJS.Timeout | null = null;

  /** Start all keyword runners with staggered initial delays. */
  async start(): Promise<void> {
    const intervalMs = config.scraper.intervalMinutes * 60_000;
    const keywords = config.search.keywords;
    const STAGGER_MS = 15_000; // 15 seconds between each keyword start

    logger.info('PerKeywordScheduler starting', {
      keywords: keywords.length,
      intervalMinutes: config.scraper.intervalMinutes,
      staggerSeconds: STAGGER_MS / 1000,
    });

    // Pre-warm profile summary cache so first cycles don't all race to generate it
    logger.info('Pre-warming profile summary cache...');
    await getOrCreateProfileSummary();

    // Create and start a runner per keyword
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      const runner = new KeywordRunner(keyword);
      runner.start(intervalMs, i * STAGGER_MS);
      this.runners.set(keyword, runner);
    }

    // Reconcile every 60s: pick up keyword changes from config
    this.reconcileTimerId = setInterval(() => {
      this.reconcile().catch((error) => {
        logger.error('Reconcile error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 60_000);

    logger.info('PerKeywordScheduler started', {
      keywords: keywords.map((k, i) => `${k} (delay ${i * STAGGER_MS / 1000}s)`),
    });
  }

  /** Detect keyword changes in config and add/remove runners accordingly. */
  private async reconcile(): Promise<void> {
    await reloadConfig();
    const currentKeywords = new Set(config.search.keywords);
    const intervalMs = config.scraper.intervalMinutes * 60_000;

    // Remove runners for keywords no longer in config
    for (const [keyword, runner] of this.runners) {
      if (!currentKeywords.has(keyword)) {
        logger.info(`[reconcile] Removing runner for "${keyword}" (keyword removed from config)`);
        runner.stop();
        await runner.waitForCompletion();
        this.runners.delete(keyword);
      }
    }

    // Add runners for new keywords
    for (const keyword of currentKeywords) {
      if (!this.runners.has(keyword)) {
        logger.info(`[reconcile] Adding runner for "${keyword}" (new keyword in config)`);
        const runner = new KeywordRunner(keyword);
        runner.start(intervalMs, 0); // start immediately for newly added keywords
        this.runners.set(keyword, runner);
      }
    }
  }

  /** Stop all runners and wait for in-progress cycles to finish. */
  async stopAll(): Promise<void> {
    logger.info('PerKeywordScheduler stopping all runners...');

    // Stop the reconcile timer
    if (this.reconcileTimerId) {
      clearInterval(this.reconcileTimerId);
      this.reconcileTimerId = null;
    }

    // Stop all runners (prevents new cycles)
    for (const runner of this.runners.values()) {
      runner.stop();
    }

    // Wait for all in-progress cycles to complete
    const waitPromises = [...this.runners.values()].map(r => r.waitForCompletion());
    await Promise.all(waitPromises);

    logger.info('PerKeywordScheduler all runners stopped');
  }

  /** Check if any keyword runner has a cycle in progress. */
  isAnyRunning(): boolean {
    for (const runner of this.runners.values()) {
      if (runner.isRunning) return true;
    }
    return false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SchedulerHandle {
  stop: () => void;
  stopAll: () => Promise<void>;
  isAnyRunning: () => boolean;
}

/**
 * Starts independent per-keyword scrape schedulers.
 * Each keyword gets its own cycle running on the global interval.
 * Keywords are staggered to avoid resource spikes.
 */
export async function startScheduler(): Promise<SchedulerHandle> {
  logger.info('Starting per-keyword scheduler', {
    intervalMinutes: config.scraper.intervalMinutes,
    keywords: config.search.keywords,
    maxMinutesAgo: config.scraper.maxMinutesAgo,
  });

  const scheduler = new PerKeywordScheduler();
  await scheduler.start();

  return {
    stop: () => {
      // Legacy — just stops the reconcile timer. Use stopAll for full shutdown.
      scheduler.stopAll().catch(() => {});
    },
    stopAll: () => scheduler.stopAll(),
    isAnyRunning: () => scheduler.isAnyRunning(),
  };
}
