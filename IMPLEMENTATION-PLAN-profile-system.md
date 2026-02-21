# Implementation Plan: Profile & Settings System Redesign

## Overview

Move all structured data from flat files (`data/settings.json`, `data/profile-summary.json`) into SQLite via Prisma. Keep binary files (PDFs, documents) on disk in `data/documents/`, tracked by a `Document` table. Eliminate `settings.json` entirely.

**Two-tier storage:**
- **SQLite (Prisma)** — all structured data: user profile, preferences, work history, education, skills, references, app settings
- **Disk (`data/documents/`)** — binary files (resume PDFs, etc.), referenced by DB rows

---

## Phase 1: Prisma Schema — New Models

Add these models to `prisma/schema.prisma`:

### UserProfile (singleton — merges personal info + preferences)

```prisma
model UserProfile {
  id        String   @id @default("singleton")

  // Contact Info
  firstName   String @default("")
  lastName    String @default("")
  email       String @default("")
  phone       String @default("")
  linkedinUrl String @default("")
  website     String @default("")
  city        String @default("")
  state       String @default("")
  country     String @default("")
  zipCode     String @default("")

  // Personal Summary (user-written elevator pitch)
  summary     String @default("")

  // AI-Generated Profile Cache (replaces data/profile-summary.json)
  profileSummaryCache    String?
  profileSummaryCachedAt DateTime?

  // Job Preferences (replaces settings.profile.preferences)
  remoteOnly            Boolean @default(false)
  willingToRelocate     Boolean @default(false)
  openToContract        Boolean @default(false)
  visaSponsorshipNeeded Boolean @default(false)
  minSalary             Int     @default(0)
  preferredCompanySize  String  @default("[]")  // JSON array
  avoidIndustries       String  @default("[]")  // JSON array
  preferredTechStack    String  @default("[]")  // JSON array
  targetSeniority       String  @default("[]")  // JSON array
  excludeTitleKeywords  String  @default("[]")  // JSON array
  keyInterests          String  @default("[]")  // JSON array
  dealbreakers          String  @default("[]")  // JSON array

  // Relations
  workExperience WorkExperience[]
  education      Education[]
  skills         Skill[]
  references     Reference[]
  documents      Document[]

  updatedAt DateTime @updatedAt
}
```

### WorkExperience

```prisma
model WorkExperience {
  id          String   @id @default(uuid())
  profileId   String   @default("singleton")
  profile     UserProfile @relation(fields: [profileId], references: [id])

  employer    String
  title       String
  location    String   @default("")
  startDate   String   // "2023-01" format
  endDate     String?  // null = current position
  isCurrent   Boolean  @default(false)
  description String   @default("")
  sortOrder   Int      @default(0)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([profileId])
}
```

### Education

```prisma
model Education {
  id           String   @id @default(uuid())
  profileId    String   @default("singleton")
  profile      UserProfile @relation(fields: [profileId], references: [id])

  institution  String
  degree       String
  fieldOfStudy String   @default("")
  startDate    String?
  endDate      String?
  gpa          String?
  sortOrder    Int      @default(0)

  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([profileId])
}
```

### Skill

```prisma
model Skill {
  id                String   @id @default(uuid())
  profileId         String   @default("singleton")
  profile           UserProfile @relation(fields: [profileId], references: [id])

  name              String
  category          String   @default("technical")
  yearsOfExperience Int?
  proficiency       String?

  createdAt         DateTime @default(now())

  @@index([profileId])
}
```

### Reference

```prisma
model Reference {
  id           String   @id @default(uuid())
  profileId    String   @default("singleton")
  profile      UserProfile @relation(fields: [profileId], references: [id])

  name         String
  relationship String   @default("")
  company      String   @default("")
  email        String   @default("")
  phone        String   @default("")
  notes        String   @default("")

  createdAt    DateTime @default(now())

  @@index([profileId])
}
```

### Document (tracks files on disk)

```prisma
model Document {
  id          String   @id @default(uuid())
  profileId   String   @default("singleton")
  profile     UserProfile @relation(fields: [profileId], references: [id])

  type        String   // "resume", "other"
  filename    String
  storagePath String   // relative: "documents/resume-20260220.pdf"
  mimeType    String   @default("application/pdf")
  sizeBytes   Int      @default(0)
  isPrimary   Boolean  @default(false)

  uploadedAt  DateTime @default(now())

  @@index([profileId])
}
```

### AppSettings (singleton — operational config only)

```prisma
model AppSettings {
  id                String  @id @default("singleton")

  // Search
  searchKeywords    String  @default("[]")
  searchLocations   String  @default("[\"United States\"]")
  geoId             String  @default("103644278")

  // Scraper
  intervalMinutes   Int     @default(2)
  headless          Boolean @default(true)
  minMatchScore     Int     @default(50)
  maxMinutesAgo     Int     @default(10)

  // UI
  uiPort            Int     @default(3000)

  updatedAt         DateTime @updatedAt
}
```

**Run:** `npx prisma migrate dev --name add_profile_and_settings_models`

