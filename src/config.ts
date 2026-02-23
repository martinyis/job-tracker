import dotenv from 'dotenv';
import { getOrCreateSettings } from './database/settings-queries';

dotenv.config();

/**
 * Application configuration.
 * Secrets (API key) come from .env.
 * Everything else comes from AppSettings in the database.
 *
 * Call `initConfig()` once at startup before accessing `config`.
 */
export const config = {
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY || '',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    model: 'moonshotai/kimi-k2-instruct',
    maxTokens: 4096,
    temperature: 0.3,
  },
  search: {
    keywords: [] as string[],
    locations: ['United States'] as string[],
    geoId: '103644278',
  },
  scraper: {
    intervalMinutes: 2,
    headless: true,
    maxMinutesAgo: 10,
    maxConsecutiveErrors: 5,
    errorPauseMinutes: 30,
    navigationDelay: { min: 2000, max: 5000 },
    clickDelay: { min: 1000, max: 3000 },
  },
  ui: {
    port: 3000,
  },
  telegram: {
    botToken: '',
    chatId: '',
  },
};

/**
 * Initializes configuration from the database.
 * Must be called once at startup before the app uses `config`.
 */
export async function initConfig(): Promise<void> {
  dotenv.config({ override: true });
  config.nvidia.apiKey = process.env.NVIDIA_API_KEY || '';
  config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  config.telegram.chatId = process.env.TELEGRAM_CHAT_ID || '';

  const settings = await getOrCreateSettings();

  config.search.keywords = settings.searchKeywords;
  config.search.locations = settings.searchLocations;
  config.search.geoId = settings.geoId;

  config.scraper.intervalMinutes = settings.intervalMinutes;
  config.scraper.headless = settings.headless;
  config.scraper.maxMinutesAgo = settings.maxMinutesAgo;

  config.ui.port = settings.uiPort;
}

/**
 * Reloads configuration from the database.
 * Call after saving settings so the running process picks up changes.
 */
export async function reloadConfig(): Promise<void> {
  await initConfig();
}

/**
 * Validates that all required configuration is set.
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.nvidia.apiKey) errors.push('NVIDIA_API_KEY is required');
  if (config.search.keywords.length === 0) errors.push('Job search keywords are required');

  return { valid: errors.length === 0, errors };
}
