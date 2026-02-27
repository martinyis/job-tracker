import { prisma } from '../database/client';
import { logger } from '../logger';

const CLEANUP_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Deletes all jobs with status "rejected" from the database.
 */
async function deleteRejectedJobs(): Promise<void> {
  try {
    const result = await prisma.job.deleteMany({
      where: { status: 'rejected' },
    });
    if (result.count > 0) {
      logger.info(`Rejected job cleanup: deleted ${result.count} rejected jobs`);
    }
  } catch (error) {
    logger.error('Rejected job cleanup failed', { error });
  }
}

/**
 * Starts a background interval that deletes rejected jobs every 2 hours.
 * Runs an initial cleanup immediately on startup.
 */
export function startRejectedJobCleanup(): NodeJS.Timeout {
  // Run once immediately on startup
  deleteRejectedJobs();

  return setInterval(deleteRejectedJobs, CLEANUP_INTERVAL_MS);
}
