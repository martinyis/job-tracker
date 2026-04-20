import { PrismaClient } from '@prisma/client';
import { DetailScraper, LoginBlockedError } from './scraper/detail-scraper';
import { randomDelay } from './scraper/anti-detection';
import { initConfig } from './config';
import { logger } from './logger';

const prisma = new PrismaClient();
let shutdownRequested = false;
let detailScraper: DetailScraper | null = null;

function parseApplicantCount(text: string): number | null {
  if (!text) return null;
  const match = text.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function main(): Promise<void> {
  logger.info('Applicant filter starting', { pid: process.pid });

  await initConfig();

  // Get all "new" jobs that haven't been checked yet
  const jobs = await prisma.job.findMany({
    where: { status: 'new' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, linkedinId: true, title: true, company: true, applicantCount: true },
  });

  if (jobs.length === 0) {
    logger.info('No new jobs to filter');
    return;
  }

  // Split: jobs that already have applicant data (from enrichment) vs those that need scraping
  const alreadyHaveCount = jobs.filter((j) => j.applicantCount && j.applicantCount.length > 0);
  const needScraping = jobs.filter((j) => !j.applicantCount || j.applicantCount.length === 0);

  let rejectedCount = 0;
  let processedCount = 0;
  const total = jobs.length;

  // Phase 1: Check jobs that already have applicant count data (no browser needed)
  for (const job of alreadyHaveCount) {
    if (shutdownRequested) break;

    processedCount++;
    const count = parseApplicantCount(job.applicantCount);

    if (count !== null && count >= 100) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'rejected',
          dealbreaker: 'tooManyApplicants',
          rejectedAt: new Date(),
        },
      });
      rejectedCount++;
      logger.info(`[${processedCount}/${total}] ${job.title} @ ${job.company} → REJECTED (${count} applicants, cached)`);
    } else {
      logger.info(`[${processedCount}/${total}] ${job.title} @ ${job.company} → kept (${job.applicantCount || 'no data'}, cached)`);
    }
  }

  if (needScraping.length === 0 || shutdownRequested) {
    logger.info('Applicant filter complete', { total, rejected: rejectedCount, processedCount });
    return;
  }

  // Phase 2: Scrape jobs that don't have applicant count yet
  logger.info(`Launching browser to check ${needScraping.length} jobs without applicant data`);

  const BETWEEN_JOBS_DELAY = { min: 3000, max: 8000 };
  const BROWSER_RESTART_INTERVAL = 50;
  let jobsSinceBrowserStart = 0;

  try {
    detailScraper = new DetailScraper();
    await detailScraper.launch();
  } catch (error) {
    logger.error('Failed to launch browser', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const job of needScraping) {
    if (shutdownRequested) break;

    processedCount++;

    // Restart browser periodically
    if (jobsSinceBrowserStart >= BROWSER_RESTART_INTERVAL) {
      logger.info('Restarting browser to prevent memory leaks');
      await detailScraper!.close();
      detailScraper = new DetailScraper();
      await detailScraper.launch();
      jobsSinceBrowserStart = 0;
    }

    try {
      const detail = await detailScraper!.scrapeJobDetail(job.linkedinId);
      const count = parseApplicantCount(detail.applicantCount);

      if (detail.notAcceptingApplications) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'rejected',
            dealbreaker: 'notAcceptingApplications',
            applicantCount: detail.applicantCount,
            rejectedAt: new Date(),
          },
        });
        rejectedCount++;
        logger.info(`[${processedCount}/${total}] ${job.title} @ ${job.company} → REJECTED (no longer accepting applications)`);
      } else if (count !== null && count >= 100) {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'rejected',
            dealbreaker: 'tooManyApplicants',
            applicantCount: detail.applicantCount,
            rejectedAt: new Date(),
          },
        });
        rejectedCount++;
        logger.info(`[${processedCount}/${total}] ${job.title} @ ${job.company} → REJECTED (${count} applicants)`);
      } else {
        // Save the applicant count even if we're not rejecting
        await prisma.job.update({
          where: { id: job.id },
          data: { applicantCount: detail.applicantCount },
        });
        logger.info(`[${processedCount}/${total}] ${job.title} @ ${job.company} → kept (${detail.applicantCount || 'no count found'})`);
      }
    } catch (error) {
      if (error instanceof LoginBlockedError) {
        logger.warn(`[${processedCount}/${total}] ${job.title} @ ${job.company} → skipped (login blocked)`);
      } else {
        logger.error(`[${processedCount}/${total}] ${job.title} @ ${job.company} → error`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    jobsSinceBrowserStart++;
    await sleep(randomDelay(BETWEEN_JOBS_DELAY.min, BETWEEN_JOBS_DELAY.max));
  }

  logger.info('Applicant filter complete', {
    total,
    processed: processedCount,
    rejected: rejectedCount,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Applicant filter received ${signal}, shutting down...`);
  shutdownRequested = true;

  if (detailScraper?.isOpen) {
    await detailScraper.close();
  }

  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main()
  .catch(async (error) => {
    logger.error('Applicant filter fatal error', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  })
  .finally(async () => {
    if (detailScraper?.isOpen) {
      await detailScraper.close();
    }
    await prisma.$disconnect();
  });
