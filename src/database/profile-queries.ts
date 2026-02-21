import { prisma } from './client';
import { logger } from '../logger';

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

// ─── UserProfile ─────────────────────────────────────────

const PROFILE_INCLUDE = {
  workExperience: { orderBy: { sortOrder: 'asc' as const } },
  education: { orderBy: { sortOrder: 'asc' as const } },
  skills: true,
  references: true,
  documents: true,
  demographicAnswers: { orderBy: { category: 'asc' as const } },
};

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
export async function updateProfile(data: Record<string, unknown>) {
  // Fields that should invalidate the AI summary cache when changed
  const cacheInvalidatingFields = [
    'firstName', 'lastName', 'summary',
    'preferredTechStack', 'targetSeniority', 'excludeTitleKeywords',
    'keyInterests', 'dealbreakers', 'remoteOnly', 'minSalary',
  ];

  const shouldInvalidateCache = Object.keys(data).some((key) =>
    cacheInvalidatingFields.includes(key),
  );

  if (shouldInvalidateCache) {
    data.profileSummaryCache = null;
    data.profileSummaryCachedAt = null;
  }

  return prisma.userProfile.upsert({
    where: { id: 'singleton' },
    update: data,
    create: { id: 'singleton', ...data },
    include: PROFILE_INCLUDE,
  });
}

/**
 * Returns profile + preferences + work experience + education + skills
 * for AI consumption (no references/documents).
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
    keyInterests: parseJsonArray(profile.keyInterests),
    dealbreakers: parseJsonArray(profile.dealbreakers),
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,
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

export async function getWorkExperience() {
  return prisma.workExperience.findMany({
    where: { profileId: 'singleton' },
    orderBy: { sortOrder: 'asc' },
  });
}

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

export async function updateWorkExperience(id: string, data: Record<string, unknown>) {
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

export async function getEducation() {
  return prisma.education.findMany({
    where: { profileId: 'singleton' },
    orderBy: { sortOrder: 'asc' },
  });
}

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

export async function updateEducation(id: string, data: Record<string, unknown>) {
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

export async function getSkills() {
  return prisma.skill.findMany({
    where: { profileId: 'singleton' },
    orderBy: { name: 'asc' },
  });
}

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

export async function updateSkill(id: string, data: Record<string, unknown>) {
  const entry = await prisma.skill.update({
    where: { id },
    data,
  });
  await invalidateProfileSummaryCache();
  return entry;
}

export async function deleteSkill(id: string) {
  await prisma.skill.delete({ where: { id } });
  await invalidateProfileSummaryCache();
}

// ─── Reference CRUD ──────────────────────────────────────

export async function getReferences() {
  return prisma.reference.findMany({
    where: { profileId: 'singleton' },
    orderBy: { name: 'asc' },
  });
}

export async function addReference(data: {
  name: string;
  relationship?: string;
  company?: string;
  email?: string;
  phone?: string;
  notes?: string;
}) {
  return prisma.reference.create({
    data: {
      profileId: 'singleton',
      ...data,
    },
  });
}

export async function updateReference(id: string, data: Record<string, unknown>) {
  return prisma.reference.update({
    where: { id },
    data,
  });
}

export async function deleteReference(id: string) {
  await prisma.reference.delete({ where: { id } });
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
  // If marking as primary, clear other primaries of same type first
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

// ─── DemographicAnswer CRUD ─────────────────────────────

export async function getDemographicAnswers() {
  return prisma.demographicAnswer.findMany({
    where: { profileId: 'singleton' },
    orderBy: { category: 'asc' },
  });
}

export async function getDemographicAnswerByCategory(category: string) {
  return prisma.demographicAnswer.findUnique({
    where: { profileId_category: { profileId: 'singleton', category } },
  });
}

export async function upsertDemographicAnswer(category: string, answer: string, notes?: string) {
  return prisma.demographicAnswer.upsert({
    where: { profileId_category: { profileId: 'singleton', category } },
    update: { answer, notes: notes ?? '' },
    create: { profileId: 'singleton', category, answer, notes: notes ?? '' },
  });
}

export async function upsertDemographicAnswersBatch(
  answers: Array<{ category: string; answer: string; notes?: string }>
) {
  return prisma.$transaction(
    answers.map((a) =>
      prisma.demographicAnswer.upsert({
        where: { profileId_category: { profileId: 'singleton', category: a.category } },
        update: { answer: a.answer, notes: a.notes ?? '' },
        create: { profileId: 'singleton', category: a.category, answer: a.answer, notes: a.notes ?? '' },
      })
    )
  );
}

export async function deleteDemographicAnswer(category: string) {
  return prisma.demographicAnswer.deleteMany({
    where: { profileId: 'singleton', category },
  });
}

// ─── Auto-Apply Profile Data ────────────────────────────

/**
 * Returns everything the auto-apply agent needs: profile, preferences,
 * work history, education, skills, demographic answers, and primary resume path.
 */
export async function getProfileForAutoApply() {
  const profile = await prisma.userProfile.findUnique({
    where: { id: 'singleton' },
    include: {
      workExperience: { orderBy: { sortOrder: 'asc' } },
      education: { orderBy: { sortOrder: 'asc' } },
      skills: true,
      demographicAnswers: true,
      documents: {
        where: { type: 'resume', isPrimary: true },
        take: 1,
      },
    },
  });

  if (!profile) return null;

  return {
    // Contact info
    firstName: profile.firstName,
    lastName: profile.lastName,
    preferredName: profile.preferredName,
    pronouns: profile.pronouns,
    email: profile.email,
    phone: profile.phone,
    linkedinUrl: profile.linkedinUrl,
    website: profile.website,
    city: profile.city,
    state: profile.state,
    country: profile.country,
    zipCode: profile.zipCode,

    // Additional application fields
    dateOfBirth: profile.dateOfBirth,
    yearsOfExperience: profile.yearsOfExperience,
    desiredSalary: profile.desiredSalary,
    availableStartDate: profile.availableStartDate,
    summary: profile.summary,
    coverLetterNotes: profile.coverLetterNotes,

    // Preferences
    remoteOnly: profile.remoteOnly,
    openToContract: profile.openToContract,
    visaSponsorshipNeeded: profile.visaSponsorshipNeeded,
    minSalary: profile.minSalary,
    preferredTechStack: parseJsonArray(profile.preferredTechStack),
    keyInterests: parseJsonArray(profile.keyInterests),

    // Experience, education, skills
    workExperience: profile.workExperience,
    education: profile.education,
    skills: profile.skills,

    // Demographic answers (keyed by category for easy lookup)
    demographicAnswers: Object.fromEntries(
      profile.demographicAnswers.map((a) => [a.category, { answer: a.answer, notes: a.notes }])
    ),

    // Resume
    resumePath: profile.documents[0]?.storagePath ?? null,
  };
}
