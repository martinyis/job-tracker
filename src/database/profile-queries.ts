import { Prisma } from '@prisma/client';
import { prisma } from './client';

// ─── JSON Helpers ────────────────────────────────────────

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function toJsonArray(arr: string[]): string {
  return JSON.stringify(arr);
}

// ─── Types ───────────────────────────────────────────────

export interface ProfileUpdate {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  website?: string;
  city?: string;
  state?: string;
  country?: string;
  zipCode?: string;
  missionStatement?: string;
  urgencySignals?: string;
  summary?: string;
  remoteOnly?: boolean;
  willingToRelocate?: boolean;
  openToContract?: boolean;
  visaSponsorshipNeeded?: boolean;
  minSalary?: number;
  preferredCompanySize?: string;
  avoidIndustries?: string;
  preferredTechStack?: string;
  targetSeniority?: string;
  excludeTitleKeywords?: string;
  includeTitlePatterns?: string;
  jobSearchDescription?: string;
  keyInterests?: string;
  dealbreakers?: string;
}

export interface WorkExperienceUpdate {
  employer?: string;
  title?: string;
  location?: string;
  startDate?: string;
  endDate?: string | null;
  isCurrent?: boolean;
  description?: string;
  sortOrder?: number;
}

export interface EducationUpdate {
  institution?: string;
  degree?: string;
  fieldOfStudy?: string;
  startDate?: string | null;
  endDate?: string | null;
  gpa?: string | null;
  sortOrder?: number;
}

// ─── UserProfile ─────────────────────────────────────────

const PROFILE_INCLUDE = {
  workExperience: { orderBy: { sortOrder: 'asc' } },
  education: { orderBy: { sortOrder: 'asc' } },
  skills: true,
  documents: true,
} satisfies Prisma.UserProfileInclude;

const CACHE_INVALIDATING_FIELDS: (keyof ProfileUpdate)[] = [
  'firstName', 'lastName', 'summary',
  'preferredTechStack', 'targetSeniority', 'excludeTitleKeywords',
  'includeTitlePatterns', 'jobSearchDescription',
  'keyInterests', 'dealbreakers', 'remoteOnly', 'minSalary',
  'missionStatement', 'urgencySignals',
];

/**
 * Returns the singleton profile with all relations, creating with defaults if missing.
 */
export async function getOrCreateProfile() {
  let profile = await prisma.userProfile.findUnique({
    where: { id: 'singleton' },
    include: PROFILE_INCLUDE,
  });

  if (!profile) {
    profile = await prisma.userProfile.create({
      data: { id: 'singleton' },
      include: PROFILE_INCLUDE,
    });
  }

  return profile;
}

/**
 * Partial update of profile fields. Invalidates profileSummaryCache when
 * profile or preference data changes.
 */
export async function updateProfile(data: ProfileUpdate) {
  const shouldInvalidateCache = Object.keys(data).some((key) =>
    CACHE_INVALIDATING_FIELDS.includes(key as keyof ProfileUpdate),
  );

  const updateData: Prisma.UserProfileUncheckedUpdateInput = { ...data };

  if (shouldInvalidateCache) {
    updateData.profileSummaryCache = null;
    updateData.profileSummaryCachedAt = null;
  }

  return prisma.userProfile.upsert({
    where: { id: 'singleton' },
    update: updateData,
    create: { id: 'singleton', ...data },
    include: PROFILE_INCLUDE,
  });
}

/**
 * Returns profile + preferences for AI consumption.
 */
export async function getProfileForAI() {
  const profile = await getOrCreateProfile();
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    summary: profile.summary,
    remoteOnly: profile.remoteOnly,
    willingToRelocate: profile.willingToRelocate,
    openToContract: profile.openToContract,
    visaSponsorshipNeeded: profile.visaSponsorshipNeeded,
    minSalary: profile.minSalary,
    preferredCompanySize: parseJsonArray(profile.preferredCompanySize),
    avoidIndustries: parseJsonArray(profile.avoidIndustries),
    preferredTechStack: parseJsonArray(profile.preferredTechStack),
    targetSeniority: parseJsonArray(profile.targetSeniority),
    excludeTitleKeywords: parseJsonArray(profile.excludeTitleKeywords),
    includeTitlePatterns: parseJsonArray(profile.includeTitlePatterns),
    jobSearchDescription: profile.jobSearchDescription,
    keyInterests: parseJsonArray(profile.keyInterests),
    dealbreakers: parseJsonArray(profile.dealbreakers),
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,
  };
}

