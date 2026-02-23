# Implementation Plan: Improved Job Filtering

## Summary

Overhaul the three-layer job filtering pipeline to dramatically reduce false positives (irrelevant jobs getting saved). The current system relies on a keyword blacklist with bugs and an AI prompt that is too permissive, resulting in roles like "Vision System Engineer", "5DX- Flying Probe Programmer", and "Sr Machine Learning Engineer" being saved. This plan fixes the keyword pre-filter, adds a new configurable title whitelist layer, and rewrites the AI prompt to be anchored around the user's stated role intent rather than vague skill matching.

## Context & Problem

**Current state:** 171 jobs saved, all status "new", many clearly irrelevant. The pipeline has three layers:
1. Keyword blacklist pre-filter (`preFilterByKeywords` in `src/ai/job-matcher.ts`)
2. Deduplication (same title + company)
3. AI batch relevance filter (one API call per keyword batch)

**What's broken:**

1. **Keyword pre-filter has a substring matching bug.** The blacklist contains "sr." (with period) but LinkedIn titles use "Sr " (with space). The `String.includes()` check for "sr." does not match "Sr Machine Learning Engineer" because the title has "Sr " not "Sr.". Same issue affects any keyword where punctuation matters.

2. **No level-number filtering.** "Software Engineer III", "Developer IV", "Platform Engineer II" are senior-level roles. Roman numerals and Arabic level numbers (3, 4) are not in the blacklist.

3. **No positive/whitelist filtering.** The system only rejects bad titles. It never asks "does this title look like a product development role?" A whitelist pre-filter would eliminate most garbage (SMT Programmer, Flying Probe Programmer, CNC Programmer, NX CAD Developer, etc.) at zero cost before the AI call.

4. **AI prompt is too vague.** It says "directly matches the candidate's skills" and "when in doubt, REJECT" but the model interprets Python/software skills broadly enough to keep Robotics Software Engineers, Vision System Engineers, and niche platform roles. The prompt needs to describe what IS wanted, not just what to exclude.

5. **AI error fallback saves ALL jobs.** Line 290 of `src/ai/job-matcher.ts`: `return new Set(afterDedup.map((j) => j.linkedinId))`. If the AI call fails or times out, every job passes. This should fail closed (save nothing).

**Concrete examples of false positives in the database:**
- "5DX- Flying Probe Programmer" / "Surface Mount Technology (SMT) Programmer" / "Computer Numerical Control Programmer" -- manufacturing
- "Vision System Engineer" / "Audio Engineering Specialist" / "Post-Silicon Validation & Debug Engineer" -- hardware/specialized
- "Sr Machine Learning Engineer" / "Advisory Software Engineer" / "Platform Engineer IV" -- seniority not caught
- "Solutions Engineer" (x3) / "JetBrains AI Developer Advocate" -- sales/DevRel roles
- "ServiceNow Developer" / "Power Platform Developer" / "Syteline Developer" / "SSRS Reports Developer" -- niche platform roles
- "IT Systems Support Specialist" / "IT Operations Engineer" / "Syncade MES engineer" -- IT ops/support
- "Model Behavior Engineer" / "Product Developer" / "Observability Engineer" -- ambiguous titles

## Chosen Approach

Three complementary improvements, all configurable via UserProfile in the database (editable from both the Profile page and Setup page):

**Layer A -- Fix and harden the keyword blacklist pre-filter.** Change substring matching to word-boundary-aware matching so "sr" matches "Sr Machine Learning Engineer" without needing the exact punctuation. Add level numbers to the blacklist. Expand with commonly missed terms.

**Layer B -- Add a new configurable title whitelist pre-filter.** A new `includeTitlePatterns` field on UserProfile containing comma-separated patterns. A job title must match at least one pattern to proceed. This runs after the blacklist (Layer A) and before the AI call (Layer C). When the whitelist is empty, this layer is skipped (backward-compatible). Patterns are simple case-insensitive substring matches, same as the blacklist -- no regex needed for users.

**Layer C -- Rewrite the AI prompt.** Add a new `jobSearchDescription` field on UserProfile where the user describes what kind of work they want in plain English (e.g., "I'm a new CS graduate looking for entry-level roles where I'll be building software products -- web apps, mobile apps, AI products, APIs, etc."). The prompt uses this description as the primary filter criterion instead of vague skill-matching. When the field is empty, the prompt falls back to the existing behavior.

**Layer D -- Fail closed on AI errors.** Change the catch block to return an empty set instead of all IDs.

This approach was chosen because:
- Layers A and B are zero-cost (no API calls) and will eliminate 80-90% of false positives
- Layer C catches the remaining edge cases the AI currently lets through
- Everything is configurable -- other users with different job searches can set their own patterns
- The whitelist is optional (empty = disabled) so existing behavior is preserved for users who don't configure it

