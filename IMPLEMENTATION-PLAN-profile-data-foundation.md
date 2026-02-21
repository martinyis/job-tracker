# Implementation Plan: Profile & Data Foundation for Auto-Apply

## Summary

Expand the database schema and profile UI to capture all personal data the auto-apply agent needs to fill job application forms. This includes a new `DemographicAnswer` model for sensitive/legal questions (veteran status, ethnicity, gender, disability, work authorization), additional fields on `UserProfile` for commonly requested application data not yet tracked, and a new "Application Answers" section in the profile UI where users configure their demographic responses once.

## Context & Problem

The existing `UserProfile` model covers contact info (name, email, phone, address), work experience, education, skills, and job preferences. This is sufficient for the scraper agent's AI filtering, but an auto-apply agent needs more:

1. **Demographic/legal questions** -- Applications routinely ask about veteran status, disability, gender, race/ethnicity, and work authorization. These cannot be AI-generated; they require explicit user-provided answers. There is currently no place to store these.

2. **Missing common application fields** -- Some fields that appear on nearly every job application are not in `UserProfile`: date of birth (for age verification), desired salary (exists as `minSalary` but applications often want a specific number or range, not a minimum), years of total experience, preferred name/pronouns, and availability/start date.

3. **Cover letter defaults** -- While the AI will generate tailored cover letters, the user may want to provide a default cover letter or key talking points to guide the AI.

This plan is a prerequisite for the auto-apply agent (Plan 2). It is purely data modeling and UI -- no new processes, no Playwright, no form-filling logic.

## Chosen Approach

**Category-based demographic answer storage in the database.**

Rather than adding dozens of individual Boolean/String fields to `UserProfile` for every possible demographic question, we create a `DemographicAnswer` model that stores question-answer pairs organized by category. The system ships with a predefined list of ~12-15 common categories. The user fills in their answer for each category once. At runtime, the auto-apply agent's AI classifies each form question into a category and retrieves the stored answer.

This approach is:
- **Extensible** -- New categories can be added without schema migrations.
- **Clean** -- Keeps sensitive data separate from general profile fields.
- **Maintainable** -- Adding a new question type is a data change, not a code change.

For missing `UserProfile` fields, we add them directly to the existing model since they are straightforward scalar fields that belong alongside the existing contact/personal info.

## Detailed Implementation Steps

### Step 1: Add `DemographicAnswer` model to Prisma schema

**File: `prisma/schema.prisma`**

Add a new model linked to `UserProfile`:

```prisma
model DemographicAnswer {
  id        String      @id @default(uuid())
  profileId String      @default("singleton")
  profile   UserProfile @relation(fields: [profileId], references: [id])

  category  String      // e.g. "gender", "ethnicity", "veteran_status"
  answer    String      @default("")  // The user's chosen answer text
  notes     String      @default("")  // Optional context for the AI

  updatedAt DateTime    @updatedAt

  @@unique([profileId, category])
  @@index([profileId])
}
```

The `@@unique([profileId, category])` constraint ensures one answer per category per profile. The `notes` field allows the user to provide additional context the AI can use when the form's phrasing is unusual (e.g., for `work_authorization`, notes might say "I am a US citizen, no sponsorship needed").

Add the relation to `UserProfile`:

```prisma
model UserProfile {
  // ... existing fields ...

  // Add this relation
  demographicAnswers DemographicAnswer[]

  // ... existing relations ...
}
```

### Step 2: Add missing fields to `UserProfile`

**File: `prisma/schema.prisma`**

Add these fields to the existing `UserProfile` model, after the existing contact info block:

```prisma
  // Additional Application Fields
  preferredName     String @default("")   // Name to use on applications if different from legal name
  pronouns          String @default("")   // e.g. "he/him", "she/her", "they/them"
  dateOfBirth       String @default("")   // "YYYY-MM-DD" format, for age verification questions
  yearsOfExperience Int    @default(0)    // Total professional years
  desiredSalary     String @default("")   // Free text: "120000", "110k-130k", "negotiable"
  availableStartDate String @default("")  // "immediately", "2 weeks", "2026-03-15", etc.
  coverLetterNotes  String @default("")   // Key talking points/guidance for AI-generated cover letters
```