/**
 * Returns profile data specifically for the enrichment AI prompt.
 */
export async function getProfileForEnrichmentAI() {
  const profile = await getOrCreateProfile();
  return {
    profileSummaryCache: profile.profileSummaryCache || '',
    jobSearchDescription: profile.jobSearchDescription,
    missionStatement: profile.missionStatement,
    urgencySignals: profile.urgencySignals,
    keyInterests: parseJsonArray(profile.keyInterests),
    dealbreakers: parseJsonArray(profile.dealbreakers),
    preferredTechStack: parseJsonArray(profile.preferredTechStack),
    targetSeniority: parseJsonArray(profile.targetSeniority),
    workExperience: profile.workExperience.slice(0, 5).map((exp) => ({
      title: exp.title,
      employer: exp.employer,
      startDate: exp.startDate,
      endDate: exp.endDate,
      isCurrent: exp.isCurrent,
    })),
    skills: profile.skills.map((s) => s.name),
  };
}

export async function invalidateProfileSummaryCache() {
  return prisma.userProfile.update({
    where: { id: 'singleton' },
    data: { profileSummaryCache: null, profileSummaryCachedAt: null },
  });
}

export async function setProfileSummaryCache(summary: string) {
  return prisma.userProfile.upsert({
    where: { id: 'singleton' },
    update: { profileSummaryCache: summary, profileSummaryCachedAt: new Date() },
    create: { id: 'singleton', profileSummaryCache: summary, profileSummaryCachedAt: new Date() },
  });
}

export async function getProfileSummaryCache() {
  const profile = await prisma.userProfile.findUnique({
    where: { id: 'singleton' },
    select: { profileSummaryCache: true, profileSummaryCachedAt: true },
  });
  return {
    cache: profile?.profileSummaryCache ?? null,
    cachedAt: profile?.profileSummaryCachedAt ?? null,
  };
}

// ─── WorkExperience CRUD ─────────────────────────────────

export async function addWorkExperience(data: {
  employer: string;
  title: string;
  location?: string;
  startDate: string;
  endDate?: string | null;
  isCurrent?: boolean;
  description?: string;
  sortOrder?: number;
}) {
  const entry = await prisma.workExperience.create({
    data: {
      profileId: 'singleton',
      ...data,
    },
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function updateWorkExperience(id: string, data: WorkExperienceUpdate) {
  const entry = await prisma.workExperience.update({
    where: { id },
    data,
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function deleteWorkExperience(id: string) {
  await prisma.workExperience.delete({ where: { id } });
  await invalidateProfileSummaryCache();
}

// ─── Education CRUD ──────────────────────────────────────

export async function addEducation(data: {
  institution: string;
  degree: string;
  fieldOfStudy?: string;
  startDate?: string | null;
  endDate?: string | null;
  gpa?: string | null;
  sortOrder?: number;
}) {
  const entry = await prisma.education.create({
    data: {
      profileId: 'singleton',
      ...data,
    },
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function updateEducation(id: string, data: EducationUpdate) {
  const entry = await prisma.education.update({
    where: { id },
    data,
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function deleteEducation(id: string) {
  await prisma.education.delete({ where: { id } });
  await invalidateProfileSummaryCache();
}

// ─── Skill CRUD ──────────────────────────────────────────

export async function addSkill(data: {
  name: string;
  category?: string;
  yearsOfExperience?: number | null;
  proficiency?: string | null;
}) {
  const entry = await prisma.skill.create({
    data: {
      profileId: 'singleton',
      ...data,
    },
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function deleteSkill(id: string) {
  await prisma.skill.delete({ where: { id } });
  await invalidateProfileSummaryCache();
}

// ─── Document Tracking ───────────────────────────────────

export async function getDocuments() {
  return prisma.document.findMany({
    where: { profileId: 'singleton' },
    orderBy: { uploadedAt: 'desc' },
  });
}

export async function addDocument(data: {
  type: string;
  filename: string;
  storagePath: string;
  mimeType?: string;
  sizeBytes?: number;
  isPrimary?: boolean;
}) {
  if (data.isPrimary) {
    await prisma.document.updateMany({
      where: { profileId: 'singleton', type: data.type, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  return prisma.document.create({
    data: {
      profileId: 'singleton',
      ...data,
    },
  });
}

export async function deleteDocument(id: string) {
  await prisma.document.delete({ where: { id } });
}

export async function getPrimaryResume() {
  return prisma.document.findFirst({
    where: { profileId: 'singleton', type: 'resume', isPrimary: true },
  });
}