## Detailed Implementation Steps

### Step 1: Add new fields to UserProfile schema

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/prisma/schema.prisma`

Add two new fields to the `UserProfile` model:

```
includeTitlePatterns  String  @default("[]")  // JSON array of strings
jobSearchDescription  String  @default("")     // Plain-text description of desired roles
```

Add them in the "Job Preferences" group, right after `excludeTitleKeywords` (line 96). The `includeTitlePatterns` field stores a JSON array of case-insensitive substring patterns (same format as `excludeTitleKeywords`). The `jobSearchDescription` field stores a free-text paragraph.

Then run `npm run prisma:migrate` to create the migration.

### Step 2: Update `getProfileForAI` to return new fields

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/database/profile-queries.ts`

In the `getProfileForAI()` function (line 82-104), add two new fields to the returned object:

```typescript
includeTitlePatterns: parseJsonArray(profile.includeTitlePatterns),
jobSearchDescription: profile.jobSearchDescription,
```

Also add `includeTitlePatterns` and `jobSearchDescription` to the `cacheInvalidatingFields` array in `updateProfile()` (line 55-58). Changing these should invalidate the profile summary cache since the AI prompt depends on them.

### Step 3: Update `ProfilePreferences` interface and plumb through scheduler

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

Update the `ProfilePreferences` interface (line 134-138) to add:

```typescript
export interface ProfilePreferences {
  excludeTitleKeywords: string[];
  includeTitlePatterns: string[];
  targetSeniority: string[];
  preferredTechStack: string[];
  jobSearchDescription: string;
}
```

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/scheduler.ts`

Update the preferences object construction (line 87-91) to include the new fields:

```typescript
const preferences: ProfilePreferences = {
  excludeTitleKeywords: profileData.excludeTitleKeywords,
  includeTitlePatterns: profileData.includeTitlePatterns,
  targetSeniority: profileData.targetSeniority,
  preferredTechStack: profileData.preferredTechStack,
  jobSearchDescription: profileData.jobSearchDescription,
};
```

### Step 4: Fix keyword blacklist matching (Layer A)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

Replace the `preFilterByKeywords` function (lines 144-165). The current implementation uses `titleLower.includes(kw)` which requires exact substring match including punctuation. The new implementation should use word-boundary-aware matching.

The fix: for each keyword, strip trailing punctuation (periods, commas) and check if the keyword appears as a word boundary in the title. Specifically:

1. Normalize each keyword: trim and lowercase.
2. For each keyword, build a regex that matches the keyword at word boundaries. Use `\b` word boundaries for alphanumeric keywords. For keywords with special characters (like "c++", ".net"), fall back to the current `includes()` behavior.
3. Test the title against the regex.

The implementation should look like:

```typescript
function preFilterByKeywords(jobs: JobForFiltering[], excludeKeywords: string[]): {
  passed: JobForFiltering[];
  rejected: JobForFiltering[];
} {
  if (excludeKeywords.length === 0) return { passed: jobs, rejected: [] };

  // Build regexes for each keyword, handling punctuation gracefully
  const matchers = excludeKeywords.map((kw) => {
    const normalized = kw.trim().toLowerCase();
    // Strip trailing period for matching (so "sr." matches "sr ")
    const base = normalized.replace(/\.+$/, '');
    // If keyword is purely alphanumeric/spaces, use word boundaries
    if (/^[a-z0-9\s]+$/i.test(base)) {
      return new RegExp(`\\b${escapeRegex(base)}\\b`, 'i');
    }
    // For special-character keywords (c++, .net), use simple includes
    return null; // will fall back to includes
  });

  const rawKeywords = excludeKeywords.map((kw) => kw.trim().toLowerCase());

  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();
    const isExcluded = matchers.some((regex, i) => {
      if (regex) return regex.test(titleLower);
      return titleLower.includes(rawKeywords[i]);
    });
    if (isExcluded) {
      rejected.push(job);
    } else {
      passed.push(job);
    }
  }

  return { passed, rejected };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

**Key behavioral changes:**
- "sr." now matches "Sr Machine Learning Engineer" (because trailing period is stripped, "sr" matches at word boundary)
- "sr." still matches "Sr. Engineer" (the base "sr" matches at word boundary before the period)
- "lead" matches "Lead Software Engineer" but not "Misleading Title" (word boundary)
- Keywords like ".net" or "c++" still use simple includes for correct behavior

### Step 5: Add seniority-level-number detection to the keyword pre-filter

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