Rationale for each field:
- `preferredName` -- Some applications ask "preferred name" separately from legal name.
- `pronouns` -- Increasingly common on application forms; also useful for AI-generated text.
- `dateOfBirth` -- Rare on applications, but needed for "are you 18 or older?" type questions. Stored as a string so the user can leave it blank.
- `yearsOfExperience` -- Many forms ask this as a single number. Currently calculable from work history but forms want a specific number.
- `desiredSalary` -- Different from `minSalary` (a filter threshold). This is what the agent puts in the "desired compensation" field. Free text because applications accept different formats.
- `availableStartDate` -- Extremely common application question.
- `coverLetterNotes` -- Not a cover letter itself, but guidance/talking points the AI uses when generating one. Things like "Always mention my experience leading distributed teams" or "Emphasize my transition from backend to full-stack."

### Step 3: Add `ApplierState` model (for Plan 2, but migrate now)

**File: `prisma/schema.prisma`**

Add the state model for the auto-apply agent. Including it in this migration avoids a second migration when Plan 2 starts:

```prisma
model ApplierState {
  id            String   @id @default("singleton")
  lastRunAt     DateTime @default(now())
  lastSuccessAt DateTime?
  errorCount    Int      @default(0)
  isRunning     Boolean  @default(false)
  pid           Int?
  totalApplied  Int      @default(0)
  totalSkipped  Int      @default(0)
  totalFailed   Int      @default(0)
}
```

### Step 4: Add `ApplicationLog` model (for Plan 2, but migrate now)

**File: `prisma/schema.prisma`**

Each auto-apply attempt gets a log entry with details about what happened:

```prisma
model ApplicationLog {
  id        String   @id @default(uuid())
  jobId     String
  job       Job      @relation(fields: [jobId], references: [id])

  status    String   // "applied", "skipped", "failed"
  reason    String   @default("")  // Why it was skipped/failed
  formType  String   @default("")  // "single_page", "multi_step", "account_required", "captcha", "unknown"
  fieldsFilledCount Int @default(0)
  aiCallsUsed       Int @default(0)
  durationMs        Int @default(0)
  screenshotPath    String @default("")  // Path to screenshot taken before/after submission

  createdAt DateTime @default(now())

  @@index([jobId])
  @@index([status])
  @@index([createdAt])
}
```

Add the relation to the `Job` model:

```prisma
model Job {
  // ... existing fields ...

  // Add this relation
  applicationLogs ApplicationLog[]
}
```

### Step 5: Expand the Job status values

**File: `src/database/queries.ts`**

Update the `JobStatus` type to include the new auto-apply statuses:

```typescript
export type JobStatus = 'new' | 'applying' | 'applied' | 'skipped' | 'failed' | 'reviewed' | 'rejected';
```

Update `VALID_STATUSES` in `src/ui/routes.ts` to match:

```typescript
const VALID_STATUSES: JobStatus[] = ['new', 'applying', 'applied', 'skipped', 'failed', 'reviewed', 'rejected'];
```

### Step 6: Run the migration

After making all schema changes from Steps 1-4:

```bash
npx prisma migrate dev --name add_demographic_answers_and_applier_models
```

This creates a single migration that adds:
- `DemographicAnswer` table
- New columns on `UserProfile`
- `ApplierState` table
- `ApplicationLog` table
- Relation column on `Job` for application logs

All new columns have defaults, so existing data is unaffected.

### Step 7: Define predefined demographic categories

**New file: `src/constants/demographic-categories.ts`**

This file defines the system's known demographic question categories. It is used by both the UI (to show the form) and the auto-apply agent (to look up answers).

