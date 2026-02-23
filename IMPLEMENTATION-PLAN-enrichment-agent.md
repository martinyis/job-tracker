# Implementation Plan: Job Enrichment Agent

## Summary

Add a second agent process ("enrichment agent") that takes jobs saved by the scraper (which only have title, company, and link) and enriches them by visiting the full LinkedIn detail page, extracting the complete job description, company info, people to reach out to, and other metadata. The enriched data is then analyzed by AI against the user's profile, interests, and urgency signals to assign a priority level (urgent/high/normal/low) with actionable insights. The dashboard sorts jobs by priority so the most important opportunities are always at the top.

## Context & Problem

The scraper agent is intentionally fast and shallow -- it grabs card-level data (title, company, link) and saves it in under a minute per cycle. This is by design: speed means catching jobs within minutes of posting.

But the user then has to manually open each job on LinkedIn, read the description, and decide what to do. This is the bottleneck. Some jobs contain signals that demand immediate action (a poster inviting Instagram DMs, a startup building AI agents, a founding engineer role) but these signals are invisible until you read the full description. By then, the advantage of being early may be lost.

The enrichment agent fills this gap. It runs as a background queue processor, visiting each new job's detail page, extracting everything useful, and running an AI analysis that categorizes priority and suggests specific actions.

## Chosen Approach

A separate detached process (matching the existing scraper agent pattern) that operates as a queue processor rather than an interval scheduler. It processes jobs with `status = 'new'` and `enrichmentStatus = 'pending'`, enriching them one at a time with anti-detection delays, then idles when the queue is empty.

This was chosen over:
- **Enriching during the scrape cycle** -- would slow down the scraper, defeating its speed-first purpose. The scraper already visits detail pages for apply link extraction; adding full description parsing + AI calls would multiply cycle time.
- **On-demand enrichment (user clicks a button)** -- defeats the purpose of having intelligence ready when you open the dashboard.
- **Batch enrichment on a fixed interval** -- wasteful when the queue is empty, and introduces unnecessary delay when jobs are waiting.

## Detailed Implementation Steps

### Step 1: Database Schema Changes

**File: `/Users/martinbabak/Desktop/projects/job-tracker/prisma/schema.prisma`**

**1a. Add enrichment fields to the Job model:**

Add these fields to the existing `Job` model, after the `notes` field and before the `createdAt` field:

```
// Enrichment
enrichmentStatus  String   @default("pending")  // pending/enriched/failed/skipped
enrichedAt        DateTime?
priority          String   @default("normal")    // urgent/high/normal/low
priorityReason    String   @default("")
actionItems       String   @default("[]")        // JSON array of action strings
redFlags          String   @default("[]")        // JSON array of warning strings
companyInfo       String   @default("")           // "About the company" text
applicantCount    String   @default("")           // "X applicants" or "Be among first 25"
seniorityLevel    String   @default("")           // metadata chip: "Entry level", "Mid-Senior", etc.
employmentType    String   @default("")           // metadata chip: "Full-time", "Contract", etc.
jobFunction       String   @default("")           // metadata chip: "Engineering", "IT", etc.
postedBy          String   @default("")           // poster name
postedByTitle     String   @default("")           // poster title/role
postedByProfile   String   @default("")           // poster LinkedIn profile URL
contactPeople     String   @default("[]")         // JSON array of {name, title, profileUrl}
```

Add indexes:
```
@@index([enrichmentStatus])
@@index([priority])
```

**1b. Add EnricherState model (singleton, mirrors ScraperState):**

```
model EnricherState {
  id            String   @id @default("singleton")
  lastRunAt     DateTime @default(now())
  lastSuccessAt DateTime?
  errorCount    Int      @default(0)
  isProcessing  Boolean  @default(false)
  pid           Int?
  totalEnriched Int      @default(0)
  totalFailed   Int      @default(0)
}
```

Note: Uses `isProcessing` instead of `isRunning` to avoid confusion with "is the process alive" (which is determined by PID liveness). `isProcessing` means "currently enriching a specific job".

**1c. Add new profile fields to UserProfile:**

Add after the `coverLetterNotes` field:

```
// Enrichment AI Context
missionStatement  String @default("")  // Why you're looking, what excites you, ideal scenario
urgencySignals    String @default("")  // What should trigger "urgent" priority
```

**1d. Create and apply migration:**

Run `npx prisma migrate dev --name add_enrichment_agent` to generate and apply the migration. Existing jobs will get `enrichmentStatus = 'pending'` by default, meaning they'll be queued for enrichment when the agent starts. This is correct -- it will backfill existing jobs.

---

### Step 2: Enrichment Database Queries

**File to create: `/Users/martinbabak/Desktop/projects/job-tracker/src/database/enrichment-queries.ts`**

This module provides all DB operations for the enrichment agent. Functions to implement:

