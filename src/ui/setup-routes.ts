import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { loadSettings, saveSettings, reloadConfig, getSettingsPath, type Settings } from '../config';

export const setupRouter = Router();

const DATA_DIR = path.resolve('./data');
const ENV_PATH = path.resolve('./.env');
const RESUME_PATH = path.join(DATA_DIR, 'resume.pdf');
const SUMMARY_PATH = path.join(DATA_DIR, 'profile-summary.json');

// Multer config for resume upload
const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      cb(null, DATA_DIR);
    },
    filename: (_req, _file, cb) => {
      cb(null, 'resume.pdf');
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Multer config for settings JSON upload
const settingsUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are accepted'));
    }
  },
  limits: { fileSize: 1 * 1024 * 1024 },
});

/**
 * Reads the API key from .env file.
 */
function readApiKey(): string {
  if (!fs.existsSync(ENV_PATH)) return '';
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    const val = trimmed.substring(eqIndex + 1).trim();
    if (key === 'NVIDIA_API_KEY') return val;
  }
  return '';
}

/**
 * Writes the API key to .env file (keeping only secrets there).
 */
function saveApiKey(apiKey: string): void {
  const envContent = `# NVIDIA API Key (only secret kept in .env)\nNVIDIA_API_KEY=${apiKey}\n`;
  fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
}

/**
 * Clears cached profile summary so it regenerates.
 */
function clearProfileSummary(): void {
  if (fs.existsSync(SUMMARY_PATH)) {
    fs.unlinkSync(SUMMARY_PATH);
    logger.info('Cleared cached profile summary');
  }
}

/**
 * Checks if the app has been configured.
 */
export function isConfigured(): boolean {
  const apiKey = readApiKey();
  if (!apiKey || apiKey === 'nvapi-...') return false;
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = loadSettings();
    return settings.search.keywords.length > 0;
  } catch {
    return false;
  }
}

/**
 * GET /setup — Render the setup/settings page.
 */
setupRouter.get('/setup', (req: Request, res: Response) => {
  const apiKey = readApiKey();
  const settings = loadSettings();
  const hasResume = fs.existsSync(RESUME_PATH);
  const hasSummary = fs.existsSync(SUMMARY_PATH);

  res.render('setup', {
    apiKey,
    settings,
    hasResume,
    hasSummary,
    saved: req.query.saved === '1',
  });
});

/**
 * POST /setup/config — Save API key + search/scraper/UI settings.
 */
setupRouter.post('/setup/config', (req: Request, res: Response) => {
  try {
    const {
      NVIDIA_API_KEY,
      JOB_KEYWORDS,
      JOB_LOCATIONS,
      SCRAPE_INTERVAL_MINUTES,
      HEADLESS_MODE,
      MIN_MATCH_SCORE,
      UI_PORT,
    } = req.body;

    // Save API key to .env
    saveApiKey(NVIDIA_API_KEY || '');

    // Save search/scraper/UI settings to settings.json (preserve profile section)
    const current = loadSettings();
    const updated: Settings = {
      ...current,
      search: {
        keywords: splitComma(JOB_KEYWORDS),
        locations: splitComma(JOB_LOCATIONS),
        geoId: current.search.geoId,
      },
      scraper: {
        ...current.scraper,
        intervalMinutes: parseInt(SCRAPE_INTERVAL_MINUTES, 10) || 2,
        headless: HEADLESS_MODE === 'true',
        minMatchScore: parseInt(MIN_MATCH_SCORE, 10) || 50,
      },
      ui: {
        port: parseInt(UI_PORT, 10) || 3000,
      },
    };

    saveSettings(updated);
    reloadConfig();
    logger.info('Configuration saved to settings.json');

    res.redirect('/setup?saved=1');
  } catch (error) {
    logger.error('Failed to save config', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save configuration');
  }
});

/**
 * POST /setup/resume — Upload resume PDF.
 */
setupRouter.post('/setup/resume', resumeUpload.single('resume'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).send('No file uploaded. Please select a PDF file.');
    return;
  }

  clearProfileSummary();
  logger.info('Resume uploaded', { size: req.file.size });
  res.redirect('/setup?saved=1');
});

/**
 * POST /setup/profile — Save profile/preference settings.
 */
