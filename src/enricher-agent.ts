import { config, initConfig, validateConfig } from './config';
import { logger } from './logger';
import { disconnectDatabase } from './database/client';
import {
  getEnricherState,
  setEnricherPid,
  clearEnricherPid,
  resetEnricherStateOnStartup,
  markEnricherProcessing,
  markEnricherSuccess,
  markEnricherError,
  getNextJobToEnrich,
  updateJobEnrichment,
  markJobEnrichmentFailed,
} from './database/enrichment-queries';
import { getProfileForEnrichmentAI } from './database/profile-queries';
import { DetailScraper, SessionExpiredError } from './scraper/detail-scraper';
import { analyzeEnrichedJob } from './ai/job-enricher';
import {
  checkDealbreakers,
  calculateDeterministicScores,
  computeFinalScore,
  assignPriority,
} from './ai/scoring-engine';
import { randomDelay } from './scraper/anti-detection';
import { isTelegramConfigured, sendUrgentJobNotification } from './notifications/telegram';

let shutdownRequested = false;
let detailScraper: DetailScraper | null = null;

async function main(): Promise<void> {
  logger.info('Enricher agent starting', { pid: process.pid });

  await initConfig();

  const { valid, errors } = validateConfig();
  if (!valid) {
    for (const error of errors) {
      logger.error(`Config error: ${error}`);
    }
    logger.error('Enricher agent cannot start — configuration invalid');
    process.exit(1);
  }

  // Check if another enricher is already running
  const existingState = await getEnricherState();
  if (existingState.pid !== null) {
    let alive = false;
    try {
      process.kill(existingState.pid, 0);
      alive = true;
    } catch {
      // Process is dead — safe to take over
    }
    if (alive) {
      logger.error('Another enricher agent is already running', { existingPid: existingState.pid });
      console.error(`ERROR: Another enricher agent is already running (PID ${existingState.pid}). Stop it first.`);
      process.exit(1);
    }
  }

  await resetEnricherStateOnStartup();
  await setEnricherPid(process.pid);
  logger.info('Enricher agent registered', { pid: process.pid });

  await enrichmentLoop();
}