```typescript
export interface DemographicCategory {
  id: string;           // Unique key, stored in DemographicAnswer.category
  label: string;        // Human-readable label for the UI
  description: string;  // Help text explaining what this covers
  options: string[];    // Common answer options (user can also type custom text)
  defaultAnswer: string; // Pre-filled default (usually empty or "Prefer not to say")
}

export const DEMOGRAPHIC_CATEGORIES: DemographicCategory[] = [
  {
    id: 'gender',
    label: 'Gender',
    description: 'How you identify. Many applications ask this for diversity tracking.',
    options: ['Male', 'Female', 'Non-binary', 'Prefer not to say', 'Other'],
    defaultAnswer: '',
  },
  {
    id: 'ethnicity',
    label: 'Race / Ethnicity',
    description: 'Used for voluntary EEO (Equal Employment Opportunity) reporting.',
    options: [
      'American Indian or Alaska Native',
      'Asian',
      'Black or African American',
      'Hispanic or Latino',
      'Native Hawaiian or Other Pacific Islander',
      'White',
      'Two or More Races',
      'Prefer not to say',
    ],
    defaultAnswer: '',
  },
  {
    id: 'veteran_status',
    label: 'Veteran Status',
    description: 'Protected veteran classification under VEVRAA.',
    options: [
      'I am not a protected veteran',
      'I identify as one or more of the classifications of a protected veteran',
      'I do not wish to answer',
    ],
    defaultAnswer: '',
  },
  {
    id: 'disability_status',
    label: 'Disability Status',
    description: 'Voluntary self-identification under Section 503 of the Rehabilitation Act.',
    options: [
      'Yes, I have a disability (or previously had a disability)',
      'No, I do not have a disability',
      'I do not wish to answer',
    ],
    defaultAnswer: '',
  },
  {
    id: 'work_authorization',
    label: 'Work Authorization',
    description: 'Whether you are legally authorized to work in your target country.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'sponsorship_required',
    label: 'Sponsorship Requirement',
    description: 'Whether you require visa sponsorship now or in the future.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'age_over_18',
    label: 'Age Verification',
    description: 'Whether you are 18 years of age or older.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'felony_conviction',
    label: 'Criminal History',
    description: 'Whether you have been convicted of a felony. Note: many jurisdictions have ban-the-box laws.',
    options: ['Yes', 'No', 'Prefer not to answer'],
    defaultAnswer: '',
  },
  {
    id: 'drug_test',
    label: 'Drug Testing Consent',
    description: 'Whether you are willing to submit to pre-employment drug testing.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'background_check',
    label: 'Background Check Consent',
    description: 'Whether you consent to a background check as part of the hiring process.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'sexual_orientation',
    label: 'Sexual Orientation',
    description: 'Some companies ask for diversity tracking. Always voluntary.',
    options: [
      'Heterosexual',
      'Gay or Lesbian',
      'Bisexual',
      'Prefer not to say',
      'Other',
    ],
    defaultAnswer: '',
  },
  {
    id: 'non_compete',
    label: 'Non-Compete Agreement',
    description: 'Whether you are currently bound by a non-compete or non-solicitation agreement.',
    options: ['Yes', 'No'],
    defaultAnswer: '',
  },
  {
    id: 'security_clearance',
    label: 'Security Clearance',
    description: 'Current or prior government security clearance level.',
    options: [
      'None',
      'Confidential',
      'Secret',
      'Top Secret',
      'Top Secret/SCI',
      'Other',
    ],
    defaultAnswer: '',
  },
];
```

### Step 8: Add demographic answer CRUD to profile queries

**File: `src/database/profile-queries.ts`**

Add functions for managing demographic answers:

```typescript
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
```

Also add a function to get the full profile data for the auto-apply agent (extends `getProfileForAI`):

```typescript
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

    // Preferences (for AI context when generating cover letters, answering questions)
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
```

### Step 9: Update `PROFILE_INCLUDE` to include demographic answers

**File: `src/database/profile-queries.ts`**

Update the existing `PROFILE_INCLUDE` constant to include the new relation:

```typescript
const PROFILE_INCLUDE = {
  workExperience: { orderBy: { sortOrder: 'asc' as const } },
  education: { orderBy: { sortOrder: 'asc' as const } },
  skills: true,
  references: true,
  documents: true,
  demographicAnswers: { orderBy: { category: 'asc' as const } },
};
```

### Step 10: Add ApplicationLog query functions

**New file: `src/database/application-queries.ts`**

```typescript
// Functions needed:
// - createApplicationLog(data) -- called by auto-apply agent after each attempt
// - getApplicationLogsForJob(jobId) -- for dashboard detail view
// - getRecentApplicationLogs(limit) -- for monitoring/dashboard
// - getApplicationStats() -- aggregate counts by status
```