---

## Phase 2: Database Query Layer

### New file: `src/database/profile-queries.ts`

CRUD functions for the new models:

**UserProfile:**
- `getOrCreateProfile()` — returns singleton with all relations, creates with defaults if missing
- `updateProfile(data)` — partial update; invalidates `profileSummaryCache` when profile/preference data changes
- `getProfileForAI()` — returns profile + preferences + work experience + education + skills (no references/documents)
- `invalidateProfileSummaryCache()` — nulls cache fields
- `setProfileSummaryCache(summary)` — writes cache + timestamp
- `getProfileSummaryCache()` — returns `{ cache: string | null, cachedAt: Date | null }`

**WorkExperience CRUD:** `getWorkExperience()`, `addWorkExperience(data)`, `updateWorkExperience(id, data)`, `deleteWorkExperience(id)`

**Education CRUD:** `getEducation()`, `addEducation(data)`, `updateEducation(id, data)`, `deleteEducation(id)`

**Skill CRUD:** `getSkills()`, `addSkill(data)`, `updateSkill(id, data)`, `deleteSkill(id)`

**Reference CRUD:** `getReferences()`, `addReference(data)`, `updateReference(id, data)`, `deleteReference(id)`

**Document tracking:** `getDocuments()`, `addDocument(data)`, `deleteDocument(id)`, `getPrimaryResume()`

**JSON helpers:** `parseJsonArray(value: string): string[]` and `toJsonArray(arr: string[]): string`

### New file: `src/database/settings-queries.ts`

- `getOrCreateSettings()` — returns singleton, creates with defaults if missing; parses JSON arrays
- `updateSettings(data)` — partial update; stringifies array fields

---

## Phase 3: Rewrite `src/config.ts`

**Remove:** `loadSettings()`, `saveSettings()`, `getSettingsPath()`, `DEFAULTS`, `Settings` type, all `settings.json` file I/O.

**Add:**
- `initConfig()` — async, must be called once at startup. Queries `AppSettings` from DB, populates the `config` object.
- `reloadConfig()` — now `async`. Re-queries DB, repopulates `config`.

**Config object shape changes:**
- `config.nvidia` — unchanged (reads from `process.env`)
- `config.search` — keywords, locations, geoId from `AppSettings`
- `config.scraper` — from `AppSettings` + hardcoded operational constants (maxConsecutiveErrors, delays, etc.)
- `config.ui` — port from `AppSettings`
- `config.profile` — **REMOVED**. Code that reads preferences must accept them as parameters or query DB directly.
- `config.paths` — reduced to just `logs`. Resume path looked up via `getPrimaryResume()`. LinkedIn cookies stays as hardcoded constant.

**Callers to update:**
- `src/index.ts` — add `await initConfig()` before `startServer()`
- `src/scraper-agent.ts` — add `await initConfig()` before `startScheduler()`

---

## Phase 4: Update Data Consumers

### `src/ai/resume-processor.ts`

- Check `getProfileSummaryCache()` from DB instead of checking file on disk
- Get resume path from `getPrimaryResume()` → read PDF from `data/{storagePath}`
- Get additional context from `getProfileForAI()` instead of `loadSettings()`
- Write cache via `setProfileSummaryCache()` instead of `fs.writeFileSync`
- Remove all `profile-summary.json` file I/O

### `src/ai/job-matcher.ts`

- `filterRelevantJobs()` gains a `preferences` parameter:
  ```ts
  interface ProfilePreferences {
    excludeTitleKeywords: string[];
    targetSeniority: string[];
    preferredTechStack: string[];
  }
  ```
- `preFilterByKeywords()` takes `excludeKeywords: string[]` parameter instead of reading from `config`
- Remove all `config.profile` references

### `src/scheduler.ts`

- At start of `runScrapeCycle()`: call `await reloadConfig()` for fresh settings
- Load profile preferences from DB via `getProfileForAI()` once per cycle
- Pass preferences to `filterRelevantJobs()`

---

## Phase 5: UI Routes & Templates

### New file: `src/ui/profile-routes.ts`

**Routes:**
```
GET  /profile                      — Profile overview page
POST /profile/personal             — Update contact info + summary
POST /profile/preferences          — Update job preferences

POST /profile/experience           — Add work experience
POST /profile/experience/:id       — Update entry
POST /profile/experience/:id/delete — Delete entry

POST /profile/education            — Add education
POST /profile/education/:id        — Update entry
POST /profile/education/:id/delete — Delete entry

POST /profile/skill                — Add skill
POST /profile/skill/:id/delete     — Delete skill

POST /profile/reference            — Add reference
POST /profile/reference/:id        — Update reference
POST /profile/reference/:id/delete — Delete reference

POST /profile/document             — Upload file (multer → data/documents/)
POST /profile/document/:id/delete  — Delete file + DB row
POST /profile/document/:id/primary — Set as primary resume
```

### Rename `src/ui/setup-routes.ts` → `src/ui/settings-routes.ts`

