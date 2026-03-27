import { prisma } from './client';

export async function createOptimizedResume(jobId: string) {
  return prisma.optimizedResume.create({
    data: { jobId, status: 'processing' },
  });
}

export async function updateOptimizedResume(
  id: string,
  data: {
    googleDocId?: string;
    googleDocUrl?: string;
    pdfFilename?: string;
    pdfStoragePath?: string;
    pdfSizeBytes?: number;
    status?: string;
    errorMessage?: string;
    sectionsModified?: string[];
    optimizationNotes?: string;
  },
) {
  return prisma.optimizedResume.update({
    where: { id },
    data: {
      ...data,
      sectionsModified: data.sectionsModified
        ? JSON.stringify(data.sectionsModified)
        : undefined,
    },
  });
}

export async function getOptimizedResumesForJob(jobId: string) {
  return prisma.optimizedResume.findMany({
    where: { jobId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getOptimizedResumeById(id: string) {
  return prisma.optimizedResume.findUnique({ where: { id } });
}

export async function getLatestOptimizedResume(jobId: string) {
  return prisma.optimizedResume.findFirst({
    where: { jobId, status: 'completed' },
    orderBy: { createdAt: 'desc' },
  });
}
