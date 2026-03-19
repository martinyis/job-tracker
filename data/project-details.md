# Project Technical Details

> Comprehensive technical context for all major projects. Use this to answer questions about tech stack, features built, architecture decisions, and technical experience.

---

## 1. Mudface / Nanu — AI Skincare Analysis Platform

**Role:** Solo Developer (Internship, started September 2025)
**What it is:** AI-powered skincare analysis and recommendation platform with a React Native mobile app, Next.js web platform, Django REST API backend, and custom ML model infrastructure.

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Mobile App | React Native 0.80, React 19, TypeScript, React Navigation 7 |
| Web Landing | Next.js 15, React 19, Tailwind CSS, Framer Motion |
| Web Dashboard | Next.js 14, React 18, MUI, Recharts, TanStack Query |
| Backend API | Django 5.2, Django REST Framework |
| Database | MongoDB (pymongo) |
| Cache / Queue | Redis + Celery (django-celery-beat) |
| Storage | AWS S3 (boto3) |
| Auth | JWT (HS256), Google OAuth, Apple OAuth |
| Push Notifications | Firebase Cloud Messaging (FCM) |
| Payments | Stripe (webhooks), Shopify (e-commerce) |
| AI / LLM | OpenAI API, Perplexity API |
| ML Models | Custom skin analysis models (wrinkle, acne, pigmentation, eyebag, face landmarks) hosted on GCP |
| Email | Mailgun + Gmail SMTP |
| Analytics Pixels | Reddit CAPI, TikTok Events API, LinkedIn Conversions, Google Tag Manager |
| OCR | react-native-text-recognition (on-device) |

### Features I Built

**Authentication:** Email/password signup with JWT tokens, Google Sign-In (OAuth), Apple Sign-In (OAuth), password reset flow via email, Terms of Service acceptance gate, automatic FCM push token registration.

**User Onboarding:** 3-step questionnaire (age, gender, skin concerns, skin type, budget, allergies). Editable profile with skin type, concerns, sensitivity, budget, reminder time. Fitzpatrick skin tone detection.

**Face Scanning & Skin Analysis:** Live camera capture using react-native-vision-camera with oval mask overlay. Photo import from camera roll with EXIF date preservation. Backend sends image to custom ML models for analysis. Metrics: wrinkle score, acne count + severity, pigmentation score, eyebag area, skin age. Percentile rankings against age-matched population. Segmented image overlay (color-coded regions). Both original and segmented images stored on AWS S3. Historical trends, photo gallery with calendar view, streak tracking.

**Product Scanning (OCR) — My Proudest Feature:** Camera capture of product ingredient labels. On-device OCR via react-native-text-recognition. Text normalization pipeline (lowercase, remove punctuation, collapse spaces). Backend fuzzy matching using FuzzyWuzzy algorithm against 1000+ product database. Fallback to Perplexity AI for semantic product identification. Manual product search as alternative. Products saved with tags (Morning, Evening) and categories (shelf, scanned, past).

**Product Database & Ingredients:** 1000+ products with brand, name, category, price, ingredients, usage instructions. Each ingredient has: common name, scientific name, safety tag (green/red/grey), benefits, rating (1-5), categories. Research papers linked to ingredients with key quotes, effects, side effects.

**Skin Match Scoring:** Algorithm scores each product 0-100 against user's skin profile. Factors: ingredient benefits, concerns, skin type compatibility, budget fit. Tiers: great_match, good_match, neutral, mixed, poor. Cached results, invalidated when profile changes.

**AI Consultation System:** Initial consultation requires 3+ scans, 1+ scanned product, complete profile. Sends profile + skin analysis + products to OpenAI/Perplexity. AI generates structured recommendations: products to stop (with reasons), tweak (modify usage), add (new products). Follow-up consultations calculate metric deltas and update recommendations. Multi-step UI flow: Welcome → Skin Baseline → Concerns → Loading → Changes → Stop/Tweak/Add → New Routine → Reminder → Confirmation.