Add a new helper function `preFilterBySeniorityLevel` that rejects jobs with Roman numeral or Arabic level indicators that imply senior level. This runs as part of the pre-filter chain, after keyword exclusion.

```typescript
/**
 * Rejects jobs whose titles contain seniority level numbers (II, III, IV, 2, 3, 4, etc.)
 * that indicate mid-senior to senior level. Only active when targetSeniority is set
 * and does NOT include "senior" or "mid-senior" levels.
 *
 * Level mapping:
 *   I / 1 = entry-level (keep)
 *   II / 2 = mid-level (keep if target includes "mid")
 *   III / 3 = senior (reject)
 *   IV / 4+ = staff/principal (reject)
 */
function preFilterBySeniorityLevel(
  jobs: JobForFiltering[],
  targetSeniority: string[],
): { passed: JobForFiltering[]; rejected: JobForFiltering[] } {
  // If no seniority targets set, skip this filter
  if (targetSeniority.length === 0) return { passed: jobs, rejected: [] };

  const targets = targetSeniority.map((s) => s.toLowerCase());
  const allowsSenior = targets.some((t) => t.includes('senior') || t.includes('staff') || t.includes('principal'));
  if (allowsSenior) return { passed: jobs, rejected: [] };

  const allowsMid = targets.some((t) => t === 'mid' || t === 'mid-level' || t === 'intermediate');

  // Regex to match level indicators at end of title or before parenthetical
  // Matches: "Engineer III", "Developer IV", "Engineer 3", "Developer 4"
  const seniorLevelPattern = /\b(III|IV|V|VI|VII)\b|\b([3-9])\s*(?:\(|$|-|,|:)/i;
  const midLevelPattern = /\bII\b|\b2\s*(?:\(|$|-|,|:)/i;

  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const title = job.title;
    if (seniorLevelPattern.test(title)) {
      rejected.push(job);
    } else if (!allowsMid && midLevelPattern.test(title)) {
      rejected.push(job);
    } else {
      passed.push(job);
    }
  }

  return { passed, rejected };
}
```

**Important edge case:** "Software Engineer II" at a company like Microsoft means mid-level, which might be acceptable. "Software Engineer III" means senior. The function should only reject level III+ by default. Level II is rejected only when targetSeniority does not include "mid". Since the current user's targetSeniority includes "mid", Level II jobs will be kept.

### Step 6: Add title whitelist pre-filter (Layer B)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

Add a new function `preFilterByWhitelist` that runs after keyword exclusion and seniority-level filtering, but before the AI call.

```typescript
/**
 * Whitelist pre-filter: keeps only jobs whose titles match at least one
 * inclusion pattern. When the whitelist is empty, all jobs pass (disabled).
 * Patterns are case-insensitive substring matches.
 */
function preFilterByWhitelist(
  jobs: JobForFiltering[],
  includePatterns: string[],
): { passed: JobForFiltering[]; rejected: JobForFiltering[] } {
  if (includePatterns.length === 0) return { passed: jobs, rejected: [] };

  const lowerPatterns = includePatterns.map((p) => p.trim().toLowerCase());
  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();
    const matches = lowerPatterns.some((pattern) => titleLower.includes(pattern));
    if (matches) {
      passed.push(job);
    } else {
      rejected.push(job);
    }
  }

  return { passed, rejected };
}
```

### Step 7: Wire the new filters into `filterRelevantJobs`

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

Rewrite the `filterRelevantJobs` function (lines 200-292) to use all four filter layers in sequence:

1. Keyword blacklist exclusion (existing, now fixed -- Step 4)
2. Seniority level number filter (new -- Step 5)
3. Title whitelist inclusion filter (new -- Step 6)
4. Deduplication (existing, unchanged)
5. AI batch filter (existing, with rewritten prompt -- Step 8)

The updated flow with logging:

