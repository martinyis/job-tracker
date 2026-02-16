import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

/**
 * Singleton Prisma client instance for database operations.
 * Logs queries in development and errors always.
 */
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('error', (e) => {
  logger.error('Prisma error', { message: e.message, target: e.target });
});

prisma.$on('warn', (e) => {
  logger.warn('Prisma warning', { message: e.message, target: e.target });
});

/**
 * Gracefully disconnects the Prisma client.
 * Should be called during application shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