setupRouter.post('/setup/profile', (req: Request, res: Response) => {
  try {
    const {
      remote_only,
      willing_to_relocate,
      preferred_company_size,
      avoid_industries,
      preferred_tech_stack,
      target_seniority,
      exclude_title_keywords,
      open_to_contract,
      visa_sponsorship_needed,
      min_salary,
      key_interests,
      dealbreakers,
    } = req.body;

    const current = loadSettings();
    const updated: Settings = {
      ...current,
      profile: {
        preferences: {
          remote_only: remote_only === 'on',
          willing_to_relocate: willing_to_relocate === 'on',
          preferred_company_size: splitComma(preferred_company_size),
          avoid_industries: splitComma(avoid_industries),
          preferred_tech_stack: splitComma(preferred_tech_stack),
          target_seniority: splitComma(target_seniority),
          exclude_title_keywords: splitComma(exclude_title_keywords),
        },
        additional_info: {
          open_to_contract: open_to_contract === 'on',
          visa_sponsorship_needed: visa_sponsorship_needed === 'on',
          min_salary: parseInt(min_salary, 10) || 0,
          key_interests: splitComma(key_interests),
        },
        dealbreakers: splitComma(dealbreakers),
      },
    };

    saveSettings(updated);
    reloadConfig();
    clearProfileSummary();

    logger.info('Profile preferences saved to settings.json');
    res.redirect('/setup?saved=1');
  } catch (error) {
    logger.error('Failed to save profile', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save profile');
  }
});

/**
 * POST /setup/import — Upload a settings.json file to replace current settings.
 */
setupRouter.post('/setup/import', settingsUpload.single('settings_file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).send('No file uploaded. Please select a JSON file.');
    return;
  }

  try {
    const raw = JSON.parse(req.file.buffer.toString('utf-8'));

    // Validate basic structure
    if (!raw.search || !raw.scraper || !raw.ui) {
      res.status(400).send('Invalid settings file. Must contain search, scraper, and ui sections.');
      return;
    }

    // Merge with defaults to fill any missing fields
    const imported: Settings = {
      search: {
        keywords: Array.isArray(raw.search?.keywords) ? raw.search.keywords : [],
        locations: Array.isArray(raw.search?.locations) ? raw.search.locations : ['United States'],
        geoId: raw.search?.geoId || '103644278',
      },
      scraper: {
        intervalMinutes: raw.scraper?.intervalMinutes ?? 2,
        headless: raw.scraper?.headless ?? true,
        minMatchScore: raw.scraper?.minMatchScore ?? 50,
        maxMinutesAgo: raw.scraper?.maxMinutesAgo ?? 10,
      },
      ui: {
        port: raw.ui?.port ?? 3000,
      },
      profile: {
        preferences: {
          remote_only: raw.profile?.preferences?.remote_only ?? false,
          willing_to_relocate: raw.profile?.preferences?.willing_to_relocate ?? false,
          preferred_company_size: raw.profile?.preferences?.preferred_company_size ?? [],
          avoid_industries: raw.profile?.preferences?.avoid_industries ?? [],
          preferred_tech_stack: raw.profile?.preferences?.preferred_tech_stack ?? [],
          target_seniority: raw.profile?.preferences?.target_seniority ?? [],
          exclude_title_keywords: raw.profile?.preferences?.exclude_title_keywords ?? [],
        },
        additional_info: {
          open_to_contract: raw.profile?.additional_info?.open_to_contract ?? false,
          visa_sponsorship_needed: raw.profile?.additional_info?.visa_sponsorship_needed ?? false,
          min_salary: raw.profile?.additional_info?.min_salary ?? 0,
          key_interests: raw.profile?.additional_info?.key_interests ?? [],
        },
        dealbreakers: raw.profile?.dealbreakers ?? [],
      },
    };

    saveSettings(imported);
    reloadConfig();
    clearProfileSummary();

    logger.info('Settings imported from uploaded file');
    res.redirect('/setup?saved=1');
  } catch (error) {
    logger.error('Failed to import settings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(400).send('Invalid JSON file. Please check the format.');
  }
});

/**
 * GET /setup/export — Download current settings.json.
 */
setupRouter.get('/setup/export', (_req: Request, res: Response) => {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    const settings = loadSettings();
    saveSettings(settings);
  }
  res.download(settingsPath, 'settings.json');
});

/** Helper: splits a comma-separated string into a trimmed array. */
function splitComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