These functions are straightforward Prisma wrappers. The auto-apply agent calls `createApplicationLog` after each application attempt. The dashboard uses the getters to show application history.

### Step 11: Add profile routes for demographic answers

**File: `src/ui/setup-routes.ts`** (or a new file if preferred -- but since setup-routes already handles profile data, adding here keeps it consistent)

Add two routes:

**`GET /profile/demographics`** -- Returns the demographic answers page (or section within the profile page).

**`POST /profile/demographics`** -- Saves all demographic answers in one form submission. The form sends all categories at once (even blank ones), and the handler upserts each one.

The route handler:
1. Reads the submitted form data. Each category is a form field named `demographic_<category_id>`, with an optional `demographic_<category_id>_notes` field.
2. Iterates over all known categories from `DEMOGRAPHIC_CATEGORIES`.
3. For each category, calls `upsertDemographicAnswer(category, answer, notes)`.
4. Redirects back to the profile page with a success indicator.

### Step 12: Add demographic answers and new fields to the profile UI

**File: `src/ui/views/profile.ejs`**

Add a new "Application Answers" section to the profile page. This section contains:

1. **Additional Application Fields** -- Input fields for the new `UserProfile` columns: preferred name, pronouns, date of birth, years of experience, desired salary, available start date, and cover letter notes (textarea).

2. **Demographic & Legal Answers** -- For each category in `DEMOGRAPHIC_CATEGORIES`:
   - The category label and description as help text.
   - A select dropdown populated with the category's `options` array, plus a "Custom" option.
   - A text input for custom answers (shown when "Custom" is selected or when the stored answer does not match any predefined option).
   - An optional "Notes for AI" text input for the `notes` field.
   - The current stored answer pre-selected.

3. A single "Save All" button at the bottom that submits all demographic answers plus the additional profile fields in one POST.

The section should visually separate "Personal Application Info" (pronouns, salary, start date -- light, non-sensitive) from "Demographic & Legal" (gender, ethnicity, veteran -- marked with a note explaining these are for EEO compliance forms and are always voluntary).

### Step 13: Add CSS for the new profile sections

**File: `src/ui/views/styles.css`**

Add styles for:
- `.demographic-section` -- Visually distinct subsection for sensitive data.
- `.demographic-item` -- Each category's input group.
- `.demographic-description` -- Help text under each label.
- `.demographic-note` -- Small info banner explaining that demographic data is voluntary and stored locally only.
- `.select-input` -- Styled select dropdown matching existing form input styles.

Follow the existing dark theme conventions: `#141414` backgrounds, `#2a2a2a` borders, `#e0e0e0` text, `#6ea8fe` accents.

### Step 14: Update status badge styles for new statuses

**File: `src/ui/views/styles.css`**

Add CSS classes for the new job statuses:

```css
.status-applying { background: #2a2a3a; color: #a78bfa; }
.status-skipped { background: #2a2a2a; color: #888; }
.status-failed { background: #3a1a1a; color: #ff6b6b; }
```

### Step 15: Update dashboard filter buttons for new statuses

**File: `src/ui/views/jobs.ejs`**

The filter bar currently shows: All, New, Reviewed, Applied, Rejected. Add buttons for: Applying, Skipped, Failed. The order should be: All | New | Applying | Applied | Skipped | Failed | Reviewed | Rejected.

### Step 16: Add auto-apply settings to AppSettings

**File: `prisma/schema.prisma`**

Add auto-apply configuration fields to the `AppSettings` model (included in the same migration as Step 6):

```prisma
model AppSettings {
  // ... existing fields ...

  // Auto-Apply
  autoApplyEnabled      Boolean @default(false)
  autoApplyDryRun       Boolean @default(true)   // Fill forms but don't submit
  autoApplyBatchSize    Int     @default(5)       // Jobs per cycle
  autoApplyDelaySeconds Int     @default(10)      // Delay between applications
  autoApplyPollMinutes  Int     @default(2)       // How often to check for new jobs when queue is empty
  autoApplySkipDomains  String  @default("[]")    // JSON array of domain patterns to always skip

  // ... existing updatedAt ...
}
```

### Step 17: Add auto-apply settings to the settings UI

**File: `src/ui/views/setup.ejs`**

