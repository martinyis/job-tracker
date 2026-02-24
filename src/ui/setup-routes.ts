import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { reloadConfig } from '../config';
import { getOrCreateSettings, updateSettings } from '../database/settings-queries';
import {
  getOrCreateProfile,
  updateProfile,
  invalidateProfileSummaryCache,
  addDocument,
  parseJsonArray,
  toJsonArray,
} from '../database/profile-queries';

export const setupRouter = Router();

const DATA_DIR = path.resolve('./data');
const ENV_PATH = path.resolve('./.env');

// Multer config for resume upload — saves to data/documents/
const DOCUMENTS_DIR = path.resolve('./data/documents');
const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(DOCUMENTS_DIR)) {
        fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
      }
      cb(null, DOCUMENTS_DIR);
    },
    filename: (_req, _file, cb) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      cb(null, `resume-${timestamp}.pdf`);
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
 * Writes the API key to .env file, preserving all other env vars.
 */
function saveApiKey(apiKey: string): void {
  let lines: string[] = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  }

  let found = false;
  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('NVIDIA_API_KEY=') || trimmed.startsWith('NVIDIA_API_KEY =')) {
      found = true;
      return `NVIDIA_API_KEY=${apiKey}`;
    }
    return line;
  });

  if (!found) {
    lines.push(`NVIDIA_API_KEY=${apiKey}`);
  }

  // Remove trailing empty lines, add single newline at end
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push('');

  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
}

/**
 * Checks if the app has been configured (async — reads from DB).
 */
export async function isConfigured(): Promise<boolean> {
  const apiKey = readApiKey();
  if (!apiKey || apiKey === 'nvapi-...') return false;
  try {
    const settings = await getOrCreateSettings();
    return settings.searchKeywords.length > 0;
  } catch {
    return false;
  }
}

/**
 * GET /setup — Render the setup/settings page.
 */
setupRouter.get('/setup', async (req: Request, res: Response) => {
  const apiKey = readApiKey();
  const settings = await getOrCreateSettings();
  const profile = await getOrCreateProfile();

  // Build a structured settings object for the template
  const templateSettings = {
    search: {
      keywords: settings.searchKeywords,
      locations: settings.searchLocations,
      geoId: settings.geoId,
    },
    ui: {
      port: settings.uiPort,
    },
    profile: {
      preferences: {
        remote_only: profile.remoteOnly,
        willing_to_relocate: profile.willingToRelocate,
        preferred_company_size: parseJsonArray(profile.preferredCompanySize),
        avoid_industries: parseJsonArray(profile.avoidIndustries),
        preferred_tech_stack: parseJsonArray(profile.preferredTechStack),
        target_seniority: parseJsonArray(profile.targetSeniority),
        exclude_title_keywords: parseJsonArray(profile.excludeTitleKeywords),
        include_title_patterns: parseJsonArray(profile.includeTitlePatterns),
      },
      additional_info: {
        open_to_contract: profile.openToContract,
        visa_sponsorship_needed: profile.visaSponsorshipNeeded,
        min_salary: profile.minSalary,
        key_interests: parseJsonArray(profile.keyInterests),
        years_of_experience: profile.yearsOfExperience,
      },
      dealbreakers: parseJsonArray(profile.dealbreakers),
      job_search_description: profile.jobSearchDescription,
      missionStatement: profile.missionStatement,
      urgencySignals: profile.urgencySignals,
    },
  };

  res.render('setup', {
    apiKey,
    settings: templateSettings,
    saved: req.query.saved === '1',
  });
});

/**
 * POST /setup/config — Save API key + search/scraper/UI settings.
 */
