import express from 'express';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';
import { router } from './routes';
import { setupRouter, isConfigured } from './setup-routes';

/**
 * Creates and configures the Express UI server.
 */
export function createServer(): express.Application {
  const app = express();

  // Body parsing
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // View engine
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Static files
  app.use('/static', express.static(path.join(__dirname, 'views')));

  // Setup routes (always available)
  app.use('/', setupRouter);

  // Redirect to setup if not configured
  app.use((req, res, next) => {
    if (!isConfigured() && req.path === '/') {
      res.redirect('/setup');
      return;
    }
    next();
  });

  // Main app routes
  app.use('/', router);

  return app;
}

/**
 * Starts the Express server on the configured port.
 */
export function startServer(): void {
  const app = createServer();

  app.listen(config.ui.port, () => {
    logger.info(`UI server running at http://localhost:${config.ui.port}`);
  });
}

// Allow running standalone
if (require.main === module) {
  startServer();
}
