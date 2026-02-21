import { prisma } from './client';

// ─── ApplicationLog CRUD ────────────────────────────────

export async function createApplicationLog(data: {
  jobId: string;
  status: string;
  reason?: string;
  formType?: string;
  fieldsFilledCount?: number;
  aiCallsUsed?: number;
  durationMs?: number;
  screenshotPath?: string;
}) {
  return prisma.applicationLog.create({
    data: {
      jobId: data.jobId,
      status: data.status,
      reason: data.reason ?? '',
      formType: data.formType ?? '',
      fieldsFilledCount: data.fieldsFilledCount ?? 0,
      aiCallsUsed: data.aiCallsUsed ?? 0,
      durationMs: data.durationMs ?? 0,
      screenshotPath: data.screenshotPath ?? '',
    },
  });
}

export async function getApplicationLogsForJob(jobId: string) {
  return prisma.applicationLog.findMany({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getRecentApplicationLogs(limit = 50) {
  return prisma.applicationLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      job: { select: { title: true, company: true } },
    },
  });
}

export async function getApplicationStats() {
  const byStatus = await prisma.applicationLog.groupBy({
    by: ['status'],
    _count: { id: true },
  });

  const counts: Record<string, number> = {};
  for (const row of byStatus) {
    counts[row.status] = row._count.id;
  }

  return {
    applied: counts['applied'] ?? 0,
    skipped: counts['skipped'] ?? 0,
    failed: counts['failed'] ?? 0,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}