- `getEnricherState()` -- returns the singleton EnricherState, creating it if missing (same pattern as `getScraperState()` in `/Users/martinbabak/Desktop/projects/job-tracker/src/database/queries.ts`)
- `setEnricherPid(pid: number)` -- writes the agent's PID
- `clearEnricherPid()` -- clears PID and resets isProcessing
- `resetEnricherStateOnStartup()` -- clears stuck isProcessing and stale PIDs (same pattern as `resetScraperStateOnStartup()`)
- `markEnricherProcessing()` -- sets isProcessing = true, updates lastRunAt
- `markEnricherSuccess()` -- sets isProcessing = false, updates lastSuccessAt, resets errorCount, increments totalEnriched
- `markEnricherError()` -- sets isProcessing = false, increments errorCount and totalFailed
- `getNextJobToEnrich()` -- queries for the first job where `enrichmentStatus = 'pending'` AND `status = 'new'`, ordered by `createdAt DESC` (newest first). Returns null if queue is empty.
- `getEnrichmentQueueSize()` -- counts jobs matching the same criteria (for dashboard display)
- `updateJobEnrichment(id: string, data: EnrichmentData)` -- updates a job with all the enrichment fields (description, priority, priorityReason, matchScore, matchReason, keyMatches, actionItems, redFlags, companyInfo, contactPeople, etc.) and sets `enrichmentStatus = 'enriched'` and `enrichedAt = new Date()`
- `markJobEnrichmentFailed(id: string)` -- sets `enrichmentStatus = 'failed'`
- `markJobEnrichmentSkipped(id: string)` -- sets `enrichmentStatus = 'skipped'` (for jobs whose status changed to 'rejected' before enrichment reached them)

The `EnrichmentData` interface should include all the fields being updated: description, priority, priorityReason, matchScore, matchReason, keyMatches (as string[]), actionItems (as string[]), redFlags (as string[]), companyInfo, applicantCount, seniorityLevel, employmentType, jobFunction, postedBy, postedByTitle, postedByProfile, contactPeople (as array of {name, title, profileUrl}).

JSON array fields (keyMatches, actionItems, redFlags, contactPeople) should be serialized to JSON strings before storage, consistent with how `keyMatches` is already handled in `saveJob()` at `/Users/martinbabak/Desktop/projects/job-tracker/src/database/queries.ts:132`.

---

### Step 3: Detail Page Scraper

**File to create: `/Users/martinbabak/Desktop/projects/job-tracker/src/scraper/detail-scraper.ts`**

This module handles extracting full data from a LinkedIn job detail page (`/jobs/view/{id}/`). It reuses the existing browser infrastructure (`stealth-browser.ts`, `anti-detection.ts`, `linkedin-auth.ts`) but does NOT extend `LinkedInScraper` -- it's a standalone class because the lifecycle is different (the enricher keeps the browser open across multiple jobs, the scraper opens/closes per cycle).

**Class: `DetailScraper`**

Public methods:
- `launch()` -- launches browser with stealth config, loads LinkedIn cookies, validates session. Same pattern as `LinkedInScraper.launch()` in `/Users/martinbabak/Desktop/projects/job-tracker/src/scraper/linkedin-scraper.ts:44-91`. The enricher REQUIRES authentication -- without it, detail pages show limited data and modals block content. If session validation fails, throw an error so the enricher can report it clearly.
- `scrapeJobDetail(linkedinId: string)` -- navigates to `/jobs/view/{linkedinId}/`, waits for the page to render, extracts all fields, returns a `JobDetail` object. Details below.
- `close()` -- closes browser.

**`scrapeJobDetail` extraction logic:**

Navigate to the job detail page, wait for `[data-view-name="job-detail-page"]` (same selector the apply link extraction already uses), then extract:

1. **Job description**: The main description container. Look for the `.jobs-description__content` or `[class*="description"]` section. Extract `innerText` to get clean text without HTML. Truncate to 10,000 characters as a safety limit.

2. **About the company**: Look for a section that contains company info -- typically a card with company name, follower count, industry, size. This is often in a `[class*="company"]` or `[class*="top-card"]` area. Extract as text.

3. **People you can reach out to**: LinkedIn shows a section like "People you may know at [Company]" or "Meet the hiring team" with small profile cards. For each person card, extract:
   - Name (text from the heading/link)
   - Title (subtitle text)
   - Profile URL (href from the link, clean to `https://www.linkedin.com/in/{slug}/`)

   Return as an array. This section may not exist on all jobs -- return empty array if not found.

4. **Poster info**: The person who posted the job sometimes appears at the top or in a "Posted by" section. Extract name, title, and profile URL. If not found, leave empty strings.

5. **Applicant count**: LinkedIn shows text like "47 applicants" or "Be among the first 25 applicants" or "Over 200 applicants". Extract this text as-is. Look for elements containing "applicant" text.

6. **Metadata chips**: LinkedIn shows chips for seniority level, employment type, job function, and sometimes industry. These are typically in a `[class*="description__job-criteria"]` list or similar. Extract each as text.

**Important implementation notes for scraping:**

- Use `page.evaluate()` for most extraction to avoid multiple round-trips. Write one large evaluate function that returns all fields at once.
- CSS class names on LinkedIn are heavily obfuscated and change frequently. Prefer selectors that use data attributes, ARIA roles, or structural patterns (e.g., "the second section inside the main content area") over specific class names. Where class names must be used, use partial matches (`[class*="description"]`) and try multiple selectors with fallbacks.
- Some sections load lazily. After initial page load, scroll the page once to trigger any lazy-loaded sections, wait 1 second, then extract.
- If the page redirects to `/login` or `/authwall`, detect this and throw a `SessionExpiredError` so the enricher can handle it.
- If extraction partially fails (e.g., got description but not company info), return what we have rather than failing entirely. Use empty strings/arrays for missing fields.

