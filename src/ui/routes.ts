import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  getJobs,
  getJobById,
  updateJobStatus,
  updateJobNotes,
  getStats,
  getScraperState,
  JobStatus,
} from '../database/queries';
import { loadCookies, areCookiesValid } from '../scraper/linkedin-auth';
import { getAgentStatus, startAgent, stopAgent } from './agent-manager';
import { logger } from '../logger';

export const router = Router();

const VALID_STATUSES: JobStatus[] = ['new', 'applying', 'applied', 'skipped', 'failed', 'reviewed', 'rejected'];

/**
 * GET / — Main jobs dashboard.
 * Displays all jobs sorted by score, with optional status filter.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const statusFilter = req.query.status as JobStatus | undefined;
    const validFilter = statusFilter && VALID_STATUSES.includes(statusFilter) ? statusFilter : undefined;

    const [jobs, stats, scraperState, agentStatus] = await Promise.all([
      getJobs(validFilter),
      getStats(),
      getScraperState(),
      getAgentStatus(),
    ]);

    // Check LinkedIn session status
    const cookies = loadCookies();
    const linkedinSessionValid = cookies !== null && areCookiesValid(cookies);

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

    const agentError = req.query.agentError as string | undefined;

    res.render('jobs', {
      jobs: parsedJobs,
      stats,
      scraperState,
      agentStatus,
      agentError,
      linkedinSessionValid,
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

// ─── Agent Control ─────────────────────────────────────

/**
 * POST /agent/start — Spawn the scraper agent process.
 */
router.post('/agent/start', async (_req: Request, res: Response) => {
  try {
    await startAgent();
    res.redirect('/');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start agent', { error: message });
    res.redirect(`/?agentError=${encodeURIComponent(message)}`);
  }
});

/**
 * POST /agent/stop — Stop the scraper agent process.
 */
router.post('/agent/stop', async (_req: Request, res: Response) => {
  try {
    await stopAgent();
    res.redirect('/');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to stop agent', { error: message });
    res.redirect(`/?agentError=${encodeURIComponent(message)}`);
  }
});

/**
 * GET /agent/status — JSON endpoint for agent status.
 */
router.get('/agent/status', async (_req: Request, res: Response) => {
  try {
    const status = await getAgentStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error fetching agent status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch agent status' });
  }
});

/**
 * GET /agent/logs — Returns the last N lines of the agent log file.
 * Query params: lines (default 150)
 */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

router.get('/agent/logs', (_req: Request, res: Response) => {
  try {
    const maxLines = Math.min(Number(_req.query.lines) || 150, 500);
    const logPath = path.resolve('./logs/agent.log');

    if (!fs.existsSync(logPath)) {
      res.json({ lines: [], truncated: false });
      return;
    }

    // Read the tail of the file efficiently — read last 64KB max
    const stat = fs.statSync(logPath);
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    const allLines = content.split('\n').filter((l) => l.length > 0);
    const truncated = allLines.length > maxLines || stat.size > readSize;
    const lines = allLines.slice(-maxLines).map((line) => line.replace(ANSI_REGEX, ''));

    res.json({ lines, truncated });
  } catch (error) {
    logger.error('Error reading agent logs', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to read agent logs' });
  }
});
