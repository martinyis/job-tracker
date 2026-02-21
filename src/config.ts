import dotenv from 'dotenv';
import path from 'path';
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
    model: 'moonshotai/kimi-k2.5',
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
    minMatchScore: 50,
    maxMinutesAgo: 10,
    maxConsecutiveErrors: 5,
    errorPauseMinutes: 30,
    navigationDelay: { min: 2000, max: 5000 },
    clickDelay: { min: 1000, max: 3000 },
    maxConcurrentMatches: 5,
    maxDescriptionLength: 2000,
  },
  ui: {
    port: 3000,
  },
  paths: {
    linkedinCookies: path.resolve('./data/linkedin-cookies.json'),
    logs: path.resolve('./logs/app.log'),
  },
};

/**
 * Initializes configuration from the database.
 * Must be called once at startup before the app uses `config`.
 */
export async function initConfig(): Promise<void> {
  dotenv.config({ override: true });
  config.nvidia.apiKey = process.env.NVIDIA_API_KEY || '';

  const settings = await getOrCreateSettings();

  config.search.keywords = settings.searchKeywords;
  config.search.locations = settings.searchLocations;
  config.search.geoId = settings.geoId;

  config.scraper.intervalMinutes = settings.intervalMinutes;
  config.scraper.headless = settings.headless;
  config.scraper.minMatchScore = settings.minMatchScore;
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
