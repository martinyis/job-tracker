import { prisma } from './client';
import { logger } from '../logger';

/** Shape of a job record as extracted from scraping + AI matching */
export interface JobInput {
  linkedinId: string;
  title: string;
  company: string;
  location: string;
  description: string;
  link: string;
  applyLink: string;
  postedDate: string;
  matchScore: number;
  matchReason: string;
  keyMatches: string[];
}

/** Possible application status values */
export type JobStatus = 'new' | 'applying' | 'applied' | 'skipped' | 'failed' | 'reviewed' | 'rejected';

/**
 * Checks if a job with the given LinkedIn ID already exists in the database.
 */
export async function jobExists(linkedinId: string): Promise<boolean> {
  const count = await prisma.job.count({ where: { linkedinId } });
  return count > 0;
}

/**
 * Checks multiple LinkedIn IDs at once and returns the set of IDs that already exist.
 * Much faster than calling jobExists() in a loop.
 */
export async function jobExistsBatch(linkedinIds: string[]): Promise<Set<string>> {
  if (linkedinIds.length === 0) return new Set();

  const existing = await prisma.job.findMany({
    where: { linkedinId: { in: linkedinIds } },
    select: { linkedinId: true },
  });

  return new Set(existing.map((j) => j.linkedinId));
}

/** Minimal data needed to save a job from the new scraper flow */
export interface JobMinimalInput {
  linkedinId: string;
  title: string;
  company: string;
  link: string;
  applyLink?: string;
  postedDate: string;
}

/**
 * Saves a job with only the essential fields (title, company, link).
 * All other fields use their schema defaults.
 */
export async function saveJobMinimal(input: JobMinimalInput) {
  try {
    const job = await prisma.job.create({
      data: {
        linkedinId: input.linkedinId,
        title: input.title,
        company: input.company,
        link: input.link,
        applyLink: input.applyLink || '',
        postedDate: input.postedDate,
        status: 'new',
      },
    });

    logger.info('Saved new job (minimal)', {
      id: job.id,
      title: job.title,
      company: job.company,
    });

    return job;
  } catch (error) {
    logger.error('Failed to save job', { linkedinId: input.linkedinId, error });
    throw error;
  }
}

/**
 * Saves multiple minimal jobs in a single transaction.
 */
export async function saveJobsMinimalBatch(inputs: JobMinimalInput[]) {
  return prisma.$transaction(
    inputs.map((input) =>
      prisma.job.create({
        data: {
          linkedinId: input.linkedinId,
          title: input.title,
          company: input.company,
          link: input.link,
          applyLink: input.applyLink || '',
          postedDate: input.postedDate,
          status: 'new',
        },
      }),
    ),
  );
}

/**
 * Saves a new matched job to the database.
 * Returns the created job record or null if it already exists.
 */
export async function saveJob(input: JobInput) {
  try {
    const existing = await jobExists(input.linkedinId);
    if (existing) {
      logger.debug('Job already exists, skipping', { linkedinId: input.linkedinId });
      return null;
    }

    const job = await prisma.job.create({
      data: {
        linkedinId: input.linkedinId,
        title: input.title,
        company: input.company,
        location: input.location,
        description: input.description,
        link: input.link,
        applyLink: input.applyLink || '',
        postedDate: input.postedDate,
        matchScore: input.matchScore,
        matchReason: input.matchReason,
        keyMatches: JSON.stringify(input.keyMatches),
        status: 'new',
      },
    });

    logger.info('Saved new job', {
      id: job.id,
      title: job.title,
      company: job.company,
      score: job.matchScore,
    });

    return job;
  } catch (error) {
    logger.error('Failed to save job', { linkedinId: input.linkedinId, error });
    throw error;
  }
}

/**
 * Saves multiple jobs in a single transaction for better performance.
 */
