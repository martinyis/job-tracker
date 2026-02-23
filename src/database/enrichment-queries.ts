import { prisma } from './client';
import { logger } from '../logger';

// ─── EnricherState ───────────────────────────────────────

export async function getEnricherState() {
  let state = await prisma.enricherState.findUnique({ where: { id: 'singleton' } });
  if (!state) {
    state = await prisma.enricherState.create({ data: { id: 'singleton' } });
  }
  return state;
}

export async function setEnricherPid(pid: number) {
  return prisma.enricherState.upsert({
    where: { id: 'singleton' },
    update: { pid },
    create: { id: 'singleton', pid },
  });
}

export async function clearEnricherPid() {
  return prisma.enricherState.upsert({
    where: { id: 'singleton' },
    update: { pid: null, isProcessing: false },
    create: { id: 'singleton' },
  });
}

export async function resetEnricherStateOnStartup() {
  const state = await getEnricherState();
  if (state.isProcessing || state.pid !== null) {
    logger.warn('Enricher state was stuck from a previous session — resetting', {
      lastRunAt: state.lastRunAt.toISOString(),
      errorCount: state.errorCount,
      stalePid: state.pid,
    });
    await prisma.enricherState.update({
      where: { id: 'singleton' },
      data: { isProcessing: false, pid: null },
    });
  }
  return state;
}

export async function markEnricherProcessing() {
  return prisma.enricherState.upsert({
    where: { id: 'singleton' },
    update: { isProcessing: true, lastRunAt: new Date() },
    create: { id: 'singleton', isProcessing: true, lastRunAt: new Date() },
  });
}

export async function markEnricherSuccess() {
  const state = await getEnricherState();
  return prisma.enricherState.update({
    where: { id: 'singleton' },
    data: {
      isProcessing: false,
      lastSuccessAt: new Date(),
      errorCount: 0,
      totalEnriched: state.totalEnriched + 1,
    },
  });
}

export async function markEnricherError() {
  const state = await getEnricherState();
  return prisma.enricherState.update({
    where: { id: 'singleton' },
    data: {
      isProcessing: false,
      errorCount: state.errorCount + 1,
      totalFailed: state.totalFailed + 1,
    },
  });
}

// ─── Job Enrichment Queries ──────────────────────────────

export async function getNextJobToEnrich() {
  return prisma.job.findFirst({
    where: {
      enrichmentStatus: 'pending',
      status: { not: 'rejected' },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getEnrichmentQueueSize() {
  return prisma.job.count({
    where: {
      enrichmentStatus: 'pending',
      status: { not: 'rejected' },
    },
  });
}

export interface EnrichmentData {
  description: string;
  priority: string;
  priorityReason: string;
  matchScore: number;
  matchReason: string;
  keyMatches: string[];
  actionItems: string[];
  redFlags: string[];
  companyInfo: string;
  applicantCount: string;
  seniorityLevel: string;
  employmentType: string;
  jobFunction: string;
  postedBy: string;
  postedByTitle: string;
  postedByProfile: string;
  contactPeople: Array<{ name: string; title: string; profileUrl: string }>;
}

export async function updateJobEnrichment(id: string, data: EnrichmentData) {
  return prisma.job.update({
    where: { id },
    data: {
      description: data.description,
      priority: data.priority,
      priorityReason: data.priorityReason,
      matchScore: data.matchScore,
      matchReason: data.matchReason,
      keyMatches: JSON.stringify(data.keyMatches),
      actionItems: JSON.stringify(data.actionItems),
      redFlags: JSON.stringify(data.redFlags),
      companyInfo: data.companyInfo,
      applicantCount: data.applicantCount,
      seniorityLevel: data.seniorityLevel,
      employmentType: data.employmentType,
      jobFunction: data.jobFunction,
      postedBy: data.postedBy,
      postedByTitle: data.postedByTitle,
      postedByProfile: data.postedByProfile,
      contactPeople: JSON.stringify(data.contactPeople),
      enrichmentStatus: 'enriched',
      enrichedAt: new Date(),
    },
  });
}

export async function markJobEnrichmentFailed(id: string) {
  return prisma.job.update({
    where: { id },
    data: { enrichmentStatus: 'failed' },
  });
}

export async function getJobForTestNotification() {
  const urgent = await prisma.job.findFirst({
    where: { priority: 'urgent', enrichmentStatus: 'enriched' },
    orderBy: { createdAt: 'desc' },
  });
  if (urgent) return urgent;

  const high = await prisma.job.findFirst({
    where: { priority: 'high', enrichmentStatus: 'enriched' },
    orderBy: { createdAt: 'desc' },
  });
  if (high) return high;

  return prisma.job.findFirst({
    where: { enrichmentStatus: 'enriched' },
    orderBy: { createdAt: 'desc' },
  });
}