```typescript
export async function filterRelevantJobs(
  profileSummary: string,
  jobs: JobForFiltering[],
  preferences: ProfilePreferences,
): Promise<Set<string>> {
  if (jobs.length === 0) return new Set();

  // Layer 1: Keyword blacklist
  const { passed: afterKeywords, rejected: keywordRejected } =
    preFilterByKeywords(jobs, preferences.excludeTitleKeywords);
  if (keywordRejected.length > 0) {
    logger.info(`Keyword pre-filter: ${jobs.length} -> ${afterKeywords.length} (rejected ${keywordRejected.length})`, {
      rejectedTitles: keywordRejected.map((j) => j.title),
    });
  }

  // Layer 2: Seniority level numbers
  const { passed: afterSeniority, rejected: seniorityRejected } =
    preFilterBySeniorityLevel(afterKeywords, preferences.targetSeniority);
  if (seniorityRejected.length > 0) {
    logger.info(`Seniority level filter: ${afterKeywords.length} -> ${afterSeniority.length} (rejected ${seniorityRejected.length})`, {
      rejectedTitles: seniorityRejected.map((j) => j.title),
    });
  }

  // Layer 3: Title whitelist (skip if empty)
  const { passed: afterWhitelist, rejected: whitelistRejected } =
    preFilterByWhitelist(afterSeniority, preferences.includeTitlePatterns);
  if (whitelistRejected.length > 0) {
    logger.info(`Whitelist pre-filter: ${afterSeniority.length} -> ${afterWhitelist.length} (rejected ${whitelistRejected.length})`, {
      rejectedTitles: whitelistRejected.map((j) => j.title),
    });
  }

  // Layer 4: Deduplication
  const { unique: afterDedup, duplicates } = deduplicateJobs(afterWhitelist);
  if (duplicates > 0) {
    logger.info(`Dedup filter: ${afterWhitelist.length} -> ${afterDedup.length} (removed ${duplicates} duplicates)`);
  }

  if (afterDedup.length === 0) return new Set();

  // Layer 5: AI batch filter (with fail-closed error handling)
  // ... (AI call code, same structure, updated prompt, changed error handling)
}
```

### Step 8: Rewrite the AI relevance filter prompt (Layer C)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/prompts.ts`

Update the `FilteringRules` interface (lines 89-93) to add:

```typescript
export interface FilteringRules {
  targetSeniority: string[];
  excludeTitleKeywords: string[];
  preferredTechStack: string[];
  includeTitlePatterns: string[];
  jobSearchDescription: string;
}
```

Rewrite `buildRelevanceFilterPrompt` (lines 103-145). The key change is shifting from "does this match the candidate's skills?" to "does this match what the candidate is looking for?" The new prompt structure:

1. **If `jobSearchDescription` is set:** Use it as the primary criterion. The prompt tells the AI: "The candidate is looking for: [description]. A job is relevant ONLY if the role involves this kind of work."
2. **If `jobSearchDescription` is empty:** Fall back to the existing skill-matching prompt (backward compatible).
3. **Include specific rejection categories** that the pre-filters might miss (sales roles with "engineer" in title, DevRel, IT support, niche platforms).
4. **Add example-based guidance** showing concrete accept/reject decisions to calibrate the model.

The new prompt:

```typescript
export function buildRelevanceFilterPrompt(
  profileSummary: string,
  jobs: { linkedinId: string; title: string; company: string }[],
  rules: FilteringRules,
): string {
  const jobList = jobs
    .map((j) => `- ID: ${j.linkedinId} | Title: "${j.title}" | Company: "${j.company}"`)
    .join('\n');

  const jobSearchSection = rules.jobSearchDescription
    ? `\nWHAT THE CANDIDATE IS LOOKING FOR:
${rules.jobSearchDescription}

A job is RELEVANT only if the role clearly involves the kind of work described above. The title must indicate a hands-on product development or engineering role. When in doubt, REJECT.`
    : '';

  const senioritySection = rules.targetSeniority.length > 0
    ? `\nSENIORITY RULES:
- The candidate targets: ${rules.targetSeniority.join(', ')} level roles.
- REJECT any title containing "Senior", "Sr", "Staff", "Principal", "Lead", "Director", "VP", "Head of", "Manager", or "Architect" unless the candidate's target seniority explicitly includes that level.
- REJECT titles with level numbers III, IV, V or higher (e.g., "Software Engineer III" = senior level).`
    : '';

  const techSection = rules.preferredTechStack.length > 0
    ? `\nTECH CONTEXT: The candidate works with ${rules.preferredTechStack.join(', ')}.
- REJECT roles focused on unrelated technology domains (embedded systems, hardware, ERP platforms like Guidewire/SAP/Salesforce/ServiceNow, mainframe, COBOL) unless the title is clearly a general software development role.`
    : '';

  const whitelistSection = rules.includeTitlePatterns.length > 0
    ? `\nTITLE GUIDANCE: The candidate is interested in roles matching these patterns: ${rules.includeTitlePatterns.join(', ')}.
- Use this as a signal for what the candidate considers relevant. Titles that are far outside these patterns are likely irrelevant.`
    : '';

  return `You are a STRICT job relevance filter. Given a candidate profile and a list of job postings (title + company only), return ONLY the IDs of jobs that are genuinely relevant.