**Daily Check-in System:** Rotating daily questionnaire (~15 topics: stress, sleep, events, etc.). Question types: checkbox, multiple choice, rating (1-5), free text. Optional selfie capture, product usage selection.

**Home Dashboard:** Skin scan calendar, latest analysis card, streak card, reward points, onboarding checklist, morning/evening routine display, pull-to-refresh.

**Push Notifications:** Firebase Cloud Messaging for remote push. Local notifications for foreground. Background message handling stored in AsyncStorage. Server-side reminder scheduling via Celery (checks every minute). Android notification channels, iOS permission flow.

**Payments & E-commerce:** Stripe webhook integration. Shopify product checkout. Shopping cart management. Promotion code tracking.

**Web Skin Analysis Flow:** Multi-step questionnaire (8-9 steps). Photo analysis using same ML models as mobile. Product recommendations. AI chatbot integration.

**Business/Brand Dashboard:** Statistics dashboard with charts (client count, gender, skin type, age demographics). Client management with advanced filtering. Bulk messaging/email to segments. Shopify order integration. Promotion campaign management.

**Marketing Attribution:** Reddit Conversions API, TikTok Events API, LinkedIn Conversions API, Google Tag Manager. Conversion tracking with click ID storage.

### Backend Architecture
Modular Django REST Framework: auth, user, analyze, photo, product, ingredient, consultation, checkin, chatbot, business, shopify, tracking, search, support modules. 13+ MongoDB collections. Background tasks via Celery + Redis. Image processing pipeline: capture → compress to 200KB → base64 → ML inference on GCP → segmented overlay → S3 upload. bcrypt password hashing, JWT auth, admin decorators.

### Scale
1,000+ report generations on web platform. 1,000+ products in database. 5+ ML models. 3 platforms served. 70+ major features across mobile and backend.

---

## 2. TaskMind — B2B SaaS Company Intelligence Platform

**Role:** Team Lead (team of 4 developers)
**What it is:** AI-powered company intelligence, market research, and sales enablement platform for business development teams. Live at taskmind.pro.

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 13 (Pages Router), React 18, JavaScript, MUI v7, Tailwind CSS v3, Emotion, Framer Motion, D3.js, TanStack React Query v5 |
| Backend | Express.js 4, TypeScript, Node.js 20 |
| Database | MongoDB Atlas, Mongoose 8 |
| Auth | JWT (90-day expiry), bcryptjs (12 rounds) |
| PDF Generation | Puppeteer (headless Chrome), PDFKit |
| Email | Nodemailer (Gmail SMTP) |
| Payments | Stripe v18 (subscriptions, webhooks, customer portal) |
| AI Providers | Perplexity AI (sonar model), Google Gemini, OpenRouter |
| Contact Discovery | Apollo.io API |
| Geocoding | OpenCage API |
| Hosting | Google App Engine (backend), Vercel (frontend) |
| CI/CD | Google Cloud Build |

### Features I Built / Oversaw

**AI Company Intelligence Reports:** Users search for any company, backend uses Perplexity AI to find matches. Generates 25+ modular report sections (Financial Health, Competitive Landscape, Department Mapping, etc.) using Gemini and Perplexity in parallel. Asynchronous generation with frontend status polling. PDF export via Puppeteer headless Chrome rendering. Email notification on completion.

**Vertical Market Reports:** Market landscape scanner with geographic filtering (city/radius via OpenCage geocoding), sector, company size, funding stage, growth signals (HIRING, EXPANDING, PARTNERSHIPS, ACQUISITIONS), customer type (B2B/B2C/GOV), technology focus, ESG criteria. Two-phase generation: company list → individual mini-reports.

**AI Market Insights (Automated):** InsightScheduler runs every 6 hours (4x/day). Generates categorized insights per company: Market, Competitive, Consumer, Product, Geographic. Each insight has header, summary, detail, impact tag, category, source URLs. In-app notification + email alert.

