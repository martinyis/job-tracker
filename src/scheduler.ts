import { config } from './config';
import { logger } from './logger';
import { LinkedInScraper, ScrapedJob } from './scraper/linkedin-scraper';
import { getOrCreateProfileSummary } from './ai/resume-processor';
import { filterRelevantJobs } from './ai/job-matcher';
import {
  jobExistsBatch,
  saveJobMinimal,
  getScraperState,
  markScraperRunning,
  markScraperSuccess,
  markScraperError,
  resetScraperStateOnStartup,
} from './database/queries';

/**
 * Executes a single scrape cycle with the new pipeline:
 *
 * 1. Launch browser, scroll full page, extract ALL cards (title, company, time, link)
 * 2. Filter by time: keep only jobs posted within maxMinutesAgo (default 10 min)
 * 3. ONE AI call: batch-filter irrelevant titles (e.g. "Electrical Engineer")
 * 4. Check DB for duplicates (batch query)
 * 5. Save new relevant jobs with minimal data (title, company, link)
 *
 * No detail-page scraping. No per-job AI scoring. Fast and efficient.
 */
async function runScrapeCycle(): Promise<void> {
  const cycleStart = Date.now();
  logger.info('=== SCRAPE CYCLE: Starting ===');

  const state = await getScraperState();
  logger.info('Scraper state check', {
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt.toISOString(),
    lastSuccessAt: state.lastSuccessAt?.toISOString() ?? 'never',
    errorCount: state.errorCount,
  });

  // Prevent overlapping runs
  if (state.isRunning) {
    logger.warn('Previous scrape cycle still running, skipping');
    return;
  }

  // Check if paused due to too many errors
  if (state.errorCount >= config.scraper.maxConsecutiveErrors) {
    const pauseUntil = new Date(state.lastRunAt.getTime() + config.scraper.errorPauseMinutes * 60_000);
    if (new Date() < pauseUntil) {
      logger.warn('Scraper paused due to consecutive errors', {
        errorCount: state.errorCount,
        maxErrors: config.scraper.maxConsecutiveErrors,
        resumesAt: pauseUntil.toISOString(),
      });
      return;
    }
    logger.info('Error pause expired, resuming scraper');
  }

  await markScraperRunning();

  const scraper = new LinkedInScraper();
  let totalScanned = 0;
  let totalAfterTimeFilter = 0;
  let totalAfterAiFilter = 0;
  let totalNew = 0;
  let totalSaved = 0;

  try {
    // Load profile summary for AI relevance filtering
    logger.info('Loading profile summary for AI filtering...');
    const profileSummary = await getOrCreateProfileSummary();

    // Launch browser (loads LinkedIn cookies if available)
    logger.info('Launching browser...');
    await scraper.launch();
    logger.info('Browser launched', { authenticated: scraper.authenticated });

    const keywords = config.search.keywords;
    logger.info(`Scanning ${keywords.length} keywords`, { keywords });

    for (let ki = 0; ki < keywords.length; ki++) {
      const keyword = keywords[ki];
      logger.info(`[${ki + 1}/${keywords.length}] Scanning: "${keyword}"`);

      // STEP 1: Scroll full page, extract ALL cards
      const allCards = await scraper.scanAllCards(keyword);
      totalScanned += allCards.length;

      // Log all extracted card IDs and titles for traceability
      if (allCards.length > 0) {
        logger.info(`[${ki + 1}/${keywords.length}] Extracted cards`, {
          cards: allCards.map(j => ({ id: j.linkedinId, title: j.title, company: j.company, minutesAgo: j.minutesAgo })),
        });
      }

      if (allCards.length === 0) {
        logger.info(`[${ki + 1}/${keywords.length}] No cards found for "${keyword}"`);
        continue;
      }

      // STEP 2: Filter by time — keep only jobs posted within maxMinutesAgo.
      // When authenticated, cards lack time info so minutesAgo defaults to 0 (trusting URL filter).
      const recentCards = allCards.filter(
        (job) => job.minutesAgo <= config.scraper.maxMinutesAgo,
      );
      totalAfterTimeFilter += recentCards.length;

      const timeFilterNote = scraper.authenticated
        ? " (authenticated: relying on URL time filter)"
        : "";
      logger.info(
        `[${ki + 1}/${keywords.length}] Time filter: ${allCards.length} → ${recentCards.length} (kept jobs ≤${config.scraper.maxMinutesAgo}m old)${timeFilterNote}`,
      );

      if (recentCards.length === 0) {
        logger.info(`[${ki + 1}/${keywords.length}] No recent jobs for "${keyword}" after time filter`);
        continue;
      }

      // STEP 3: ONE AI call to filter irrelevant titles
      const relevantIds = await filterRelevantJobs(profileSummary, recentCards);
      const relevantCards = recentCards.filter((job) => relevantIds.has(job.linkedinId));
      totalAfterAiFilter += relevantCards.length;

      logger.info(
        `[${ki + 1}/${keywords.length}] AI filter: ${recentCards.length} → ${relevantCards.length} relevant`,
      );

      if (relevantCards.length === 0) {
        logger.info(`[${ki + 1}/${keywords.length}] No relevant jobs for "${keyword}" after AI filter`);
        continue;
      }

      // STEP 4: Batch DB check — which of these already exist?
      const existingIds = await jobExistsBatch(relevantCards.map((j) => j.linkedinId));
      const newCards = relevantCards.filter((job) => !existingIds.has(job.linkedinId));
      totalNew += newCards.length;

      logger.info(
        `[${ki + 1}/${keywords.length}] DB dedup: ${relevantCards.length} → ${newCards.length} new`,
      );

      // STEP 5: Extract apply links (if authenticated) and save new jobs
      for (const job of newCards) {
        try {
          // Extract external apply link before saving.
          // If external → use the external URL; if Easy Apply or extraction fails → use the LinkedIn job link.
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
          logger.info(`  SAVED: "${job.title}" at ${job.company} (${job.minutesAgo}m ago)`, {
            applyLink: applyLink ? 'extracted' : 'none',
          });
        } catch (error) {
          logger.error(`  Failed to save "${job.title}"`, {
            linkedinId: job.linkedinId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    await markScraperSuccess();

    const elapsed = Date.now() - cycleStart;
    logger.info('=== SCRAPE CYCLE: Complete ===', {
      totalScanned,
      totalAfterTimeFilter,
      totalAfterAiFilter,
      totalNew,
      totalSaved,
      authenticated: scraper.authenticated,
      keywords: keywords.length,
      elapsed: `${elapsed}ms`,
      elapsedReadable: `${Math.round(elapsed / 1000)}s`,
    });
  } catch (error) {
    await markScraperError();
    const elapsed = Date.now() - cycleStart;
    logger.error('=== SCRAPE CYCLE: Failed ===', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      elapsed: `${elapsed}ms`,
    });
  } finally {
    await scraper.close();
  }
}

/**
 * Starts the scheduler loop that runs scrape cycles
 * at the configured interval (default: 2 minutes).
 */
export async function startScheduler(): Promise<void> {
  const intervalMs = config.scraper.intervalMinutes * 60_000;

  logger.info('Starting job tracker scheduler', {
    intervalMinutes: config.scraper.intervalMinutes,
    keywords: config.search.keywords,
    maxMinutesAgo: config.scraper.maxMinutesAgo,
  });

  // Reset any stuck isRunning state from a previous crashed/killed session
  await resetScraperStateOnStartup();

  // Run immediately on start
  runScrapeCycle().catch((error) => {
    logger.error('Initial scrape cycle error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });

  // Then run on interval
  setInterval(() => {
    runScrapeCycle().catch((error) => {
      logger.error('Scheduled scrape cycle error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    });
  }, intervalMs);
}