Stripped to only operational config:
```
GET  /settings         — Settings page (API key, search, scraper, UI config)
POST /settings         — Save settings to DB + API key to .env
GET  /settings/export  — Export as JSON download
POST /settings/import  — Import from JSON upload
GET  /setup            — Redirect to /settings (backward compat)
```

### New template: `src/ui/views/profile.ejs`

Sectioned page: Personal Info, Preferences, Work Experience, Education, Skills, References, Documents. Each section has its own form. Follows existing CSS patterns.

### Rename `src/ui/views/setup.ejs` → `src/ui/views/settings.ejs`

Stripped to: API Key, Search Settings, Scraper Settings, UI Settings, Import/Export.

### Update `src/ui/server.ts`

- Mount `profileRouter` and `settingsRouter`
- Remove `setupRouter`
- Make `isConfigured()` async (checks DB for API key + keywords)
- Redirect unconfigured users to `/settings`

### Update navigation in all templates

Add nav links: Dashboard (`/`), Profile (`/profile`), Settings (`/settings`).

---

## Phase 6: Data Migration

### New file: `src/migrate-to-db.ts`

One-time, idempotent migration script. Add `"migrate-data": "tsx src/migrate-to-db.ts"` to package.json.

**Steps:**
1. Read `data/settings.json` → create `AppSettings` row (upsert)
2. Read `settings.profile.*` → create `UserProfile` row with preference fields (upsert)
3. If `data/profile-summary.json` exists → write to `UserProfile.profileSummaryCache`
4. If `data/resume.pdf` exists → copy to `data/documents/resume.pdf`, create `Document` row
5. Log results. Do NOT delete original files (user verifies first).

---

## Phase 7: Cleanup

- Delete `data/settings.example.json`
- Remove dead imports of `loadSettings`, `saveSettings`, `getSettingsPath`, `Settings`
- Update `CLAUDE.md`: Configuration System, File Locations, Common Workflows, Architecture sections
- Add `/setup` → `/settings` redirect for backward compatibility

---

## Implementation Order

| Step | What | Dependencies |
|------|------|-------------|
| 1 | Prisma schema + migration | None |
| 2 | Query layer (`profile-queries.ts`, `settings-queries.ts`) | Step 1 |
| 3 | Rewrite `config.ts` (async init/reload from DB) | Step 2 |
| 4 | Update `index.ts` + `scraper-agent.ts` startup | Step 3 |
| 5 | Update `resume-processor.ts` (DB cache + document path) | Steps 2, 3 |
| 6 | Update `job-matcher.ts` (preferences parameter) | Step 2 |
| 7 | Update `scheduler.ts` (reload from DB, pass preferences) | Steps 3, 5, 6 |
| 8 | Data migration script | Steps 1, 2 |
| 9 | Settings routes + template (rename setup → settings) | Steps 2, 3 |
| 10 | Profile routes + template (new) | Step 2 |
| 11 | Update `server.ts` + navigation | Steps 9, 10 |
| 12 | Cleanup + update CLAUDE.md | All above |

**Steps 1-7 can ship without UI changes** — the scraper keeps working with data in the DB. Steps 9-10 can be done in parallel.

---

## Files Affected

### New:
- `src/database/profile-queries.ts`
- `src/database/settings-queries.ts`
- `src/ui/profile-routes.ts`
- `src/ui/views/profile.ejs`
- `src/migrate-to-db.ts`
- `data/documents/.gitkeep`
- `prisma/migrations/<timestamp>_add_profile_and_settings_models/`

### Modified:
- `prisma/schema.prisma` — 7 new models
- `src/config.ts` — full rewrite
- `src/index.ts` — async init
- `src/scraper-agent.ts` — async init
- `src/scheduler.ts` — DB reload + pass preferences
- `src/ai/resume-processor.ts` — DB cache + document path
- `src/ai/job-matcher.ts` — preferences parameter
- `src/ui/server.ts` — new routers, async middleware
- `src/ui/setup-routes.ts` → renamed to `settings-routes.ts`
- `src/ui/views/setup.ejs` → renamed to `settings.ejs`
- `src/ui/views/jobs.ejs` — nav update
- `src/ui/views/styles.css` — profile page styles
- `package.json` — add migrate-data script
- `CLAUDE.md` — documentation update

### Deleted:
- `data/settings.example.json`

---

## Edge Cases

1. **First-run (empty DB):** All `getOrCreate*` functions use upsert with defaults. App works from scratch.
2. **Concurrent UI + scraper:** SQLite WAL handles concurrent access. Only conflict point is `profileSummaryCache` — use optimistic check before writing.
3. **Document deletion with missing file:** Log warning, still delete DB row.
4. **Multiple primary resumes:** Enforce single primary per type in a transaction.
5. **JSON array parse failures:** `parseJsonArray()` returns `[]` on malformed data.
6. **No resume uploaded:** `getOrCreateProfileSummary()` throws clear error, scraper logs it without crashing.
7. **Scheduler interval change:** Takes effect on next agent restart (document in UI).