**Return type `JobDetail`:**

```typescript
interface JobDetail {
  description: string;
  companyInfo: string;
  contactPeople: Array<{ name: string; title: string; profileUrl: string }>;
  postedBy: string;
  postedByTitle: string;
  postedByProfile: string;
  applicantCount: string;
  seniorityLevel: string;
  employmentType: string;
  jobFunction: string;
}
```

---

### Step 4: Enrichment AI Prompt and Analyzer

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/prompts.ts`**

Add a new prompt builder function `buildEnrichmentAnalysisPrompt`. This is the core AI interaction that takes the full job detail + user context and returns priority, analysis, and action items.

**What the prompt receives:**

From the user profile (loaded via a new `getProfileForEnrichmentAI()` function, see Step 5):
- `profileSummaryCache` -- the AI-generated resume summary
- `jobSearchDescription` -- what kind of roles they want
- `missionStatement` -- why they're looking, what excites them (NEW)
- `urgencySignals` -- what should trigger "urgent" (NEW)
- `keyInterests` -- topics/domains that excite them (JSON array, rendered as comma-separated)
- `dealbreakers` -- hard no's (JSON array, rendered as comma-separated)
- `preferredTechStack` -- their tech stack (JSON array, rendered as comma-separated)
- `targetSeniority` -- target levels (JSON array, rendered as comma-separated)
- Work experience -- condensed to "Title at Company (duration)" lines, max 5 most recent
- Skills -- just names, comma-separated

From the scraped job detail:
- Title, company, location (from existing Job record)
- Full description text
- About the company text
- People to reach out to (names, titles)
- Poster info (name, title)
- Applicant count text
- Seniority/employment type/function metadata

**Prompt structure:**

```
You are an intelligent job analyst. Analyze this job posting against the candidate's profile and priorities, then assign a priority level and provide actionable insights.

CANDIDATE PROFILE:
{profileSummaryCache}

WHAT THE CANDIDATE IS LOOKING FOR:
{jobSearchDescription}

THE CANDIDATE'S MISSION (what excites and motivates them):
{missionStatement}

KEY INTERESTS: {keyInterests}
DEALBREAKERS: {dealbreakers}
PREFERRED TECH STACK: {preferredTechStack}
TARGET SENIORITY: {targetSeniority}

RECENT EXPERIENCE:
{condensed work experience}

SKILLS: {skills list}

URGENCY TRIGGERS (if ANY of these are present, strongly consider "urgent" priority):
{urgencySignals}

---

JOB POSTING:
Title: {title}
Company: {company}
Location: {location}
Seniority: {seniorityLevel}
Type: {employmentType}
Function: {jobFunction}
Applicants: {applicantCount}

Description:
{description}

About the Company:
{companyInfo}

Posted by: {postedBy} ({postedByTitle})
People to Reach Out To:
{contactPeople formatted as "- Name, Title (LinkedIn URL)"}

---

ANALYSIS INSTRUCTIONS:
1. Assign a PRIORITY based on these definitions:
   - "urgent": This job has time-sensitive advantages. One or more urgency triggers match, OR there is a unique opportunity to make direct contact, OR this is an exceptionally strong match for the candidate's stated mission. The candidate should act on this TODAY.
   - "high": Strong overall match. The role aligns well with the candidate's skills, interests, and career goals. Worth applying soon.
   - "normal": Decent match. The candidate could apply, but there's nothing that sets this apart.
   - "low": Borderline match. Saved by the title filter but the full description reveals it's not a great fit (wrong focus area, too senior/junior, unexciting domain, etc.).

2. If ANY dealbreakers are found in the description, the priority should be "low" regardless of other factors.

3. Pay special attention to:
   - Direct contact opportunities (poster name, social media handles, "DM me", email addresses in description)
   - Startup/small team signals ("founding", "first engineer", team size mentions)
   - Alignment with key interests (especially if the company is building products in those areas)
   - Red flags (years of experience mismatch, required skills the candidate lacks, on-site only when remote preferred)

4. Generate 1-3 specific ACTION ITEMS when applicable. These should be concrete next steps:
   - "DM [name] on [platform] -- they invited direct messages"
   - "Mention your experience with [specific tech] -- it's their primary stack"
   - "Apply through their company website at [URL] for faster response"
   - "Check if [name] ([LinkedIn URL]) is a mutual connection"
   Do NOT generate generic action items like "apply to this job" or "update your resume". Only include actions that are specific to THIS posting.