Add an "Auto-Apply" section to the settings page with form fields for:
- Enable/disable toggle (checkbox)
- Dry run mode toggle (checkbox, default on, with a prominent note: "When enabled, forms are filled but NOT submitted. Review screenshots in logs before turning this off.")
- Batch size (number input)
- Delay between applications (number input, seconds)
- Poll interval (number input, minutes)
- Skip domains (comma-separated text input)

### Step 18: Update settings queries for auto-apply fields

**File: `src/database/settings-queries.ts`**

Add the new fields to `AppSettingsParsed` interface and the parse/stringify logic. `autoApplySkipDomains` is a JSON array field, same pattern as `searchKeywords`.

### Step 19: Update setup-routes to handle auto-apply settings

**File: `src/ui/setup-routes.ts`**

Update `POST /setup/config` to accept and save the new auto-apply fields. Update `GET /setup` to pass them to the template. Update import/export to include auto-apply settings.

## Files Affected

### New Files
- `src/constants/demographic-categories.ts` -- Predefined demographic question categories
- `src/database/application-queries.ts` -- ApplicationLog CRUD functions
- `prisma/migrations/<timestamp>_add_demographic_answers_and_applier_models/` -- Single migration for all schema changes

### Modified Files
- `prisma/schema.prisma` -- Add `DemographicAnswer` model, `ApplierState` model, `ApplicationLog` model, new `UserProfile` fields, `Job` relation, `AppSettings` auto-apply fields
- `src/database/profile-queries.ts` -- Add demographic answer CRUD, `getProfileForAutoApply()`, update `PROFILE_INCLUDE`
- `src/database/settings-queries.ts` -- Add auto-apply fields to `AppSettingsParsed` and parse/stringify logic
- `src/database/queries.ts` -- Expand `JobStatus` type
- `src/ui/setup-routes.ts` -- Add demographic answer routes, handle auto-apply settings
- `src/ui/routes.ts` -- Update `VALID_STATUSES` array
- `src/ui/views/profile.ejs` -- Add "Application Answers" section with demographic and additional fields
- `src/ui/views/setup.ejs` -- Add "Auto-Apply" settings section
- `src/ui/views/jobs.ejs` -- Add filter buttons for new statuses
- `src/ui/views/styles.css` -- Add demographic section styles, new status badge colors

### Unchanged Files
- `src/index.ts` -- No changes
- `src/scraper-agent.ts` -- No changes
- `src/scheduler.ts` -- No changes
- `src/ai/*` -- No changes
- `src/scraper/*` -- No changes
- `src/config.ts` -- No changes (auto-apply config read from DB by the agent directly)
- `src/ui/server.ts` -- No changes (routes already mounted)

## Data Flow / Architecture

```
User fills in profile page:
  Profile form (name, email, etc.) ---> UserProfile table
  Additional fields (salary, start date) ---> UserProfile table
  Demographic answers form ---> DemographicAnswer table (one row per category)

Auto-apply agent reads at runtime (Plan 2):
  getProfileForAutoApply() ---> returns unified object with:
    - All UserProfile fields (Tier 1: direct mapping)
    - All DemographicAnswer rows (Tier 3: lookup by category)
    - Resume file path (for file upload fields)
    - Cover letter notes (Tier 2: AI generation guidance)

AI form-filling flow (Plan 2):
  Form field detected ---> AI classifies into:
    1. Standard field (name, email) ---> map to UserProfile field
    2. Content field (cover letter) ---> AI generates using profile + job details + coverLetterNotes
    3. Demographic field (gender, veteran) ---> lookup in demographicAnswers by category
    4. Unknown required field ---> skip job, log reason
```

## Edge Cases & Error Handling

### 1. User has not filled in demographic answers
`getProfileForAutoApply()` returns an empty `demographicAnswers` object. The auto-apply agent treats unfilled demographic questions the same as "unknown required field" -- it either skips the field (if optional) or skips the entire job (if required and no answer available). The dashboard should show a warning if auto-apply is enabled but demographic answers are mostly empty.

### 2. Form question does not match any predefined category
The AI returns "unknown" as the category. The agent checks if it can answer from general profile data. If not, it skips the field or the job depending on whether the field is required. The `ApplicationLog.reason` field captures what question could not be answered, so the user can add a new demographic answer or profile field if they keep seeing the same skip reason.

