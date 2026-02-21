# Implementation Plan: Auto-Apply Agent

## Summary

Add a second agent process that automatically applies to jobs found by the scraper. The auto-apply agent picks up jobs with `status: 'new'` from the database, navigates to each job's application link, determines if it is a simple single-page form, and if so, uses AI to fill the form fields and submit the application. Multi-step applications, CAPTCHAs, and account-required sites are skipped. The agent follows the same process management pattern as the existing scraper agent (detached child process, PID tracking, UI start/stop controls).

## Context & Problem

The scraper agent finds and saves relevant job postings, but the user must manually visit each link and fill out application forms. This creates a bottleneck: the app's value proposition is speed (being first to apply), but manual form-filling negates that advantage. Many jobs have simple single-page application forms that can be filled programmatically with data the user has already provided in their profile.

This plan assumes Plan 1 (Profile & Data Foundation) is complete: `UserProfile` has all necessary fields, `DemographicAnswer` categories are populated, `ApplierState` and `ApplicationLog` tables exist, and auto-apply settings are configurable from the UI.

## Chosen Approach

**Mirror the scraper agent pattern with a queue-based (not interval-based) cycle.**

The auto-apply agent runs as a separate detached process, managed identically to the scraper agent. However, instead of running on a fixed timer, it processes a queue: pick up N jobs from the DB, apply to each, then poll for more. When the queue is empty, it waits before polling again. This is more efficient than a fixed interval because it processes jobs as fast as they appear without wasting cycles.

The form-filling strategy uses a layered detection approach: URL pre-screening, DOM structural analysis, then AI classification only when ambiguous. Form fields are filled using a three-tier data source: direct profile data mapping (Tier 1), AI-generated content (Tier 2), and pre-configured demographic answers (Tier 3).

A **dry-run mode** (enabled by default) fills forms but does not submit, taking screenshots for user review. This allows the user to validate the agent's behavior before enabling live submission.

## Detailed Implementation Steps

### Step 1: Create the applier state management in the database

**File: `src/database/queries.ts`**

