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
import { getEnrichmentQueueSize, getJobForTestNotification } from '../database/enrichment-queries';
import { getOrCreateSettings, updateSettings } from '../database/settings-queries';
import { isTelegramConfigured, sendTestNotification } from '../notifications/telegram';
import { loadCookies, areCookiesValid } from '../scraper/linkedin-auth';
import { getAgentStatus, startAgent, stopAgent } from './agent-manager';
import { getEnricherStatus, startEnricher, stopEnricher } from './enricher-manager';
import { config, reloadConfig } from '../config';
import { logger } from '../logger';

export const router = Router();

const VALID_STATUSES: JobStatus[] = ['new', 'applied', 'reviewed', 'rejected'];

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * GET / — Main jobs dashboard.
 * Displays all jobs sorted by score, with optional status filter.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const statusFilter = req.query.status as JobStatus | undefined;
    const validFilter = statusFilter && VALID_STATUSES.includes(statusFilter) ? statusFilter : undefined;

    const [jobs, stats, agentStatus, enricherStatus] = await Promise.all([
      getJobs(validFilter),
      getStats(),
      getAgentStatus(),
      getEnricherStatus(),
    ]);

    // Parse JSON fields for each job
    const parsedJobs = jobs.map((job) => ({
      ...job,
      keyMatchesParsed: safeParseJsonArray(job.keyMatches),
      actionItemsParsed: safeParseJsonArray(job.actionItems),
      redFlagsParsed: safeParseJsonArray(job.redFlags),
      contactPeopleParsed: safeParseJson(job.contactPeople, []),
    }));

    res.render('jobs', {
      jobs: parsedJobs,
      stats,
      agentStatus,
      enricherStatus,
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
 * GET /jobs — Jobs board (kanban or list view).
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const statusFilter = req.query.status as JobStatus | undefined;
    const validFilter = statusFilter && VALID_STATUSES.includes(statusFilter) ? statusFilter : undefined;
    const view = req.query.view === 'list' ? 'list' : 'kanban';

    const [jobs, stats] = await Promise.all([
      getJobs(validFilter),
      getStats(),
    ]);

    // Parse JSON fields for each job
    const parsedJobs = jobs.map((job) => ({
      ...job,
      keyMatchesParsed: safeParseJsonArray(job.keyMatches),
      actionItemsParsed: safeParseJsonArray(job.actionItems),
      redFlagsParsed: safeParseJsonArray(job.redFlags),
      contactPeopleParsed: safeParseJson(job.contactPeople, []),
    }));

    res.render('kanban', {
      jobs: parsedJobs,
      stats,
      currentFilter: validFilter || 'all',
      currentView: view,
      statuses: VALID_STATUSES,
    });
  } catch (error) {
    logger.error('Error rendering jobs board page', {
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
    res.redirect('/control');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start agent', { error: message });
    res.redirect(`/control?agentError=${encodeURIComponent(message)}`);
  }
});

/**
 * POST /agent/stop — Stop the scraper agent process.
 */
router.post('/agent/stop', async (_req: Request, res: Response) => {
  try {
    await stopAgent();
    res.redirect('/control');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to stop agent', { error: message });
    res.redirect(`/control?agentError=${encodeURIComponent(message)}`);
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

// ─── Enricher Agent Control ────────────────────────────

router.post('/enricher/start', async (_req: Request, res: Response) => {
  try {
    await startEnricher();
    res.redirect('/control');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to start enricher', { error: message });
    res.redirect(`/control?agentError=${encodeURIComponent(message)}`);
  }
});

router.post('/enricher/stop', async (_req: Request, res: Response) => {
  try {
    await stopEnricher();
    res.redirect('/control');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to stop enricher', { error: message });
    res.redirect(`/control?agentError=${encodeURIComponent(message)}`);
  }
});

router.get('/enricher/status', async (_req: Request, res: Response) => {
  try {
    const status = await getEnricherStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error fetching enricher status', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch enricher status' });
  }
});

router.get('/enricher/logs', (_req: Request, res: Response) => {
  try {
    const maxLines = Math.min(Number(_req.query.lines) || 150, 500);
    const logPath = path.resolve('./logs/enricher.log');

    if (!fs.existsSync(logPath)) {
      res.json({ lines: [], truncated: false });
      return;
    }

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
    logger.error('Error reading enricher logs', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to read enricher logs' });
  }
});

// ─── Telegram Notifications ──────────────────────────────

/**
 * POST /notifications/test — Send a test Telegram notification using a real job.
 */
router.post('/notifications/test', async (_req: Request, res: Response) => {
  try {
    if (!isTelegramConfigured()) {
      res.redirect('/control?notificationError=' + encodeURIComponent(
        'Telegram not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to your .env file.'
      ));
      return;
    }

    const job = await getJobForTestNotification();
    if (!job) {
      res.redirect('/control?notificationError=' + encodeURIComponent(
        'No enriched jobs in the database yet. Run the enricher first, then try again.'
      ));
      return;
    }

    const result = await sendTestNotification(job);
    if (result.success) {
      res.redirect('/control?notificationSent=1');
    } else {
      res.redirect('/control?notificationError=' + encodeURIComponent(
        result.error || 'Failed to send test notification.'
      ));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Test notification failed', { error: message });
    res.redirect('/control?notificationError=' + encodeURIComponent(message));
  }
});

// ─── Control Panel ──────────────────────────────────────

/**
 * GET /control — Render the control panel page with agent panels and scraper settings.
 */
router.get('/control', async (req: Request, res: Response) => {
  try {
    const [scraperState, agentStatus, enricherStatus, enrichmentQueueSize, settings] = await Promise.all([
      getScraperState(),
      getAgentStatus(),
      getEnricherStatus(),
      getEnrichmentQueueSize(),
      getOrCreateSettings(),
    ]);

    const cookies = loadCookies();
    const linkedinSessionValid = cookies !== null && areCookiesValid(cookies);
    const telegramConfigured = !!(config.telegram.botToken && config.telegram.chatId);

    res.render('control', {
      scraperState,
      agentStatus,
      enricherStatus,
      enrichmentQueueSize,
      linkedinSessionValid,
      telegramConfigured,
      scraperSettings: {
        intervalMinutes: settings.intervalMinutes,
        headless: settings.headless,
      },
      agentError: req.query.agentError || null,
      saved: req.query.saved === '1',
      notificationSent: req.query.notificationSent === '1',
      notificationError: req.query.notificationError || null,
    });
  } catch (error) {
    logger.error('Error rendering control panel', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Internal Server Error');
  }
});

/**
 * POST /control/scraper-settings — Save scrape interval and headless mode.
 */
router.post('/control/scraper-settings', async (req: Request, res: Response) => {
  try {
    const { SCRAPE_INTERVAL_MINUTES, HEADLESS_MODE } = req.body;

    await updateSettings({
      intervalMinutes: parseInt(SCRAPE_INTERVAL_MINUTES, 10) || 2,
      headless: HEADLESS_MODE === 'true',
    });

    await reloadConfig();
    logger.info('Scraper settings saved from control panel');

    res.redirect('/control?saved=1');
  } catch (error) {
    logger.error('Failed to save scraper settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save scraper settings');
  }
});