### 3. Demographic answer is "Prefer not to say"
This is a valid answer. The AI should select the equivalent option on the form. Most EEO forms explicitly offer this choice.

### 4. User edits demographic answers while auto-apply agent is running
Not a problem. The agent reads answers from DB at the start of each job, not cached for the whole session. Changes take effect on the next job in the queue.

### 5. Date of birth privacy concern
The `dateOfBirth` field is optional and stored locally in SQLite. It is never sent to the AI model. The agent only uses it to answer binary questions like "Are you 18 or older?" by computing age locally. If the user leaves it blank and a form asks for date of birth specifically (not just age verification), the agent skips the field.

### 6. Custom demographic answers
If the user types a custom answer not in the predefined `options` list, it is stored as-is. The AI will use it verbatim when filling the form. This handles edge cases where a form offers options not in our predefined list.

### 7. Migration on existing data
All new columns have defaults. All new tables start empty. No data migration script is needed -- existing profiles and jobs are unaffected. The user simply sees new empty sections to fill in.

## Testing Considerations

### Manual testing checklist

1. **Schema migration**: Run `npx prisma migrate dev`. Verify all new tables and columns exist in Prisma Studio.

2. **Profile page**: Navigate to `/profile`. Verify the new "Application Answers" section renders with all demographic categories. Fill in answers, save, reload -- verify answers persist.

3. **Custom answers**: Select "Other" / "Custom" for a demographic category, type a custom answer. Save and reload -- verify the custom text persists and displays correctly.

4. **Empty state**: With no demographic answers filled, verify `getProfileForAutoApply()` returns a valid object with empty `demographicAnswers` map.

5. **Dashboard filters**: Verify new status filter buttons (Applying, Skipped, Failed) appear and filter correctly. Verify new status badge colors display properly.

6. **Auto-apply settings**: Navigate to settings page. Verify auto-apply section renders with dry-run enabled by default. Toggle settings, save, reload -- verify persistence.

7. **Settings export/import**: Export settings. Verify auto-apply settings are included. Import the file -- verify auto-apply settings round-trip correctly.

## Migration / Breaking Changes

### Database migration
One migration adds all new schema elements. Non-destructive: nullable/defaulted columns only.

### Job status expansion
The `JobStatus` type gains three new values. Existing code that switches on status values (the dashboard template, the filter buttons) needs to handle the new values. No existing statuses are removed or renamed.

### No API changes
No routes are removed or changed. New routes are additive. The `/agent/*` routes are unchanged.

### No dependency changes
No new npm packages required.

## Open Questions

1. **Cover letter storage**: Should the agent save generated cover letters to the `ApplicationLog`? This would let the user review what was sent. The `ApplicationLog` model could gain a `coverLetterText` field. Alternatively, cover letters could be stored as files on disk. Decide during Plan 2 implementation based on storage considerations.

2. **Demographic answer versioning**: If a user changes a demographic answer after some applications were submitted, there is no record of what answer was used for previous applications. If auditability matters, the `ApplicationLog` could snapshot the answers used. This is probably not needed for MVP.

3. **Profile completeness indicator**: The settings page could show a "profile readiness" score -- what percentage of fields are filled in, with warnings for fields that auto-apply commonly needs. This is a nice-to-have UI feature that could be added during or after Plan 2.

## Implementation Order

| Step | What | Dependencies |
|------|------|-------------|
| 1-4 | Schema changes (DemographicAnswer, UserProfile fields, ApplierState, ApplicationLog) | None |
| 5 | Update JobStatus type | None |
| 6 | Run migration | Steps 1-4 |
| 7 | Define demographic categories constant | None |
| 8-9 | Demographic answer CRUD + update PROFILE_INCLUDE | Step 6 |
| 10 | ApplicationLog query functions | Step 6 |
| 11 | Profile routes for demographics | Steps 7, 8 |
| 12-13 | Profile UI + CSS for demographic answers | Steps 7, 11 |
| 14-15 | Status badge styles + dashboard filters | Step 5 |
| 16-19 | Auto-apply settings (schema already done in Step 4, just UI + queries) | Step 6 |

Steps 7-10 can be done in parallel. Steps 11-15 can be done in parallel with 16-19.