setupRouter.post('/setup/config', async (req: Request, res: Response) => {
  try {
    const {
      NVIDIA_API_KEY,
      JOB_KEYWORDS,
      JOB_LOCATIONS,
      UI_PORT,
    } = req.body;

    // Save API key to .env
    saveApiKey(NVIDIA_API_KEY || '');

    // Save search/UI settings to DB
    await updateSettings({
      searchKeywords: splitComma(JOB_KEYWORDS),
      searchLocations: splitComma(JOB_LOCATIONS),
      uiPort: parseInt(UI_PORT, 10) || 3000,
    });

    await reloadConfig();
    logger.info('Configuration saved to database');

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
setupRouter.post('/setup/resume', resumeUpload.single('resume'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).send('No file uploaded. Please select a PDF file.');
    return;
  }

  // Track the document in the DB
  await addDocument({
    type: 'resume',
    filename: req.file.originalname,
    storagePath: `documents/${req.file.filename}`,
    mimeType: req.file.mimetype,
    sizeBytes: req.file.size,
    isPrimary: true,
  });

  await invalidateProfileSummaryCache();
  logger.info('Resume uploaded', { size: req.file.size, path: req.file.filename });
  res.redirect('/setup?saved=1');
});

/**
 * POST /setup/profile — Save profile/preference settings.
 */
setupRouter.post('/setup/profile', async (req: Request, res: Response) => {
  try {
    const {
      remote_only,
      willing_to_relocate,
      preferred_company_size,
      avoid_industries,
      preferred_tech_stack,
      target_seniority,
      exclude_title_keywords,
      include_title_patterns,
      job_search_description,
      missionStatement,
      urgencySignals,
      open_to_contract,
      visa_sponsorship_needed,
      min_salary,
      key_interests,
      dealbreakers,
      years_of_experience,
    } = req.body;

    await updateProfile({
      remoteOnly: remote_only === 'on',
      willingToRelocate: willing_to_relocate === 'on',
      yearsOfExperience: parseInt(years_of_experience, 10) || 0,
      preferredCompanySize: toJsonArray(splitComma(preferred_company_size)),
      avoidIndustries: toJsonArray(splitComma(avoid_industries)),
      preferredTechStack: toJsonArray(splitComma(preferred_tech_stack)),
      targetSeniority: toJsonArray(splitComma(target_seniority)),
      excludeTitleKeywords: toJsonArray(splitComma(exclude_title_keywords)),
      includeTitlePatterns: toJsonArray(splitComma(include_title_patterns)),
      jobSearchDescription: job_search_description || '',
      missionStatement: missionStatement || '',
      urgencySignals: urgencySignals || '',
      openToContract: open_to_contract === 'on',
      visaSponsorshipNeeded: visa_sponsorship_needed === 'on',
      minSalary: parseInt(min_salary, 10) || 0,
      keyInterests: toJsonArray(splitComma(key_interests)),
      dealbreakers: toJsonArray(splitComma(dealbreakers)),
    });

    await reloadConfig();
    logger.info('Profile preferences saved to database');
    res.redirect('/setup?saved=1');
  } catch (error) {
    logger.error('Failed to save profile', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save profile');
  }
});

/**
 * POST /setup/import — Upload a settings JSON file to import.
 */
setupRouter.post('/setup/import', settingsUpload.single('settings_file'), async (req: Request, res: Response) => {
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

    // Import AppSettings
    await updateSettings({
      searchKeywords: Array.isArray(raw.search?.keywords) ? raw.search.keywords : [],
      searchLocations: Array.isArray(raw.search?.locations) ? raw.search.locations : ['United States'],
      geoId: raw.search?.geoId || '103644278',
      intervalMinutes: raw.scraper?.intervalMinutes ?? 2,
      headless: raw.scraper?.headless ?? true,
      maxMinutesAgo: raw.scraper?.maxMinutesAgo ?? 10,
      uiPort: raw.ui?.port ?? 3000,
    });

    // Import profile preferences if present
    if (raw.profile) {
      await updateProfile({
        remoteOnly: raw.profile?.preferences?.remote_only ?? false,
        willingToRelocate: raw.profile?.preferences?.willing_to_relocate ?? false,
        preferredCompanySize: toJsonArray(raw.profile?.preferences?.preferred_company_size ?? []),
        avoidIndustries: toJsonArray(raw.profile?.preferences?.avoid_industries ?? []),
        preferredTechStack: toJsonArray(raw.profile?.preferences?.preferred_tech_stack ?? []),
        targetSeniority: toJsonArray(raw.profile?.preferences?.target_seniority ?? []),
        excludeTitleKeywords: toJsonArray(raw.profile?.preferences?.exclude_title_keywords ?? []),
        includeTitlePatterns: toJsonArray(raw.profile?.preferences?.include_title_patterns ?? []),
        jobSearchDescription: raw.profile?.job_search_description ?? '',
        openToContract: raw.profile?.additional_info?.open_to_contract ?? false,
        visaSponsorshipNeeded: raw.profile?.additional_info?.visa_sponsorship_needed ?? false,
        minSalary: raw.profile?.additional_info?.min_salary ?? 0,
        keyInterests: toJsonArray(raw.profile?.additional_info?.key_interests ?? []),
        dealbreakers: toJsonArray(raw.profile?.dealbreakers ?? []),
      });
    }

    await reloadConfig();
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
 * GET /setup/export — Download current settings as JSON.
 */
setupRouter.get('/setup/export', async (_req: Request, res: Response) => {
  const settings = await getOrCreateSettings();
  const profile = await getOrCreateProfile();

  const exportData = {
    search: {
      keywords: settings.searchKeywords,
      locations: settings.searchLocations,
      geoId: settings.geoId,
    },
    scraper: {
      intervalMinutes: settings.intervalMinutes,
      headless: settings.headless,
      maxMinutesAgo: settings.maxMinutesAgo,
    },
    ui: {
      port: settings.uiPort,
    },
    profile: {
      preferences: {
        remote_only: profile.remoteOnly,
        willing_to_relocate: profile.willingToRelocate,
        preferred_company_size: parseJsonArray(profile.preferredCompanySize),
        avoid_industries: parseJsonArray(profile.avoidIndustries),
        preferred_tech_stack: parseJsonArray(profile.preferredTechStack),
        target_seniority: parseJsonArray(profile.targetSeniority),
        exclude_title_keywords: parseJsonArray(profile.excludeTitleKeywords),
        include_title_patterns: parseJsonArray(profile.includeTitlePatterns),
      },
      additional_info: {
        open_to_contract: profile.openToContract,
        visa_sponsorship_needed: profile.visaSponsorshipNeeded,
        min_salary: profile.minSalary,
        key_interests: parseJsonArray(profile.keyInterests),
      },
      dealbreakers: parseJsonArray(profile.dealbreakers),
      job_search_description: profile.jobSearchDescription,
    },
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="settings.json"');
  res.send(JSON.stringify(exportData, null, 2));
});

/** Helper: splits a comma-separated string into a trimmed array. */
function splitComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