**Contact Discovery (Apollo.io):** Find decision-makers at target companies. Contacts filtered by job title relevance and location. Data includes: name, title, email, LinkedIn URL, phone, photo. 10 contacts per report limit. Team-wide visibility.

**AI Email Generation:** Personalized outreach emails contextualized with contact info + company research. Threading support for responses and follow-ups. Custom rewrite with notes (150/month limit). Full conversation history maintained.

**Strategy Node Tool (D3.js):** Interactive force-directed graph for go-to-market strategy building. Users link reports, insights, context files as nodes. D3.js force simulation with collision detection. Graph layout persisted to MongoDB (node positions saved). AI generates prospect companies from strategy context.

**Buying Committee Tracker (Kanban):** Kanban board for stakeholder relationship tracking. Stages: Not Contacted → Reached Out → Engaged → Champion. Stakeholder roles: Economic Buyer, Champion, Decision Maker, Technical Evaluator, Influencer, Blocker, End User. Drag-and-drop between stages.

**Company Identity Enrichment:** Auto-enriches company profile via Perplexity AI on creation. Populates: legal name, industry, revenue, funding, investors, valuation, growth rate, digital presence, competitors, risks, strengths, weaknesses.

**Team Management:** Email invitations with 6-digit activation codes (SHA-256 hashed). Team toggle for shared vs. personal data views. Lead/Contributor role system. Seat-based access control (1-25 users).

**Team Analytics Dashboard:** Member performance overview: report count, contact count, engagement level, last active. Monthly breakdowns. Active/inactive user tracking.

**Subscription & Billing (Stripe):** Seat-based pricing: $99.99/month base + $100/additional user. 25 distinct Stripe Price IDs. Stripe Checkout for payment. Webhooks for lifecycle events. Customer Portal for self-service. Usage limits enforced server-side, reset on new billing period. Promo code system with bcrypt-hashed one-time codes.

**Notifications:** In-app notifications with bell icon + unread count. Email notifications via Nodemailer. User-configurable preferences.

**Marketing Site:** Animated landing page with Framer Motion scroll-triggered animations, floating UI previews, company logo marquee. Pricing, solutions, contact, legal pages.

### Architecture
Monorepo: Next.js frontend (Vercel) + Express.js backend (Google Cloud App Engine). Controller → Service → Model pattern. Middleware chain: Auth → Subscription → Rate Limiting → Controller. In-process background scheduler (setInterval) for insights. Auto-scaling: min 1 instance, max 10, 65% CPU target.

### Scale
15+ MongoDB collections. 40+ API endpoints across 10 route groups. 20+ frontend pages. 6 external API integrations. 25+ AI report types. Seat-based pricing with 25 Stripe tiers.

---

## 3. Airfare — Flight Price Tracker & Search Engine

**Role:** Solo Developer (built in ~3 weeks, Feb 27 - Mar 18, 2026)
**What it is:** iOS mobile app that finds the cheapest dates to fly by searching hundreds of date combinations simultaneously and monitoring prices with intelligent tracking. Pre-App Store launch.

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Mobile App | React Native 0.81, Expo 54, Expo Router 6, React 19, TypeScript 5.7 |
| Animations | React Native Reanimated 4 (60fps native-thread) |
| HTTP | Axios with auto-refresh interceptors |
| Auth | expo-apple-authentication, expo-auth-session (Google OAuth) |
| Payments | react-native-iap (StoreKit 2) |
| Push | expo-notifications |
| Secure Storage | expo-secure-store |
| UI Components | @gorhom/bottom-sheet, Lucide React Native, expo-linear-gradient, expo-blur |
| Backend | Node.js, TypeScript, Express.js 4.21 |
| Database | PostgreSQL, Prisma 7.4 with @prisma/adapter-pg |
| Flight Data | SerpAPI (Google Flights scraper) |
| Auth | JWT (1-hour access + 90-day refresh tokens), google-auth-library, apple-signin-auth |
| Background Jobs | node-cron |
| Logging | Pino (structured JSON with request ID) |
| Validation | Zod |
| Security | express-rate-limit, Helmet |
| Testing | Vitest + Supertest |
| Web | Next.js 16, Tailwind CSS 4 |

