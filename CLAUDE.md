# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An automated AI agent that continuously scrapes LinkedIn for job postings, uses AI (NVIDIA's Kimi K2.5 model) to filter them based on a resume and preferences, and saves relevant matches to a local SQLite database with a web dashboard for review. No LinkedIn login required - uses public job search pages.

## Development Commands

### Essential Commands
- `npm run dev` - Start in development mode (runs both UI server and scraper scheduler)
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run the compiled production build
- `npm run ui` - Start only the web UI server (no scraper) on port 3000
- `npm run scrape` - Run a single scrape cycle manually

### Database Commands
- `npm run prisma:generate` - Generate Prisma client after schema changes
- `npm run prisma:migrate` - Create and apply database migrations
- `npm run prisma:studio` - Open Prisma Studio GUI for database inspection

## Architecture

### Entry Point Flow
The application starts via `src/index.ts`:
1. Starts the UI server immediately (for setup access at `http://localhost:3000`)
2. Checks if the app has been configured (requires settings.json and resume.pdf)
3. Validates configuration (API key, search keywords)
4. Starts the scraper scheduler if configured

### Configuration System
**Two-tier configuration**:
- **Secrets** (API key) live in `.env` (not committed)
- **All other settings** live in `data/settings.json` (not committed, use `data/settings.example.json` as template)

The `config.ts` module:
- Loads settings from `data/settings.json` on startup
- Merges them with defaults for missing fields
- Provides `reloadConfig()` to hot-reload after settings changes
- `validateConfig()` checks for required fields (API key, keywords)

**Note**: The codebase currently references `ANTHROPIC_API_KEY` and Anthropic in the README, but the actual implementation uses `NVIDIA_API_KEY` and NVIDIA's API (see `config.ts:93-97`). This is an inconsistency to be aware of.

### Scraper Pipeline (Fast & Efficient)
The scraper (`src/scheduler.ts` + `src/scraper/linkedin-scraper.ts`) uses a **card-level** approach with no detail-page visits:

1. **Browser Launch**: Playwright with stealth plugin (anti-detection)
2. **Scroll Full Page**: Load ALL job cards (~100-170 per keyword) by scrolling to bottom
3. **Time Filter**: Keep only jobs posted ≤ `maxMinutesAgo` (default 10 minutes)
4. **AI Batch Filter**: ONE API call per keyword to filter irrelevant titles
5. **DB Dedup Check**: Batch query to filter out already-seen jobs
6. **Save**: Insert new relevant jobs with minimal data (no descriptions)

**Why scroll all cards?** LinkedIn's "sorted by most recent" is unreliable - recent jobs can appear anywhere in the list. The scraper loads everything, then filters by parsed time.

### AI Filtering Strategy
Located in `src/ai/job-matcher.ts`:

**Pre-filters (zero cost)**:
1. Hard keyword exclusion (`exclude_title_keywords`) - runs before AI
2. Deduplication (same title + company)

**AI call**: Batch relevance filter with strict prompt
- Sends all jobs in one call (not per-job)
- Prompt includes seniority targets, tech stack preferences, exclusion rules
- Returns array of relevant `linkedinIds`

**Profile summary**: `src/ai/resume-processor.ts` extracts skills/experience from uploaded resume PDF and caches it in `data/profile-summary.json`

### Database Schema
SQLite database via Prisma (`prisma/schema.prisma`):

**Job model**:
- `linkedinId` (unique) - primary dedup key
- Basic fields: title, company, location, link, postedDate
- AI fields: matchScore, matchReason, keyMatches (JSON string)
- Status tracking: status (new/reviewed/applied/rejected), notes
- Timestamps: createdAt, updatedAt

**ScraperState model** (singleton):
- Tracks scraper health: lastRunAt, lastSuccessAt, errorCount
- Prevents overlapping runs with `isRunning` flag
- Auto-pauses after 5 consecutive errors for 30 minutes

### UI Layer
Express server (`src/ui/server.ts`) with EJS templates:
- `/setup` route (`src/ui/setup-routes.ts`) - first-time configuration
  - Upload resume, set keywords, configure preferences
  - Saves to `data/settings.json`
  - Calls `reloadConfig()` to apply changes without restart
- Dashboard routes (`src/ui/routes.ts`) - job review, status updates, notes

### Anti-Detection
`src/scraper/anti-detection.ts` + `src/scraper/stealth-browser.ts`:
- Randomized user agents, viewports
- Human-like delays (configurable ranges)
- Playwright-extra with stealth plugin
- Modal dismissal (LinkedIn shows login prompts on public pages)

### Logging
Winston logger (`src/logger.ts`):
- Console output + file logging
- `logs/app.log` - combined logs
- `logs/error.log` - errors only

## Key Implementation Details

### Configuration Hot-Reload
When settings are saved via UI, the code calls `reloadConfig()` to update the running process without restart. The scheduler continues using old config until next cycle starts.

### Stuck State Recovery
On startup, `resetScraperStateOnStartup()` clears any stuck `isRunning=true` state from previous crashes.

### Time Parsing
`linkedin-scraper.ts:262-290` - Parses relative time text ("37 minutes ago", "1 hour ago") into numeric minutes for filtering.

### LinkedIn Job ID Extraction
Multiple patterns (`/jobs/view/(\d+)`, `currentJobId=(\d+)`, or any 8+ digit number) because LinkedIn uses different URL formats.

### Error Handling
The scraper tolerates individual card extraction failures but marks the cycle as failed if the browser crashes or network errors occur. After 5 consecutive failures, it pauses for 30 minutes.

## Common Workflows

### Adding a New Search Keyword
1. Edit `data/settings.json` manually, OR
2. Use the UI at `/setup` to add keywords and save

### Changing AI Model Parameters
Edit `config.ts:92-97` to adjust model, maxTokens, or temperature for NVIDIA API calls.

### Adjusting Scraper Speed
Edit `config.ts:104-114`:
- `intervalMinutes` - time between scrape cycles
- `maxMinutesAgo` - only save jobs posted within this window
- `navigationDelay`, `clickDelay` - anti-detection timing

### Testing AI Filters Without Full Scrape
Use `npm run scrape` to run one cycle manually. Check logs for filter metrics (keyword filter → dedup → AI filter → saved).

## File Locations
- `data/resume.pdf` - uploaded resume (not committed)
- `data/settings.json` - user configuration (not committed)
- `data/profile-summary.json` - cached AI resume summary (not committed)
- `prisma/dev.db` - SQLite database (not committed)
- `logs/` - Winston log files (not committed)

## Important Notes
- The scraper does NOT log into LinkedIn - uses only public job search pages
- LinkedIn may show login modals - these are automatically dismissed
- The "sorted by most recent" filter (`sortBy=DD`) is applied to the URL but LinkedIn's actual ordering is unreliable
- Job descriptions are NOT scraped in the current pipeline - only card-level data (title, company, time, link)
- `matchScore` and `matchReason` fields exist in the schema but are not populated in the current fast pipeline (defaulted to 0 and empty string)
