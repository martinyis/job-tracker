import { prisma } from './client';
import { logger } from '../logger';

export type JobStatus = 'new' | 'applied' | 'reviewed' | 'rejected';

export async function jobExistsBatch(linkedinIds: string[]): Promise<Set<string>> {
  if (linkedinIds.length === 0) return new Set();

  const existing = await prisma.job.findMany({
    where: { linkedinId: { in: linkedinIds } },
    select: { linkedinId: true },
  });

  return new Set(existing.map((j) => j.linkedinId));
}

export interface JobMinimalInput {
  linkedinId: string;
  title: string;
  company: string;
  link: string;
  applyLink?: string;
  postedDate: string;
}

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

export async function getJobs(status?: JobStatus) {
  const jobs = await prisma.job.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  });

  const priorityRank: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
  return jobs.sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3));
}

export async function getJobById(id: string) {
  return prisma.job.findUnique({ where: { id } });
}

export async function updateJobStatus(id: string, status: JobStatus) {
  return prisma.job.update({
    where: { id },
    data: { status },
  });
}

export async function updateJobNotes(id: string, notes: string) {
  return prisma.job.update({
    where: { id },
    data: { notes },
  });
}

export async function getStats() {
  const [total, byStatus, byPriority, pendingEnrichment] = await Promise.all([
    prisma.job.count(),
    prisma.job.groupBy({
      by: ['status'] as const,
      _count: { id: true },
    }),
    prisma.job.groupBy({
      by: ['priority'] as const,
      _count: { id: true },
    }),
    prisma.job.count({
      where: { enrichmentStatus: 'pending' },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of byStatus) {
    statusCounts[row.status] = row._count.id;
  }

  const priorityCounts: Record<string, number> = {};
  for (const row of byPriority) {
    priorityCounts[row.priority] = row._count.id;
  }

  return {
    totalJobs: total,
    statusCounts,
    priorityCounts,
    pendingEnrichment,
  };
}

// ─── Scraper State ────────────────────────────────────────

export async function getScraperState() {
  let state = await prisma.scraperState.findUnique({ where: { id: 'singleton' } });
  if (!state) {
    state = await prisma.scraperState.create({ data: { id: 'singleton' } });
  }
  return state;
}

export async function markScraperRunning() {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { isRunning: true, lastRunAt: new Date() },
    create: { id: 'singleton', isRunning: true, lastRunAt: new Date() },
  });
}

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

export async function setScraperPid(pid: number) {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { pid },
    create: { id: 'singleton', pid },
  });
}

export async function clearScraperPid() {
  return prisma.scraperState.upsert({
    where: { id: 'singleton' },
    update: { pid: null, isRunning: false },
    create: { id: 'singleton' },
  });
}
