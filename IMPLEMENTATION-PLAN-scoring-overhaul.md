# Implementation Plan: Scoring System Overhaul & Red Flag Fix

## Summary

Replace the current unstructured AI-only scoring and red flag system with a hybrid approach: deterministic dealbreaker detection (hard zeros), a 16-dimension weighted scoring rubric (AI sub-scores for qualitative + deterministic calculations for factual), and strictly restricted red flags that only surface factual problems. Also fix the inaccurate profile experience cache and add a manual `yearsOfExperience` override field.

## Context & Problem

The current enrichment agent asks the AI for a single 0-100 `matchScore` and a freeform `redFlags` array with almost no guidance. This produces:

1. **Generic, undifferentiated scores** -- 78 out of 85 enriched jobs scored 0-40, clustering at 10-30 with no meaningful separation between "completely unqualified" and "mediocre fit."
2. **Hallucinated red flags** -- The AI invents warnings based on its own assumptions: flagging non-startup companies as problems, flagging on-site roles when the user is willing to relocate, flagging "no visa sponsorship" when the user has a green card, and treating preferences as requirements.
3. **Missing profile context** -- Key profile fields (`willingToRelocate`, `visaSponsorshipNeeded`, `remoteOnly`, `openToContract`) exist in the database but are never passed to the enrichment AI prompt.
4. **Wrong experience data** -- The `profileSummaryCache` says 2 years of experience; the user has 4. There is no manual override field.

## Chosen Approach

**Hybrid scoring**: The AI provides 0-10 sub-scores for 10 qualitative dimensions. Deterministic rules calculate 6 factual dimensions from structured data. A weighted formula combines all 16 into the final 0-100 score. Dealbreakers short-circuit the entire process (score = 0, priority = low). Red flags are kept but the AI prompt strictly limits them to factual, verifiable problems only.

