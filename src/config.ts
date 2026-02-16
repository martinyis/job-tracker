import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const DATA_DIR = path.resolve('./data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

/**
 * Default settings used when settings.json doesn't exist yet.
 */
const DEFAULTS = {
  search: {
    keywords: [] as string[],
    locations: ['United States'],
    geoId: '103644278',
  },
  scraper: {
    intervalMinutes: 2,
    headless: true,
    minMatchScore: 50,
    maxMinutesAgo: 10,
  },
  ui: {
    port: 3000,
  },
  profile: {
    preferences: {
      remote_only: false,
      willing_to_relocate: false,
      preferred_company_size: [] as string[],
      avoid_industries: [] as string[],
      preferred_tech_stack: [] as string[],
      target_seniority: [] as string[],
      exclude_title_keywords: [] as string[],
    },
    additional_info: {
      open_to_contract: false,
      visa_sponsorship_needed: false,
      min_salary: 0,
      key_interests: [] as string[],
    },
    dealbreakers: [] as string[],
  },
};

export type Settings = typeof DEFAULTS;

/**
 * Reads settings.json from disk. Returns defaults if file doesn't exist.
 */
export function loadSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) return structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    return {
      search: { ...DEFAULTS.search, ...raw.search },
      scraper: { ...DEFAULTS.scraper, ...raw.scraper },
      ui: { ...DEFAULTS.ui, ...raw.ui },
      profile: {
        preferences: { ...DEFAULTS.profile.preferences, ...raw.profile?.preferences },
        additional_info: { ...DEFAULTS.profile.additional_info, ...raw.profile?.additional_info },
        dealbreakers: raw.profile?.dealbreakers ?? DEFAULTS.profile.dealbreakers,
      },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/**
 * Writes settings to disk.
 */
export function saveSettings(settings: Settings): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Returns the path to settings.json.
 */
export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

function buildConfig() {
  const s = loadSettings();
  return {
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      model: 'claude-sonnet-4-20250514' as const,
      maxTokens: 1000,
      temperature: 0.3,
    },
    search: {
      keywords: s.search.keywords,
      locations: s.search.locations,
      geoId: s.search.geoId,
    },
    scraper: {
      intervalMinutes: s.scraper.intervalMinutes,
      headless: s.scraper.headless,
      minMatchScore: s.scraper.minMatchScore,
      maxMinutesAgo: s.scraper.maxMinutesAgo,
      maxConsecutiveErrors: 5,
      errorPauseMinutes: 30,
      navigationDelay: { min: 2000, max: 5000 },
      clickDelay: { min: 1000, max: 3000 },
      maxConcurrentMatches: 5,
      maxDescriptionLength: 2000,
    },
    ui: {
      port: s.ui.port,
    },
    paths: {
      resume: path.resolve('./data/resume.pdf'),
      settings: SETTINGS_PATH,
      profileSummary: path.resolve('./data/profile-summary.json'),
      logs: path.resolve('./logs/app.log'),
    },
    profile: s.profile,
  };
}

/**
 * Application configuration.
 * Secrets (API key) come from .env.
 * Everything else comes from data/settings.json.
 */
export const config = buildConfig();

/**
 * Reloads configuration from disk.
 * Call this after saving settings.json so the running process picks up changes.
 */
export function reloadConfig(): void {
  dotenv.config({ override: true });
  const fresh = buildConfig();
  Object.assign(config.claude, fresh.claude);
  Object.assign(config.search, fresh.search);
  Object.assign(config.scraper, fresh.scraper);
  Object.assign(config.ui, fresh.ui);
  Object.assign(config.paths, fresh.paths);
  config.profile = fresh.profile;
}

/**
 * Validates that all required configuration is set.
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.claude.apiKey) errors.push('ANTHROPIC_API_KEY is required');
  if (config.search.keywords.length === 0) errors.push('Job search keywords are required');

  return { valid: errors.length === 0, errors };
}
