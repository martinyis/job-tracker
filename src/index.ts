import { config, validateConfig } from './config';
import { logger } from './logger';
import { disconnectDatabase } from './database/client';
import { startScheduler } from './scheduler';
import { startServer } from './ui/server';
import { isConfigured } from './ui/setup-routes';

/**
 * Application entry point.
 * Starts the UI server immediately (for setup access).
 * Starts the scraper only when properly configured.
 */
async function main(): Promise<void> {
  logger.info('Starting LinkedIn Job Tracker');

  // Always start UI server so user can access setup page
  startServer();

  // Check if the app has been configured
  if (!isConfigured()) {
    logger.info('App not configured yet — open the UI to complete setup');
    logger.info(`Visit http://localhost:${config.ui.port}/setup to get started`);
    return;
  }

  // Validate configuration
  const { valid, errors } = validateConfig();
  if (!valid) {
    for (const error of errors) {
      logger.error(`Config error: ${error}`);
    }
    logger.warn('Configuration incomplete — scraper paused. Visit /setup to fix.');
    return;
  }

  logger.info('Configuration validated', {
    keywords: config.search.keywords,
    locations: config.search.locations,
    interval: `${config.scraper.intervalMinutes} minutes`,
    minScore: config.scraper.minMatchScore,
    headless: config.scraper.headless,
  });

  // Start scraper scheduler (resets stuck state from previous runs, then begins)
  await startScheduler();

  logger.info('All systems running');
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((error) => {
  logger.error('Fatal startup error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
