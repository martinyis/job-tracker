import { prisma } from '../database/client';
import { logger } from '../logger';

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const SPAM_THRESHOLD = 5;

/**
 * Finds companies with 5+ "new" jobs and rejects all their postings.
 * Large companies that mass-post positions are not worth applying to.
 */
async function rejectSpamCompanies(): Promise<void> {
  try {
    const companyCounts = await prisma.job.groupBy({
      by: ['company'],
      where: { status: 'new' },
      _count: { id: true },
    });

    const spamCompanies = companyCounts
      .filter((c) => c._count.id >= SPAM_THRESHOLD)
      .map((c) => c.company);

    if (spamCompanies.length === 0) return;

    const result = await prisma.job.updateMany({
      where: { company: { in: spamCompanies }, status: 'new' },
      data: { status: 'rejected' },
    });

    logger.info(
      `Spam company detector: rejected ${result.count} jobs from ${spamCompanies.length} companies`,
      { companies: spamCompanies },
    );
  } catch (error) {
    logger.error('Spam company detector failed', { error });
  }
}

/**
 * Starts a background interval that checks for spam companies every 2 minutes.
 * Runs an initial check immediately on startup.
 */
export function startSpamCompanyDetector(): NodeJS.Timeout {
  rejectSpamCompanies();
  return setInterval(rejectSpamCompanies, CHECK_INTERVAL_MS);
}
