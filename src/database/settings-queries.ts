import { prisma } from './client';
import { parseJsonArray, toJsonArray } from './profile-queries';

/** JSON array fields in AppSettings that need parsing/stringifying */
const JSON_ARRAY_FIELDS = ['searchKeywords', 'searchLocations', 'autoApplySkipDomains'] as const;

export interface AppSettingsParsed {
  id: string;
  searchKeywords: string[];
  searchLocations: string[];
  geoId: string;
  intervalMinutes: number;
  headless: boolean;
  minMatchScore: number;
  maxMinutesAgo: number;
  autoApplyEnabled: boolean;
  autoApplyDryRun: boolean;
  autoApplyBatchSize: number;
  autoApplyDelaySeconds: number;
  autoApplyPollMinutes: number;
  autoApplySkipDomains: string[];
  uiPort: number;
  updatedAt: Date;
}

/**
 * Returns the singleton AppSettings, creating with defaults if missing.
 * JSON array fields are parsed into real arrays.
 */
export async function getOrCreateSettings(): Promise<AppSettingsParsed> {
  let settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
  });

  if (!settings) {
    settings = await prisma.appSettings.create({
      data: { id: 'singleton' },
    });
  }

  return {
    ...settings,
    searchKeywords: parseJsonArray(settings.searchKeywords),
    searchLocations: parseJsonArray(settings.searchLocations),
    autoApplySkipDomains: parseJsonArray(settings.autoApplySkipDomains),
  };
}

/**
 * Partial update of AppSettings. Array fields are stringified before saving.
 */
export async function updateSettings(data: Record<string, unknown>): Promise<AppSettingsParsed> {
  // Stringify any JSON array fields
  const dbData = { ...data };
  for (const field of JSON_ARRAY_FIELDS) {
    if (Array.isArray(dbData[field])) {
      dbData[field] = toJsonArray(dbData[field] as string[]);
    }
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: 'singleton' },
    update: dbData,
    create: { id: 'singleton', ...dbData },
  });

  return {
    ...settings,
    searchKeywords: parseJsonArray(settings.searchKeywords),
    searchLocations: parseJsonArray(settings.searchLocations),
    autoApplySkipDomains: parseJsonArray(settings.autoApplySkipDomains),
  };
}
