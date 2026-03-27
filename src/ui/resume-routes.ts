import { Router, Request, Response } from 'express';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { getJobById } from '../database/queries';
import {
  getOptimizedResumesForJob,
  getOptimizedResumeById,
} from '../database/resume-queries';
import { runResumePipeline } from '../resume/resume-pipeline';

export const resumeRouter = Router();

/**
 * POST /api/resume/optimize/:jobId
 * Trigger resume optimization for a job. Returns immediately with a resumeId.
 */
resumeRouter.post('/api/resume/optimize/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;

    // Validate config
    if (!config.anthropic.apiKey) {
      res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured in .env' });
      return;
    }
    if (!config.google.serviceAccountEmail || !config.google.serviceAccountPrivateKey) {
      res.status(503).json({ error: 'Google service account not configured in .env' });
      return;
    }
    if (!config.google.resumeTemplateDocId) {
      res.status(503).json({ error: 'GOOGLE_RESUME_TEMPLATE_DOC_ID not configured in .env' });
      return;
    }

    // Validate job exists and is enriched
    const job = await getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (!job.description) {
      res.status(400).json({ error: 'Job has no description. Enrich it first.' });
      return;
    }

    // Start pipeline (async — returns immediately)
    const resumeId = await runResumePipeline(jobId);

    res.json({ resumeId, status: 'processing' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error starting resume optimization', { error: message });
    res.status(500).json({ error: 'Failed to start resume optimization' });
  }
});

/**
 * GET /api/resume/status/:resumeId
 * Poll for optimization status.
 */
resumeRouter.get('/api/resume/status/:resumeId', async (req: Request, res: Response) => {
  try {
    const record = await getOptimizedResumeById(req.params.resumeId as string);
    if (!record) {
      res.status(404).json({ error: 'Resume optimization not found' });
      return;
    }

    res.json({
      id: record.id,
      status: record.status,
      errorMessage: record.errorMessage,
      googleDocUrl: record.googleDocUrl,
      pdfFilename: record.pdfFilename,
      pdfSizeBytes: record.pdfSizeBytes,
      sectionsModified: JSON.parse(record.sectionsModified || '[]'),
      optimizationNotes: record.optimizationNotes,
      createdAt: record.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error fetching resume status', { error: message });
    res.status(500).json({ error: 'Failed to fetch resume status' });
  }
});

/**
 * GET /api/resume/download/:resumeId
 * Download the optimized PDF.
 */
resumeRouter.get('/api/resume/download/:resumeId', async (req: Request, res: Response) => {
  try {
    const record = await getOptimizedResumeById(req.params.resumeId as string);
    if (!record) {
      res.status(404).json({ error: 'Resume not found' });
      return;
    }
    if (record.status !== 'completed' || !record.pdfStoragePath) {
      res.status(400).json({ error: 'Resume PDF not ready' });
      return;
    }

    const fullPath = path.resolve(record.pdfStoragePath);
    res.download(fullPath, record.pdfFilename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error downloading resume', { error: message });
    res.status(500).json({ error: 'Failed to download resume' });
  }
});

/**
 * GET /api/resume/job/:jobId
 * List all optimized resumes for a job.
 */
resumeRouter.get('/api/resume/job/:jobId', async (req: Request, res: Response) => {
  try {
    const resumes = await getOptimizedResumesForJob(req.params.jobId as string);
    res.json({
      resumes: resumes.map((r) => ({
        id: r.id,
        status: r.status,
        errorMessage: r.errorMessage,
        googleDocUrl: r.googleDocUrl,
        pdfFilename: r.pdfFilename,
        pdfSizeBytes: r.pdfSizeBytes,
        sectionsModified: JSON.parse(r.sectionsModified || '[]'),
        optimizationNotes: r.optimizationNotes,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Error listing resumes for job', { error: message });
    res.status(500).json({ error: 'Failed to list resumes' });
  }
});
