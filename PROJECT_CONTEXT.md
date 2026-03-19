# LinkedIn Job Tracker - Full Project Context

## Summary

This is a fully automated, AI-powered job hunting system I built from scratch that continuously scrapes LinkedIn for job postings, uses AI to filter and rank them against my resume and preferences, and presents the best matches through a custom web dashboard. The entire system runs locally on my machine with no cloud infrastructure - just a Node.js backend, SQLite database, and a browser automation engine.

The core idea: instead of manually scrolling through LinkedIn dozens of times a day, I built an autonomous agent that watches LinkedIn 24/7, intelligently filters out irrelevant postings using a multi-layer AI pipeline, deeply analyzes the remaining jobs with a 16-dimension scoring system, and sends me Telegram notifications when a high-priority opportunity appears. It doesn't require a LinkedIn login for scraping - it uses only public job search pages, with anti-detection measures to avoid being blocked.

This isn't a simple scraper. It's a multi-process system with three independent agents (scraper, enricher, applicant filter), a full web dashboard with analytics, a built-in AI chat assistant for drafting application responses, and a sophisticated scoring engine that weighs 16 different dimensions to produce a 0-100 match score for every job. The system processes hundreds of jobs per day and has saved me significant time by automating the most tedious parts of the job search.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript (strict mode, ES2022 target) |
| **Runtime** | Node.js |
| **Web Framework** | Express.js |
| **Database** | SQLite via Prisma ORM |
| **Browser Automation** | Playwright with stealth plugin (anti-detection) |
| **AI Model** | NVIDIA API (Kimi K2.5 model via OpenAI-compatible SDK) |
| **Templating** | EJS (server-rendered HTML) |
| **Charts** | Chart.js (analytics dashboard) |
| **PDF Parsing** | pdf-parse (resume extraction) |
| **Notifications** | Telegram Bot API |
| **Logging** | Winston (structured, rotating file logs) |
| **Dev Tools** | tsx (TypeScript execution), Prisma CLI |

---

## Features

### 1. Automated LinkedIn Scraping (No Login Required)

The scraper continuously monitors LinkedIn's public job search pages for new postings matching configured keywords. It runs on a configurable interval (default: every 2 minutes) and processes all results for each keyword.

**How it works:**
- Launches a headless browser with Playwright and anti-detection stealth plugins
- Constructs LinkedIn search URLs with time filters (`f_TPR=r600` for jobs posted in the last 10 minutes)
- Scrolls the full search results page to load all job cards (100-170 per keyword)
- Uses LinkedIn's internal `seeMoreJobPostings` API to load additional batches beyond the initial page
- Extracts job data from each card: title, company, location, posting time, LinkedIn job ID
- Parses relative time text ("37 minutes ago", "2h", "just now") into numeric values for filtering

**Why scroll everything?** LinkedIn's "most recent" sort is unreliable - recent jobs can appear anywhere in the results list, so the scraper loads all cards and filters by parsed time.

### 2. Multi-Layer AI Filtering Pipeline

Before any job reaches the dashboard, it passes through 6 filtering layers that progressively eliminate irrelevant postings. This is the core intelligence of the system.

**Layer 1a - Keyword Blacklist (zero cost):** Regex-based title matching against configured exclusion keywords. Handles special characters (C++, .NET) with substring fallback.

**Layer 1b - Company Blacklist (zero cost):** Rejects jobs from known spam aggregator companies (remotehunter, jobright.ai, wire).

**Layer 1c - Unpaid Filter (zero cost):** Rejects titles containing "unpaid", "volunteer", "no pay", "uncompensated".

**Layer 2 - Seniority Level Filter (zero cost):** Rejects titles with seniority indicators (III, IV, V, Senior, Staff, Principal, Lead, Director, Architect) that don't match the target seniority level.

**Layer 3 - Title Whitelist (zero cost, optional):** When configured, keeps only titles matching specific patterns.

**Layer 4 - Deduplication (zero cost):** Removes jobs with identical title + company combinations.

**Layer 5 - AI Batch Filter (one API call per keyword):** Sends all remaining jobs in a single API call with a strict relevance prompt. The AI evaluates each title against the candidate's profile, tech stack, and career goals. Uses a fail-closed approach - if the AI call fails, all jobs are rejected (they'll reappear in the next cycle). The prompt includes 7 explicit rejection categories and 5 acceptance categories with detailed seniority rules.

**Layer 6 - Database Dedup:** Batch query to filter out jobs already in the database.

### 3. Deep Job Enrichment with AI Analysis