5. Note any RED FLAGS -- things that might make this job worse than it appears:
   - Required experience significantly above candidate's level
   - Skills requirements that don't match
   - High applicant count (200+) reducing chances
   - Signs of a re-post or long-unfilled position

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "priority": "urgent" | "high" | "normal" | "low",
  "priorityReason": "<1-2 sentence explanation of why this priority was assigned>",
  "matchScore": <number 0-100>,
  "matchReason": "<2-3 sentence analysis of how well this job fits the candidate>",
  "keyMatches": ["specific match 1", "specific match 2", ...],
  "actionItems": ["concrete action 1", "concrete action 2", ...],
  "redFlags": ["red flag 1", ...]
}
```

**Key design decisions in this prompt:**

- The `urgencySignals` field is placed prominently with explicit instructions to "strongly consider urgent" when they match. This makes urgency user-controllable.
- The `missionStatement` is separate from `jobSearchDescription` so the AI understands the emotional/motivational dimension, not just the functional one.
- Action items are constrained to be job-specific. Generic advice wastes dashboard space.
- Red flags are separate from priority -- a job can be "high" priority but still have a red flag worth noting.
- The prompt explicitly tells the AI to deprioritize when dealbreakers are found, even if other signals are positive.

**What is NOT passed to the AI (and why):**

| Field | Reason for Exclusion |
|-------|---------------------|
| `firstName`, `lastName`, `email`, `phone` | PII. The AI is analyzing the job, not addressing the candidate. Including identity information adds prompt noise and sends personal data to an external API unnecessarily. |
| `linkedinUrl`, `website` | Personal URLs irrelevant to job analysis. |
| `city`, `state`, `country`, `zipCode` | Location matching is a deterministic check, not an AI judgment call. The scraper already filters by geoId. Including it would make the AI try to be a location filter, which it's bad at (it doesn't know commute distances or remote policies reliably). Could be added as a future hard filter if needed. |
| `dateOfBirth`, `pronouns`, `preferredName` | Application form data. Zero relevance to analyzing whether a job is a good match. |
| `desiredSalary`, `minSalary` | Salary is rarely in LinkedIn descriptions (only ~15% of postings include it). When it is present, a future deterministic filter would be more reliable than asking the AI to parse salary ranges. Not worth the prompt space in v1. |
| `availableStartDate` | Descriptions almost never specify exact start dates. No value in the AI trying to match this. |
| `coverLetterNotes` | For generating cover letters (a different feature), not for analyzing job fit. Including it would confuse the AI about its task. |
| `remoteOnly`, `willingToRelocate`, `openToContract`, `visaSponsorshipNeeded` | These are binary filters that should be deterministic checks, not AI judgment. The AI might say "this seems remote-friendly" when it's not, or miss an "on-site required" buried in the description. Better to add these as post-enrichment hard filters in a future iteration. |
| `preferredCompanySize`, `avoidIndustries` | Could be useful since we're scraping "About the company", but excluded from v1 to keep the prompt focused. The AI is already doing a lot (priority + score + matches + actions + flags). These can be added in v2 if priority assignments aren't granular enough. |
| `DemographicAnswer` records | EEO compliance answers (gender, ethnicity, veteran status). No relevance to job matching. Stored locally for form-filling only. |
| `Document`, `Reference` records | File metadata and reference contact info. Not useful for job analysis. |
| `education` | The `profileSummaryCache` already includes education from the resume. Sending it again is redundant and adds prompt tokens. If a job requires a PhD, the AI can identify the mismatch from the profile summary alone. |

---

### Step 5: Profile Query for Enrichment AI

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/database/profile-queries.ts`**

Add a new function `getProfileForEnrichmentAI()` that returns exactly the data the enrichment prompt needs. This is similar to the existing `getProfileForAI()` (line 83) but includes the new fields and condensed work experience/skills.

```typescript
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
    workExperience: profile.workExperience.slice(0, 5).map(exp => ({
      title: exp.title,
      employer: exp.employer,
      startDate: exp.startDate,
      endDate: exp.endDate,
      isCurrent: exp.isCurrent,
    })),
    skills: profile.skills.map(s => s.name),
  };
}
```

Also add `missionStatement` and `urgencySignals` to the `cacheInvalidatingFields` array in the existing `updateProfile()` function (line 55) so that changing these fields invalidates the profile summary cache.

---

