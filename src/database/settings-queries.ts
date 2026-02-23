import { Prisma } from '@prisma/client';
import { prisma } from './client';
import { parseJsonArray, toJsonArray } from './profile-queries';

export interface AppSettingsParsed {
  id: string;
  searchKeywords: string[];
  searchLocations: string[];
  geoId: string;
  intervalMinutes: number;
  headless: boolean;
  maxMinutesAgo: number;
  uiPort: number;
  updatedAt: Date;
}

export interface AppSettingsUpdate {
  searchKeywords?: string[];
  searchLocations?: string[];
  geoId?: string;
  intervalMinutes?: number;
  headless?: boolean;
  maxMinutesAgo?: number;
  uiPort?: number;
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
  };
}

/**
 * Partial update of AppSettings. Array fields are stringified before saving.
 */
export async function updateSettings(data: AppSettingsUpdate): Promise<AppSettingsParsed> {
  const dbData: Prisma.AppSettingsCreateManyInput = { id: 'singleton' };

  if (data.searchKeywords !== undefined) dbData.searchKeywords = toJsonArray(data.searchKeywords);
  if (data.searchLocations !== undefined) dbData.searchLocations = toJsonArray(data.searchLocations);
  if (data.geoId !== undefined) dbData.geoId = data.geoId;
  if (data.intervalMinutes !== undefined) dbData.intervalMinutes = data.intervalMinutes;
  if (data.headless !== undefined) dbData.headless = data.headless;
  if (data.maxMinutesAgo !== undefined) dbData.maxMinutesAgo = data.maxMinutesAgo;
  if (data.uiPort !== undefined) dbData.uiPort = data.uiPort;

  const settings = await prisma.appSettings.upsert({
    where: { id: 'singleton' },
    update: dbData,
    create: dbData,
  });

  return {
    ...settings,
    searchKeywords: parseJsonArray(settings.searchKeywords),
    searchLocations: parseJsonArray(settings.searchLocations),
  };
}