This was chosen over pure-AI scoring (current approach, unreliable) and pure-rules scoring (can't evaluate qualitative fit from description text).

---

## Final Scoring Rubric: 16 Dimensions

### Dealbreakers (checked BEFORE scoring -- any match = score 0, priority "low")

| ID | Dealbreaker | Detection Method |
|----|-------------|-----------------|
| D1 | **Seniority too high** | AI checks description for Senior/Staff/Principal/Lead/Director/VP/Head of/Manager/Architect level requirements. Also cross-reference LinkedIn `seniorityLevel` metadata if available ("Mid-Senior level", "Director", etc.). |
| D2 | **Security clearance required** | AI scans description for "security clearance", "Secret", "Top Secret", "TS/SCI", "DoD clearance", "clearance required", "must be clearable". |
| D3 | **Wrong tech domain entirely** | AI determines if the PRIMARY required stack is C++/CUDA, Java/Spring, C#/.NET, Embedded systems, COBOL, or another domain with zero overlap to candidate's skills. A job that MENTIONS Java but primarily uses Python/TypeScript is NOT a dealbreaker. |
| D4 | **Experience requires 6+ years minimum** | AI extracts the minimum years-of-experience requirement from the description. If the stated minimum is 6 or higher, it's a dealbreaker. "3-6 years" has a minimum of 3, so it is NOT a dealbreaker. "6+ years", "6-10 years", "minimum 6 years" ARE dealbreakers. If no years are stated, it is NOT a dealbreaker. |

### Category A: Core Fit (42% total weight)

| # | Dimension | Type | Weight | What 0-10 means |
|---|-----------|------|--------|-----------------|
| 1 | **Tech Stack Alignment** | AI | 10% | 0 = zero overlap with candidate's skills. 5 = some overlap (1-2 technologies match). 8 = strong overlap (3+ core technologies). 10 = exact stack match (React/Next.js/Node/Python/FastAPI all listed). |
| 2 | **Role Type: Building vs. Maintaining** | AI | 9% | 0 = purely advisory/consulting/maintaining legacy. 5 = mixed (some building, some maintenance). 8 = primarily building new features/products. 10 = greenfield product development, building from scratch. |
| 3 | **AI/LLM Relevance** | AI | **12%** | 0 = no AI/ML mention at all. 3 = vague "we use AI" without specifics. 6 = AI is part of the product but not the core job. 8 = building AI features, LLM integration, agents. 10 = core AI product role (RAG, prompt engineering, AI agents, LLM applications). |
| 4 | **Full Stack Breadth** | AI | 5% | 0 = extremely narrow scope (single component). 5 = frontend OR backend only. 8 = frontend + backend. 10 = true full-stack (frontend + backend + infrastructure/deployment). |
| 5 | **Product Ownership Signal** | AI | 6% | 0 = "implement tickets from Jira." 5 = standard team contributor role. 8 = "own features end-to-end." 10 = "ship the product, work directly with founders, wear many hats." |

### Category B: Opportunity Quality (18% total weight -- simplified to 2 dimensions)

| # | Dimension | Type | Weight | What 0-10 means |
|---|-----------|------|--------|-----------------|
| 6 | **Company Stage (Startup Signal)** | AI | **12%** | 0 = large enterprise (5000+ employees), bureaucratic. 3 = mid-to-large company (1000-5000). 5 = mid-size (200-1000). 7 = growth-stage startup (50-200). 9 = early-stage startup (<50 people). 10 = founding team, "first engineer", recently funded, <20 people. |
| 7 | **Growth & Learning Potential** | AI | 6% | 0 = dead-end ticket-grinding, no mentorship signals. 5 = standard corporate career path. 8 = work with senior engineers, exposure to architecture decisions. 10 = work directly with founders/CTO, mentorship, rapid skill growth signals. |

### Category C: Competitive Advantage (22% total weight)

| # | Dimension | Type | Weight | What 0-10 means |
|---|-----------|------|--------|-----------------|
| 8 | **Experience Level Match** | Deterministic | 8% | Calculated from AI-extracted minimum years requirement vs. candidate's 4 years. 0-2 required = 10. 2-3 required = 9. 3-4 required = 8. 4-5 required = 6. 5-6 required = 3 (stretch). Not stated = 7. |
| 9 | **Seniority Alignment** | Deterministic | 5% | LinkedIn metadata seniority vs. target (junior/mid/entry-level). Exact match = 10. "Entry level" or "Associate" = 9. "Not specified" = 6. "Mid-Senior" that slipped through = 3. |
| 10 | **Applicant Competition** | Deterministic | 4% | "Be among first 25" = 10. Under 50 = 8. Under 100 = 6. 100-200 = 4. 200+ = 2. Unknown = 5. |
| 11 | **Description Specificity & Quality** | AI | 3% | 0 = empty/vague boilerplate, buzzword soup, likely ghost listing. 5 = adequate but generic. 8 = specific requirements, clear team context. 10 = detailed projects, named technologies, real team description. |
| 12 | **Posting Freshness Signal** | AI | 2% | 0 = clear repost signals (huge applicants for "new" listing, identical to other postings). 5 = no signal either way. 10 = clearly fresh, low applicant count, specific/timely language. |

### Category D: Access & Actionability (18% total weight)

| # | Dimension | Type | Weight | What 0-10 means |
|---|-----------|------|--------|-----------------|
| 13 | **Remote Position** | Deterministic | **12%** | 10 = explicitly remote / "remote-first". 8 = hybrid with significant remote flexibility. 5 = hybrid (2-3 days onsite). 3 = on-site with no remote mention. Score never goes below 3 because candidate is willing to relocate. |
| 14 | **Direct Contact Opportunity** | Deterministic | 3% | Named poster with profile + DM invitation = 10. Named poster with profile = 7. Named poster only = 5. No poster info = 3. |
| 15 | **Poster Role & Seniority** | AI | 2% | Founder/CTO = 10. Engineering manager = 8. In-house recruiter = 6. External recruiter/staffing agency = 3. No info = 4. |
| 16 | **Application Method** | Deterministic | 1% | Direct referral/DM pathway = 10. External careers page = 8. Easy Apply = 7. No clear path = 5. |

**Total: 100%**

**Top 3 highest-weighted dimensions (user's priorities):**
- AI/LLM Relevance: 12%
- Company Stage (Startup Signal): 12%
- Remote Position: 12%

### Bonus Modifiers (additive, applied after base score calculation)

| Bonus | Condition | Points |
|-------|-----------|--------|
| Urgency Signal Match | Any trigger from `urgencySignals` profile field matched by AI | +5 |
| Founding/First Engineer | Description mentions founding engineer, first hire, first engineer | +5 |
| Recent Funding | Company recently raised money (mentioned in description/company info) | +3 |
| "DM Me" Signal | Poster explicitly invites direct outreach | +3 |
| Exact Stack Match | 4+ of candidate's core technologies (React, Next.js, Node, Python, FastAPI) explicitly listed | +3 |

### Penalty Modifiers (subtractive, applied after base score calculation)

| Penalty | Condition | Points |
|---------|-----------|--------|
| Staffing Agency | Posted by a recruiting/staffing firm, not the actual company | -8 |
| Very High Applicants | 500+ applicants | -5 |
| Ghost Listing Signals | Multiple signs of inactivity: huge applicant count + vague description + no poster | -5 |
| Repost Signal | Clear indicators this is a recycled/re-posted listing | -3 |

### Priority Assignment (from final clamped score)

| Score Range | Condition | Priority |
|-------------|-----------|----------|
| 85+ | With any urgency signal match | **urgent** |
| 75+ | -- | **high** |
| 50-74 | -- | **normal** |
| Below 50 | -- | **low** |
| 0 | Dealbreaker hit | **low** |

Final score is clamped to 0-100 after bonuses/penalties.

---

## Detailed Implementation Steps

### Step 1: Schema Changes

**File:** `prisma/schema.prisma`

Add a `yearsOfExperience` field to `UserProfile`:

```
yearsOfExperience Int @default(0)  // Manual override, used for scoring
```

Add a `scoreBreakdown` field to `Job` to store the per-dimension sub-scores:

```
scoreBreakdown    String   @default("{}")  // JSON object of dimension scores
dealbreaker       String   @default("")    // Which dealbreaker was triggered, empty if none
```

The `scoreBreakdown` field stores a JSON object like:
```json
{
  "techStack": 8,
  "roleType": 7,
  "aiRelevance": 10,
  "fullStackBreadth": 6,
  "productOwnership": 8,
  "companyStage": 9,
  "growthPotential": 7,
  "experienceMatch": 9,
  "seniorityAlignment": 8,
  "applicantCompetition": 6,
  "descriptionQuality": 7,
  "postingFreshness": 5,
  "remotePosition": 10,
  "directContact": 7,
  "posterRole": 8,
  "applicationMethod": 7,
  "bonuses": ["urgencySignal", "exactStackMatch"],
  "penalties": [],
  "baseScore": 82,
  "finalScore": 90,
  "minYearsExtracted": 2
}
```

Run: `npm run prisma:migrate` after the schema change.

### Step 2: Profile Cache Fix & Years of Experience

**Files:**
- `prisma/schema.prisma` (already covered in Step 1)
- `src/database/profile-queries.ts`
- `src/ui/setup-routes.ts`
- `src/ui/views/setup.ejs` (or whichever settings page manages profile fields)

**Changes:**

In `profile-queries.ts`:
- Add `yearsOfExperience` to the `ProfileUpdate` interface.
- Add `yearsOfExperience` to `CACHE_INVALIDATING_FIELDS`.
- In `getProfileForEnrichmentAI()`, include `yearsOfExperience` in the returned object.

In `setup-routes.ts`:
- In the `POST /setup/profile` handler, read `years_of_experience` from `req.body` and include it in the `updateProfile()` call.

In the settings UI template:
- Add a number input field for "Years of Experience" with a label like "Total years of professional software development experience (used for job matching)."

After migration, manually update the current profile:
```sql
UPDATE UserProfile SET yearsOfExperience = 4 WHERE id = 'singleton';
```
Or handle via the UI once the field exists.

Also invalidate the profile summary cache so it regenerates with correct data:
```sql
UPDATE UserProfile SET profileSummaryCache = NULL, profileSummaryCachedAt = NULL WHERE id = 'singleton';
```

### Step 3: Pass Missing Profile Fields to Enrichment Prompt

**File:** `src/database/profile-queries.ts`

In `getProfileForEnrichmentAI()`, add these fields to the returned object:

```typescript
willingToRelocate: profile.willingToRelocate,
visaSponsorshipNeeded: profile.visaSponsorshipNeeded,
remoteOnly: profile.remoteOnly,
openToContract: profile.openToContract,
yearsOfExperience: profile.yearsOfExperience,
```

**File:** `src/ai/prompts.ts`

Update the `EnrichmentProfileContext` interface to include:
```typescript
willingToRelocate: boolean;
visaSponsorshipNeeded: boolean;
remoteOnly: boolean;
openToContract: boolean;
yearsOfExperience: number;
```

### Step 4: Create the Scoring Engine Module

**New file:** `src/ai/scoring-engine.ts`

This is the core new module. It contains:

1. **`SCORING_DIMENSIONS`** -- a constant array defining all 16 dimensions with their keys, weights, and types (AI vs. deterministic).

2. **`DIMENSION_WEIGHTS`** -- the weight map:
    ```
    techStack: 0.10
    roleType: 0.09
    aiRelevance: 0.12
    fullStackBreadth: 0.05
    productOwnership: 0.06
    companyStage: 0.12
    growthPotential: 0.06
    experienceMatch: 0.08
    seniorityAlignment: 0.05
    applicantCompetition: 0.04
    descriptionQuality: 0.03
    postingFreshness: 0.02
    remotePosition: 0.12
    directContact: 0.03
    posterRole: 0.02
    applicationMethod: 0.01
    ```

3. **`checkDealbreakers(aiDealbreakers: DealbreakersResult): string | null`**
    - Takes the structured dealbreaker result from the AI response.
    - Returns the dealbreaker ID string if one was triggered, or `null` if none.
    - The AI returns a structured object: `{ seniorityTooHigh: boolean, clearanceRequired: boolean, wrongTechDomain: boolean, experienceMinYears: number | null }`.
    - This function checks each field. If `experienceMinYears !== null && experienceMinYears >= 6`, dealbreaker triggered.

4. **`calculateDeterministicScores(job, profile, aiExtracted): Record<string, number>`**
    - Calculates scores for dimensions 8-10, 13-14, 16.
    - `experienceMatch`: Uses `aiExtracted.minYearsRequired` vs. `profile.yearsOfExperience`. Scoring formula as defined in the rubric.
    - `seniorityAlignment`: Maps LinkedIn `seniorityLevel` metadata string to score. "Entry level" or "Associate" = 9. "Not specified" / empty = 6. "Mid-Senior level" = 3.
    - `applicantCompetition`: Parses `job.applicantCount` string. Extracts number via regex. Maps to score per rubric.
    - `remotePosition`: Uses `aiExtracted.workArrangement` which the AI classifies as "remote" / "hybrid" / "onsite" / "unknown". Maps to score per rubric.
    - `directContact`: Checks if `job.postedBy` exists, if `job.postedByProfile` exists, if AI detected DM invitation. Maps to score.
    - `applicationMethod`: Uses `aiExtracted.applicationMethod` ("easyApply" / "externalSite" / "directReferral" / "unknown"). Maps to score.

5. **`calculateBonuses(aiAnalysis): { bonuses: string[], totalBonus: number }`**
    - Checks each bonus condition from the AI response.
    - Returns list of triggered bonus names and total points.

6. **`calculatePenalties(aiAnalysis): { penalties: string[], totalPenalty: number }`**
    - Checks each penalty condition from the AI response.
    - Returns list of triggered penalty names and total points.

7. **`computeFinalScore(aiScores, deterministicScores, bonuses, penalties): { baseScore: number, finalScore: number, breakdown: ScoreBreakdown }`**
    - Weighted sum: `sum(subscore[dim] * weight[dim])` across all 16 dimensions. Each sub-score is 0-10, and each `subscore * weight` produces 0 to `weight*10` points. Since weights sum to 1.0 and max sub-score is 10, the max base score is 100.
    - Apply bonuses and penalties.
    - Clamp to 0-100.
    - Return the full breakdown object for storage.

8. **`assignPriority(finalScore, urgencySignalMatched): string`**
    - 85+ with urgency = "urgent". 75+ = "high". 50-74 = "normal". Below 50 = "low".

### Step 5: Rewrite the Enrichment AI Prompt

**File:** `src/ai/prompts.ts`

Replace the `buildEnrichmentAnalysisPrompt()` function entirely. The new prompt asks the AI to return a structured JSON object with three sections:

**Section 1: Dealbreaker Detection**
```json
"dealbreakers": {
  "seniorityTooHigh": false,
  "clearanceRequired": false,
  "wrongTechDomain": false,
  "experienceMinYears": 3
}
```

The prompt specifies exactly what each dealbreaker means:
- `seniorityTooHigh`: True if the role clearly requires Senior, Staff, Principal, Lead, Director, VP, Head of, Architect, or Manager level experience based on the description (not just the title -- the description may reveal senior expectations even with a generic title).
- `clearanceRequired`: True if the posting requires any security clearance (Secret, Top Secret, TS/SCI, DoD, etc.) or states "must be clearable."
- `wrongTechDomain`: True if the PRIMARY required technology stack is C++/CUDA, Java/Spring, C#/.NET, Embedded systems, or COBOL with no meaningful overlap to the candidate's skills. A job that mentions Java as secondary but primarily uses Python/TypeScript is NOT wrong-tech-domain.
- `experienceMinYears`: Extract the MINIMUM years of experience stated in the description as a number. "3-6 years" = 3. "5+ years" = 5. "6 years minimum" = 6. If no years stated, return `null`.

**Section 2: Dimension Sub-Scores (AI-scored dimensions only)**
```json
"scores": {
  "techStack": 8,
  "roleType": 7,
  "aiRelevance": 10,
  "fullStackBreadth": 6,
  "productOwnership": 8,
  "companyStage": 9,
  "growthPotential": 7,
  "descriptionQuality": 8,
  "postingFreshness": 6,
  "posterRole": 8
}
```

The prompt includes the EXACT scoring rubric for each dimension (the 0-10 scale descriptions from the rubric above), so the AI has an unambiguous reference. Each dimension gets 2-3 lines of anchor descriptions.

**Section 3: Extracted Signals and Analysis**
```json
"extracted": {
  "workArrangement": "hybrid",
  "applicationMethod": "externalSite",
  "urgencySignalMatched": true,
  "isFoundingRole": false,
  "recentFunding": false,
  "dmInvitation": false,
  "exactStackCount": 4,
  "isStaffingAgency": false,
  "highApplicantCount": false,
  "ghostListingSignals": false,
  "repostSignal": false
},
"analysis": {
  "matchReason": "2-3 sentence summary of overall fit",
  "keyMatches": ["specific match 1", "specific match 2"],
  "actionItems": ["concrete action 1"],
  "redFlags": ["factual red flag 1"]
}
```

**Critical change to red flags instructions in the prompt:**

The prompt will include an explicit section:

```
RED FLAGS RULES -- follow these EXACTLY:
A red flag is ONLY a factual problem verifiable from the posting text. It must be something the candidate needs to know that is NOT already captured by the scoring dimensions.

VALID red flags (examples):
- "Requires 5 years of Java experience (candidate has 0 Java experience)"
- "Posting mentions this is a re-opening after previous hire left"
- "350+ applicants already"
- "Description appears copy-pasted from a different company's listing"

NEVER flag ANY of the following (these are scored via dimensions, not red flags):
- Company size or type (scored in companyStage dimension)
- Industry not being AI or startup (scored in aiRelevance and companyStage)
- On-site, hybrid, or relocation requirement (candidate has green card and is willing to relocate ANYWHERE in the US)
- Visa sponsorship not offered (candidate has a GREEN CARD and does NOT need sponsorship)
- Lack of direct contact info (scored in directContact dimension)
- The role not being at a startup (scored in companyStage dimension)
- Any PREFERENCE mismatch already reflected in a scoring dimension
- The ABSENCE of a positive signal (e.g., "no mention of AI" is not a red flag -- it's a low aiRelevance score)

If there are no legitimate red flags, return an empty array.
```

**Profile context additions to the prompt:**

The new prompt will include these lines in the candidate profile section:

```
CANDIDATE FACTS (use these for scoring -- do NOT contradict):
- Years of professional experience: {yearsOfExperience}
- Visa status: Has green card (does NOT need sponsorship)
- Willing to relocate: {willingToRelocate ? "Yes, anywhere in the US" : "No"}
- Remote preference: {remoteOnly ? "Remote only" : "Remote preferred but open to hybrid/onsite"}
- Open to contract: {openToContract ? "Yes" : "No, full-time only"}
```

### Step 6: Update the Enrichment AI Caller

**File:** `src/ai/job-enricher.ts`

The `EnrichmentAnalysis` interface changes to:

```typescript
export interface EnrichmentAnalysis {
  // Dealbreakers
  dealbreakers: {
    seniorityTooHigh: boolean;
    clearanceRequired: boolean;
    wrongTechDomain: boolean;
    experienceMinYears: number | null;
  };
  // AI sub-scores (0-10 each)
  scores: {
    techStack: number;
    roleType: number;
    aiRelevance: number;
    fullStackBreadth: number;
    productOwnership: number;
    companyStage: number;
    growthPotential: number;
    descriptionQuality: number;
    postingFreshness: number;
    posterRole: number;
  };
  // Extracted signals for deterministic scoring + bonuses/penalties
  extracted: {
    workArrangement: 'remote' | 'hybrid' | 'onsite' | 'unknown';
    applicationMethod: 'easyApply' | 'externalSite' | 'directReferral' | 'unknown';
    urgencySignalMatched: boolean;
    isFoundingRole: boolean;
    recentFunding: boolean;
    dmInvitation: boolean;
    exactStackCount: number;
    isStaffingAgency: boolean;
    highApplicantCount: boolean;
    ghostListingSignals: boolean;
    repostSignal: boolean;
  };
  // Human-readable analysis
  analysis: {
    matchReason: string;
    keyMatches: string[];
    actionItems: string[];
    redFlags: string[];
  };
  // Set by caller, not by AI
  aiFailed?: boolean;
}
```

The `analyzeEnrichedJob()` function:
- Still makes the AI call with the new prompt.
- Parses the structured JSON response.
- Validates each field (clamp sub-scores to 0-10, validate booleans, etc.).
- On AI failure: returns a default result with all scores at 0 and `aiFailed: true`.
- Does NOT compute the final score -- that happens in the enricher agent after this function returns.

### Step 7: Update the Enricher Agent

**File:** `src/enricher-agent.ts`

The enrichment loop changes from:

```
scrape -> AI analyze -> save
```

to:

```
scrape -> AI analyze -> check dealbreakers -> calculate deterministic scores -> compute final score -> assign priority -> save
```

Specifically, after `const analysis = await analyzeEnrichedJob(...)`:

1. Import and call `checkDealbreakers(analysis.dealbreakers)`.
2. If a dealbreaker is triggered:
   - Set `matchScore = 0`, `priority = 'low'`, `dealbreaker = triggeredDealbreaker`.
   - Set `priorityReason` to a description of why (e.g., "Dealbreaker: requires security clearance").
   - Still save the scraped data (description, company info, etc.) and AI analysis (matchReason, keyMatches, etc.) so the user can see what was wrong.
   - Skip bonus/penalty calculation.
3. If no dealbreaker:
   - Call `calculateDeterministicScores(...)` with scraped job data, profile data, and AI-extracted signals.
   - Call `computeFinalScore(analysis.scores, deterministicScores, bonuses, penalties)`.
   - Call `assignPriority(finalScore, analysis.extracted.urgencySignalMatched)`.
4. Call `updateJobEnrichment(...)` with all data including the new `scoreBreakdown` and `dealbreaker` fields.

### Step 8: Update the Database Enrichment Functions

**File:** `src/database/enrichment-queries.ts`

Update the `EnrichmentData` interface to include:
```typescript
scoreBreakdown: object;  // The full breakdown JSON
dealbreaker: string;     // Which dealbreaker triggered, or empty string
```

Update `updateJobEnrichment()` to save:
```typescript
scoreBreakdown: JSON.stringify(data.scoreBreakdown),
dealbreaker: data.dealbreaker,
```

### Step 9: Update the UI to Show Score Breakdown

**File:** `src/ui/views/kanban.ejs`

In the detail panel, replace the current simple score display with a score breakdown view. When a job is selected and has been enriched:

- Show the final score prominently (as before).
- Below it, show the breakdown as a compact list of dimension names with their sub-scores (0-10) and small bar indicators. Group by category (Core Fit, Opportunity Quality, etc.).
- If a dealbreaker was triggered, show a clear "Dealbreaker: [reason]" banner instead of the score breakdown.
- Red flags section: keep the "Heads Up" label and rendering, but the content will now be much more restricted (factual-only per the prompt changes).

**File:** `src/ui/routes.ts`

Add `scoreBreakdownParsed` and `dealbreaker` to the parsed job objects:
```typescript
scoreBreakdownParsed: safeParseJson(job.scoreBreakdown, {}),
dealbreaker: job.dealbreaker || '',
```

**File:** `src/ui/views/styles.css`

Add styles for:
- Score breakdown grid (dimension name + bar + score number).
- Dealbreaker banner (distinct from red flags -- more prominent, different color).
- Category headers within the breakdown.

### Step 10: Update Telegram Notifications

**File:** `src/notifications/telegram.ts`

No structural changes needed. The `sendUrgentJobNotification()` function already receives the analysis data. The `matchReason` and `actionItems` it uses will be better quality because the AI prompt is better, but the notification code itself doesn't change.

One minor adjustment: the enricher agent's urgency check should now use the priority from `assignPriority()` (which it already does -- `analysis.priority` is replaced by the computed priority before the Telegram check).

Actually, looking at the current code more carefully:

```typescript
if (analysis.priority === 'urgent' && !analysis.aiFailed && isTelegramConfigured()) {
```

This reads `analysis.priority` directly from the AI response. In the new system, the AI no longer returns a priority -- priority is computed by the scoring engine. So this line needs to change to read the computed priority from the scoring result instead.

---

## Files Affected

### New Files
| File | Purpose |
|------|---------|
| `src/ai/scoring-engine.ts` | Scoring engine: weights, dealbreaker checks, deterministic scores, final score computation, priority assignment |

### Modified Files
| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `yearsOfExperience` to UserProfile, add `scoreBreakdown` and `dealbreaker` to Job |
| `src/ai/prompts.ts` | Rewrite `buildEnrichmentAnalysisPrompt()` entirely with new structured output format, update `EnrichmentProfileContext` interface |
| `src/ai/job-enricher.ts` | New `EnrichmentAnalysis` interface structure, update validation logic for new response format |
| `src/enricher-agent.ts` | Add scoring engine integration between AI analysis and DB save. Change priority and notification logic to use computed values. |
| `src/database/enrichment-queries.ts` | Add `scoreBreakdown` and `dealbreaker` to `EnrichmentData` interface and `updateJobEnrichment()` |
| `src/database/profile-queries.ts` | Add `yearsOfExperience` to `ProfileUpdate`, `CACHE_INVALIDATING_FIELDS`, and `getProfileForEnrichmentAI()` return value. Add `willingToRelocate`, `visaSponsorshipNeeded`, `remoteOnly`, `openToContract` to enrichment AI return. |
| `src/ui/routes.ts` | Parse `scoreBreakdown` and `dealbreaker` for job display |
| `src/ui/views/kanban.ejs` | Render score breakdown in detail panel, dealbreaker banner, updated red flags |
| `src/ui/views/styles.css` | Styles for score breakdown grid, dealbreaker banner |
| `src/ui/setup-routes.ts` | Handle `yearsOfExperience` field in profile save |
| `src/ui/views/setup.ejs` | Add years of experience input field |

### No Changes Needed
| File | Why |
|------|-----|
| `src/ai/job-matcher.ts` | Pre-filtering pipeline is independent of enrichment scoring |
| `src/notifications/telegram.ts` | Notification code doesn't change, just receives better data |
| `src/scraper/detail-scraper.ts` | Scraping logic is independent of scoring |
| `src/config.ts` | No new config needed |
| `src/scraper-agent.ts` | Scraper agent is independent |

---

## Data Flow After Changes

```
Job enters enrichment queue (status=new, enrichmentStatus=pending)
  |
  v
Enricher agent picks up job
  |
  v
Detail scraper: visits LinkedIn detail page
  -> Extracts: description, companyInfo, applicantCount, seniorityLevel,
     employmentType, jobFunction, postedBy, postedByTitle, contactPeople
  |
  v
Load profile context (now includes: yearsOfExperience, willingToRelocate,
  visaSponsorshipNeeded, remoteOnly, openToContract)
  |
  v
AI call (single call, new structured prompt)
  -> Returns: dealbreakers{}, scores{}, extracted{}, analysis{}
  |
  v
Scoring engine: checkDealbreakers()
  |
  +-- Dealbreaker triggered? --> score=0, priority=low, dealbreaker="D1"
  |
  +-- No dealbreaker:
      |
      v
      calculateDeterministicScores() for dimensions 8-10, 13-14, 16
      using job data + profile + AI-extracted signals
      |
      v
      computeFinalScore() = weighted sum + bonuses - penalties, clamped 0-100
      |
      v
      assignPriority() based on score + urgency signals
  |
  v
Save to DB: all scraped data + AI analysis + scoreBreakdown + dealbreaker +
  computed matchScore + computed priority
  |
  v
If priority=urgent -> send Telegram notification (unchanged)
```

---

## Edge Cases & Error Handling

1. **AI returns invalid sub-scores**: Clamp each to 0-10 range. If a score field is missing or NaN, default to 5 (neutral, not punitive).

2. **AI fails entirely**: Existing fail-safe behavior preserved -- save scraped data, set `aiFailed: true`, default score = 0, priority = "normal" (not "low" -- we don't know if there's a dealbreaker, so we don't penalize). Red flags = empty. The job can be re-enriched later if desired.

3. **Dealbreaker edge case -- AI misjudges seniority**: The title pre-filter already catches most senior titles before enrichment. The AI dealbreaker check is a second layer for cases where the title is generic ("Software Engineer") but the description says "8+ years and team leadership experience." False positives here are low-risk because the user can manually review.

4. **Experience extraction ambiguity**: "3+ years preferred, 1+ required" -- the AI should extract the stated MINIMUM requirement (1 year). The prompt will explicitly instruct: "Extract the MINIMUM years of experience REQUIRED (not preferred). If the posting says 'X+ years preferred' but a lower number required, use the required number. If only a preferred number is stated with no hard requirement, return null."

5. **Jobs already enriched**: Existing enriched jobs keep their old scores. The new scoring only applies to newly enriched jobs. If the user wants to re-score existing jobs, they would need to reset `enrichmentStatus` to "pending" (manual DB operation or future UI feature).

6. **Score breakdown backwards compatibility**: Old jobs have `scoreBreakdown = "{}"` (default). The UI should handle this gracefully -- if breakdown is empty, just show the matchScore without the dimension grid.

7. **Profile cache invalidation**: Adding `yearsOfExperience` to `CACHE_INVALIDATING_FIELDS` means changing this value will trigger cache rebuild. The AI that generates the profile summary will then have access to the correct experience data.

---

## Testing Considerations

1. **Scoring engine unit tests** (`src/ai/scoring-engine.test.ts`):
   - Test `checkDealbreakers()` with each dealbreaker type and edge cases (6 exactly, 5.9, null).
   - Test `calculateDeterministicScores()` with various applicant counts, seniority levels, work arrangements.
   - Test `computeFinalScore()` with known sub-scores to verify weighted math.
   - Test `assignPriority()` at boundary scores (49, 50, 74, 75, 84, 85).
   - Test that all weights sum to exactly 1.0.

2. **Prompt integration test**: Run the new prompt against 3-5 real job descriptions from the existing DB and verify the AI returns valid structured JSON matching the schema. Check that sub-scores are in 0-10 range and dealbreaker booleans are actual booleans.

3. **Red flag regression test**: Take the specific false-positive red flags from the user's complaint and verify they no longer appear:
   - "Large enterprise company" -- should not be a red flag.
   - "On-site in [city]" -- should not be a red flag.
   - "No visa sponsorship" -- should not be a red flag.
   - "No direct founder/CTO contact" -- should not be a red flag.

4. **Dealbreaker test**: Verify that a job requiring DoD clearance gets score=0. Verify that a "3-6 years" requirement does NOT trigger the 6+ dealbreaker (minimum is 3). Verify that a "6+ years required" posting DOES trigger it.

5. **End-to-end test**: Run the enricher on 5-10 pending jobs and verify scores are more differentiated than the old system (should see spread across 30-90+ range instead of clustering at 10-35).

---

## Migration / Breaking Changes

1. **Database migration required**: Two new fields on Job (`scoreBreakdown`, `dealbreaker`) and one on UserProfile (`yearsOfExperience`). Both have defaults, so existing data is unaffected. Run `npm run prisma:migrate`.

2. **No breaking API changes**: The UI routes return the same job data structure with additional fields. Old fields (`matchScore`, `matchReason`, `redFlags`, etc.) are still populated.

3. **Existing enriched jobs**: Keep their old scores. The `scoreBreakdown` will be `"{}"` and `dealbreaker` will be `""`. The UI must handle this gracefully.

4. **Profile cache must be invalidated** after adding `yearsOfExperience` to ensure the AI profile summary reflects the correct experience count.

---

## Implementation Order

| Order | Step | Depends On | Estimated Complexity |
|-------|------|-----------|---------------------|
| 1 | Schema changes (Step 1) | Nothing | Low |
| 2 | Profile cache fix + years field (Step 2) | Step 1 | Low |
| 3 | Pass missing profile fields (Step 3) | Step 2 | Low |
| 4 | Create scoring engine module (Step 4) | Nothing | Medium |
| 5 | Rewrite enrichment prompt (Step 5) | Step 3 | Medium-High |
| 6 | Update AI caller (Step 6) | Step 5 | Medium |
| 7 | Update enricher agent (Step 7) | Steps 4, 6 | Medium |
| 8 | Update DB enrichment functions (Step 8) | Step 1 | Low |
| 9 | Update UI (Step 9) | Steps 7, 8 | Medium |
| 10 | Update Telegram notification trigger (Step 10) | Step 7 | Low |

Steps 1-3 can be done as one batch. Step 4 can be done in parallel with steps 5-6 since the scoring engine is a standalone module. Steps 7-10 depend on everything above.

---

## Open Questions

1. **Re-enrichment of existing jobs**: Should the implementation include a way to reset enrichment status for all existing jobs so they get re-scored with the new system? This could be a one-time script or a UI button. Not strictly required for v1 but would be useful.

2. **Weight configurability**: The weights are hardcoded in this plan. Should they be stored in the database (AppSettings or a new ScoringConfig model) so the user can tune them from the UI? This adds complexity but makes future adjustments trivial. Recommendation: hardcode for v1, add UI configuration as a follow-up if the user wants to tune.

3. **Prompt token budget**: The new prompt is significantly longer than the current one (includes full rubric descriptions for 10 AI dimensions + dealbreaker definitions + red flag rules + profile facts). Verify it stays within the `maxTokens: 4096` response budget and the model's context window. The response JSON is also larger. May need to increase `maxTokens` to 6144 or 8192.

4. **Dimension sub-score display format**: The plan describes a "compact list with bar indicators" for the UI. The exact visual design (horizontal bars? radar chart? simple number grid?) should be decided during implementation based on what fits the existing UI style.
