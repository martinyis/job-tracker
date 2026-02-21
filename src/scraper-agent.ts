import { config, initConfig, validateConfig } from './config';
import { logger } from './logger';
import { disconnectDatabase } from './database/client';
import { setScraperPid, clearScraperPid, getScraperState, resetScraperStateOnStartup } from './database/queries';
import { startScheduler, requestShutdown, SchedulerHandle } from './scheduler';

let schedulerHandle: SchedulerHandle | null = null;

async function main(): Promise<void> {
  logger.info('Scraper agent starting', { pid: process.pid });

  // Initialize config from DB before doing anything
  await initConfig();

  // Validate configuration before doing anything
  const { valid, errors } = validateConfig();
  if (!valid) {
    for (const error of errors) {
      logger.error(`Config error: ${error}`);
    }
    logger.error('Scraper agent cannot start — configuration invalid');
    process.exit(1);
  }

  // Check if another agent is already running
  const existingState = await getScraperState();
  if (existingState.pid !== null) {
    let alive = false;
    try {
      process.kill(existingState.pid, 0);
      alive = true;
    } catch {
      // Process is dead — safe to take over
    }
    if (alive) {
      logger.error('Another scraper agent is already running', { existingPid: existingState.pid });
      console.error(`ERROR: Another scraper agent is already running (PID ${existingState.pid}). Stop it first.`);
      process.exit(1);
    }
  }

  // Clear any stuck state from a previous crashed/killed agent before registering
  await resetScraperStateOnStartup();

  // Write our PID to the database
  await setScraperPid(process.pid);
  logger.info('Scraper agent registered', { pid: process.pid });

  // Start the scheduler loop
  schedulerHandle = await startScheduler();

  logger.info('Scraper agent running', {
    pid: process.pid,
    intervalMinutes: config.scraper.intervalMinutes,
    keywords: config.search.keywords,
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`Scraper agent received ${signal}, shutting down gracefully...`);

  // Signal the scheduler to stop
  requestShutdown();
  if (schedulerHandle) {
    schedulerHandle.stop();
  }

  // Wait for any in-progress cycle to finish
  const maxWaitMs = 120_000; // 2 minutes max
  const pollMs = 1000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const state = await getScraperState();
    if (!state.isRunning) break;
    logger.info('Waiting for current scrape cycle to finish...');
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // Clean up our PID from the database
  await clearScraperPid();
  await disconnectDatabase();
  logger.info('Scraper agent shut down cleanly');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('Scraper agent uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Scraper agent unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch(async (error) => {
  logger.error('Scraper agent fatal error', {
    error: error instanceof Error ? error.message : String(error),
  });
  await clearScraperPid().catch(() => {});
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