async function enrichmentLoop(): Promise<void> {
  const ERROR_PAUSE_THRESHOLD = 5;
  const ERROR_PAUSE_MS = 30 * 60 * 1000; // 30 minutes
  const IDLE_POLL_MS = 30_000; // 30 seconds
  const BETWEEN_JOBS_DELAY = { min: 3000, max: 8000 };
  const BROWSER_RESTART_INTERVAL = 50; // Restart browser every N jobs
  let jobsProcessedSinceBrowserStart = 0;

  while (!shutdownRequested) {
    try {
      // Reload config each iteration
      await initConfig();

      // Check error pause
      const state = await getEnricherState();
      if (state.errorCount >= ERROR_PAUSE_THRESHOLD) {
        const pauseEnd = new Date(state.lastRunAt.getTime() + ERROR_PAUSE_MS);
        if (new Date() < pauseEnd) {
          const remainingMin = Math.ceil((pauseEnd.getTime() - Date.now()) / 60000);
          logger.info(`Enricher paused due to ${state.errorCount} consecutive errors. Resuming in ${remainingMin}m`);
          await sleep(60_000);
          continue;
        }
      }

      // Get next job
      const job = await getNextJobToEnrich();
      if (!job) {
        // Queue is empty — close browser to save resources
        if (detailScraper?.isOpen) {
          logger.info('Enrichment queue empty — closing browser');
          await detailScraper.close();
          detailScraper = null;
          jobsProcessedSinceBrowserStart = 0;
        }
        await sleep(IDLE_POLL_MS);
        continue;
      }

      // Launch browser if needed
      if (!detailScraper?.isOpen) {
        try {
          detailScraper = new DetailScraper();
          await detailScraper.launch();
          jobsProcessedSinceBrowserStart = 0;
        } catch (error) {
          if (error instanceof SessionExpiredError) {
            logger.error(`Enricher: ${error.message}`);
          } else {
            logger.error('Enricher: failed to launch browser', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await markEnricherError();
          detailScraper = null;
          await sleep(60_000);
          continue;
        }
      }

      // Restart browser periodically to prevent memory leaks
      if (jobsProcessedSinceBrowserStart >= BROWSER_RESTART_INTERVAL) {
        logger.info('Enricher: restarting browser to prevent memory leaks', {
          jobsProcessed: jobsProcessedSinceBrowserStart,
        });
        await detailScraper!.close();
        detailScraper = new DetailScraper();
        await detailScraper.launch();
        jobsProcessedSinceBrowserStart = 0;
      }

      // Process the job
      logger.info('Enriching job', {
        id: job.id,
        title: job.title,
        company: job.company,
        linkedinId: job.linkedinId,
      });

      await markEnricherProcessing();

      // Step 1: Scrape the detail page
      let jobDetail;
      try {
        jobDetail = await detailScraper!.scrapeJobDetail(job.linkedinId);
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          logger.error('Enricher: session expired during scraping', {
            linkedinId: job.linkedinId,
          });
          await detailScraper!.close();
          detailScraper = null;
          await markEnricherError();
          continue;
        }
        logger.error('Enricher: failed to scrape job detail', {
          linkedinId: job.linkedinId,
          error: error instanceof Error ? error.message : String(error),
        });
        await markJobEnrichmentFailed(job.id);
        await markEnricherError();
        // Continue to next job
        await sleep(randomDelay(BETWEEN_JOBS_DELAY.min, BETWEEN_JOBS_DELAY.max));
        continue;
      }

      // Step 2: Load profile context
      const profileContext = await getProfileForEnrichmentAI();

      // Step 3: AI analysis
      const analysis = await analyzeEnrichedJob(profileContext, {
        title: job.title,
        company: job.company,
        location: job.location,
        description: jobDetail.description,
        companyInfo: jobDetail.companyInfo,
        contactPeople: jobDetail.contactPeople,
        postedBy: jobDetail.postedBy,
        postedByTitle: jobDetail.postedByTitle,
        applicantCount: jobDetail.applicantCount,
        seniorityLevel: jobDetail.seniorityLevel,
        employmentType: jobDetail.employmentType,
        jobFunction: jobDetail.jobFunction,
      });

      // Step 4: Scoring pipeline
      let computedScore = 0;
      let computedPriority = 'normal';
      let computedPriorityReason = '';
      let scoreBreakdown: object = {};
      let triggeredDealbreaker = '';

      if (analysis.aiFailed) {
        // AI failed — save scraped data with defaults, don't penalize
        computedScore = 0;
        computedPriority = 'normal';
        computedPriorityReason = 'AI analysis failed — scoring unavailable';
      } else {
        // Check dealbreakers first
        const dealbreaker = checkDealbreakers(analysis.dealbreakers, profileContext.yearsOfExperience);

        if (dealbreaker) {
          // Dealbreaker triggered — score 0, priority low
          computedScore = 0;
          computedPriority = 'low';
          triggeredDealbreaker = dealbreaker;

          const reasonMap: Record<string, string> = {
            seniorityTooHigh: 'Dealbreaker: role requires senior-level experience',
            clearanceRequired: 'Dealbreaker: requires security clearance',
            wrongTechDomain: 'Dealbreaker: primary tech stack has no overlap with candidate skills',
            experienceRequires6Plus: `Dealbreaker: requires ${analysis.dealbreakers.experienceMinYears}+ years of experience`,
            experienceGapTooLarge: `Dealbreaker: requires ${analysis.dealbreakers.experienceMinYears}+ years, candidate has ${profileContext.yearsOfExperience}`,
          };
          computedPriorityReason = reasonMap[dealbreaker] || `Dealbreaker: ${dealbreaker}`;

          // Still build a partial breakdown for transparency
          scoreBreakdown = {
            dealbreaker,
            scores: analysis.scores,
            extracted: analysis.extracted,
            baseScore: 0,
            finalScore: 0,
            minYearsExtracted: analysis.dealbreakers.experienceMinYears,
          };
        } else {
          // No dealbreaker — run full scoring
          const deterministicScores = calculateDeterministicScores(
            {
              seniorityLevel: jobDetail.seniorityLevel,
              applicantCount: jobDetail.applicantCount,
              postedBy: jobDetail.postedBy,
              postedByProfile: jobDetail.postedByProfile,
            },
            {
              yearsOfExperience: profileContext.yearsOfExperience,
              willingToRelocate: profileContext.willingToRelocate,
              remoteOnly: profileContext.remoteOnly,
            },
            analysis.extracted,
            analysis.dealbreakers.experienceMinYears,
          );

          const result = computeFinalScore(analysis.scores, deterministicScores, analysis.extracted);

          computedScore = result.finalScore;
          computedPriority = assignPriority(result.finalScore, analysis.extracted.urgencySignalMatched);
          computedPriorityReason = analysis.analysis.matchReason;

          result.breakdown.minYearsExtracted = analysis.dealbreakers.experienceMinYears;
          scoreBreakdown = result.breakdown;
        }
      }

      // Step 5: Save enrichment data
      await updateJobEnrichment(job.id, {
        description: jobDetail.description,
        priority: computedPriority,
        priorityReason: computedPriorityReason,
        matchScore: computedScore,
        matchReason: analysis.analysis.matchReason,
        keyMatches: analysis.analysis.keyMatches,
        actionItems: analysis.analysis.actionItems,
        redFlags: analysis.analysis.redFlags,
        companyInfo: jobDetail.companyInfo,
        applicantCount: jobDetail.applicantCount,
        seniorityLevel: jobDetail.seniorityLevel,
        employmentType: jobDetail.employmentType,
        jobFunction: jobDetail.jobFunction,
        postedBy: jobDetail.postedBy,
        postedByTitle: jobDetail.postedByTitle,
        postedByProfile: jobDetail.postedByProfile,
        contactPeople: jobDetail.contactPeople,
        scoreBreakdown,
        dealbreaker: triggeredDealbreaker,
        ...(triggeredDealbreaker ? { status: 'rejected' } : {}),
      });

      await markEnricherSuccess();

      // Send Telegram notification for urgent jobs
      if (computedPriority === 'urgent' && !analysis.aiFailed && isTelegramConfigured()) {
        await sendUrgentJobNotification(
          {
            title: job.title,
            company: job.company,
            link: job.link,
            applyLink: job.applyLink,
            postedBy: jobDetail.postedBy,
            postedByTitle: jobDetail.postedByTitle,
          },
          {
            priorityReason: computedPriorityReason,
            matchReason: analysis.analysis.matchReason,
            actionItems: analysis.analysis.actionItems,
          },
        );
      }

      jobsProcessedSinceBrowserStart++;

      logger.info('Job enriched successfully', {
        id: job.id,
        title: job.title,
        company: job.company,
        priority: computedPriority,
        matchScore: computedScore,
        dealbreaker: triggeredDealbreaker || 'none',
        aiFailed: analysis.aiFailed ?? false,
        notified: computedPriority === 'urgent' && !analysis.aiFailed && isTelegramConfigured(),
      });

      // Anti-detection delay between jobs
      await sleep(randomDelay(BETWEEN_JOBS_DELAY.min, BETWEEN_JOBS_DELAY.max));
    } catch (error) {
      logger.error('Enricher loop unexpected error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await markEnricherError();
      await sleep(10_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Enricher agent received ${signal}, shutting down gracefully...`);
  shutdownRequested = true;

  // Wait for current job to finish (up to 2 minutes)
  const maxWaitMs = 120_000;
  const pollMs = 1000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const state = await getEnricherState();
    if (!state.isProcessing) break;
    logger.info('Waiting for current enrichment to finish...');
    await sleep(pollMs);
  }

  // Close browser
  if (detailScraper?.isOpen) {
    await detailScraper.close();
  }

  await clearEnricherPid();
  await disconnectDatabase();
  logger.info('Enricher agent shut down cleanly');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('Enricher agent uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Enricher agent unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch(async (error) => {
  logger.error('Enricher agent fatal error', {
    error: error instanceof Error ? error.message : String(error),
  });
  await clearEnricherPid().catch(() => {});
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
