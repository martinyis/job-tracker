import { prisma } from '../database/client';
import { logger } from '../logger';

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const SPAM_THRESHOLD = 5;

// Companies to always reject regardless of post count (case-insensitive substring match)
const BLOCKED_COMPANIES = [
  'Mercor',
  'Data Annotations',
];

/**
 * Rejects jobs from explicitly blocked companies (substring match, case-insensitive).
 */
async function rejectBlockedCompanies(): Promise<void> {
  if (BLOCKED_COMPANIES.length === 0) return;

  const conditions = BLOCKED_COMPANIES.map((name) => ({
    company: { contains: name },
  }));

  const result = await prisma.job.updateMany({
    where: {
      status: 'new',
      OR: conditions,
    },
    data: { status: 'rejected', rejectedAt: new Date() },
  });

  if (result.count > 0) {
    logger.info(`Blocked company filter: rejected ${result.count} jobs`, {
      blocklist: BLOCKED_COMPANIES,
    });
  }
}

/**
 * Finds companies with 5+ "new" jobs and rejects all their postings.
 * Large companies that mass-post positions are not worth applying to.
 */
async function rejectSpamCompanies(): Promise<void> {
  try {
    await rejectBlockedCompanies();

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
      data: { status: 'rejected', rejectedAt: new Date() },
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
