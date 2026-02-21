import { config, initConfig } from './config';
import { logger } from './logger';
import { disconnectDatabase } from './database/client';
import { startServer } from './ui/server';

/**
 * Application entry point — UI only.
 * The scraper agent runs as a separate process, started via
 * the dashboard or `npm run agent`.
 */
async function main(): Promise<void> {
  logger.info('Starting Job Tracker UI');

  await initConfig();
  startServer();

  if (!config.nvidia.apiKey || config.search.keywords.length === 0) {
    logger.info('App not configured yet — open the UI to complete setup');
    logger.info(`Visit http://localhost:${config.ui.port}/setup to get started`);
  } else {
    logger.info(`Dashboard ready at http://localhost:${config.ui.port}`);
    logger.info('Start the scraper agent from the dashboard or run: npm run agent');
  }
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);
  await disconnectDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