A separate enrichment agent picks up saved jobs and performs deep analysis by visiting the full job detail page on LinkedIn.

**Detail page scraping extracts:**
- Full job description (using 4 fallback extraction strategies for LinkedIn's varying page structures)
- Company information
- Hiring team / contact people (from profile links)
- Applicant count (via text scanning)
- Metadata: seniority level, employment type, job function
- External apply links

**AI analysis produces:**
- Dealbreaker detection (seniority too high, clearance required, wrong tech domain, experience gap too large)
- 10 AI-scored dimensions (0-10 each): tech stack fit, role type match, AI/ML relevance, full-stack breadth, product ownership signals, company stage fit, growth potential, description quality, posting freshness, poster role quality
- Extracted signals: work arrangement, application method, urgency indicators, founding role, recent funding, DM invitation, staffing agency detection, ghost listing signals, repost detection
- Human-readable analysis: match reason, key matches, action items, red flags

### 4. 16-Dimension Hybrid Scoring Engine

Every enriched job gets a 0-100 composite score calculated from 16 weighted dimensions that combine AI assessments with deterministic signals.

**AI-scored dimensions (10):** Tech stack fit, role type match, AI/ML relevance, full-stack breadth, product ownership, company stage, growth potential, description quality, posting freshness, poster role.

**Deterministic dimensions (6):** Experience match, seniority alignment, remote position, applicant competition, direct contact availability, application method.

**Bonus modifiers:** Urgency signal (+5), founding role (+5), entry level (+4), recent funding (+3), DM invitation (+3), exact stack match (+3).

**Penalty modifiers:** Staffing agency (-8), high applicants (-5), ghost listing (-5), repost (-3).

**Dealbreakers override the score to 0**, regardless of other dimensions.

**Priority assignment:** Urgent (85+ with urgency signal), High (75+), Normal (50+), Low (<50).

### 5. Web Dashboard

A full-featured web dashboard built with Express and server-rendered EJS templates.

**Dashboard Home:** Summary statistics cards with SVG sparkline charts (total jobs, new jobs, applied/accepted count, enrichment queue). Job cards grid filtered by status with priority color coding.

**Jobs Board (Kanban-style):** Split-pane master/detail layout. Left panel shows a scrollable job list with score badges and priority indicators. Right panel shows full job details including score breakdown visualization, action items, red flags, contact people, and the integrated AI chat. Includes a sort/filter toolbar (by date, score, priority, company, enrichment status, dealbreaker presence).

**Analytics Dashboard:** Daily application goal tracker with circular progress ring. Chart.js visualizations for applications per day, jobs scraped per day, and rejections per day. Configurable period selector (7-90 days).

**Control Panel:** System health status bar with 5 indicators. Start/stop controls for all three agents (scraper, enricher, applicant filter) with live log viewers. Scraper configuration (interval, headless mode). Telegram notification testing. LinkedIn session status.

**Settings Page:** API key configuration, search keywords and locations, profile preferences (remote only, company size, tech stack, seniority targets, title exclusions/inclusions, salary, dealbreakers), resume upload.

**Profile Page:** Personal information with inline auto-save, work experience CRUD, education CRUD, skills management (categorized: language, frontend, backend, database, cloud, devops, AI/ML, tools, soft skills), document management.

### 6. Built-in AI Chat Assistant

Each job on the dashboard has an integrated AI chat panel that acts as a job application assistant. It operates in three modes:

**Application Question Mode:** Directly answers application form questions (e.g., "Why are you interested in this role?") in first person, 2-4 sentences, drawing from the candidate's full profile and the specific job details.

**Outreach Message Mode:** Generates concise 5-line outreach emails/InMails with strict formatting rules (one company per message, no tech stack dumps, mandatory portfolio link).

**General Question Mode:** Answers questions about the job, company, or application strategy.

The chat system uses in-memory session storage with 30-minute TTL, 40-message history limit, and full context awareness (candidate profile, job details, match score, action items, red flags).

### 7. Telegram Notifications

When the enrichment agent identifies a high-priority job (score >= 85), it sends a Telegram notification. The notification message is AI-generated to sound like a friend texting about the opportunity - casual, excited, with action items woven in naturally. Includes an apply link. Falls back to a structured template if the AI generates a confused or malformed response. Configured via bot token and chat ID in environment variables.

### 8. Anti-Detection & Stealth

The scraper uses extensive measures to avoid LinkedIn's bot detection:

- **Playwright with stealth plugin:** Patches WebGL, navigator, chrome object, permissions
- **Fingerprint randomization:** 8 desktop + 4 mobile user agents, 5 desktop + 4 mobile viewport sizes, randomly selected per launch
- **Human-like timing:** Randomized delays for navigation (2-5s), clicks (1-3s), scrolling pauses (3-5s), API pagination (1-2.5s)
- **Modal dismissal:** Automatic detection and dismissal of LinkedIn login prompts, auth walls, and blocking overlays
- **Dual browser context:** Clean (no-cookie) context for search (respects URL time filters), authenticated context for apply link extraction

### 9. Applicant Count Filter

A dedicated one-shot agent that checks all "new" jobs for applicant count and auto-rejects jobs with 100+ applicants. Launched on-demand from the control panel.

### 10. Spam Company Detection

Background worker (runs every 2 minutes) that identifies companies with 5+ "new" job postings and auto-rejects them as likely spam or mass-posting aggregators.

### 11. Resume Processing

Uploaded resume PDFs are parsed with `pdf-parse` to extract text. The text is then processed by the AI model to generate a structured profile summary (skills, experience, education, achievements, career goals, preferences). This summary is cached in the database and used as context for all AI filtering and analysis operations.

### 12. Settings Import/Export

All application settings can be exported as a JSON file and imported on another instance, enabling easy backup and migration of the full configuration.

---

## Architecture

### Multi-Process Design

The application runs as multiple independent processes that communicate exclusively through the shared SQLite database:

**Process 1 - UI Server** (`npm run dev`): Express server on port 3000 serving the dashboard, handling settings, managing agent lifecycles. Runs background tasks: rejected job cleanup (every 2h), spam company detection (every 2m), chat session cleanup (every 5m).

**Process 2 - Scraper Agent** (`npm run agent`): Long-running process with per-keyword schedulers running on configurable intervals. Each keyword gets its own independent scrape cycle. Writes PID to database for liveness tracking. Handles SIGTERM gracefully.

**Process 3 - Enricher Agent** (`npm run enricher`): Long-running process that picks up pending jobs from the database queue, scrapes full detail pages, runs AI analysis, calculates scores, and sends notifications. Restarts the browser every 50 jobs to prevent memory leaks.

**Process 4 - Applicant Filter** (on-demand): One-shot process that checks applicant counts and rejects high-competition jobs.

**Process Management:** The UI spawns agents as detached child processes (`child_process.spawn` with `detached: true`). Agent liveness is checked by probing stored PIDs with `process.kill(pid, 0)`. Stale PIDs from crashed processes are automatically cleaned up.

### Database Schema (9 Models)

**Job** - Primary data model with 30+ fields covering job details, AI matching scores, enrichment data, application tracking status, and contact information.

**ScraperState / EnricherState** - Singleton models tracking agent health (last run, error count, PID, processing flags).

**UserProfile** - Singleton with personal info, job preferences, AI-generated profile summary cache, and relations to work experience, education, skills, and documents.

**WorkExperience / Education / Skill / Document** - Profile sub-models for structured candidate data.

**AppSettings** - Singleton with search configuration, scraper settings, and UI preferences.

### Configuration System

Two-tier configuration: secrets (API keys, Telegram tokens) in `.env` file, everything else in the SQLite database. Hot-reload capability - settings saved via the UI are immediately picked up by the UI process, and the scraper agent re-reads config at the start of each cycle.

### Error Handling & Resilience

- Consecutive error tracking with automatic 30-minute pause after 5 failures
- Stuck state recovery on startup (clears stale `isRunning` flags and PIDs)
- Browser restart every 50 enrichment jobs to prevent memory leaks
- AI call timeouts (60s filter, 90s enrichment, 30s chat)
- Fail-closed AI filtering (rejected jobs reappear next cycle)
- Graceful shutdown with SIGTERM handling (finishes current work, cleans up)
- SIGKILL fallback for unresponsive agents

---

## Development Journey

### Phase 1: Foundation (Initial Commit)
Started with the core scraper pipeline: Playwright browser automation to scrape LinkedIn's public job search pages, basic AI filtering with the Anthropic SDK, SQLite database with Prisma, and a minimal Express dashboard to view results. The initial goal was simple - automate the most tedious part of job searching: scrolling through LinkedIn.

### Phase 2: AI Model Migration
Migrated from the Anthropic SDK to the OpenAI-compatible SDK targeting NVIDIA's API with the Kimi K2.5 model. This was a strategic decision for cost efficiency while maintaining quality - the OpenAI SDK provides a standardized interface that made the switch seamless.

### Phase 3: Authenticated Scraping
Added LinkedIn cookie-based authentication to access richer job data, particularly external apply links that aren't available on public pages. Implemented a dual browser context strategy - clean context for search (because authenticated LinkedIn ignores URL time filters) and authenticated context for detail page access.

### Phase 4: Profile System & Process Separation
Built the full profile management system (personal info, work experience, education, skills, documents) and separated the application into independent processes. The UI server and scraper agent became separate processes communicating through the database. Added the auto-apply foundation and improved the dashboard with better job cards and status tracking.

### Phase 5: Enrichment Pipeline
Created the enrichment agent as a third process that deep-dives into each job. Built the detail page scraper with 4 fallback extraction strategies for LinkedIn's varying HTML structures. Added AI-powered job analysis that produces dealbreaker detection, dimensional scoring, and human-readable insights.

### Phase 6: UI Overhaul & Notifications
Restructured the entire UI with a persistent sidebar navigation, added the Telegram notification system with AI-generated casual messages, and migrated all configuration from environment variables to the database for easier management through the UI.

### Phase 7: Scoring Engine
Built the 16-dimension hybrid scoring engine that combines 10 AI-scored dimensions with 6 deterministic signals, plus bonus/penalty modifiers and dealbreaker overrides. This replaced the simple pass/fail filtering with nuanced 0-100 scores and priority levels (urgent/high/normal/low).

### Phase 8: Chat Assistant & Scraper Overhaul
Added the built-in AI chat assistant for drafting application responses directly from the job detail view. Overhauled the scraper to use LinkedIn's internal pagination API for loading additional results. Built the kanban-style jobs board with split-pane master/detail layout.

### Phase 9: Background Workers & Refinements
Added the spam company detector (auto-rejects companies mass-posting 5+ jobs), rejected job cleanup worker, and unauthenticated detail scraper mode with retry logic. Refined the chat system with intent detection and session management.

### Phase 10: Analytics & Polish
Built the analytics dashboard with daily application goal tracking, Chart.js visualizations, and period selection. Added the sort/filter toolbar to the jobs board. Implemented the 100+ applicant auto-rejection feature and relative time display on job cards. Fine-tuned AI prompts to prioritize React Native mobile roles and reject native iOS/Android positions.

---

## Key Technical Decisions & Why

**Why no LinkedIn login for scraping?** Public pages provide enough data for the initial filter. Login adds detection risk and credential management complexity. The authenticated context is only used for apply link extraction after a job passes all filters.

**Why fail-closed AI filtering?** If the AI model is down or returns garbage, it's safer to reject all jobs (they'll reappear in the next scrape cycle) than to flood the dashboard with unfiltered noise.