### Features I Built

**Multi-Date Flight Search Engine:** Users specify route, date window, night range. Backend generates every valid date combination (up to 200). Fires up to 5 concurrent SerpAPI requests per date pair. For roundtrip: fetches outbound legs first, hydrates top 4 with return-leg details via departure tokens. Results deduplicated, sorted by price, stored as JSON columns. 50 raw results cached for zero-cost local filtering. 24-hour dedup window prevents duplicate credit charges.

**Advanced API Filters:** Maximum stops (nonstop/1-stop/2-stop). Include/exclude specific airlines or alliances (Star Alliance, SkyTeam, OneWorld). Maximum flight duration. Carry-on bag included. Local airline filtering on cached results (instant, zero API cost).

**Intelligent Price Tracking with Sentinel Strategy:** Instead of re-checking all combinations (expensive), selects 3-4 representative "sentinel" date pairs. Each check cycle only queries sentinels. If sentinel price drops >$2 below cached cheapest, triggers full re-search. Reduces API costs by ~90%. Tracking durations: 7, 14, 30 days, or until departure. Auto-deactivation when departure passes or window expires. Dynamic scheduling via nextCheckAt.

**Credits Economy:** Usage-based pricing replacing earlier subscription model. Tiered pricing based on complexity (1-200 combinations = 5-80 credits for search). Credit packs via Apple IAP: $4.99 (50 credits) to $59.99 (1000 credits). ~50% margin per search. Serializable transaction isolation prevents race conditions. Automatic refund on API failure or low-value results (≤5 results). First search free, first 7-day tracking free.

**Social-Only Authentication:** Google OAuth + Apple Sign-In only (no email/password). JWT access tokens (1-hour expiry) + refresh tokens (90-day). Token rotation: each refresh creates new token, invalidates old. Family ID tracking: reuse of revoked token revokes entire family (replay attack protection). SHA-256 hashed token storage. Serializable isolation on rotation.

**Apple In-App Purchases (StoreKit 2):** Two-phase verification: App initiates purchase → user pays → app sends transaction ID to backend → backend verifies with Apple's App Store Server API → app finishes StoreKit transaction. Server-side receipt validation with Apple's signed JWTs. Bundle ID verification. Unique constraint on appleTransactionId. Pending transaction recovery on app launch (crash safety). Three environments: Xcode, Sandbox, Production.

**Push Notifications:** Price drop alerts via Expo push notification service. Deep-links to specific search detail screen on tap. Deduplication via lastNotifiedAt.

**Re-Search with Airline Exclusions:** Create new search excluding specific airlines from previous results. Transfers active tracking. Deactivates old search.

**Manual Refresh:** Free refresh every 8 hours for tracked searches. Paid refresh anytime with filter changes.

### Architecture
Express routes → Controllers → Services → Prisma (PostgreSQL). Service layer: authService, creditService, savedSearchService (crud + operations + tracking submodules), flight (orchestration + serpClient), notificationService, appleIapService. Barrel exports for clean imports. Custom AppError class with HTTP status codes. Request ID tracking via Pino. Graceful shutdown with SIGTERM/SIGINT handlers.

**Frontend:** Provider-based state management (no Redux): NetworkProvider → HapticsProvider → AuthProvider → CreditsProvider → PendingSearchProvider → ToastProvider → BottomSheetModalProvider → ErrorBoundary. Token auto-refresh Axios interceptor. Fast vs slow error distinction. Haptics on every interaction (Apple HIG). Native-thread animations via Reanimated.

