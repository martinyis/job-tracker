import { Router, Request, Response } from 'express';
import {
  getJobs,
  getJobById,
  updateJobStatus,
  updateJobNotes,
  getStats,
  getScraperState,
  JobStatus,
} from '../database/queries';
import { logger } from '../logger';

export const router = Router();

const VALID_STATUSES: JobStatus[] = ['new', 'reviewed', 'applied', 'rejected'];

/**
 * GET / — Main jobs dashboard.
 * Displays all jobs sorted by score, with optional status filter.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const statusFilter = req.query.status as JobStatus | undefined;
    const validFilter = statusFilter && VALID_STATUSES.includes(statusFilter) ? statusFilter : undefined;

    const [jobs, stats, scraperState] = await Promise.all([
      getJobs(validFilter),
      getStats(),
      getScraperState(),
    ]);

    // Parse keyMatches JSON for each job
    const parsedJobs = jobs.map((job) => ({
      ...job,
      keyMatchesParsed: (() => {
        try {
          return JSON.parse(job.keyMatches) as string[];
        } catch {
          return [];
        }
      })(),
    }));

    res.render('jobs', {
      jobs: parsedJobs,
      stats,
      scraperState,
      currentFilter: validFilter || 'all',
      statuses: VALID_STATUSES,
    });
  } catch (error) {
    logger.error('Error rendering jobs page', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /update-status — Update a job's application status.
 */
router.post('/update-status', async (req: Request, res: Response) => {
  try {
    const { id, status } = req.body as { id: string; status: string };

    if (!id || !status || !VALID_STATUSES.includes(status as JobStatus)) {
      res.status(400).json({ error: 'Invalid id or status' });
      return;
    }

    await updateJobStatus(id, status as JobStatus);
    logger.info('Job status updated', { id, status });

    res.redirect(req.headers.referer || '/');
  } catch (error) {
    logger.error('Error updating job status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * POST /add-note — Add or update a note on a job.
 */
router.post('/add-note', async (req: Request, res: Response) => {
  try {
    const { id, notes } = req.body as { id: string; notes: string };

    if (!id) {
      res.status(400).json({ error: 'Job id is required' });
      return;
    }

    await updateJobNotes(id, notes || '');
    logger.info('Job note updated', { id });

    res.redirect(req.headers.referer || '/');
  } catch (error) {
    logger.error('Error updating job notes', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

/**
 * GET /stats — JSON endpoint for summary statistics.
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Error fetching stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /job/:id — JSON endpoint for a single job detail.
 */
router.get('/job/:id', async (req: Request, res: Response) => {
  try {
    const jobId = req.params.id as string;
    const job = await getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      ...job,
      keyMatchesParsed: (() => {
        try {
          return JSON.parse(job.keyMatches) as string[];
        } catch {
          return [];
        }
      })(),
    });
  } catch (error) {
    logger.error('Error fetching job', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});