**Why separate processes instead of one monolith?** The scraper and enricher have very different resource profiles and failure modes. A browser crash in the enricher shouldn't take down the dashboard. Independent processes can be restarted individually without losing the other's state.

**Why SQLite instead of Postgres?** Single-user application running locally. SQLite is zero-configuration, embedded, and more than fast enough. Prisma provides the same DX regardless of database engine.

**Why server-rendered EJS instead of React/Vue?** The dashboard is a tool for one person, not a product for thousands. Server-rendered HTML with vanilla JS is simpler, faster to build, and has zero build step for the frontend.

**Why NVIDIA's Kimi K2.5?** Cost-effective with strong reasoning capabilities. The OpenAI-compatible API means the model can be swapped without code changes.

**Why a 16-dimension scoring system?** Simple pass/fail filtering loses nuance. A multi-dimensional score lets me see *why* a job ranked high or low, which dimensions contributed, and make informed decisions rather than binary keep/reject.

---

## What I Learned Building This

- **Browser automation at scale** requires extensive anti-detection: stealth plugins, fingerprint randomization, human-like timing, and modal dismissal
- **AI prompt engineering** for structured output: getting reliable JSON responses requires explicit format specifications, examples, and fail-safe parsing
- **Multi-process Node.js architecture** with process spawning, PID tracking, graceful shutdown, and inter-process coordination through a shared database
- **LinkedIn's internal APIs** and DOM structure (SDUI components, virtual scrolling, varying page layouts that require multiple extraction strategies)
- **Resilient system design**: error budgets, circuit breakers (pause after N failures), stuck state recovery, stale PID cleanup, and fail-closed vs fail-open strategies
- **Real-time web UI** with server-sent data, auto-refreshing status indicators, inline editing, and chart visualization
- **AI system design**: batch processing (one API call for many jobs), prompt chaining (filter -> enrich -> score -> notify), and graceful degradation when AI calls fail
- **Database-as-message-queue** pattern: using SQLite tables to coordinate work between independent processes without a dedicated message broker
