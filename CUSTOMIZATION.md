# Customizing Job Tracker for Your Profile

This agent is built as a personal tool — the AI prompts, scoring weights, and filtering logic are tuned for a specific person's job search. It works for **any field** (engineering, marketing, finance, design, operations, sales, healthcare — anything on LinkedIn), but the current codebase has one person's priorities hardcoded. If you've cloned this repo, you'll need to adapt it to match your own background and career goals.

**The fastest way to do this:** Open this project in [Claude Code](https://claude.ai/code) and tell Claude about yourself. It will read this file and know exactly what to change. For example:

> "I just cloned this project. I'm a marketing manager with 5 years of experience in B2B SaaS, looking for senior brand strategy roles. I'm based in Chicago and open to remote. Set this up for me."

> "I cloned this repo. I'm a financial analyst with 3 years in investment banking, looking for corporate finance or FP&A roles in New York. Help me configure it."

> "Set this project up for me — I'm a UX designer with 7 years of experience, targeting product design lead roles at mid-stage startups. I'm remote-only."

Claude will update every file listed below based on your profile. Then you just need to set up your `.env`, run the setup UI to upload your resume and keywords, and start the agents.

---

## What You Configure via the UI (no code changes)

These settings live in the database and are editable at `http://localhost:3000/setup`:

- Resume PDF upload
- Search keywords and locations
- Target seniority levels
- Preferred skills and tools
- Title exclusion/inclusion keywords
- Dealbreakers
- Job search description (free-text)
- Mission statement and urgency signals
- Remote/relocation/contract/visa preferences
- Daily application goal and timezone

**Do this first.** Many of the AI prompts pull from these database fields dynamically. But some things are hardcoded in the source and need code changes — that's what the rest of this file covers.

---

## What Needs Code Changes

### 1. Hardcoded Location and Visa Status

**File:** `src/ai/prompts.ts` — `buildEnrichmentAnalysisPrompt()` (lines ~210-214)

The enrichment prompt contains hardcoded candidate facts:

```typescript
- Current location: San Jose, CA (San Francisco Bay Area)
- Visa status: Has green card (does NOT need sponsorship)
- Remote preference: Remote is preferred but NOT critical. Hybrid or onsite roles
  in the Bay Area (San Jose, San Francisco, South Bay, Peninsula, East Bay) are
  perfectly fine. Do NOT penalize Bay Area hybrid/onsite roles.
```

**What to change:** Replace with your location, visa status, and remote preference. These are passed to the AI as ground truth — they affect scoring, red flag generation, and dealbreaker detection.

Also update the red flags section (lines ~317-318) which references the same location/visa info:

```typescript
- On-site, hybrid, or relocation requirement (candidate lives in San Jose/Bay Area
  and is willing to relocate ANYWHERE in the US)
- Visa sponsorship not offered (candidate has a GREEN CARD and does NOT need sponsorship)
```

---

### 2. Role Category Preferences in AI Filter

**File:** `src/ai/prompts.ts` — `buildRelevanceFilterPrompt()` (lines ~105-119)

The batch relevance filter has hardcoded rules about which role types to accept/reject. The current setup is configured for software engineering roles — it accepts titles like "Software Engineer" and rejects things like "Sales Engineer" or "QA Engineer."

**What to change:** Rewrite the ACCEPT and REJECT category lists to match your field entirely.

- **Marketing example:** ACCEPT "Marketing Manager", "Brand Strategist", "Growth Lead". REJECT "Marketing Intern", "Event Coordinator", "PR Specialist" (if those aren't relevant to you).
- **Finance example:** ACCEPT "Financial Analyst", "FP&A Manager", "Investment Associate". REJECT "Accounts Payable Clerk", "Bookkeeper", "Tax Preparer."
- **Design example:** ACCEPT "Product Designer", "UX Lead", "Design Director". REJECT "Graphic Designer", "Print Designer", "UI Intern."

The rules in this prompt (rules 1-7) define what the AI considers relevant vs. irrelevant. Rewrite them from scratch for your field — they are the single biggest factor in filtering quality.

---

### 3. AI Relevance Scoring Rubric

**File:** `src/ai/prompts.ts` — `buildEnrichmentAnalysisPrompt()` (lines ~270-281)

The enrichment scoring has 10 dimensions, each with a rubric the AI follows. Every dimension's 0-10 scale is written with specific criteria — and those criteria are currently tailored for one person's priorities. You should rewrite each rubric to match your own field and preferences.

Key dimensions to rewrite:

- `techStack` (dimension 1) — Currently references React/Next.js/Node/Python/FastAPI. Replace with your own core skills and tools (e.g., "Salesforce, HubSpot, Google Analytics" for marketing, "Excel, SQL, Bloomberg Terminal" for finance, "Figma, Sketch, Framer" for design).
- `roleType` (dimension 2) — Currently biased toward "building products." For non-engineering fields, rewrite to reflect what you value (e.g., strategy vs. execution, client-facing vs. internal, creative vs. analytical).
- `aiRelevance` (dimension 3) — This is the "domain fit" dimension. Currently checks for AI/ML and mobile development relevance. **Rename and rewrite this entirely** for your priority domains (e.g., "brandRelevance" for marketing, "industryFit" for finance).
- `fullStackBreadth` (dimension 4) — Currently measures frontend+backend breadth. For non-engineering roles, rewrite to measure scope/breadth relevant to your field (e.g., "cross-functional scope" or "strategic breadth").
- `productOwnership` (dimension 5) — Currently values "ship the product, work with founders." Rewrite to reflect ownership in your field (e.g., "own the campaign end-to-end" or "own the P&L").
- `companyStage` (dimension 6) — Currently biased toward early-stage startups. If you prefer large enterprises, Fortune 500s, or agencies, flip the scoring.
- `posterRole` (dimension 10) — Currently: founder/CTO = 10. Adjust based on who you'd want to hear from (e.g., VP Marketing = 10, external recruiter = 3).

---

### 4. Scoring Dimension Weights

**File:** `src/ai/scoring-engine.ts` — `DIMENSION_WEIGHTS` (lines ~85-102)

The final 0-100 score is a weighted sum of 16 dimensions. Current weights:

| Dimension | Weight | What it means |
|---|---|---|
| `aiRelevance` | 0.14 | Highest — domain fit matters most |
| `techStack` | 0.12 | Skills/tools overlap |
| `companyStage` | 0.12 | Company size preference |
| `roleType` | 0.10 | Type of work (strategic vs. tactical, creative vs. analytical, etc.) |
| `experienceMatch` | 0.08 | Years of experience alignment |
| `productOwnership` | 0.07 | End-to-end ownership |
| `growthPotential` | 0.06 | Learning and career growth |
| `fullStackBreadth` | 0.05 | Scope/breadth of role |
| `seniorityAlignment` | 0.05 | Seniority level match |
| `remotePosition` | 0.05 | Remote/hybrid/onsite preference |
| `applicantCompetition` | 0.04 | Fewer applicants = better odds |
| `descriptionQuality` | 0.03 | Well-written listings preferred |
| `directContact` | 0.03 | Direct outreach opportunity |
| `posterRole` | 0.02 | Who posted (hiring manager vs. recruiter) |
| `postingFreshness` | 0.02 | Fresh > stale |
| `applicationMethod` | 0.02 | Easy Apply preferred |

**What to change:** Adjust weights to reflect what matters to you. If you prefer large companies, lower `companyStage` or flip its rubric. If remote work is a dealbreaker, raise `remotePosition`. If industry fit matters more than skills overlap, raise `aiRelevance` and lower `techStack`. Weights must sum to 1.0.

---

### 5. Priority Thresholds

**File:** `src/ai/scoring-engine.ts` (lines ~337-340)

```typescript
if (finalScore >= 85 && urgencySignalMatched) return 'urgent';
if (finalScore >= 75) return 'high';
if (finalScore >= 50) return 'normal';
return 'low';
```

**What to change:** Adjust these thresholds based on how selective you want to be. Lower them if you're getting too few results; raise them if you're getting too many.

---

### 6. Dealbreaker Thresholds

**File:** `src/ai/scoring-engine.ts` (lines ~115-117)

```typescript
experienceMinYears >= 6        // Hard reject if job requires 6+ years
experienceMinYears - candidateYears >= 3  // Hard reject if gap is 3+ years
```

**What to change:** If you have 10 years of experience, the `>= 6` threshold makes no sense — raise it or remove it. If you have 1 year of experience, you might lower the gap threshold. Adjust based on how far above your actual experience level you're willing to reach.

---

### 7. Experience Matching Curve

**File:** `src/ai/scoring-engine.ts` (lines ~144-151)

```typescript
if (minRequired <= 2) return 10;   // 0-2 years required = perfect
if (minRequired <= 3) return 9;
if (minRequired <= 4) return 8;
if (minRequired <= 5) return 6;
return 3;                          // 6+ years = poor match
```

**What to change:** This is calibrated for someone with ~2 years of experience. If you have more experience, shift these bands up. Someone with 10 years would want `<= 8` to score 10 and `<= 12` to still score well. Match the curve to your actual experience level.

---

### 8. Seniority Alignment Scoring

**File:** `src/ai/scoring-engine.ts` (lines ~154-161)

```typescript
'entry level' or 'internship': 9   // Currently targets entry-level
'associate': 9
'mid-senior level': 3              // Mid-senior penalized
'director' or 'executive': 1
```

**What to change:** Flip these to match your target seniority. If you're looking for senior roles, `mid-senior level` should score 9-10 and `entry level` should score low.

---

### 9. Bonus and Penalty Points

**File:** `src/ai/scoring-engine.ts` (lines ~213-266)

Bonuses (added to final score):
- Urgency signal matched: +5
- Founding role: +5
- Recent funding: +3
- DM invitation: +3
- Exact stack match (4+ techs): +3
- Entry-level role: +4

Penalties (subtracted from final score):
- Staffing agency: -8
- High applicant count (500+): -5
- Ghost listing signals: -5
- Repost signal: -3

**What to change:** The `isEntryLevel: +4` bonus only makes sense for entry-level candidates. Remove or invert it for senior roles. Adjust other bonuses/penalties based on what you value.

---

### 10. Applicant Count Auto-Rejection

**File:** `src/enricher-agent.ts` (line ~226)

```typescript
if (applicantCountNum !== null && applicantCountNum >= 100)  // Auto-reject 100+ applicants
```

**What to change:** This automatically rejects jobs with 100+ applicants before AI scoring. Raise or remove this threshold if you don't mind competition, or lower it if you want to focus only on low-competition postings.

---

### 11. Telegram Notification Threshold

**File:** `src/enricher-agent.ts` (lines ~378-379)

```typescript
if (computedScore >= 85 && !analysis.aiFailed && isTelegramConfigured())
```

**What to change:** Only jobs scoring 85+ trigger Telegram alerts. Lower this if you want more notifications.

---

### 12. Blacklisted Companies

**File:** `src/ai/job-matcher.ts` (line ~80)

```typescript
const BLACKLISTED_COMPANIES = ['remotehunter', 'jobright.ai', 'wire'];
```

**What to change:** Add or remove companies. These are job-board spam aggregators that repost other companies' listings.

---

### 13. Exact Skills/Tools Count Reference

**File:** `src/ai/prompts.ts` (line ~293)

```typescript
exactStackCount: count of candidate's core technologies
(React, Next.js, Node, Python, FastAPI) explicitly listed in the description (0-5+)
```

**What to change:** Replace with your core skills and tools so the AI counts the right matches. For marketing this might be "HubSpot, Google Analytics, Marketo, SEMrush, Tableau". For finance: "Excel, SQL, Python, Bloomberg, PowerBI". For design: "Figma, Sketch, Framer, Adobe CC, Webflow".

---

### 14. Remote Position Scoring

**File:** `src/ai/scoring-engine.ts` (lines ~177-188)

```typescript
'remote': 10
'hybrid': 8
'onsite': willingToRelocate ? 5 : 3
'unknown': 7
```

**What to change:** If remote work is a dealbreaker for you, make onsite score 0 and adjust. If you prefer onsite, flip the scoring.

---

## Summary: The Minimum Changes

If you're adapting this for yourself, the critical files are:

| File | What to change |
|---|---|
| `.env` | Your NVIDIA API key, Telegram credentials |
| UI at `/setup` | Resume, keywords, preferences, dealbreakers |
| `src/ai/prompts.ts` | Location, visa status, role category rules, scoring rubrics, skills/tools references |
| `src/ai/scoring-engine.ts` | Dimension weights, thresholds, bonuses, penalties, experience curves |
| `src/enricher-agent.ts` | Applicant count rejection threshold, Telegram notification threshold |
| `src/ai/job-matcher.ts` | Blacklisted companies |

The UI handles about 60% of personalization. The code changes handle the other 40% — mostly the AI prompt text and scoring math. The tool works for **any profession** — the current code just happens to be tuned for software engineering. Claude Code can rewrite the prompts and scoring for marketing, finance, design, operations, healthcare, legal, or any other field.

---

## Using Claude Code for Setup

### How it works

Open this project in [Claude Code](https://claude.ai/code) and tell it you want to set up the job tracker for yourself. Claude will read this file and then **interview you** — asking questions one by one to understand your background, field, preferences, and priorities. Once it has everything it needs, it will create a plan and update every hardcoded value across the codebase to match your profile.

You don't need to know which files to edit or what the scoring engine looks like. Just answer questions in plain language.

### What to say

Start with something like:

> "I just cloned this project. Help me set it up for my job search."

Claude will take it from there.

### The interview

Claude should ask about each of the following areas. You don't need to prepare answers — just have a conversation. Claude will ask follow-ups when it needs more detail.

**1. Your background**
- What field/industry are you in?
- What's your current or most recent job title?
- How many years of professional experience do you have?
- What are your core skills, tools, and competencies? (e.g., "Figma and design systems" or "financial modeling and Excel" or "React and Node.js" — whatever applies to your field)
- Any certifications, degrees, or credentials that matter for the roles you're targeting?

**2. What you're looking for**
- What job titles are you targeting? (list a few examples)
- What types of roles should be auto-rejected? (titles, categories, or keywords you never want to see)
- Are there specific industries or company types you prefer? (startups, enterprise, agencies, nonprofits, etc.)
- Are there industries or company types you want to avoid?
- What seniority level are you targeting? (entry, mid, senior, director, etc.)
- What does your ideal role look like? (strategic vs. hands-on, team size, scope of responsibility, etc.)

**3. Location and logistics**
- Where are you located?
- Are you open to remote, hybrid, onsite, or all three?
- If hybrid/onsite, what cities or regions are acceptable?
- Are you willing to relocate? If so, where?
- Do you need visa sponsorship?
- Are you open to contract/freelance work, or full-time only?

**4. Priorities and scoring**
- What matters most when evaluating a job? Rank or describe your top priorities. Examples:
  - Company stage (startup vs. enterprise)
  - Specific domain or industry fit
  - Skills/tools match
  - Growth potential and learning
  - Compensation
  - Work arrangement (remote, etc.)
  - Role scope and ownership
  - Who posted it (hiring manager vs. recruiter)
- What should trigger an "urgent" alert? (e.g., "dream company posted", "founding role", "perfect title match")
- What are your absolute dealbreakers? (e.g., "requires 10+ years", "security clearance", "unpaid")

**5. Thresholds and tuning**
- Should jobs with lots of applicants (100+, 500+) be auto-rejected or just scored lower?
- How selective should the AI filter be? (aggressive = fewer but more relevant results, loose = more results with some noise)
- Do you want Telegram notifications? If so, how urgent should a match be before it sends an alert?

### What Claude does after the interview

Once Claude has your answers, it will:

1. **Create a plan** listing every file and value it will change, with the old value and new value
2. **Ask you to approve** the plan before making any changes
3. **Update the codebase** — rewriting AI prompts, scoring rubrics, dimension weights, thresholds, bonuses, penalties, and dealbreaker logic across all files listed in this document
4. **Verify** that the changes are consistent (weights sum to 1.0, thresholds make sense for your experience level, etc.)

After that, you:

5. Run `npm run dev`, go to `http://localhost:3000/setup`
6. Upload your resume, set search keywords and locations, and fill in the UI-configurable preferences
7. Start the collector and enricher from the Control Panel

### The full list of files Claude will modify

| File | What changes |
|---|---|
| `src/ai/prompts.ts` | Location, visa status, remote preference, role accept/reject rules, scoring dimension rubrics, skills/tools references |
| `src/ai/scoring-engine.ts` | Dimension weights, priority thresholds, experience curve, seniority scoring, bonus/penalty values, dealbreaker thresholds, remote scoring |
| `src/enricher-agent.ts` | Applicant count auto-rejection threshold, Telegram notification score threshold |
| `src/ai/job-matcher.ts` | Blacklisted companies list |

Everything else (search keywords, resume, preferences, dealbreakers, mission statement, urgency signals) is configured through the UI at `/setup` — no code changes needed for those.