**Design Philosophy:** "You are already in the sky" — abstract luminosity, not airplane imagery. Mesh gradient backgrounds, subtle glass morphism, content-first layouts. Outfit font family. Sky blue primary (#2F9CF4), warm gold accent (#F59E0B). Custom pulsing dots instead of skeleton loaders.

### Database
4 models: User, SavedSearch, CreditTransaction, RefreshToken. Key indexes on (active, dateTo), (active, nextCheckAt), (userId, createdAt), (tokenHash), (familyId). JSON columns for flight results, price history, filters, sentinel pairs.

### Scale
23 REST endpoints. 8 frontend screens. 6 providers. 17 database migrations. ~15,000+ lines of TypeScript. Built in ~3 weeks solo.

---

## 4. LinkedIn Job Tracker — Automated AI Job Hunting System

**Role:** Solo Developer (ongoing, 2026)
**What it is:** Autonomous agent that continuously scrapes LinkedIn for job postings, uses AI to filter and rank them against resume and preferences, saves matches to SQLite with a web dashboard. Runs 24/7 locally.

### Tech Stack
| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode, ES2022) |
| Runtime | Node.js |
| Web Framework | Express.js |
| Database | SQLite via Prisma ORM |
| Browser Automation | Playwright with stealth plugin |
| AI Model | NVIDIA API (Kimi K2.5 via OpenAI SDK) |
| Templating | EJS (server-rendered HTML) |
| Charts | Chart.js |
| PDF Parsing | pdf-parse |
| Notifications | Telegram Bot API |
| Logging | Winston |

### Features I Built

**Automated LinkedIn Scraping (No Login):** Headless Playwright with anti-detection stealth plugins. Constructs LinkedIn search URLs with time filters. Scrolls full results (100-170 cards per keyword). Uses LinkedIn's internal seeMoreJobPostings API for pagination. Parses relative time text into numeric values. Randomized user agents (8 desktop + 4 mobile), viewports, human-like delays. Modal dismissal for login prompts.

**6-Layer AI Filtering Pipeline:** Layer 1a: Keyword blacklist (regex, handles C++/.NET). Layer 1b: Company blacklist (spam aggregators). Layer 1c: Unpaid filter. Layer 2: Seniority level filter. Layer 3: Title whitelist (optional). Layer 4: Deduplication (title + company). Layer 5: AI batch filter (one API call per keyword, fail-closed). Layer 6: Database dedup.

**Deep Job Enrichment:** Separate enricher agent visits full detail pages. 4 fallback extraction strategies for LinkedIn's varying HTML. Extracts: description, company info, contacts, applicant count, metadata, external apply links. AI produces: dealbreaker detection, 10-dimension scoring, work arrangement signals, human-readable analysis.

**16-Dimension Hybrid Scoring Engine:** 10 AI-scored dimensions: tech stack fit, role type match, AI/ML relevance, full-stack breadth, product ownership, company stage, growth potential, description quality, posting freshness, poster role. 6 deterministic dimensions: experience match, seniority alignment, remote, applicant competition, direct contact, application method. Bonus modifiers: urgency (+5), founding role (+5), entry level (+4), recent funding (+3). Penalty modifiers: staffing agency (-8), high applicants (-5), ghost listing (-5). Dealbreakers override score to 0. Priority: Urgent (85+), High (75+), Normal (50+), Low (<50).

**Web Dashboard:** Summary stats with SVG sparklines. Kanban-style jobs board with split-pane master/detail. Score breakdown visualization. Sort/filter toolbar (date, score, priority, company, enrichment status, dealbreakers). Analytics dashboard with Chart.js (applications/day, jobs scraped/day, rejections/day). Daily application goal tracker with progress ring. Control panel with agent start/stop, live logs, system health indicators. Settings page for all configuration. Profile page with work experience, education, skills CRUD.

**AI Chat Assistant:** Three modes: application questions (2-4 sentence answers), outreach messages (strict 5-line format), general questions. In-memory sessions with 30-min TTL. Full context: candidate profile, job details, match score, action items, red flags. Personal context file for human-sounding responses.