RULES -- follow these exactly:
1. A job is RELEVANT only if it is a hands-on technical role where the person builds, develops, or engineers software products, features, or systems.
2. When in doubt, REJECT. It is far better to miss a borderline job than to include an irrelevant one. The scraper runs frequently -- missed jobs will appear again.
3. REJECT these categories regardless of how the title is worded:
   - Sales/presales roles (Solutions Engineer, Sales Engineer, Solutions Architect)
   - Developer relations/advocacy (Developer Advocate, Developer Evangelist, Community Engineer)
   - IT support/operations (IT Engineer, IT Specialist, Support Engineer, Systems Administrator)
   - QA/testing-only roles (QA Engineer, Test Engineer, SDET) unless the title says "Software Engineer in Test"
   - Non-software engineering (Mechanical, Electrical, Civil, Chemical, Industrial, Manufacturing, Hardware)
   - Data-only roles with no software development (Data Analyst, Business Analyst, Data Scientist) unless combined with engineering (Data Engineer is borderline -- reject unless it clearly involves software development)
   - Niche platform administration (Salesforce Admin, ServiceNow Admin, SAP Consultant)
   - Research-only roles (Research Scientist) unless combined with engineering
4. REJECT titles that are vague or clearly non-development (Programmer Analyst, Product Developer with no tech context, Specialist, Coordinator)
5. ACCEPT standard software development roles: Software Engineer, Developer, Frontend/Backend/Full Stack Engineer, Mobile Developer/Engineer, Web Developer, AI/ML Engineer (if building products), Platform Engineer (if building software platforms), DevOps Engineer (if it involves building tooling/infrastructure code)
${jobSearchSection}
${senioritySection}
${techSection}
${whitelistSection}

CANDIDATE PROFILE:
${profileSummary}

JOB POSTINGS:
${jobList}

Respond with ONLY valid JSON (no markdown, no code fences). Return ONLY the linkedinId values for jobs that are genuinely relevant:
{
  "relevantIds": ["id1", "id2", "id3"]
}

If NONE of the jobs are relevant, return: { "relevantIds": [] }`;
}
```