export async function saveJobsBatch(inputs: JobInput[]) {
  return prisma.$transaction(
    inputs.map((input) =>
      prisma.job.create({
        data: {
          linkedinId: input.linkedinId,
          title: input.title,
          company: input.company,
          location: input.location,
          description: input.description,
          link: input.link,
          applyLink: input.applyLink || '',
          postedDate: input.postedDate,
          matchScore: input.matchScore,
          matchReason: input.matchReason,
          keyMatches: JSON.stringify(input.keyMatches),
          status: 'new',
        },
      }),
    ),
  );
}

/**
 * Retrieves all jobs, optionally filtered by status.
 * Results are sorted by match score (desc) then creation date (desc).
 */
export async function getJobs(status?: JobStatus) {
  return prisma.job.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ matchScore: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * Gets a single job by its database ID.
 */
export async function getJobById(id: string) {
  return prisma.job.findUnique({ where: { id } });
}

/**
 * Updates the application status of a job.
 */
export async function updateJobStatus(id: string, status: JobStatus) {
  return prisma.job.update({
    where: { id },
    data: { status },
  });
}

/**
 * Adds or updates a user note on a job.
 */
export async function updateJobNotes(id: string, notes: string) {
  return prisma.job.update({
    where: { id },
    data: { notes },
  });
}

/**
 * Returns summary statistics for the dashboard.
 */
export async function getStats() {
  const [total, byStatus, avgScore] = await Promise.all([
    prisma.job.count(),
    prisma.job.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.job.aggregate({
      _avg: { matchScore: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of byStatus) {
    statusCounts[row.status] = row._count.id;
  }

  return {
    totalJobs: total,
    statusCounts,
    averageScore: Math.round(avgScore._avg.matchScore ?? 0),
  };
}

// ─── Scraper State ────────────────────────────────────────

/**
 * Retrieves the current scraper state, creating the singleton row if needed.
 */
export async function getScraperState() {
  let state = await prisma.scraperState.findUnique({ where: { id: 'singleton' } });
  if (!state) {
    state = await prisma.scraperState.create({ data: { id: 'singleton' } });
  }
  return state;
}

/**
 * Marks the scraper as currently running.
 */
export async function markScraperRunning() {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { isRunning: true, lastRunAt: new Date() },
    create: { id: 'singleton', isRunning: true, lastRunAt: new Date() },
  });
}

/**
 * Marks a successful scraper run, resetting the error count.
 */
export async function markScraperSuccess() {
  return prisma.scraperState.update({
    where: { id: 'singleton' },
    data: {
      isRunning: false,
      lastSuccessAt: new Date(),
      errorCount: 0,
    },
  });
}

/**
 * Marks a failed scraper run, incrementing the error count.
 */
export async function markScraperError() {
  const state = await getScraperState();
  return prisma.scraperState.update({
    where: { id: 'singleton' },
    data: {
      isRunning: false,
      errorCount: state.errorCount + 1,
    },
  });
}

/**
 * Resets the scraper state on startup.
 * If isRunning is true from a previous crashed/killed run, reset it so the scraper can proceed.
 * Also clears any stale PID from a previous process.
 */
export async function resetScraperStateOnStartup() {
  const state = await getScraperState();
  if (state.isRunning || state.pid !== null) {
    logger.warn('Scraper state was stuck from a previous session — resetting', {
      lastRunAt: state.lastRunAt.toISOString(),
      errorCount: state.errorCount,
      stalePid: state.pid,
    });
    await prisma.scraperState.update({
      where: { id: 'singleton' },
      data: { isRunning: false, pid: null },
    });
  }
  return state;
}

/**
 * Sets the scraper agent's PID in the database.
 */
export async function setScraperPid(pid: number) {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { pid },
    create: { id: 'singleton', pid },
  });
}

/**
 * Clears the scraper agent's PID and resets isRunning.
 */
export async function clearScraperPid() {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { pid: null, isRunning: false },
    create: { id: 'singleton' },
  });
}