Add functions mirroring the scraper state management, targeting the `ApplierState` model (created in Plan 1's migration):

Functions to add:
- `getApplierState()` -- Returns the singleton, creates with defaults if missing.
- `markApplierRunning()` -- Sets `isRunning: true`, updates `lastRunAt`.
- `markApplierSuccess()` -- Sets `isRunning: false`, updates `lastSuccessAt`, resets `errorCount`.
- `markApplierError()` -- Sets `isRunning: false`, increments `errorCount`.
- `setApplierPid(pid: number)` -- Writes the agent's PID.
- `clearApplierPid()` -- Clears PID and resets `isRunning`.
- `resetApplierStateOnStartup()` -- Clears stuck `isRunning` and stale PIDs.
- `incrementApplierStats(applied: number, skipped: number, failed: number)` -- Atomically increments the aggregate counters.

These are structurally identical to the existing `ScraperState` functions but operate on the `ApplierState` table.

Also add a function to get jobs ready for auto-apply:

```typescript
/**
 * Returns jobs with status 'new' ordered by creation date (oldest first).
 * Limit controls batch size. Only returns jobs that have an applyLink.
 */
export async function getJobsForAutoApply(limit: number) {
  return prisma.job.findMany({
    where: {
      status: 'new',
      applyLink: { not: '' },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

/**
 * Atomically claims a job for auto-apply by setting status to 'applying'.
 * Returns null if the job was already claimed (optimistic concurrency).
 */
export async function claimJobForApply(jobId: string) {
  try {
    return await prisma.job.update({
      where: { id: jobId, status: 'new' },
      data: { status: 'applying' },
    });
  } catch {
    // Job was already claimed or does not exist
    return null;
  }
}

/**
 * Resets any jobs stuck in 'applying' status back to 'new'.
 * Called on agent startup to recover from crashes.
 */
export async function resetStuckApplyingJobs() {
  const result = await prisma.job.updateMany({
    where: { status: 'applying' },
    data: { status: 'new' },
  });
  if (result.count > 0) {
    logger.warn(`Reset ${result.count} jobs stuck in 'applying' status`);
  }
  return result.count;
}
```

### Step 2: Create the URL pre-screening module

**New file: `src/applier/url-screener.ts`**

This module performs zero-cost classification of application URLs based on domain patterns. It determines whether to attempt, skip, or flag a URL before launching a browser.

```typescript
export type ScreenResult = 'attempt' | 'skip' | 'flag';

export interface ScreenVerdict {
  result: ScreenResult;
  reason: string;
}
```

Implementation details:

**Always skip (known multi-step / account-required):**
- `*.myworkdayjobs.com/*` -- Workday is always multi-step
- `workday.com/*` -- Same
- `*.icims.com/*` -- iCIMS ATS, always multi-step
- `*.taleo.net/*` -- Taleo/Oracle ATS, always multi-step
- `*.brassring.com/*` -- IBM Kenexa, always multi-step
- `linkedin.com/jobs/view/*` -- Easy Apply requires LinkedIn auth (different flow)
- `*.successfactors.com/*` -- SAP SuccessFactors, always multi-step

**Always attempt (known single-page friendly):**
- `*.lever.co/*` -- Lever forms are typically single-page
- `jobs.ashbyhq.com/*` -- Ashby forms are typically single-page
- `boards.greenhouse.io/*/jobs/*` -- Greenhouse application forms

**Default behavior:** URLs not matching any pattern get `'attempt'` result -- proceed to page load and DOM analysis.

The skip/attempt lists should be configurable. Read `autoApplySkipDomains` from `AppSettings` and merge with the hardcoded denylist. This lets the user add domains they have discovered are problematic.

### Step 3: Create the page analyzer module

**New file: `src/applier/page-analyzer.ts`**

This module loads a page in Playwright and determines if it contains a fillable single-page application form. It returns a structured analysis result.

```typescript
export type FormType = 'single_page' | 'multi_step' | 'account_required' | 'captcha' | 'expired' | 'no_form' | 'unknown';

export interface PageAnalysis {
  formType: FormType;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  formSelector?: string;       // CSS selector for the main form element
  fieldCount?: number;          // Number of input fields detected
  hasFileUpload?: boolean;      // Whether the form has a file input
  hasSubmitButton?: boolean;    // Whether a submit button was found
}
```

The analysis runs in order from cheapest to most expensive:

**Phase 1: Page load verification**
- Navigate to URL with a 20-second timeout.
- Check HTTP status. If 404 or redirect to a generic careers page, return `{ formType: 'expired' }`.
- Check for "this job is no longer available" / "position has been filled" text patterns. Return `{ formType: 'expired' }`.

**Phase 2: Blocker detection**
- Check for CAPTCHA elements: `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `[class*="captcha" i]`, `[id*="captcha" i]`. Return `{ formType: 'captcha' }`.
- Check for login/registration walls: forms with "create account", "sign in", "register" text that are the primary content (not a sidebar/header). Return `{ formType: 'account_required' }`.
- Check for iframes that embed an external ATS portal. If the main content is in an iframe to a different domain, return `{ formType: 'multi_step', reason: 'embedded ATS iframe' }`.

**Phase 3: Form structure analysis**
- Find all `<form>` elements on the page.
- For each form, count input fields (`input`, `select`, `textarea`) excluding hidden fields.
- Look for multi-step indicators: "step N of M", progress bars (`[role="progressbar"]`), "next" / "continue" buttons without a "submit" button, tab/accordion patterns.
- If multi-step indicators found, return `{ formType: 'multi_step' }`.
- If a single form with reasonable field count (2-30 fields) and a submit button is found, return `{ formType: 'single_page', confidence: 'high' }`.
- If no form found at all, return `{ formType: 'no_form' }`.

**Phase 4: AI tiebreaker (only if Phase 3 returns confidence: 'low')**
- Take a screenshot of the visible page.
- Send the screenshot to the AI with the prompt: "You are analyzing a job application web page. Is this a single-page application form that can be filled out and submitted in one step, without creating an account? Answer with JSON: { formType: 'single_page' | 'multi_step' | 'account_required' | 'no_form', reason: '...' }"
- Use the AI's classification to resolve the ambiguity.

Note on AI screenshot analysis: Kimi K2.5 via the NVIDIA API may or may not support vision/image inputs. If it does not, fall back to extracting the page's visible text content (`page.innerText('body')`) and sending that as text context instead. The text-based approach is less accurate but functional.

### Step 4: Create the form extractor module

**New file: `src/applier/form-extractor.ts`**

Once a page is confirmed as a single-page form, this module extracts all fillable fields into a structured representation.

```typescript
export interface FormField {
  selector: string;        // CSS selector to target this field
  type: string;            // 'text', 'email', 'tel', 'select', 'textarea', 'radio', 'checkbox', 'file'
  name: string;            // HTML name attribute
  id: string;              // HTML id attribute
  label: string;           // Extracted label text (from <label>, aria-label, placeholder, or nearby text)
  required: boolean;       // HTML required attribute or aria-required
  options?: string[];      // For select/radio: available options
  currentValue?: string;   // Pre-filled value, if any
  placeholder?: string;    // Placeholder text
}

export interface ExtractedForm {
  action: string;           // Form action URL
  method: string;           // GET or POST
  fields: FormField[];
  submitButtonSelector: string;
}
```

Implementation:
1. Locate the primary form element (using the selector from PageAnalysis).
2. For each input/select/textarea inside the form:
   - Extract the type, name, id, required status.
   - Find the associated label. Priority: explicit `<label for="...">`, `aria-label` attribute, `aria-labelledby` reference, `placeholder` attribute, nearest preceding text node.
   - For `<select>` elements, extract all `<option>` values and text.
   - For radio button groups, collect all options in the group.
   - Skip hidden inputs (`type="hidden"`) -- the form will submit them with their existing values.
3. Find the submit button. Look for: `button[type="submit"]`, `input[type="submit"]`, or a `<button>` inside the form whose text contains "submit", "apply", "send".
4. Return the structured `ExtractedForm`.

### Step 5: Create the form filler module

**New file: `src/applier/form-filler.ts`**

This module takes an `ExtractedForm` and the user's profile data, then determines what value to put in each field.

```typescript
export interface FilledField {
  selector: string;
  value: string;
  action: 'type' | 'select' | 'check' | 'upload' | 'skip';
  source: 'profile' | 'ai_generated' | 'demographic' | 'skipped';
  confidence: 'high' | 'medium' | 'low';
}

export interface FillPlan {
  fields: FilledField[];
  requiresAI: boolean;         // Whether any fields need AI generation
  aiPrompt?: string;           // The prompt to send to AI for Tier 2 fields
  skippedFields: FormField[];  // Fields that could not be filled
  canSubmit: boolean;          // Whether all required fields have values
}
```

**The filling process has two phases:**

**Phase A: Rule-based mapping (no AI call)**

For each form field, attempt to match its label/name/type to a known profile field. Use a mapping table:

```
Field patterns -> Profile data:
  "first name", "fname"                 -> profile.firstName
  "last name", "lname", "surname"       -> profile.lastName
  "email", "e-mail"                     -> profile.email
  "phone", "telephone", "mobile"        -> profile.phone
  "linkedin"                            -> profile.linkedinUrl
  "website", "portfolio", "url"         -> profile.website
  "city"                                -> profile.city
  "state", "province"                   -> profile.state
  "zip", "postal"                       -> profile.zipCode
  "country"                             -> profile.country
  "salary", "compensation", "pay"       -> profile.desiredSalary
  "start date", "availability"          -> profile.availableStartDate
  "years of experience"                 -> profile.yearsOfExperience (as string)
  "resume", "cv" (file type)            -> profile.resumePath (file upload)
```

The matching uses case-insensitive substring matching on the label, name, id, and placeholder text of each field. Multiple patterns map to the same profile field.

For demographic/legal questions, the field label is checked against the `DEMOGRAPHIC_CATEGORIES` definitions. If a match is found, the answer is looked up from `profile.demographicAnswers[category]`. If the field is a `<select>` or radio group, the agent finds the option that best matches the stored answer text (fuzzy matching, since the exact wording may differ between forms).

**Phase B: AI-assisted filling (one API call for remaining fields)**

After Phase A, any fields that were not matched rule-based are collected. If there are AI-eligible fields (cover letter, "why this company", freeform questions), they are sent to the AI in a single batch call:

Prompt structure:
```
You are filling out a job application form. Here is the applicant's profile:
[structured profile data]

Here is the job they are applying to:
[job title, company, link]

Please fill in the following form fields. For each field, provide the exact text to enter.
Return JSON: { "fields": { "<field_name>": "<value>", ... } }

Fields to fill:
1. [label] (type: textarea, required: yes) -- [any context about what's expected]
2. [label] (type: text, required: no) -- [context]

Guidelines:
- For cover letters: Write a concise, professional cover letter (200-300 words) tailored to this specific role. [include coverLetterNotes if set]
- For "why do you want to work here" type questions: Be specific to the company and role.
- For questions you cannot answer confidently from the profile data: Return "SKIP" as the value.
- Keep answers professional, concise, and truthful to the profile data.
```

Fields where the AI returns "SKIP" are added to `skippedFields`.

The `canSubmit` flag is set to `false` if any `required` field is in `skippedFields`.

### Step 6: Create the form submitter module

**New file: `src/applier/form-submitter.ts`**

This module executes the fill plan on the actual page and handles submission.

**Filling phase:**
1. Iterate over `fillPlan.fields` in order.
2. For each field, based on `action`:
   - `type`: Clear the field, then type the value with small random delays between keystrokes (anti-detection). Use `page.fill(selector, value)` for most fields, `page.type(selector, value, { delay: randomDelay(30, 80) })` for fields where keystroke simulation matters.
   - `select`: Use `page.selectOption(selector, value)`. If the exact value is not in the options, find the closest match.
   - `check`: Use `page.check(selector)` or `page.uncheck(selector)`.
   - `upload`: Use `page.setInputFiles(selector, filePath)`.
   - `skip`: Do nothing.
3. After filling all fields, wait 1-2 seconds for any client-side validation to run.

**Pre-submission validation:**
1. Check all required fields have non-empty values by reading them back from the DOM.
2. Check for visible validation error messages on the page.
3. If validation errors are present, abort and return `{ submitted: false, reason: 'validation errors detected' }`.

**Screenshot (always, regardless of dry-run):**
Take a full-page screenshot and save to `data/screenshots/<jobId>-prefill.png`. This captures the filled form before submission for audit purposes.

**Dry-run check:**
If `autoApplyDryRun` is `true` in settings, stop here. Return `{ submitted: false, reason: 'dry run mode', screenshotPath }`. The job status is set to `skipped` with reason "dry run."

**Submission phase (live mode only):**
1. Click the submit button: `page.click(submitButtonSelector)`.
2. Wait for one of: navigation event, DOM change, or 15-second timeout.
3. Take a post-submission screenshot: `data/screenshots/<jobId>-submitted.png`.
4. Analyze the resulting page for success/failure indicators:
   - **Success indicators**: "thank you", "application received", "we will review", "successfully submitted", redirect to a confirmation page.
   - **Failure indicators**: "error", "please correct", "required field", validation messages appearing, same form redisplayed.
5. Return `{ submitted: true/false, reason, screenshotPath }`.

### Step 7: Create the apply cycle orchestrator

**New file: `src/applier/apply-cycle.ts`**

This module orchestrates a single apply cycle (processing one batch of jobs). It is the equivalent of `runScrapeCycle()` for the auto-apply agent.

```typescript
export async function runApplyCycle(): Promise<void>
```

Cycle flow:

1. **Read settings**: Load auto-apply settings from DB (`getOrCreateSettings()`). Check if `autoApplyEnabled` is `true`. If not, log and return.

2. **Load profile**: Call `getProfileForAutoApply()`. If profile is null or missing critical fields (firstName, lastName, email), log an error and return.

3. **Fetch job batch**: Call `getJobsForAutoApply(batchSize)`. If empty, log "no jobs to apply to" and return.

4. **Launch browser**: Use the shared stealth browser (`src/scraper/stealth-browser.ts`) with anti-detection settings. Keep the browser open for the entire batch.

5. **Process each job**:
   ```
   for each job in batch:
     a. Claim: claimJobForApply(job.id) -- if null, skip (already claimed)
     b. Pre-screen: urlScreener.screen(job.applyLink)
        - if 'skip': update status to 'skipped', log ApplicationLog, continue
     c. Navigate: page.goto(job.applyLink, { timeout: 20000, waitUntil: 'networkidle' })
        - on timeout/error: update status to 'failed', log, continue
     d. Analyze: pageAnalyzer.analyze(page)
        - if not 'single_page': update status to 'skipped', log, continue
     e. Extract: formExtractor.extract(page, analysis.formSelector)
     f. Fill plan: formFiller.createFillPlan(extractedForm, profileData, job)
        - if !canSubmit: update status to 'skipped', log reason, continue
     g. Execute: formSubmitter.execute(page, fillPlan, isDryRun)
     h. Record result:
        - On success: update job status to 'applied', create ApplicationLog
        - On dry-run: update job status to 'skipped' with reason 'dry run', create ApplicationLog
        - On failure: update job status to 'failed', create ApplicationLog
     i. Wait: configurable delay (autoApplyDelaySeconds) between jobs
   ```

6. **Close browser**: In a `finally` block, close the browser context and browser.

7. **Log cycle summary**: Total processed, applied, skipped, failed, elapsed time.

**Error handling per job:**
Each job in the batch is wrapped in a try-catch. A failure on one job does not abort the cycle. The error is logged, the job is marked `failed`, and the cycle continues to the next job. If the browser itself crashes (not just a page error), the cycle aborts and the error counter increments.

**Domain-aware pacing:**
Track the domain of each job processed in the current batch. If the next job in the batch has the same domain as the previous one, add extra delay (30 seconds instead of the configured delay). This avoids rapid-fire requests to the same site.

### Step 8: Create the applier agent entry point

**New file: `src/applier-agent.ts`**

This file mirrors `src/scraper-agent.ts` structurally:

1. Validate config on startup.
2. Check for existing applier agent via `getApplierState()`. If PID is alive, exit with error.
3. Call `resetApplierStateOnStartup()` to clear stuck state.
4. Call `resetStuckApplyingJobs()` to recover jobs from a previous crash.
5. Write PID to DB via `setApplierPid(process.pid)`.
6. Start the apply loop.
7. Handle SIGTERM/SIGINT gracefully.

**The apply loop** is different from the scraper's `setInterval` approach:

```typescript
async function applyLoop(): Promise<void> {
  while (!shutdownRequested) {
    const settings = await getOrCreateSettings();

    if (!settings.autoApplyEnabled) {
      logger.info('Auto-apply is disabled, waiting...');
      await sleep(settings.autoApplyPollMinutes * 60_000);
      continue;
    }

    const jobCount = await countJobsForAutoApply();

    if (jobCount > 0) {
      await markApplierRunning();
      try {
        await runApplyCycle();
        await markApplierSuccess();
      } catch (error) {
        await markApplierError();
        logger.error('Apply cycle failed', { error });
      }
      // Short pause between cycles when there are more jobs
      await sleep(5_000);
    } else {
      // No jobs available, poll less frequently
      await sleep(settings.autoApplyPollMinutes * 60_000);
    }
  }
}
```

The `sleep` function respects the `shutdownRequested` flag by checking it in a polling loop rather than using a single `setTimeout`, so shutdown is responsive even during a long wait.

**Graceful shutdown:**
On SIGTERM:
1. Set `shutdownRequested = true`.
2. If currently in an apply cycle, let it finish the current job (not the whole batch). The cycle checks `shutdownRequested` between jobs.
3. Close browser if open.
4. Clear PID from DB.
5. Exit.

### Step 9: Create the applier manager module

**New file: `src/ui/applier-manager.ts`**

This mirrors `src/ui/agent-manager.ts`:

```typescript
export interface ApplierStatus {
  running: boolean;
  pid: number | null;
  lastRunAt: Date;
  lastSuccessAt: Date | null;
  errorCount: number;
  isRunningCycle: boolean;
  totalApplied: number;
  totalSkipped: number;
  totalFailed: number;
}
```

Functions:
- `getApplierStatus()` -- Reads `ApplierState`, probes PID, cleans stale PIDs.
- `startApplier()` -- Validates config, validates profile completeness, spawns `src/applier-agent.ts` as detached child. Writes to `logs/applier.log`.
- `stopApplier()` -- Sends SIGTERM, waits up to 15s, SIGKILL fallback, clears PID.

The profile completeness check in `startApplier()` verifies that at minimum firstName, lastName, and email are populated in `UserProfile`. If not, it throws an error with a clear message ("Profile incomplete: first name, last name, and email are required for auto-apply").

### Step 10: Add applier routes to the UI

**File: `src/ui/routes.ts`**

Add routes for the auto-apply agent, following the same pattern as the scraper agent routes:

```
POST /applier/start    -- Start the auto-apply agent
POST /applier/stop     -- Stop the auto-apply agent
GET  /applier/status   -- JSON status endpoint
GET  /applier/logs     -- Agent log tail (reads logs/applier.log)
```

Import and use `applier-manager.ts` functions. The route handlers are structurally identical to the `/agent/*` routes.

### Step 11: Update the dashboard UI

**File: `src/ui/views/jobs.ejs`**

Add an auto-apply agent control panel alongside the existing scraper panel. Structure:

**Option A: Two separate panels stacked vertically.**
Each panel has its own status dot, start/stop button, cycle indicator, stats, PID, and log viewer.

**Option B: A combined "Agents" panel with two columns.**
Side-by-side status for both agents, shared log viewer with a tab to switch between scraper and applier logs.

Recommendation: **Option A** for simplicity. The panels are independent and can be understood in isolation. The scraper panel stays exactly as it is; a new applier panel is added below it.

The applier panel shows:
- Status dot (green = running, gray = stopped)
- Start/Stop button
- Cycle status (Active / Idle / --)
- Last run / Last success timestamps
- Error count
- Stats: Total Applied / Total Skipped / Total Failed
- PID (when running)
- Dry-run indicator (yellow badge "DRY RUN" when dry-run mode is enabled)
- Log viewer (same collapsible pattern, polls `/applier/logs`)

Also add auto-refresh JavaScript for the applier panel, same pattern as the existing scraper status polling (fetch `/applier/status` every 5 seconds, update DOM).

### Step 12: Update dashboard status bar and filters

**File: `src/ui/views/jobs.ejs`**

Update the stats bar to include auto-apply stats:
- Add "Applying" count (jobs currently being processed)
- Add "Skipped" count
- Add "Failed" count

The filter buttons are already updated in Plan 1 (Step 15). Verify they work with the applier.

### Step 13: Add application detail to job detail view

**File: `src/ui/views/jobs.ejs`**

In the expandable detail row for each job, add an "Application History" section that shows `ApplicationLog` entries for that job:
- Status (applied/skipped/failed)
- Reason
- Form type detected
- Fields filled count
- Duration
- Timestamp
- Link to screenshot (if available)

Fetch application logs in the `GET /` route handler by including them in the job query, or by adding a lazy-load AJAX call when the detail row is expanded.

### Step 14: Add CSS for new UI elements

**File: `src/ui/views/styles.css`**

Add styles for:
- `.applier-panel` -- Same structure as `.scraper-panel` but visually distinguishable (optional: slightly different accent color, e.g., purple `#a78bfa` instead of green for the running dot).
- `.badge-dry-run` -- Yellow badge: `background: #3a3a1a; color: #facc15;`
- `.application-log` -- Styles for the application history section in job detail.
- `.screenshot-link` -- Styled link to view screenshots.
- `.applier-dot-running` -- Running indicator animation (same as scraper but different color).
- `.applier-stats` -- Stats row specific to the applier panel.

### Step 15: Serve screenshot files

**File: `src/ui/server.ts`**

Add a static file route to serve screenshots:

```typescript
app.use('/screenshots', express.static(path.resolve('./data/screenshots')));
```

Create the directory on startup if it does not exist.

### Step 16: Create the test fixture for form detection validation

**New file: `data/test-fixtures/application-urls.json`**

JSON array of test entries:

```json
[
  {
    "url": "https://boards.greenhouse.io/example/jobs/12345",
    "expectedFormType": "single_page",
    "domain": "greenhouse.io",
    "notes": "Standard Greenhouse form with resume upload"
  },
  {
    "url": "https://example.myworkdayjobs.com/en-US/careers/job/12345",
    "expectedFormType": "multi_step",
    "domain": "workday",
    "notes": "Workday always multi-step with account creation"
  }
]
```

The user populates this file with 10-15 real URLs they have manually classified.

### Step 17: Create the detection test script

**New file: `src/applier/test-detection.ts`**

A standalone script that:
1. Reads `data/test-fixtures/application-urls.json`.
2. Launches a stealth browser.
3. For each URL:
   - Runs URL pre-screening.
   - If not pre-screened out, navigates and runs page analysis.
   - Compares result to `expectedFormType`.
   - Logs pass/fail with details.
   - Takes a screenshot and saves to `data/test-fixtures/screenshots/<domain>-<index>.png`.
4. Prints a summary: X/Y passed, with details on mismatches.

Add to `package.json`:
```json
"test:detection": "tsx src/applier/test-detection.ts"
```

This script is run manually to validate and tune the detection logic. It is NOT a unit test -- it makes real network requests. Run it sparingly.

### Step 18: Add npm scripts

**File: `package.json`**

Add:
```json
{
  "scripts": {
    "applier": "tsx src/applier-agent.ts",
    "test:detection": "tsx src/applier/test-detection.ts"
  }
}
```

### Step 19: Set up the applier log file

The applier manager spawns the agent with stdout/stderr redirected to `logs/applier.log` (same pattern as `logs/agent.log` for the scraper). Winston logging in the applier process also writes to `logs/applier.log` via a dedicated transport.

**File: `src/logger.ts`**

Either:
- Add a function to create a logger instance with a configurable file path, so the applier can use `createLogger('logs/applier.log')` instead of the shared `logger`.
- Or, add a `process` field to log entries so the shared log file distinguishes scraper vs applier entries.

Recommendation: **Separate log files** -- it is simpler and matches the UI design (separate log viewer per agent). The applier-agent entry point creates its own Winston logger configured to write to `logs/applier.log`.

### Step 20: Update the auto-apply agent AI prompts

**New file: `src/applier/prompts.ts`**

Contains prompt templates for:

1. **Field classification prompt** -- Given a form field's label and context, classify it into a tier (profile_direct, ai_generated, demographic, unknown).

2. **Form filling prompt** -- Given the profile data, job details, and a list of fields to fill, return values for each field.

3. **Cover letter generation prompt** -- Given the profile data, job title, company, and cover letter notes, generate a tailored cover letter.

4. **Sanity check prompt** (optional, for extra safety) -- Given the filled form data, verify it looks correct.

5. **AI tiebreaker prompt** (for page analysis Phase 4) -- Given page text/screenshot, classify the page type.

Prompts should be explicit about output format (JSON) and include few-shot examples where helpful. The form-filling prompt should instruct the AI to return "SKIP" for any field it cannot confidently answer.

### Step 21: Update CLAUDE.md

**File: `CLAUDE.md`**

Add documentation for:
- The auto-apply agent process and its management
- New npm scripts (`npm run applier`, `npm run test:detection`)
- The dry-run mode and how to transition to live mode
- The three-tier form filling strategy
- The `ApplicationLog` table and how to review application history
- New routes (`/applier/*`)
- Screenshot storage location

## Files Affected

### New Files
- `src/applier-agent.ts` -- Auto-apply agent entry point
- `src/ui/applier-manager.ts` -- Process management for the applier
- `src/applier/url-screener.ts` -- URL-based pre-screening
- `src/applier/page-analyzer.ts` -- DOM analysis for form detection
- `src/applier/form-extractor.ts` -- Structured form field extraction
- `src/applier/form-filler.ts` -- Field mapping and AI-assisted filling
- `src/applier/form-submitter.ts` -- Form execution and submission
- `src/applier/apply-cycle.ts` -- Cycle orchestrator
- `src/applier/prompts.ts` -- AI prompt templates
- `src/applier/test-detection.ts` -- Detection validation script
- `src/database/application-queries.ts` -- ApplicationLog query functions
- `data/test-fixtures/application-urls.json` -- Test fixture for detection validation
- `data/screenshots/.gitkeep` -- Screenshot output directory

### Modified Files
- `src/database/queries.ts` -- Add applier state functions, job queue functions, `resetStuckApplyingJobs`
- `src/ui/routes.ts` -- Add `/applier/*` routes
- `src/ui/views/jobs.ejs` -- Add applier panel, application history in job detail, updated stats
- `src/ui/views/styles.css` -- Applier panel styles, application log styles
- `src/ui/server.ts` -- Add static file serving for screenshots
- `src/logger.ts` -- Add configurable logger factory (or create separate logger in applier-agent)
- `package.json` -- Add `applier` and `test:detection` scripts
- `CLAUDE.md` -- Document new architecture

### Unchanged Files
- `src/index.ts` -- No changes
- `src/scraper-agent.ts` -- No changes
- `src/scheduler.ts` -- No changes
- `src/scraper/*` -- No changes (stealth-browser.ts is imported but not modified)
- `src/ai/job-matcher.ts` -- No changes
- `src/config.ts` -- No changes
- `prisma/schema.prisma` -- No changes (all schema work done in Plan 1)

## Data Flow / Architecture

### Process Overview (Three Processes)

```
Process 1: UI (npm run dev)
  src/index.ts
    -> Express on :3000
    -> Dashboard: shows jobs, scraper status, applier status
    -> /agent/* routes: start/stop scraper
    -> /applier/* routes: start/stop applier
    -> /screenshots: serves screenshot files

Process 2: Scraper Agent (npm run agent)
  src/scraper-agent.ts
    -> PID in ScraperState
    -> Finds jobs, saves to DB with status 'new'

Process 3: Auto-Apply Agent (npm run applier)
  src/applier-agent.ts
    -> PID in ApplierState
    -> Picks up 'new' jobs, applies, updates status

Communication: All via SQLite (same dev.db file)
  Scraper writes Job rows -> Applier reads them
  Both write state to their respective State tables
  UI reads everything for display
```

### Single Job Lifecycle

```
Scraper finds job
  -> saves to DB: status='new', applyLink='https://...'

Applier picks up job
  -> claimJobForApply(): status='new' -> 'applying'
  -> URL pre-screen
    -> if skip: status='skipped', log reason
  -> Navigate to applyLink
    -> if dead: status='skipped', reason='expired'
  -> Page analysis
    -> if not single_page: status='skipped', log formType
  -> Extract form fields
  -> Create fill plan (profile data + AI)
    -> if canSubmit=false: status='skipped', reason='missing required fields'
  -> Fill form in browser
  -> Screenshot (always)
  -> Dry-run check
    -> if dry run: status='skipped', reason='dry run'
  -> Submit form
  -> Verify submission
    -> if success: status='applied'
    -> if failure: status='failed', log error
  -> Create ApplicationLog entry

User reviews on dashboard
  -> Sees status badges, filter by status
  -> Expands job detail -> sees application history
  -> Views screenshots
  -> Can manually override status (e.g., mark 'skipped' as 'reviewed')
```

### AI API Call Budget Per Job

Worst case (all calls needed):
1. Page classification tiebreaker (if DOM analysis ambiguous): 1 call
2. Form field filling (Tier 2 fields): 1 call
3. Pre-submission sanity check (optional): 1 call
Total: 2-3 calls per job

Best case (simple form, all fields are Tier 1 profile data):
1. No AI calls needed for detection (DOM analysis sufficient)
2. No Tier 2 fields (no cover letter, no freeform questions)
Total: 0 calls per job

Typical case:
1. DOM analysis handles detection (0 calls)
2. Form has a cover letter or freeform question (1 call)
Total: 1 call per job

With ~40 requests/minute shared with the scraper, and ~10 seconds between applications, the applier uses at most ~6 calls/minute at peak. The scraper uses ~1 call per keyword per cycle (every 2 minutes). Contention is minimal.

## Edge Cases & Error Handling

### 1. Dead/expired job links
Page load results in 404, "job no longer available" text, or redirect to generic careers page. The page analyzer detects this in Phase 1 and returns `{ formType: 'expired' }`. Job is marked `skipped` with reason "job listing expired or removed."

### 2. Resume file upload
Form extractor detects `<input type="file">` fields. If the label matches resume-related terms, the form submitter uploads the primary resume PDF via `page.setInputFiles()`. If no resume is uploaded in the profile, the field is treated as an unfillable required field and the job is skipped.

### 3. CAPTCHA
Page analyzer checks for reCAPTCHA/hCaptcha iframes and CAPTCHA-related DOM elements. If found, job is marked `skipped` with reason "CAPTCHA detected." No attempt to solve.

### 4. Partial/incorrect submissions
Multiple safeguards:
- Pre-submission validation reads back all field values and checks for empty required fields.
- The sanity check AI call (optional) reviews the filled data.
- Dry-run mode (default on) prevents any submissions until the user is confident.
- Post-submission verification checks for success/error indicators on the resulting page.

### 5. Rate limiting from job sites
Domain-aware pacing: extra delay when consecutive jobs are on the same domain. The stealth browser with randomized user agents and viewports reduces detection risk. If a site returns a rate-limit response (429) or a block page, the job is marked `failed` with reason "site blocked request" and the agent adds extra delay before the next job.

### 6. Same job on multiple sites
Not addressed in MVP. Duplicate title+company detection is a future enhancement. For now, the agent applies to each DB row independently.

### 7. Anti-bot measures
The agent reuses the existing `stealth-browser.ts` and `anti-detection.ts` modules. Application sites generally have weaker anti-bot than LinkedIn. If a site blocks the browser entirely (Cloudflare challenge page, etc.), the page analyzer will find no form and the job is skipped.

### 8. Missing required fields
If the form has a required field that the agent has no data for (not in profile, not in demographics, AI returns SKIP), the job is marked `skipped` with a specific reason listing the unfillable fields. The user sees this in the application log and can add the missing data to their profile.

### 9. Form submission redirects to another page
The submitter waits for navigation after clicking submit. It follows one redirect and analyzes the destination page for success/failure indicators. If the redirect goes to another form page (multi-step revealed after submission), the job is marked `failed` with reason "unexpected multi-step form after submission."

### 10. Agent crashes mid-application
On next startup, `resetStuckApplyingJobs()` finds jobs with `status: 'applying'` and resets them to `'new'`. `resetApplierStateOnStartup()` clears the stale PID and `isRunning` flag. The jobs are retried on the next cycle.

### 11. Browser crashes mid-batch
The try-catch around the entire cycle catches browser-level errors. The current job is marked `failed`. The cycle aborts (remaining jobs in the batch stay as `new` and will be picked up next cycle). The error counter increments. After 5 consecutive errors, the agent pauses for 30 minutes (same pattern as the scraper).

### 12. Confirmation page analysis failure
If the post-submission page is ambiguous (neither clear success nor clear failure indicators), the agent assumes failure and marks the job as `failed` with reason "could not confirm submission." This is conservative -- the user can check the screenshot and manually mark it as `applied` if it actually succeeded.

## Testing Considerations

### Detection Test Fixtures

Maintain `data/test-fixtures/application-urls.json` with 10-15 URLs spanning:
- 2-3 Greenhouse forms (single_page)
- 2-3 Lever forms (single_page)
- 1-2 Ashby forms (single_page)
- 2-3 Workday URLs (multi_step, should be pre-screened)
- 1-2 Company career pages with custom forms
- 1-2 Expired/dead links

Run `npm run test:detection` to validate. Update the fixture file as URLs expire and replace with fresh ones.

### Manual Testing Checklist

1. **Dry-run mode**: Enable auto-apply with dry-run on. Start the applier. Verify it fills forms and takes screenshots but does not submit. Check screenshots in `data/screenshots/`. Verify jobs are marked `skipped` with reason "dry run."

2. **URL pre-screening**: Add a Workday URL to the test fixtures. Verify it is skipped without launching a browser.

3. **Expired job link**: Manually set a job's `applyLink` to a known dead URL. Run the applier. Verify it is marked `skipped` with reason "expired."

4. **CAPTCHA detection**: Find a job page with CAPTCHA. Verify the agent detects it and skips.

5. **Profile data mapping**: Create a job with a known Greenhouse application URL. Fill in the profile completely. Run in dry-run mode. Check the screenshot to verify fields were filled correctly.

6. **Cover letter generation**: Find a form with a cover letter field. Verify the AI generates a coherent, job-specific cover letter using the profile data and cover letter notes.

7. **Demographic answers**: Find a form with EEO questions. Verify the agent uses the stored demographic answers, not AI-generated values.

8. **Missing field handling**: Leave `desiredSalary` blank in the profile. Find a form that requires salary. Verify the job is skipped with a clear reason.

9. **Process management**: Start the applier from the dashboard. Verify the panel shows "Running." Stop it. Verify clean shutdown. Kill the applier process with `kill -9`. Reload dashboard. Verify stale PID cleanup.

10. **Concurrent agents**: Run both scraper and applier simultaneously. Verify no SQLite contention issues. Verify the scraper saves new jobs and the applier picks them up promptly.

11. **Live submission** (after dry-run validation): Disable dry-run. Apply to a real job. Verify the application was submitted and the confirmation page is captured in the screenshot.

## Migration / Breaking Changes

### No schema migration
All schema changes are done in Plan 1. This plan only adds code.

### Job status semantics change
Jobs previously stayed as `new` until manually reviewed. Now they automatically transition to `applying/applied/skipped/failed`. Users who manually manage jobs via the dashboard should be aware that `new` jobs may disappear from the "New" filter quickly when the applier is running.

### New npm dependency: none
All functionality uses Playwright (already installed), the OpenAI SDK (already installed), and Node built-ins.

### Dashboard layout change
The jobs page gains a second agent panel. On smaller screens, the panels stack vertically. No existing UI elements are removed.

## Open Questions

1. **Vision API support**: Does Kimi K2.5 on the NVIDIA API support image/screenshot inputs for the AI tiebreaker in page analysis? If not, the fallback is text-based page content extraction. Test this early in implementation.

2. **Concurrent applier instances**: The current design enforces a single applier process (same as scraper). If throughput becomes a bottleneck, multiple applier processes could run in parallel with different job batches. The `claimJobForApply` function's optimistic concurrency handles this. But for MVP, one instance is sufficient.

3. **Retry strategy**: Should failed jobs be retried? Currently they stay as `failed` permanently. A future enhancement could add a retry count and re-queue failed jobs after a delay (e.g., retry once after 30 minutes in case the failure was transient). Not needed for MVP.

4. **Application confirmation tracking**: Some companies send confirmation emails. The agent has no way to verify email-based confirmations. The post-submission screenshot is the best available evidence. Consider adding a "verified" status that the user manually sets after checking their email.

5. **Browser reuse between batches**: Current design closes the browser between batches and re-launches. If batches are small (5 jobs) and frequent, the cold-start overhead adds up. An optimization could keep the browser alive across batches with a maximum lifetime (e.g., restart after 30 minutes or 20 jobs). Defer to implementation.