### Step 6: Enrichment AI Caller

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-enricher.ts`**

This module calls the AI with the enrichment prompt and parses the response. It's analogous to the `matchJob()` function in `/Users/martinbabak/Desktop/projects/job-tracker/src/ai/job-matcher.ts`.

**Function: `analyzeEnrichedJob(profileContext, jobData) -> EnrichmentAnalysis`**

- Creates an OpenAI client using the same NVIDIA config (same `createClient()` pattern)
- Builds the prompt using `buildEnrichmentAnalysisPrompt()`
- Calls the model with the same parameters (model, maxTokens, temperature)
- Parses the JSON response
- Validates the response structure (priority must be one of the four values, matchScore must be 0-100, arrays must be arrays)
- Returns the parsed `EnrichmentAnalysis` object
- On AI error: log the error and return a default result with `priority: "normal"`, empty arrays, and a matchReason indicating the AI call failed. This is fail-safe -- the job still gets enriched with the scraped data, it just doesn't get an AI analysis. Set a flag so the enricher can mark this appropriately.

**Important**: Use a longer timeout than the filter call (90 seconds vs 60) because this prompt is larger and the response is more complex.

**`EnrichmentAnalysis` interface:**

```typescript
interface EnrichmentAnalysis {
  priority: 'urgent' | 'high' | 'normal' | 'low';
  priorityReason: string;
  matchScore: number;
  matchReason: string;
  keyMatches: string[];
  actionItems: string[];
  redFlags: string[];
}
```

---

### Step 7: Enrichment Agent Process

**File to create: `/Users/martinbabak/Desktop/projects/job-tracker/src/enricher-agent.ts`**

This is the entry point for the enricher process, analogous to `/Users/martinbabak/Desktop/projects/job-tracker/src/scraper-agent.ts`.

**Startup sequence:**
1. Initialize config from DB (`initConfig()`)
2. Validate config (API key required)
3. Check for existing enricher process (probe PID, same logic as scraper-agent.ts lines 26-40)
4. Reset any stuck state (`resetEnricherStateOnStartup()`)
5. Write own PID to `EnricherState`
6. Start the enrichment loop

**Enrichment loop (not interval-based -- queue-based):**

```
while (!shutdownRequested) {
  1. Reload config from DB
  2. Check error pause (same 5-error / 30-min pause logic as scraper)
  3. Query for next job to enrich (getNextJobToEnrich())
  4. If no job found:
     - If browser is open, close it (save resources during idle)
     - Sleep 30 seconds
     - Continue loop
  5. If browser not open, launch it (DetailScraper.launch())
     - If launch fails (session expired), log error, increment error count, sleep 60s, continue
  6. Mark enricher as processing
  7. Scrape the job detail page (DetailScraper.scrapeJobDetail())
     - On SessionExpiredError: close browser, log error, mark error, continue
     - On other scrape error: mark job as failed, mark enricher error, continue to next job
  8. Load profile context (getProfileForEnrichmentAI())
  9. Call AI analysis (analyzeEnrichedJob())
  10. Update job with all enrichment data (updateJobEnrichment())
  11. Mark enricher success
  12. Anti-detection delay: random 3-8 seconds between jobs
      (Longer than scraper's click delay because we're visiting detail pages sequentially,
       which is a more suspicious access pattern than scrolling search results)
}
```

**Graceful shutdown:**
- Listen for SIGINT and SIGTERM (same pattern as scraper-agent.ts lines 59-85)
- Set shutdownRequested flag
- Wait for current job processing to finish (up to 2 minutes)
- Close browser if open
- Clear PID from EnricherState
- Disconnect database
- Exit

**Logging:**
- Use the existing Winston logger
- Log to `logs/enricher.log` (separate from `logs/agent.log` so the two agents' logs don't interleave)

**Add npm script to `package.json`:**
```json
"enricher": "tsx src/enricher-agent.ts"
```

---

### Step 8: Enricher Agent Manager

**File to create: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/enricher-manager.ts`**

This mirrors `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/agent-manager.ts` exactly, but for the enricher process. Following the earlier design decision to keep agent managers deliberately duplicated (not generalized) since there are only 2 agents with different semantics.

**Functions:**
- `getEnricherStatus()` -- returns `EnricherAgentStatus` (running, pid, lastRunAt, lastSuccessAt, errorCount, isProcessing, totalEnriched, totalFailed). Same PID liveness check pattern as `getAgentStatus()`.
- `startEnricher()` -- validates config, spawns `npx tsx src/enricher-agent.ts` as detached process, logs to `logs/enricher.log`. Same spawn pattern as `startAgent()` in agent-manager.ts lines 64-113.
- `stopEnricher()` -- sends SIGTERM, waits up to 15s, falls back to SIGKILL. Same pattern as `stopAgent()` in agent-manager.ts lines 119-172.

---

### Step 9: UI Routes for Enricher Control

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/routes.ts`**

Add enricher agent control routes, mirroring the existing scraper agent routes (lines 170-246):

- `POST /enricher/start` -- calls `startEnricher()`, redirects to `/`
- `POST /enricher/stop` -- calls `stopEnricher()`, redirects to `/`
- `GET /enricher/status` -- returns JSON status (for auto-refresh polling)
- `GET /enricher/logs` -- returns last N lines of `logs/enricher.log` (same tail-read logic as `/agent/logs`, lines 216-246)

Also update the `GET /` route (lines 25-65):

- Add `getEnricherStatus()` and `getEnrichmentQueueSize()` to the `Promise.all()` on line 30
- Pass `enricherStatus` and `enrichmentQueueSize` to the template
- Change the `getJobs()` call to sort by priority order (urgent > high > normal > low) as the primary sort, then by `createdAt DESC` within each priority. This requires updating `getJobs()` in queries.ts (see Step 10).

---

### Step 10: Update Job Queries for Priority Sorting

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/database/queries.ts`**

Update the `getJobs()` function (line 180) to sort by priority as the primary ordering:

Since Prisma doesn't support custom sort orders natively for string enums, use a raw query or a `orderBy` with a computed field. The cleanest approach in Prisma is to use `$queryRaw`:

```typescript
export async function getJobs(status?: JobStatus) {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 WHEN 'low' THEN 4 ELSE 3 END";

  const where = status ? Prisma.sql`WHERE status = ${status}` : Prisma.empty;

  return prisma.$queryRaw<Job[]>`
    SELECT * FROM Job ${where}
    ORDER BY ${Prisma.raw(priorityOrder)} ASC, createdAt DESC
  `;
}
```

Alternatively, keep the Prisma query and sort in JS after fetching -- simpler and the dataset is small enough (hundreds, not millions):

```typescript
export async function getJobs(status?: JobStatus) {
  const jobs = await prisma.job.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  });

  const priorityRank: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
  return jobs.sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3));
}
```

