/**
 * One-time, idempotent migration script.
 * Migrates data from settings.json and data files into SQLite via Prisma.
 *
 * Usage: npm run migrate-data
 */
import fs from 'fs';
import path from 'path';
import { prisma } from './database/client';
import { toJsonArray } from './database/profile-queries';

const DATA_DIR = path.resolve('./data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const PROFILE_SUMMARY_PATH = path.join(DATA_DIR, 'profile-summary.json');
const RESUME_PATH = path.join(DATA_DIR, 'resume.pdf');
const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');

async function migrate() {
  console.log('Starting data migration...\n');

  // Step 1: Migrate settings.json → AppSettings
  if (fs.existsSync(SETTINGS_PATH)) {
    console.log('1. Migrating settings.json → AppSettings...');
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

    await prisma.appSettings.upsert({
      where: { id: 'singleton' },
      update: {
        searchKeywords: JSON.stringify(raw.search?.keywords ?? []),
        searchLocations: JSON.stringify(raw.search?.locations ?? ['United States']),
        geoId: raw.search?.geoId ?? '103644278',
        intervalMinutes: raw.scraper?.intervalMinutes ?? 2,
        headless: raw.scraper?.headless ?? true,
        minMatchScore: raw.scraper?.minMatchScore ?? 50,
        maxMinutesAgo: raw.scraper?.maxMinutesAgo ?? 10,
        uiPort: raw.ui?.port ?? 3000,
      },
      create: {
        id: 'singleton',
        searchKeywords: JSON.stringify(raw.search?.keywords ?? []),
        searchLocations: JSON.stringify(raw.search?.locations ?? ['United States']),
        geoId: raw.search?.geoId ?? '103644278',
        intervalMinutes: raw.scraper?.intervalMinutes ?? 2,
        headless: raw.scraper?.headless ?? true,
        minMatchScore: raw.scraper?.minMatchScore ?? 50,
        maxMinutesAgo: raw.scraper?.maxMinutesAgo ?? 10,
        uiPort: raw.ui?.port ?? 3000,
      },
    });

    console.log('   AppSettings created/updated');
    console.log(`   Keywords: ${raw.search?.keywords?.join(', ') || 'none'}`);

    // Step 2: Migrate settings.profile → UserProfile
    if (raw.profile) {
      console.log('\n2. Migrating settings.profile → UserProfile...');
      const prefs = raw.profile.preferences || {};
      const info = raw.profile.additional_info || {};

      await prisma.userProfile.upsert({
        where: { id: 'singleton' },
        update: {
          remoteOnly: prefs.remote_only ?? false,
          willingToRelocate: prefs.willing_to_relocate ?? false,
          preferredCompanySize: toJsonArray(prefs.preferred_company_size ?? []),
          avoidIndustries: toJsonArray(prefs.avoid_industries ?? []),
          preferredTechStack: toJsonArray(prefs.preferred_tech_stack ?? []),
          targetSeniority: toJsonArray(prefs.target_seniority ?? []),
          excludeTitleKeywords: toJsonArray(prefs.exclude_title_keywords ?? []),
          openToContract: info.open_to_contract ?? false,
          visaSponsorshipNeeded: info.visa_sponsorship_needed ?? false,
          minSalary: info.min_salary ?? 0,
          keyInterests: toJsonArray(info.key_interests ?? []),
          dealbreakers: toJsonArray(raw.profile.dealbreakers ?? []),
        },
        create: {
          id: 'singleton',
          remoteOnly: prefs.remote_only ?? false,
          willingToRelocate: prefs.willing_to_relocate ?? false,
          preferredCompanySize: toJsonArray(prefs.preferred_company_size ?? []),
          avoidIndustries: toJsonArray(prefs.avoid_industries ?? []),
          preferredTechStack: toJsonArray(prefs.preferred_tech_stack ?? []),
          targetSeniority: toJsonArray(prefs.target_seniority ?? []),
          excludeTitleKeywords: toJsonArray(prefs.exclude_title_keywords ?? []),
          openToContract: info.open_to_contract ?? false,
          visaSponsorshipNeeded: info.visa_sponsorship_needed ?? false,
          minSalary: info.min_salary ?? 0,
          keyInterests: toJsonArray(info.key_interests ?? []),
          dealbreakers: toJsonArray(raw.profile.dealbreakers ?? []),
        },
      });

      console.log('   UserProfile created/updated');
      console.log(`   Tech stack: ${prefs.preferred_tech_stack?.join(', ') || 'none'}`);
      console.log(`   Target seniority: ${prefs.target_seniority?.join(', ') || 'none'}`);
      console.log(`   Exclude keywords: ${prefs.exclude_title_keywords?.length || 0} keywords`);
    }
  } else {
    console.log('1. No settings.json found — skipping (defaults will be used)');
  }

  // Step 3: Migrate profile-summary.json → UserProfile.profileSummaryCache
  if (fs.existsSync(PROFILE_SUMMARY_PATH)) {
    console.log('\n3. Migrating profile-summary.json → profileSummaryCache...');
    const summary = fs.readFileSync(PROFILE_SUMMARY_PATH, 'utf-8');

    await prisma.userProfile.upsert({
      where: { id: 'singleton' },
      update: {
        profileSummaryCache: summary,
        profileSummaryCachedAt: new Date(),
      },
      create: {
        id: 'singleton',
        profileSummaryCache: summary,
        profileSummaryCachedAt: new Date(),
      },
    });

    console.log('   Profile summary cache written to DB');
  } else {
    console.log('\n3. No profile-summary.json found — skipping');
  }

  // Step 4: Migrate resume.pdf → data/documents/ + Document row
  if (fs.existsSync(RESUME_PATH)) {
    console.log('\n4. Migrating resume.pdf → documents/...');

    // Ensure documents directory exists
    if (!fs.existsSync(DOCUMENTS_DIR)) {
      fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    }

    const destPath = path.join(DOCUMENTS_DIR, 'resume.pdf');

    // Copy if not already there
    if (!fs.existsSync(destPath)) {
      fs.copyFileSync(RESUME_PATH, destPath);
      console.log('   Copied resume.pdf → documents/resume.pdf');
    } else {
      console.log('   documents/resume.pdf already exists — skipping copy');
    }

    // Check if document row already exists
    const existing = await prisma.document.findFirst({
      where: { profileId: 'singleton', type: 'resume', isPrimary: true },
    });

    if (!existing) {
      const stat = fs.statSync(destPath);
      await prisma.document.create({
        data: {
          profileId: 'singleton',
          type: 'resume',
          filename: 'resume.pdf',
          storagePath: 'documents/resume.pdf',
          mimeType: 'application/pdf',
          sizeBytes: stat.size,
          isPrimary: true,
        },
      });
      console.log('   Document row created (primary resume)');
    } else {
      console.log('   Document row already exists — skipping');
    }
  } else {
    console.log('\n4. No resume.pdf found — skipping');
  }

  console.log('\n--- Migration complete ---');
  console.log('Original files have NOT been deleted. You can verify and remove them manually.');

  await prisma.$disconnect();
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
