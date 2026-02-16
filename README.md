# LinkedIn Job Tracker — AI-Powered Agent

An automated AI agent that continuously scrapes LinkedIn for new job postings, uses Claude AI to filter them based on your resume and preferences, and saves relevant matches to a local database with a web dashboard for review.

## What It Does

1. **Scrapes LinkedIn** — Runs on a configurable interval (default: every 2 minutes), scanning public LinkedIn job search pages for new postings. No LinkedIn login required.
2. **AI Filtering** — Sends discovered jobs to Claude (Anthropic API) in batches. Claude compares each job title and company against your resume and preferences, filtering out irrelevant matches instantly.
3. **Saves Relevant Jobs** — Stores matching jobs in a local SQLite database, automatically deduplicating against previously seen postings.
4. **Web Dashboard** — Provides a local web UI to browse, review, and track application status for every saved job.

## Features

- Stealth browser automation with anti-detection (randomized user agents, viewports, human-like delays)
- Batch AI filtering — one API call per keyword search, not per job
- Resume PDF upload and AI-generated profile summary (cached after first run)
- Configurable search keywords, locations, and geo filters
- Job status tracking: New → Reviewed → Applied → Rejected
- Notes on individual jobs
- Auto-pause after 5 consecutive scraper errors (resumes after 30 minutes)
- Stuck-state recovery on startup
- Logging to `logs/app.log` and `logs/error.log`
- Settings import/export via JSON
- Prisma Studio for direct database access

## Prerequisites

- **Node.js** v18 or higher
- **npm**
- An **Anthropic API key** ([get one here](https://console.anthropic.com/))

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up the Database

```bash
npm run prisma:generate
npm run prisma:migrate
```

### 3. Create Your `.env` File

Copy the example and add your API key:

```bash
cp .env.example .env
```

Then edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

This is the only secret stored in `.env`. All other settings live in `data/settings.json`.

### 4. Create Your `settings.json`

Copy the example settings file:

```bash
cp data/settings.example.json data/settings.json
```

This file holds all app configuration (search keywords, preferences, scraper options). You can edit it manually or through the web UI in the next step.

### 5. Configure via the Web UI

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000/setup](http://localhost:3000/setup) in your browser. From there you can:

- Upload your resume (PDF)
- Set job search keywords and locations
- Configure your profile preferences (remote work, company size, tech stack, seniority)
- Set dealbreakers and exclusion keywords
- Adjust scraper timing and behavior

Once you save your settings, the scraper starts running automatically on the configured interval.

## Running

| Command | Description |
|---|---|
| `npm run dev` | Start in development mode (TypeScript, auto-reload) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run the compiled production build |
| `npm run ui` | Start only the web UI (no scraper) |
| `npm run scrape` | Run the scraper once manually |
| `npm run prisma:studio` | Open Prisma Studio (database GUI) |

## Project Structure

```
job-tracker/
├── src/
│   ├── index.ts              # Entry point — starts UI + scraper scheduler
│   ├── config.ts             # Loads and manages settings
│   ├── scheduler.ts          # Scraper scheduling loop
│   ├── logger.ts             # Winston logging setup
│   ├── scraper/
│   │   ├── linkedin-scraper.ts   # Core LinkedIn scraping logic
│   │   ├── stealth-browser.ts    # Anti-detection browser setup
│   │   ├── anti-detection.ts     # Randomization utilities
│   │   └── selectors.ts         # LinkedIn DOM selectors
│   ├── ai/
│   │   ├── job-matcher.ts       # AI job relevance filtering
│   │   ├── resume-processor.ts  # Resume parsing + profile summary
│   │   └── prompts.ts          # Claude prompt templates
│   ├── database/
│   │   ├── client.ts           # Prisma client
│   │   └── queries.ts          # Database operations
│   └── ui/
│       ├── server.ts           # Express web server
│       ├── routes.ts           # Dashboard routes
│       ├── setup-routes.ts     # Setup/config routes
│       └── views/              # EJS templates + CSS
├── data/
│   ├── settings.example.json   # Template config (committed)
│   ├── settings.json           # Your local config (not committed)
│   ├── resume.pdf              # Your uploaded resume
│   └── profile-summary.json    # Cached AI profile summary
├── prisma/
│   ├── schema.prisma           # Database schema
│   └── dev.db                  # SQLite database
├── logs/                       # App and error logs
├── .env                        # API key (not committed)
└── package.json
```

## Tech Stack

- **TypeScript** + **Node.js**
- **Playwright** with stealth plugin for web scraping
- **Anthropic Claude** for AI-powered job filtering
- **SQLite** + **Prisma ORM** for data storage
- **Express** + **EJS** for the web dashboard
- **Winston** for logging