The JS sort approach is recommended -- it's simpler, type-safe, and the job list is never large enough for performance to matter. It also preserves `createdAt DESC` within each priority tier since the initial query orders by createdAt and JS sort is stable.

Also update `getStats()` to include enrichment stats:
- Count of jobs by priority (urgent/high/normal/low)
- Count of pending enrichments (enrichmentStatus = 'pending')

---

### Step 11: Dashboard UI Updates

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/views/jobs.ejs`**

**11a. Add enricher agent panel below the scraper panel (after line 116):**

Add a second panel with the same structure as the scraper panel (lines 39-116), but for the enricher:
- Status dot (green when running, gray when stopped)
- "Enricher Running" / "Enricher Stopped" text
- Start/Stop button
- Stats: Last Run, Last Success, Errors, Queue Size, Total Enriched, Total Failed, PID
- Log viewer section (same collapsible pattern, fetching from `/enricher/logs`)
- Auto-refresh via polling `/enricher/status` every 5 seconds (add to the existing `refreshStatus()` function or create a parallel one)

**11b. Add priority badge to job table rows:**

In the job table body (line 176), add a priority column before the Score column, or add a badge next to the job title. Recommended: add a badge next to the title since adding a column takes horizontal space.

In the `job-title-cell` (line 183), prepend a priority badge:

```html
<td class="job-title-cell">
  <% if (job.priority === 'urgent') { %>
    <span class="priority-badge priority-urgent">URGENT</span>
  <% } else if (job.priority === 'high') { %>
    <span class="priority-badge priority-high">HIGH</span>
  <% } %>
  <a href="<%= job.link %>" target="_blank" rel="noopener noreferrer"><%= job.title %></a>
</td>
```

Don't show badges for "normal" and "low" -- they're the baseline and showing them on every row would be noisy. Only "urgent" and "high" deserve visual callouts.

**11c. Update the expanded detail panel (lines 196-234):**

After enrichment, the detail panel should show much richer information. Restructure it:

- **Priority & Action Items** section (only if enriched):
  - Priority badge with reason text
  - Action items as a bulleted list (these are the most actionable piece of info)
  - Red flags as a warning-styled bulleted list

- **People to Reach Out To** section (only if contactPeople is non-empty):
  - Each person as: "Name -- Title" with a link to their LinkedIn profile
  - The poster info (postedBy) shown here too if available

- **AI Match Analysis** section:
  - Match score, match reason, key matches (same as current but now populated)

- **About the Company** section (only if companyInfo is non-empty)

- **Job Details** section:
  - Seniority level, employment type, job function, applicant count
  - Show as metadata chips/badges

- **Full Description** section:
  - The full job description text (scrollable, maybe collapsible if very long)
  - This replaces the current truncated `job.description.substring(0, 500)` on line 213

- **Status actions and notes** (keep existing, lines 215-233)

**11d. Add enrichment status indicator:**

On each job row, add a subtle indicator showing enrichment status. Options:
- A small icon after the title: a checkmark for enriched, a clock for pending, an X for failed
- Or just let the priority badge serve this purpose (if there's no badge and no enrichment data in the detail panel, it's clearly not enriched yet)

Recommended: keep it simple. The priority badge is the indicator. If a job has `enrichmentStatus = 'pending'`, show a small "Analyzing..." text in gray where the priority badge would be. If `enrichmentStatus = 'failed'`, show nothing (the job still works, it just doesn't have AI analysis).

**11e. Update stats bar:**

Add enrichment-related stats to the stats bar (lines 119-144). Add after the existing stats:
- "Urgent" count (with red color)
- "Queue" count (number of jobs pending enrichment)

---

### Step 12: Dashboard CSS Updates

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/views/styles.css`**

Add styles for:

