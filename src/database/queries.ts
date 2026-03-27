import { prisma } from './client';
import { logger } from '../logger';

export type JobStatus = 'new' | 'accepted' | 'applied' | 'interviewing' | 'rejected';

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

// ─── Paginated Jobs Query ─────────────────────────────────

export interface PaginatedJobsParams {
  status?: JobStatus;
  sortBy?: string;
  filter?: string;
  offset?: number;
  limit?: number;
}

export interface PaginatedJobsResult {
  jobs: Awaited<ReturnType<typeof prisma.job.findMany>>;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export async function getJobsPaginated(params: PaginatedJobsParams = {}): Promise<PaginatedJobsResult> {
  const {
    status,
    sortBy = 'newest',
    filter = 'all',
    offset = 0,
    limit = 50,
  } = params;

  // Build where clause
  const where: Record<string, unknown> = {};
  if (status) where.status = status;

  // Sub-filters
  if (filter === 'today') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    where.createdAt = { gte: todayStart };
  } else if (filter === 'urgent') {
    where.priority = 'urgent';
  } else if (filter === 'high+') {
    where.priority = { in: ['urgent', 'high'] };
  } else if (filter === 'enriched') {
    where.enrichmentStatus = 'enriched';
  } else if (filter === 'pending') {
    where.enrichmentStatus = 'pending';
  } else if (filter === 'dealbreaker') {
    where.dealbreaker = { not: '' };
  } else if (filter === 'no-dealbreaker') {
    where.dealbreaker = '';
  }

  // Build orderBy
  let orderBy: Record<string, string>[] = [{ createdAt: 'desc' }];
  if (sortBy === 'oldest') {
    orderBy = [{ createdAt: 'asc' }];
  } else if (sortBy === 'score-desc') {
    orderBy = [{ matchScore: 'desc' }, { createdAt: 'desc' }];
  } else if (sortBy === 'score-asc') {
    orderBy = [{ matchScore: 'asc' }, { createdAt: 'desc' }];
  } else if (sortBy === 'company') {
    orderBy = [{ company: 'asc' }, { createdAt: 'desc' }];
  }
  // 'priority' and 'newest' use default (createdAt desc); priority does JS post-sort

  const [jobs, total] = await Promise.all([
    prisma.job.findMany({
      where,
      orderBy,
      skip: offset,
      take: limit,
    }),
    prisma.job.count({ where }),
  ]);

  // Priority sort: JS post-sort since priority is a string enum, not easily sortable in SQL
  if (sortBy === 'priority') {
    const priorityRank: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4, '': 5 };
    jobs.sort((a, b) => {
      const pa = priorityRank[a.priority] ?? 5;
      const pb = priorityRank[b.priority] ?? 5;
      if (pa !== pb) return pa - pb;
      return (b.matchScore || 0) - (a.matchScore || 0);
    });
  }

  return {
    jobs,
    total,
    offset,
    limit,
    hasMore: offset + jobs.length < total,
  };
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
  const data: Record<string, unknown> = { status };

  // Track when status changes for analytics
  data.appliedAt = status === 'applied' ? new Date() : null;
  data.rejectedAt = status === 'rejected' ? new Date() : null;

  return prisma.job.update({
    where: { id },
    data,
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

// ─── Analytics Queries ────────────────────────────────────

export interface DailyCount {
  date: string; // "YYYY-MM-DD"
  count: number;
}

// Note: Prisma stores DateTime as Unix milliseconds in SQLite.
// We must use `column / 1000, 'unixepoch'` for SQLite date functions.

/**
 * Get the SQLite time modifier string for a given IANA timezone.
 * Returns e.g. '-7 hours' for America/Los_Angeles (PDT) or '-4 hours' for America/New_York (EDT).
 * This shifts UTC times to local time in SQL queries.
 */
export function getTimezoneOffsetModifier(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(now);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  // tzPart.value is like "GMT-7", "GMT+5:30", "GMT-4"
  const match = tzPart?.value?.match(/GMT([+-]?\d+)(?::(\d+))?/);
  if (!match) return '+0 hours'; // fallback to UTC
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2] || '0', 10);
  // For half-hour offsets (India, etc), approximate to nearest hour
  const totalHours = hours + (hours >= 0 ? minutes / 60 : -minutes / 60);
  const rounded = Math.round(totalHours);
  return `${rounded >= 0 ? '+' + rounded : String(rounded)} hours`;
}

export async function getAppliedPerDay(days: number = 30, timezone: string = 'UTC'): Promise<DailyCount[]> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ date: string; count: bigint }>>(
    `SELECT date(appliedAt / 1000, 'unixepoch', '${tz}') as date, COUNT(*) as count
     FROM Job
     WHERE appliedAt IS NOT NULL
       AND date(appliedAt / 1000, 'unixepoch', '${tz}') >= date('now', '${tz}', '-${days} days')
     GROUP BY date(appliedAt / 1000, 'unixepoch', '${tz}')
     ORDER BY date ASC`
  );
  return results.map((r) => ({ date: r.date, count: Number(r.count) }));
}

export async function getCreatedPerDay(days: number = 30, timezone: string = 'UTC'): Promise<DailyCount[]> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ date: string; count: bigint }>>(
    `SELECT date(createdAt / 1000, 'unixepoch', '${tz}') as date, COUNT(*) as count
     FROM Job
     WHERE date(createdAt / 1000, 'unixepoch', '${tz}') >= date('now', '${tz}', '-${days} days')
     GROUP BY date(createdAt / 1000, 'unixepoch', '${tz}')
     ORDER BY date ASC`
  );
  return results.map((r) => ({ date: r.date, count: Number(r.count) }));
}

export async function getRejectedPerDay(days: number = 30, timezone: string = 'UTC'): Promise<DailyCount[]> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ date: string; count: bigint }>>(
    `SELECT date(rejectedAt / 1000, 'unixepoch', '${tz}') as date, COUNT(*) as count
     FROM Job
     WHERE rejectedAt IS NOT NULL
       AND date(rejectedAt / 1000, 'unixepoch', '${tz}') >= date('now', '${tz}', '-${days} days')
     GROUP BY date(rejectedAt / 1000, 'unixepoch', '${tz}')
     ORDER BY date ASC`
  );
  return results.map((r) => ({ date: r.date, count: Number(r.count) }));
}

export async function getTodayAppliedCount(timezone: string = 'UTC'): Promise<number> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) as count FROM Job
     WHERE appliedAt IS NOT NULL
       AND date(appliedAt / 1000, 'unixepoch', '${tz}') = date('now', '${tz}')`
  );
  return Number(results[0]?.count ?? 0);
}

export async function getWeeklyAppliedCount(timezone: string = 'UTC'): Promise<number> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) as count FROM Job
     WHERE appliedAt IS NOT NULL
       AND date(appliedAt / 1000, 'unixepoch', '${tz}') >= date('now', '${tz}', 'weekday 0', '-6 days')`
  );
  return Number(results[0]?.count ?? 0);
}

export async function getAverageDailyApplied(days: number = 30, timezone: string = 'UTC'): Promise<number> {
  const tz = getTimezoneOffsetModifier(timezone);
  const results = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*) as count FROM Job
     WHERE appliedAt IS NOT NULL
       AND date(appliedAt / 1000, 'unixepoch', '${tz}') >= date('now', '${tz}', '-${days} days')`
  );
  const total = Number(results[0]?.count ?? 0);
  return Math.round((total / days) * 10) / 10;
}