**Telegram Notifications:** AI-generated casual messages for high-priority jobs (score ≥85). Sounds like a friend texting about an opportunity. Includes apply link. Structured template fallback.

**Multi-Process Architecture:** UI Server (Express port 3000): dashboard, settings, agent control, background workers. Scraper Agent: per-keyword schedulers, PID tracking, graceful SIGTERM. Enricher Agent: detail scraping, AI analysis, scoring, notifications, browser restart every 50 jobs. Applicant Filter: one-shot agent for auto-rejecting 100+ applicant jobs. Processes communicate via SQLite database.

**Additional Workers:** Spam company detector (auto-rejects companies with 5+ postings, runs every 2min). Rejected job cleanup (every 2h). Chat session cleanup (every 5min). Stuck state recovery on startup.

### Database
9 Prisma models: Job (30+ fields), ScraperState, EnricherState, UserProfile, WorkExperience, Education, Skill, Document, AppSettings. Two-tier config: secrets in .env, everything else in SQLite.

---

## Cross-Project Technology Experience Summary

| Technology | Where I Used It | Depth |
|-----------|----------------|-------|
| **React Native** | Mudface (0.80), Airfare (0.81) | Deep — full apps with camera, OCR, IAP, push, animations |
| **React** | All projects (v18-19) | Deep — hooks, context, providers, state management |
| **TypeScript** | Airfare, Job Tracker, TaskMind backend | Deep — strict mode, generics, type-safe APIs |
| **Next.js** | Mudface web (14, 15), TaskMind (13), Airfare web (16) | Deep — Pages Router, SSR, API routes |
| **Express.js** | Airfare, Job Tracker, TaskMind | Deep — middleware, error handling, REST APIs |
| **Django / DRF** | Mudface backend | Moderate — REST APIs, Celery tasks, MongoDB integration |
| **PostgreSQL** | Airfare | Deep — serializable isolation, complex queries, Prisma |
| **MongoDB** | Mudface, TaskMind | Deep — document modeling, indexes, aggregation |
| **SQLite** | Job Tracker | Moderate — via Prisma, single-user embedded |
| **Prisma ORM** | Airfare (v7), Job Tracker | Deep — migrations, relations, JSON columns, adapters |
| **Playwright** | Job Tracker | Deep — stealth, anti-detection, scraping at scale |
| **AWS S3** | Mudface | Moderate — image upload, presigned URLs |
| **Google Cloud** | TaskMind (App Engine), Mudface (ML models on GCP) | Moderate — deployment, auto-scaling |
| **Stripe** | Mudface, TaskMind | Deep — webhooks, subscriptions, checkout, customer portal |
| **Apple StoreKit 2** | Airfare | Deep — IAP, server-side receipt validation, crash recovery |
| **Firebase (FCM)** | Mudface | Moderate — push notifications, token management |
| **Expo** | Airfare (SDK 54) | Deep — Router, notifications, secure store, auth, builds |
| **OpenAI API** | Mudface, Job Tracker | Moderate — structured prompts, chat completions |
| **D3.js** | TaskMind | Moderate — force-directed graphs, persistent layout |
| **Tailwind CSS** | Mudface web, TaskMind, Airfare web | Moderate — utility-first styling |
| **MUI** | TaskMind, Mudface dashboard | Moderate — component library, theming |
| **Redis + Celery** | Mudface | Moderate — background tasks, scheduled jobs |
| **JWT Auth** | All projects | Deep — access/refresh tokens, rotation, replay detection |
| **OAuth** | Mudface (Google, Apple), Airfare (Google, Apple) | Deep — social sign-in flows |
| **Framer Motion** | Mudface web, TaskMind | Moderate — scroll animations, page transitions |
| **Chart.js** | Job Tracker | Basic — line/bar charts, analytics |
| **Zod** | Airfare | Moderate — runtime validation schemas |
| **Pino / Winston** | Airfare (Pino), Job Tracker (Winston) | Moderate — structured logging |
| **Vitest** | Airfare | Basic — integration tests with Supertest |