- `.priority-badge` -- small pill badge, uppercase, bold, font-size 10px
- `.priority-urgent` -- red/coral background (#dc3545 or similar), white text
- `.priority-high` -- orange background (#fd7e14), dark text
- `.enricher-panel` -- reuse the existing `.scraper-panel` styles (maybe rename to `.agent-panel` and apply to both, or just duplicate the class names)
- `.action-items-list` -- styled list for action items in the detail panel, with a subtle left border accent
- `.red-flags-list` -- warning-styled list, possibly with a yellow/amber left border
- `.contact-person` -- style for each person in the "People to Reach Out To" section
- `.enrichment-pending` -- gray italic text for "Analyzing..." indicator

---

### Step 13: Profile Page Updates for New Fields

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/views/profile.ejs`**

Add the two new text fields to the Preferences section (after `jobSearchDescription`, around line 174):

**Mission Statement field:**
```html
<div class="form-group">
  <label for="missionStatement">Your Mission / What Excites You</label>
  <textarea id="missionStatement" name="missionStatement" rows="4"
    placeholder="Example: I'm passionate about startups building AI agents and AI products. I want to be on a small team where I'm building the product hands-on. I love direct access to founders and hiring managers, and I thrive in environments where I can see my work make an immediate impact."><%= profile.missionStatement %></textarea>
  <span class="hint">What motivates you beyond job type. The AI uses this to identify jobs that align with your personal goals and passions, not just your skills.</span>
</div>
```

**Urgency Signals field:**
```html
<div class="form-group">
  <label for="urgencySignals">Urgency Signals</label>
  <textarea id="urgencySignals" name="urgencySignals" rows="4"
    placeholder="Example: Direct contact info in the posting (social media, email, 'DM me'). Founding engineer or first-hire roles. Startup building AI/ML products. The poster is the hiring manager, not a recruiter. Small team where I'd have outsized impact."><%= profile.urgencySignals %></textarea>
  <span class="hint">What should make the AI flag a job as "urgent" -- situations where you should act immediately. Be specific about what matters to you.</span>
</div>
```

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/profile-routes.ts`**

Update the preferences POST handler to accept and save the two new fields (`missionStatement`, `urgencySignals`). These are plain text fields (not JSON arrays), so they should be saved directly as strings, same as `jobSearchDescription` is handled.

---

### Step 14: Register Enricher Routes and Wire Up Server

**File: `/Users/martinbabak/Desktop/projects/job-tracker/src/ui/server.ts`**

Import and register the enricher routes. If the enricher routes are added to the existing `routes.ts` (recommended, since there are only 4 new endpoints), no new router registration is needed -- just the imports of `startEnricher`, `stopEnricher`, `getEnricherStatus` from the new `enricher-manager.ts`.

Also update the server startup to call `resetEnricherStateOnStartup()` so stale PIDs from a previous crashed enricher are cleaned up when the UI starts, just like `resetScraperStateOnStartup()` is called.

---

### Step 15: Update CLAUDE.md

**File: `/Users/martinbabak/Desktop/projects/job-tracker/CLAUDE.md`**

Update to reflect the new three-process architecture:

- Add **Enricher Agent Process** section under Process Architecture, describing the queue-based cycle, PID management, and detail page scraping
- Add `npm run enricher` to Development Commands
- Add enrichment fields to Database Schema section
- Update the Scraper Pipeline section to mention that enrichment happens in a separate process
- Add a new **Enrichment Pipeline** section describing the queue processor flow and AI analysis
- Update File Locations to include `logs/enricher.log`

---

## Files Affected

### New Files
| File | Purpose |
|------|---------|
| `src/database/enrichment-queries.ts` | DB queries for enricher state and job enrichment updates |
| `src/scraper/detail-scraper.ts` | LinkedIn detail page scraper (description, company, contacts) |
| `src/ai/job-enricher.ts` | AI analysis caller for enrichment (priority, actions, flags) |
| `src/enricher-agent.ts` | Enricher agent process entry point (queue processor) |
| `src/ui/enricher-manager.ts` | Enricher process manager (start/stop/status) |
| `prisma/migrations/{timestamp}_add_enrichment_agent/` | Database migration |

### Modified Files
| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add enrichment fields to Job, add EnricherState model, add profile fields |
| `src/ai/prompts.ts` | Add `buildEnrichmentAnalysisPrompt()` function |
| `src/database/profile-queries.ts` | Add `getProfileForEnrichmentAI()`, update cache invalidation list |
| `src/database/queries.ts` | Update `getJobs()` sort order, update `getStats()` for enrichment stats |
| `src/ui/routes.ts` | Add enricher control routes, update dashboard route for enricher data |
| `src/ui/views/jobs.ejs` | Enricher panel, priority badges, enriched detail panel, stats |
| `src/ui/views/profile.ejs` | Add missionStatement and urgencySignals fields |
| `src/ui/views/styles.css` | Priority badge styles, enricher panel styles, detail panel styles |
| `src/ui/profile-routes.ts` | Handle new profile fields in preferences POST |
| `src/ui/server.ts` | Import enricher manager, reset enricher state on startup |
| `package.json` | Add `enricher` npm script |
| `CLAUDE.md` | Update architecture docs |

## Data Flow

```
Scraper Agent                     Enricher Agent                    Dashboard
    |                                  |                               |
    | saves job with                   |                               |
    | enrichmentStatus='pending'       |                               |
    | priority='normal'                |                               |
    | description=''                   |                               |
    |                                  |                               |
    +---> [SQLite DB] <---------------+                               |
                |                      |                               |
                |  getNextJobToEnrich  |                               |
                +--------------------> |                               |
                                       |                               |
                                       | 1. Visit /jobs/view/{id}/     |
                                       | 2. Extract: description,      |
                                       |    company, contacts, meta    |
                                       | 3. Call AI with full data     |
                                       |    + user profile context     |
                                       | 4. Get back: priority,       |
                                       |    score, actions, flags      |
                                       | 5. Update job record          |
                                       |    enrichmentStatus='enriched'|
                                       |    priority='urgent'          |
                                       |                               |
                                       +----> [SQLite DB] <-----------+
                                                   |                   |
                                                   | getJobs() sorted  |
                                                   | by priority       |
                                                   +-----------------> |
                                                                       |
                                                             Shows urgent jobs
                                                             at top with badges,
                                                             action items, contacts
```

## Edge Cases & Error Handling

1. **LinkedIn session expires mid-batch**: The detail scraper detects redirects to `/login` or `/authwall`. When this happens, close the browser, log a clear error message ("LinkedIn session expired -- run `npm run login` to re-authenticate"), increment error count, and stop processing. The enricher will retry after the error pause or after restart.

2. **Job page no longer exists (404/redirect)**: LinkedIn sometimes removes or redirects job postings. Detect by checking if the final URL doesn't contain the expected job ID. Mark the job as `enrichmentStatus = 'failed'` and continue to the next job.

3. **Partial scrape failure**: If we get the description but not the company info or contacts, save what we have. Don't fail the entire enrichment because one optional section wasn't found. Set `enrichmentStatus = 'enriched'` -- partial data is still useful.

4. **AI call fails**: Save the scraped data (description, contacts, etc.) to the job record even if the AI call fails. Set a default priority of `'normal'` and put the AI error in the log. Set `enrichmentStatus = 'enriched'` (the scraping succeeded) but leave `matchScore = 0` and `priorityReason = ''` so it's clear the AI analysis is missing.

5. **User rejects a job before enrichment**: The `getNextJobToEnrich()` query filters for `status = 'new'` only. If the user changed the status to 'rejected', the enricher skips it. But the job still has `enrichmentStatus = 'pending'` in the database. This is fine -- it won't be picked up because of the status filter. If the user later changes the status back to 'new', it would be picked up. This is acceptable behavior.

6. **Enricher and scraper running simultaneously**: Both processes access SQLite. SQLite handles concurrent reads well but has a single-writer lock. Since the enricher processes one job at a time with delays between, and the scraper does batch inserts in short bursts, write contention should be minimal. Prisma's connection pooling handles retry-on-lock automatically. No special coordination needed.

7. **Backfill of existing jobs**: When the migration runs, all existing jobs get `enrichmentStatus = 'pending'`. When the enricher starts, it will process the entire backlog newest-first. If there are hundreds of existing jobs, this could take a while (each job needs a page visit + AI call, roughly 15-20 seconds per job including delays). This is expected and fine -- the enricher will work through the backlog and then idle.

8. **Rate limiting / anti-detection**: The enricher visits detail pages sequentially with 3-8 second random delays between them. This is slower than a human browsing but LinkedIn may still detect automated access if the enricher runs for hours processing a large backlog. Consider adding a longer pause every 20-30 jobs (e.g., 2-5 minutes). This can be tuned after observing behavior.

9. **Browser memory**: Playwright browser processes can leak memory over long sessions. The enricher closes the browser when the queue empties and reopens when new jobs appear. For long batches, consider adding a counter and restarting the browser every 50 jobs.

## Testing Considerations

1. **Detail scraper selectors**: LinkedIn's DOM structure changes without notice. The detail scraper should be tested manually by running it against a few known job URLs and verifying each field extracts correctly. Create a manual test script (`npm run test:detail-scrape`) that takes a LinkedIn job URL as argument, runs the scraper, and prints the extracted fields.

2. **AI prompt testing**: Test the enrichment prompt with a few real job descriptions to verify:
   - A job with an Instagram DM invitation gets "urgent"
   - A standard good-match job gets "high"
   - A borderline job gets "normal" or "low"
   - A job with dealbreakers gets "low" regardless of other signals
   - Action items are specific and actionable, not generic

3. **Queue processing**: Verify that:
   - Only jobs with `status = 'new'` AND `enrichmentStatus = 'pending'` are picked up
   - Failed jobs are marked and not retried infinitely
   - The enricher idles correctly when the queue is empty
   - New jobs arriving while the enricher is idle are picked up within 30 seconds

4. **Dashboard integration**: Verify:
   - Jobs sort correctly by priority (urgent at top)
   - Priority badges appear for urgent and high jobs
   - The expanded detail panel shows all enrichment data
   - The enricher panel shows correct status, queue size, and controls

5. **Concurrent access**: Start both the scraper and enricher, verify they don't interfere with each other or cause SQLite lock errors.

## Migration / Breaking Changes

- **Database migration**: The new fields on Job all have defaults, so existing rows are unaffected. The new EnricherState model is additive. The new UserProfile fields have empty string defaults. No data loss.
- **No breaking API changes**: All existing routes continue to work. New routes are additive.
- **Sort order change**: The dashboard will now sort by priority instead of matchScore. Since existing jobs all have `priority = 'normal'`, they'll sort by createdAt within that tier, which is a reasonable default until they're enriched.
- **Existing `matchScore` and `matchReason`**: These fields exist but are currently always 0 and empty. The enrichment agent will populate them. No conflict with existing data.

## Open Questions

1. **LinkedIn selector stability**: The detail page selectors will need to be discovered and tested against the live site. The implementing agent should run the scraper in non-headless mode (`headless: false`) during development to visually inspect the page structure and identify reliable selectors. Expect to iterate on selectors.

2. **NVIDIA API token budget**: Each enrichment call sends a larger prompt than the title-only filter call (full description + user context). Monitor token usage if the API has rate limits or costs. The temperature and maxTokens settings may need tuning for this longer prompt.

3. **Enricher-specific settings**: Should there be enricher-specific settings in AppSettings (e.g., enricher delay between jobs, batch size before pause, idle poll interval)? For v1, hardcode sensible defaults in the enricher code. If users want to tune these, add them to AppSettings and the settings UI in a follow-up.

4. **Notification for urgent jobs**: When the enricher discovers an "urgent" job, should it notify the user somehow (desktop notification, sound, email)? This is out of scope for v1 but worth considering as a fast follow-up. The dashboard already auto-refreshes status every 5 seconds, so urgent jobs will appear at the top within seconds of being enriched.