**Key differences from the old prompt:**
- Opens with "hands-on technical role where the person builds/develops software" instead of "directly matches the candidate's skills"
- Has an explicit list of REJECT categories with examples (Solutions Engineer, Developer Advocate, IT support, etc.)
- Has an explicit ACCEPT list showing what good titles look like
- Uses the `jobSearchDescription` as primary signal when available
- Passes the whitelist patterns as a hint (not a hard filter -- the AI can still accept jobs outside the patterns if they're clearly relevant)
- Explicitly says missed jobs will appear again (reduces the AI's bias toward false positives)

### Step 9: Change AI error handling to fail closed (Layer D)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

In `filterRelevantJobs`, change the catch block (currently around line 285-291):

**Current (fail open):**
```typescript
} catch (error) {
  logger.error('Failed to filter jobs for relevance', { ... });
  return new Set(afterDedup.map((j) => j.linkedinId));
}
```

**New (fail closed):**
```typescript
} catch (error) {
  logger.error('AI filter failed -- rejecting all jobs (fail closed). They will be re-evaluated next cycle.', {
    jobCount: afterDedup.length,
    error: error instanceof Error ? error.message : String(error),
  });
  return new Set();
}
```

### Step 10: Pass new fields into the filtering rules object

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`

In `filterRelevantJobs`, update the `filteringRules` object construction (currently around line 223-227) to include the new fields:

```typescript
const filteringRules: FilteringRules = {
  targetSeniority: preferences.targetSeniority,
  excludeTitleKeywords: preferences.excludeTitleKeywords,
  preferredTechStack: preferences.preferredTechStack,
  includeTitlePatterns: preferences.includeTitlePatterns,
  jobSearchDescription: preferences.jobSearchDescription,
};
```

### Step 11: Add UI fields for new settings (Profile page)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/views/profile.ejs`

After the `excludeTitleKeywords` textarea (around line 160), add two new form groups:

1. **Include Title Patterns** -- a textarea for the whitelist patterns, with helpful placeholder text and description:

```html
<div class="form-group">
  <label for="includeTitlePatterns">Include Title Patterns <span class="hint">(comma-separated)</span></label>
  <textarea id="includeTitlePatterns" name="includeTitlePatterns" rows="3"
    placeholder="software engineer, developer, frontend, backend, full stack, mobile, web developer, AI engineer"><%= parseJsonArray(profile.includeTitlePatterns).join(', ') %></textarea>
  <span class="hint">Only job titles containing at least one of these patterns will be considered. Leave empty to disable this filter.</span>
</div>
```

2. **Job Search Description** -- a textarea for the plain-text description:

```html
<div class="form-group">
  <label for="jobSearchDescription">What Kind of Roles Are You Looking For?</label>
  <textarea id="jobSearchDescription" name="jobSearchDescription" rows="4"
    placeholder="Example: I'm a new CS graduate looking for entry-level roles where I'll be building software products -- web apps, mobile apps, AI products, APIs, etc. I want to write code and ship features, not do IT support or sales."><%= profile.jobSearchDescription %></textarea>
  <span class="hint">Describe in plain English what kind of work you want. The AI uses this to decide if a job title is relevant to you. Leave empty to use default skill-based matching.</span>
</div>
```

### Step 12: Add UI fields for new settings (Setup page)

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/views/setup.ejs`

After the `exclude_title_keywords` textarea (around line 187), add corresponding fields with the setup page's naming convention (snake_case):

```html
<div class="form-group">
  <label for="include_title_patterns">Include Title Patterns <span class="hint">(comma-separated)</span></label>
  <textarea id="include_title_patterns" name="include_title_patterns" rows="3"
    placeholder="software engineer, developer, frontend, backend, full stack, mobile, web developer, AI engineer"><%= (settings.profile.preferences.include_title_patterns || []).join(', ') %></textarea>
  <span class="hint">Only titles containing at least one of these patterns will be considered. Leave empty to disable.</span>
</div>

<div class="form-group">
  <label for="job_search_description">What Kind of Roles Are You Looking For?</label>
  <textarea id="job_search_description" name="job_search_description" rows="4"
    placeholder="Example: I'm looking for roles where I'll be building software products..."><%= settings.profile.job_search_description || '' %></textarea>
  <span class="hint">Plain English description of the work you want. The AI uses this to judge job relevance.</span>
</div>
```

### Step 13: Update route handlers to save new fields

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/profile-routes.ts`

In the `POST /profile/preferences` handler (lines 135-159), add the two new fields to the `updateProfile` call:

```typescript
includeTitlePatterns: toJsonArray(splitComma(str(req.body.includeTitlePatterns))),
jobSearchDescription: str(req.body.jobSearchDescription),
```

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/setup-routes.ts`

In the `POST /setup/profile` handler (lines 231-272), add to the `updateProfile` call:

```typescript
includeTitlePatterns: toJsonArray(splitComma(include_title_patterns)),
jobSearchDescription: job_search_description || '',
```

Also destructure `include_title_patterns` and `job_search_description` from `req.body` at the top of the handler.

In the `GET /setup` handler (lines 104-162), add the new fields to the `legacySettings` object:

```typescript
profile: {
  preferences: {
    // ... existing fields ...
    include_title_patterns: parseJsonArray(profile.includeTitlePatterns),
  },
  // ... existing fields ...
  job_search_description: profile.jobSearchDescription,
},
```

### Step 14: Update settings import/export

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/setup-routes.ts`

In `POST /setup/import` (lines 310-372), add to the profile import section:

```typescript
includeTitlePatterns: toJsonArray(raw.profile?.preferences?.include_title_patterns ?? []),
jobSearchDescription: raw.profile?.job_search_description ?? '',
```

In `GET /setup/export` (lines 377-427), add to the export object:

```typescript
profile: {
  preferences: {
    // ... existing ...
    include_title_patterns: parseJsonArray(profile.includeTitlePatterns),
  },
  // ... existing ...
  job_search_description: profile.jobSearchDescription,
},
```

### Step 15: Update settings.example.json with new fields

**File:** `/Users/martinbabak/Desktop/projects/job-tracker/data/settings.example.json`

Add the new fields to the profile.preferences section:

```json
{
  "profile": {
    "preferences": {
      "include_title_patterns": [],
      "exclude_title_keywords": []
    },
    "job_search_description": ""
  }
}
```

### Step 16: Populate sensible defaults for current user

After migration, the implementing agent should run a one-time database update (via a migration seed or a manual SQL statement) to set sensible defaults for the current user:

**includeTitlePatterns:** `["software engineer", "software developer", "frontend", "backend", "full stack", "fullstack", "web developer", "mobile developer", "mobile engineer", "AI engineer", "ML engineer", "machine learning engineer", "react developer", "react engineer", "python developer", "node developer", "typescript", "javascript developer", "iOS developer", "iOS engineer", "android developer", "android engineer", "application developer", "applications engineer"]`

**jobSearchDescription:** `"I'm a new CS graduate (May 2026) looking for entry-level roles where I'll be building software products. This includes web applications, mobile apps, AI/ML products, APIs, and developer tools. I want hands-on coding roles -- writing features, building frontends/backends, developing AI agents, shipping product. NOT looking for: IT support, sales engineering, solutions consulting, hardware engineering, QA-only testing, data analysis without coding, or niche enterprise platform administration."`

**excludeTitleKeywords** (replace the current list to fix bugs and add missing terms): `["senior", "sr", "staff", "principal", "lead", "director", "vp", "head of", "manager", "architect", "embedded", "test engineer", "QA", "SDET", "mechanical", "electrical", "civil", "hardware", "systems engineer", "network engineer", "security engineer", "devops", "SRE", "data scientist", "data analyst", "guidewire", "SAP", "salesforce", "mainframe", "COBOL", "solutions engineer", "sales engineer", "developer advocate", "evangelist", "support engineer", "support specialist", "programmer analyst", "business analyst", "consultant", "administrator", "technician", "coordinator"]`

Note: "sr." is replaced with "sr" (no period) since the new word-boundary matching handles it correctly. "devops" and "SRE" are kept because the user specifically wants product development roles, not ops. These can be removed via the UI if the user changes their mind.

## Files Affected

**New files:** None (all changes are to existing files).

**Modified files:**

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `includeTitlePatterns` and `jobSearchDescription` to UserProfile |
| `src/database/profile-queries.ts` | Return new fields from `getProfileForAI()`, add to cache invalidation list |
| `src/ai/job-matcher.ts` | Fix `preFilterByKeywords`, add `preFilterBySeniorityLevel`, add `preFilterByWhitelist`, update `ProfilePreferences` interface, update `filterRelevantJobs` pipeline, change error handling to fail closed |
| `src/ai/prompts.ts` | Update `FilteringRules` interface, rewrite `buildRelevanceFilterPrompt` |
| `src/scheduler.ts` | Pass new fields into `ProfilePreferences` |
| `src/ui/views/profile.ejs` | Add includeTitlePatterns textarea, jobSearchDescription textarea |
| `src/ui/views/setup.ejs` | Add include_title_patterns textarea, job_search_description textarea |
| `src/ui/profile-routes.ts` | Save new fields in POST /profile/preferences |
| `src/ui/setup-routes.ts` | Save/load new fields in POST /setup/profile, GET /setup, import/export |
| `data/settings.example.json` | Add new fields with empty defaults |

## Data Flow / Architecture

The improved filter pipeline, in order:

```
LinkedIn cards (100-170 per keyword)
  |
  v
Time filter (keep only jobs <= maxMinutesAgo)
  |
  v
[Layer A] Keyword blacklist (word-boundary matching, zero cost)
  |  - Rejects: "Sr ML Engineer", "Staff Engineer", "Lead Developer", etc.
  v
[Layer A+] Seniority level numbers (zero cost)
  |  - Rejects: "Engineer III", "Developer IV", etc.
  v
[Layer B] Title whitelist (zero cost, optional)
  |  - Rejects: "Flying Probe Programmer", "CNC Programmer", "Vision System Engineer"
  |  - Keeps: "Software Engineer", "Backend Developer", "AI Engineer", etc.
  v
Deduplication (same title + company, zero cost)
  |
  v
[Layer C] AI batch filter (one API call)
  |  - Uses rewritten prompt with jobSearchDescription
  |  - Catches edge cases: "Solutions Engineer" (sales), "Developer Advocate" (devrel)
  |  - Fails closed on error (returns empty set)
  v
DB dedup check (reject already-saved jobs)
  |
  v
Save to database
```

**Settings flow:**
1. User edits `includeTitlePatterns` / `jobSearchDescription` via Profile page or Setup page
2. Saved to `UserProfile` table in SQLite via `updateProfile()`
3. Profile summary cache is invalidated (so AI gets fresh context next cycle)
4. On next scrape cycle, `getProfileForAI()` loads the new values
5. Values flow into `ProfilePreferences` -> `filterRelevantJobs()` -> pre-filters + prompt builder

## Edge Cases & Error Handling

1. **Empty whitelist:** When `includeTitlePatterns` is empty, the whitelist filter is a no-op (all jobs pass through). This preserves backward compatibility.

2. **Empty jobSearchDescription:** When empty, the AI prompt falls back to skill-based matching (existing behavior).

3. **AI call failure:** Returns empty set (fail closed). The log message explicitly says jobs will be re-evaluated next cycle, so the operator knows this is intentional.

4. **Keyword with special regex characters:** The `escapeRegex` helper prevents "c++" or ".net" from being interpreted as regex. These keywords fall back to simple `includes()` matching.

5. **Word boundary edge cases for keyword matching:**
   - "sr" matches "Sr Engineer" (word boundary before space)
   - "sr" does NOT match "Israel" (no word boundary -- "sr" is in the middle of a word). Actually wait -- `\bsr\b` would not match "Israel" because "s" is not at a word boundary. Correct.
   - "QA" matches "QA Engineer" but not "AQUA" (word boundaries)
   - "lead" matches "Lead Engineer" but not "Misleading Title" -- actually `\blead\b` would NOT match "Misleading" because there's no word boundary before "lead" in that word. Correct.

6. **Roman numeral false positives:** "II" could match words containing "II" that aren't level numbers. The regex uses `\bII\b` which requires word boundaries, so "FHII" would not match but "Engineer II" would. The risk is low because job titles rarely contain standalone "II" for non-level purposes.

7. **Level I jobs:** Level I (e.g., "Software Engineer I") is treated as entry-level and always kept. The seniority filter only rejects II+ (when target excludes mid) or III+ (always, when targets are junior/entry-level/mid).

8. **The whitelist must be broad enough.** If the user sets patterns too narrowly (e.g., only "software engineer"), they'll miss "Frontend Developer" or "React Engineer". The default patterns list in Step 16 is deliberately broad. The UI hint text should guide the user.

## Testing Considerations

**Manual testing against the existing database (most valuable):**

Run the 171 existing job titles through the new filter pipeline in isolation (without the scraper) to verify:
- The keyword blacklist now catches "Sr Machine Learning Engineer" (was missed before)
- "Software Engineer III" and "Developer IV" are caught by seniority level filter
- "5DX- Flying Probe Programmer", "Surface Mount Technology (SMT) Programmer", "Vision System Engineer" are caught by the whitelist
- "Software Engineer", "Full Stack Developer", "Frontend Software Engineer", "FullStack Developer - Applied AI" all pass through
- "Solutions Engineer", "Developer Advocate" are caught by the AI prompt rewrite

A quick validation script could load all 171 titles and run them through the three pre-filter layers (no AI call needed) to count how many would be rejected vs. kept. This would give immediate confidence before a live test.

**Unit test cases for `preFilterByKeywords`:**
- "Sr Machine Learning Engineer" rejected by "sr" keyword (word boundary, no period needed)
- "Sr. Software Engineer" rejected by "sr" keyword
- "Software Engineer" NOT rejected by "sr" keyword
- "Israel Technologies" NOT rejected by "sr" keyword
- "Lead Developer" rejected by "lead" keyword
- "Misleading Title" NOT rejected by "lead" keyword

**Unit test cases for `preFilterBySeniorityLevel`:**
- "Software Engineer III" rejected (target: entry-level, mid)
- "Software Engineer IV" rejected
- "Software Engineer II" NOT rejected (target includes mid)
- "Software Engineer I" NOT rejected
- "Software Engineer" (no level) NOT rejected
- "Software Engineer 3" rejected

**Unit test cases for `preFilterByWhitelist`:**
- "Software Engineer" passes with patterns ["software engineer", "developer"]
- "Full Stack Developer" passes
- "Vision System Engineer" rejected (no pattern matches "vision system")
- "5DX- Flying Probe Programmer" rejected
- All jobs pass when patterns is empty array

**Integration test:** Run one full scrape cycle with the new pipeline and compare the saved jobs against a manual review of what should have been saved.

## Migration / Breaking Changes

**Database migration required:** Adding two columns to UserProfile. This is a non-breaking additive migration (both have defaults). Run `npm run prisma:migrate` with migration name like `add_title_whitelist_and_search_description`.

**Settings import/export:** The new fields are added to the export format. Old settings files without these fields will import correctly (they'll use defaults via the `?? []` / `?? ''` fallback).

**Behavioral change:** The fail-closed error handling (Step 9) is a deliberate behavioral change. Previously, AI failures resulted in all jobs being saved. Now they result in no jobs being saved. This is intentional -- the scraper runs every 2 minutes, so missed jobs reappear quickly.

**Profile summary cache:** Adding `includeTitlePatterns` and `jobSearchDescription` to the cache-invalidating fields means the profile summary will be regenerated when these fields are first set. This is a one-time cost.

## Open Questions

1. **Should the seniority level filter be configurable?** Currently it's hardcoded to reject III+ always and II when target doesn't include "mid". An alternative is to let users specify a max level number. For now, the hardcoded logic matches the user's needs and avoids over-engineering. Flag this if a future user has different seniority requirements.

2. **Should the whitelist patterns support regex?** Currently they're simple substring matches. Regex would allow patterns like `\bdev(eloper)?\b` but would be confusing for non-technical users. Substring matching covers 95% of use cases. The AI (Layer C) handles the remaining edge cases. Recommend keeping it simple.

3. **Should we log which layer rejected each job in a structured way?** Currently each layer logs separately. A combined "filter pipeline summary" log entry showing the full journey of all jobs through all layers would be useful for debugging. Not blocking, but nice to have.
