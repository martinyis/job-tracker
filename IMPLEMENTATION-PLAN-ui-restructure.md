# Implementation Plan: UI Restructure -- Control Panel, Settings Cleanup, Profile Cleanup

## Summary

Restructure the web UI into four pages (Dashboard, Profile, Settings, Control Panel) to eliminate duplicated content, separate concerns, and make the app easier to navigate for new users. The scraper/enricher agent controls move from the Dashboard to a dedicated "Control Panel" page. Settings loses its duplicate resume upload and Telegram section. Profile loses its duplicate preferences section and the AI summary cache display.

## Context & Problem

The current three-page layout (Dashboard, Profile, Settings) has accumulated duplication and misplaced sections over time:

- **Job Preferences** appear in both `/setup` (Settings section 3) and `/profile` (Preferences section). Both write to the same `UserProfile` table. Users who edit one place don't realize the other exists, and the fields aren't identical (Profile has `missionStatement`/`urgencySignals` that Settings lacks).
- **Resume upload** appears in both `/setup` (Settings section 2) and `/profile` (Documents section). The Documents section is the more complete version (supports multiple files, primary toggling, non-resume docs).
- **Telegram Notifications** section on Settings is a dead-end for most users -- it just says "not configured" with instructions to edit `.env`. It clutters the settings page.
- **AI Profile Summary Cache** on Profile is a debugging artifact, not useful for regular users.
- **Agent control panels** (scraper + enricher) dominate the top of the Dashboard, pushing the actual job table below the fold. They belong on their own operations page.

After this restructure:
- **Dashboard** (`/`) -- Job stats, filters, and jobs table. A compact status indicator for agents in the nav.
- **Profile** (`/profile`) -- Personal info, work experience, education, skills, documents. Pure identity data.
- **Settings** (`/setup`) -- API key, search config, scrape interval, headless mode, UI port, ALL job preferences (including mission statement + urgency signals), import/export.
- **Control Panel** (`/control`) -- Scraper agent panel, enricher agent panel, logs, LinkedIn session status.

## Chosen Approach

A single restructure pass that:
1. Creates a new EJS template (`control.ejs`) and wires it up with a new route.
2. Moves agent panel HTML and JavaScript from `jobs.ejs` to `control.ejs`.
3. Moves scrape interval from Settings section 1 to the Control Panel page.
4. Adds `missionStatement` and `urgencySignals` fields to the Settings preferences form.
5. Removes sections from Settings and Profile by deleting HTML blocks.
6. Adds a compact agent-status indicator to the Dashboard nav area.
7. Updates the nav bar across all templates to include the "Control Panel" link.

This was chosen over alternatives (e.g., building a SPA, using AJAX-loaded tab panels) because it preserves the existing server-rendered EJS pattern, involves no new dependencies, and keeps the changes to HTML/route-level reorganization rather than architectural changes.

## Detailed Implementation Steps

### Step 1: Create the Control Panel EJS template

**File: `src/ui/views/control.ejs`** (new file)

Create a new EJS template that contains:
- The same `<head>`, navbar, and container structure as the other pages.
- The nav bar with four links: Dashboard, Profile, Settings, Control Panel (with "Control Panel" marked `active`).
- The LinkedIn session status badge (currently in the Dashboard nav-status area). Move it here as a status indicator at the top of the page, styled as a small info bar above the agent panels.
- The entire scraper status panel (currently lines 39-116 of `jobs.ejs`): the `#scraper-panel` div including the log viewer.
- The entire enricher status panel (currently lines 118-200 of `jobs.ejs`): the `#enricher-panel` div including the log viewer.
- A new "Scraper Settings" card between the two panels (or at the top) containing:
  - Scrape Interval (minutes) -- moved from Settings section 1
  - Headless mode checkbox -- moved from Settings section 1
  - A save button that POSTs to `/control/scraper-settings`
- All the JavaScript from `jobs.ejs` that handles:
  - `refreshScraperStatus()` (lines 451-516)
  - `refreshEnricherStatus()` (lines 518-580)
  - The `setInterval` call (lines 582-585)
  - The scraper log viewer IIFE (lines 589-636)
  - The enricher log viewer IIFE (lines 639-686)

The template receives these variables from the route handler:
- `agentStatus` -- scraper agent status object
- `enricherStatus` -- enricher agent status object
- `scraperState` -- scraper state from DB
- `enrichmentQueueSize` -- number of pending enrichment jobs
- `linkedinSessionValid` -- boolean for session badge
- `agentError` -- optional error string
- `scraperSettings` -- object with `{ intervalMinutes, headless }` for the settings card
- `saved` -- boolean for toast after saving settings

### Step 2: Create the Control Panel route handler

**File: `src/ui/routes.ts`** (modify)

Add two new routes:

**`GET /control`**: Render the control panel page. This mirrors the data-fetching logic currently in `GET /` for agent-related data:
```
const [scraperState, agentStatus, enricherStatus, enrichmentQueueSize] = await Promise.all([...]);
const cookies = loadCookies();
const linkedinSessionValid = cookies !== null && areCookiesValid(cookies);
const settings = await getOrCreateSettings();
```
Render `control.ejs` with those variables plus `scraperSettings: { intervalMinutes: settings.intervalMinutes, headless: settings.headless }`.

**`POST /control/scraper-settings`**: Save scrape interval and headless mode. Extract `SCRAPE_INTERVAL_MINUTES` and `HEADLESS_MODE` from `req.body`, call `updateSettings({ intervalMinutes, headless })`, call `reloadConfig()`, redirect to `/control?saved=1`.

The existing agent control routes (`/agent/start`, `/agent/stop`, `/agent/status`, `/agent/logs`, `/enricher/*`, `/notifications/test`) stay in `routes.ts` exactly as-is. They already work as API endpoints. The only change is that the start/stop form actions now redirect to `/control` instead of `/`:

- In `POST /agent/start`: change `res.redirect('/')` to `res.redirect('/control')` and `res.redirect('/?agentError=...')` to `res.redirect('/control?agentError=...')`
- In `POST /agent/stop`: same change
- In `POST /enricher/start`: same change
- In `POST /enricher/stop`: same change
- In `POST /notifications/test`: change redirects from `/setup?...` to `/control?...` since Telegram test is now on the Control Panel (see Step 2a below)

**Note:** Also add the import for `getOrCreateSettings` from `../database/settings-queries` and add the import for `updateSettings` and `reloadConfig`.

### Step 2a: Move Telegram test notification to Control Panel

The Telegram test button is being removed from Settings (Step 5), but the test functionality is still useful. Move it to the Control Panel page as a small section below the enricher panel:

- In `control.ejs`, add a Telegram section after the enricher panel. If `telegramConfigured` is true, show a "Send Test Notification" button (POST to `/notifications/test`). If not configured, show a brief hint ("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable Telegram alerts."). Keep it compact -- no large instructional block.
- Pass `telegramConfigured` to the template (read from `config.telegram.botToken && config.telegram.chatId`).
- Update the `POST /notifications/test` handler redirects to point to `/control` instead of `/setup`.

### Step 3: Clean up the Dashboard (jobs.ejs)

**File: `src/ui/views/jobs.ejs`** (modify)

Remove the following from `jobs.ejs`:
- The entire `#scraper-panel` div (lines 39-116) -- moved to control.ejs
- The entire `#enricher-panel` div (lines 118-200) -- moved to control.ejs
- The LinkedIn session badge from `nav-status` div (lines 20-25) -- replaced by compact agent indicator
- All JavaScript related to agent status polling and log viewers (lines 451-686) -- moved to control.ejs

Add a compact agent status indicator in the `nav-status` div. This should be very minimal -- just two small dots with labels:

```html
<div class="nav-status">
  <a href="/control" class="nav-agent-indicator" title="Scraper: <%= agentStatus.running ? 'Running' : 'Stopped' %>">
    <span class="scraper-dot <%= agentStatus.running ? 'scraper-dot-running' : '' %>"></span>
    <span class="nav-agent-label">Scraper</span>
  </a>
  <a href="/control" class="nav-agent-indicator" title="Enricher: <%= enricherStatus.running ? 'Running' : 'Stopped' %>">
    <span class="scraper-dot <%= enricherStatus.running ? 'scraper-dot-running' : '' %>"></span>
    <span class="nav-agent-label">Enricher</span>
  </a>
</div>
```

The `nav-agent-indicator` links to `/control` so clicking the dots takes you to the full control panel.

Add a small JavaScript block to auto-refresh just the nav dots (lightweight -- no log viewers, no full panel updates):

```javascript
setInterval(async function() {
  try {
    const [scraperRes, enricherRes] = await Promise.all([
      fetch('/agent/status'),
      fetch('/enricher/status')
    ]);
    if (scraperRes.ok) {
      const s = await scraperRes.json();
      const dots = document.querySelectorAll('.nav-agent-indicator');
      if (dots[0]) {
        const dot = dots[0].querySelector('.scraper-dot');
        if (s.running) dot.classList.add('scraper-dot-running');
        else dot.classList.remove('scraper-dot-running');
        dots[0].title = 'Scraper: ' + (s.running ? 'Running' : 'Stopped');
      }
    }
    if (enricherRes.ok) {
      const e = await enricherRes.json();
      const dots = document.querySelectorAll('.nav-agent-indicator');
      if (dots[1]) {
        const dot = dots[1].querySelector('.scraper-dot');
        if (e.running) dot.classList.add('scraper-dot-running');
        else dot.classList.remove('scraper-dot-running');
        dots[1].title = 'Enricher: ' + (e.running ? 'Running' : 'Stopped');
      }
    }
  } catch (e) {}
}, 5000);
```

Update the nav links in `jobs.ejs` to include all four pages:
```html
<div class="nav-links">
  <a href="/" class="nav-link active">Dashboard</a>
  <a href="/profile" class="nav-link">Profile</a>
  <a href="/setup" class="nav-link">Settings</a>
  <a href="/control" class="nav-link">Control Panel</a>
</div>
```

Simplify the data passed from the route handler (Step 7).

### Step 4: Clean up Settings page (setup.ejs)

**File: `src/ui/views/setup.ejs`** (modify)

**Remove Section 2 (Resume Upload)** -- lines 112-136. Resume management lives in Profile > Documents.

**Remove Scrape Interval and Headless Mode from Section 1** -- Remove the `form-row` containing `SCRAPE_INTERVAL_MINUTES` and `UI_PORT` (lines 87-98) and the headless mode checkbox (lines 100-106). Keep `UI_PORT` in the form -- it belongs in Settings since it's a general app config, not specific to scraper operations. Actually, rethink: UI Port is an app-level setting, not a scraper setting, so keep it in Settings. Move only `SCRAPE_INTERVAL_MINUTES` and `HEADLESS_MODE` out. The form-row that previously held both interval and port needs to be restructured to just show port as a standalone field.

**Remove Section 5 (Telegram Notifications)** -- lines 274-290. The functionality moves to the Control Panel (Step 2a).

**Add `missionStatement` and `urgencySignals` to Section 3 (Preferences)** -- These fields currently only exist in the Profile preferences form. Add them to the Settings preferences form (`POST /setup/profile`) right after the `job_search_description` textarea. Use the same labels, placeholders, and hints from `profile.ejs` lines 173-185:

- "Your Mission / What Excites You" textarea for `missionStatement`
- "Urgency Signals" textarea for `urgencySignals`

The existing `POST /setup/profile` handler in `setup-routes.ts` needs to be updated to also read and save `missionStatement` and `urgencySignals` from the form body (Step 6).

**Update step indicators** -- Currently shows 3 steps (API Key, Resume, Preferences). Remove the Resume step. Renumber to just 2 steps: "1. API Key & Search" and "2. Your Preferences". Or keep 3 with a different third -- but since Resume and Telegram are gone, 2 steps is cleaner. Update the step indicators div (lines 41-54) accordingly.

**Update nav links** to include all four pages (same as other templates).

**Remove `notificationSent` and `notificationError` toast handling** from the template (lines 33-38) since Telegram section is gone.

### Step 5: Clean up Profile page (profile.ejs)

**File: `src/ui/views/profile.ejs`** (modify)

**Remove the entire Preferences section** (lines 112-234). This includes the `#preferences` section with all the form fields for remote, seniority, exclude keywords, include patterns, job search description, mission statement, urgency signals, tech stack, company size, salary, industries, interests, and dealbreakers. All of these now live exclusively in Settings.

**Remove the AI Profile Summary Cache section** (lines 495-504). The `<% if (profile.profileSummaryCache) { %>` block at the bottom.

**Update the section nav** (lines 31-38) to remove the "Preferences" link:
```html
<div class="profile-nav">
  <a href="#personal" class="profile-nav-link">Personal</a>
  <a href="#experience" class="profile-nav-link">Experience</a>
  <a href="#education" class="profile-nav-link">Education</a>
  <a href="#skills" class="profile-nav-link">Skills</a>
  <a href="#documents" class="profile-nav-link">Documents</a>
</div>
```

**Update nav links** to include all four pages.

### Step 6: Update route handlers for data flow changes

**File: `src/ui/setup-routes.ts`** (modify)

In `GET /setup`:
- Remove `hasResume` and `hasSummary` from the template variables (no longer needed -- resume section removed).
- Remove `telegramConfigured` from template variables.
- Remove `notificationSent` and `notificationError` from template variables.
- Add `missionStatement` and `urgencySignals` to the `templateSettings.profile` object:
  ```
  missionStatement: profile.missionStatement,
  urgencySignals: profile.urgencySignals,
  ```
  These need to be accessible in the template as `settings.profile.missionStatement` and `settings.profile.urgencySignals`.

In `POST /setup/config`:
- Remove `SCRAPE_INTERVAL_MINUTES` and `HEADLESS_MODE` from the destructured body.
- Remove `intervalMinutes` and `headless` from the `updateSettings()` call. (These are now saved via `POST /control/scraper-settings`.)

In `POST /setup/profile`:
- Add `missionStatement` and `urgencySignals` to the destructured body.
- Add them to the `updateProfile()` call:
  ```
  missionStatement: missionStatement || '',
  urgencySignals: urgencySignals || '',
  ```

**File: `src/ui/profile-routes.ts`** (modify -- minor)

The `POST /profile/preferences` route handler can remain as-is since it still works if someone somehow POSTs to it, but since the form is removed from the UI, it becomes dead code. Two options:
- **Option A (safe):** Leave it. No harm, and it preserves backward compatibility if import/export or API consumers use it.
- **Option B (clean):** Remove the route handler entirely.

Recommendation: Leave it for now (Option A). It's a single route handler and doesn't cause confusion.

**File: `src/ui/routes.ts`** (modify)

In `GET /`:
- Keep fetching `agentStatus` and `enricherStatus` (needed for the compact nav dots).
- Remove `scraperState` from the fetch (no longer displayed on Dashboard).
- Remove `enrichmentQueueSize` from the fetch (no longer displayed on Dashboard).
- Remove `linkedinSessionValid` from the template variables.
- Remove `agentError` from the template variables (agent errors now show on `/control`).
- Add `agentStatus` and `enricherStatus` to template variables (for the nav dots).

Updated template variables for `GET /`:
```typescript
res.render('jobs', {
  jobs: parsedJobs,
  stats,
  agentStatus,
  enricherStatus,
  currentFilter: validFilter || 'all',
  statuses: VALID_STATUSES,
});
```

### Step 7: Add CSS for the new nav elements

**File: `src/ui/views/styles.css`** (modify)

Add styles for the compact nav agent indicators:

```css
/* ─── Nav Agent Indicators ──────────────────────────── */
.nav-agent-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  text-decoration: none;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.15s;
}
.nav-agent-indicator:hover {
  background: #1f1f1f;
  text-decoration: none;
}

.nav-agent-label {
  font-size: 11px;
  color: #666;
  font-weight: 500;
}
```

The `.scraper-dot` and `.scraper-dot-running` styles already exist and will work for the small nav dots. They may need to be slightly smaller in the nav context. Add a size override:

```css
.nav-agent-indicator .scraper-dot {
  width: 8px;
  height: 8px;
}
```

### Step 8: Update all nav bars for consistency

Every EJS template must have the same four-link nav. Update the `nav-links` div in:
- `jobs.ejs` (Dashboard -- active)
- `profile.ejs` (Profile -- active)
- `setup.ejs` (Settings -- active)
- `control.ejs` (Control Panel -- active, new file)

The pattern:
```html
<div class="nav-links">
  <a href="/" class="nav-link [active if this page]">Dashboard</a>
  <a href="/profile" class="nav-link [active if this page]">Profile</a>
  <a href="/setup" class="nav-link [active if this page]">Settings</a>
  <a href="/control" class="nav-link [active if this page]">Control Panel</a>
</div>
```

Check if there are any other EJS templates that have navbars (e.g., a login page). If so, update those too.

### Step 9: Verify import/export still works

**File: `src/ui/setup-routes.ts`** -- `GET /setup/export` and `POST /setup/import`

The export endpoint currently includes `scraper.intervalMinutes` and `scraper.headless` in the JSON. These should STAY in the export -- they're still valid settings, they just happen to be edited on a different page now. The import endpoint should also continue to import them. No changes needed here.

However, confirm that the import handler's `updateSettings()` call still includes `intervalMinutes` and `headless` since those fields are still in `AppSettings`. The import handler already does this correctly (line 316-325 of setup-routes.ts). No change needed.

## Files Affected

### New files
- `src/ui/views/control.ejs` -- Control Panel template

### Modified files
- `src/ui/views/jobs.ejs` -- Remove agent panels, add compact nav dots, update nav links
- `src/ui/views/setup.ejs` -- Remove resume upload, remove scrape interval/headless, remove Telegram, add mission/urgency fields, update step indicators, update nav links
- `src/ui/views/profile.ejs` -- Remove preferences section, remove AI cache section, update section nav, update nav links
- `src/ui/views/styles.css` -- Add nav agent indicator styles
- `src/ui/routes.ts` -- Add `GET /control` and `POST /control/scraper-settings`, update agent redirects, simplify Dashboard data
- `src/ui/setup-routes.ts` -- Remove interval/headless from config save, add mission/urgency to profile save, clean up template variables

### Unchanged files
- `src/ui/profile-routes.ts` -- `POST /profile/preferences` handler stays as-is (dead UI but functional API)
- `src/ui/agent-manager.ts` -- No changes
- `src/ui/enricher-manager.ts` -- No changes
- `src/ui/server.ts` -- No changes (control routes are on the main router which is already mounted)
- `src/config.ts` -- No changes
- `prisma/schema.prisma` -- No changes
- All database query files -- No changes

## Data Flow / Architecture

**Before:**
```
Dashboard (/) ──── agent panels + job table
Settings (/setup) ── API key + search + interval + headless + resume + preferences + Telegram
Profile (/profile) ── personal + preferences (duplicate) + experience + education + skills + docs + AI cache
```

**After:**
```
Dashboard (/) ──── job table + compact agent dots in nav
Settings (/setup) ── API key + search + port + preferences (with mission/urgency) + import/export
Profile (/profile) ── personal + experience + education + skills + docs
Control Panel (/control) ── scraper panel + enricher panel + scraper settings (interval/headless) + Telegram test + LinkedIn status
```

**Data writes remain the same:**
- `POST /setup/config` writes to `AppSettings` (minus interval/headless)
- `POST /setup/profile` writes to `UserProfile` (plus mission/urgency)
- `POST /control/scraper-settings` writes to `AppSettings` (interval + headless only) -- NEW
- `POST /agent/*` and `POST /enricher/*` unchanged
- `POST /profile/*` unchanged

## Edge Cases & Error Handling

1. **Scrape interval saved on wrong page** -- Users might look for interval in Settings since that's where it used to be. The Settings page no longer shows it. This is intentional -- the Control Panel groups all operational controls together. No action needed, but consider adding a hint on Settings that says "Scraper timing settings are on the Control Panel."

2. **Stale preferences after migration** -- If a user had different values in the Settings preferences form vs the Profile preferences form (theoretically possible since both wrote to `UserProfile`), there's no conflict because they always wrote to the same DB row. The last save wins. After this change, there's only one form, so no more confusion.

3. **`POST /profile/preferences` still works** -- Since we're leaving the route handler alive, direct API calls or old bookmarks won't break. They just won't have a corresponding form in the UI.

4. **Agent redirect change** -- The start/stop redirects changing from `/` to `/control` means if a user was on the Dashboard and somehow triggered an agent start (not possible after this change since the buttons are gone from Dashboard), they'd be redirected to Control Panel. This is correct behavior.

5. **Settings import with interval/headless** -- Import still works because the import handler writes to `AppSettings` directly. It doesn't go through the UI form. The fact that the UI form on `/setup` no longer has those fields doesn't affect import.

6. **Control Panel when no agents have run** -- ScraperState/EnricherState singletons are auto-created by `getScraperState()`/`getEnricherStatus()` with default values. The template already handles "Never" for null dates and "0" for error counts. No special handling needed.

## Testing Considerations

1. **Manual navigation test** -- Visit all four pages via nav links. Verify each page loads without errors and shows the correct content.

2. **Settings save flow** -- Save settings on `/setup`. Verify interval and headless are NOT in the form. Verify missionStatement and urgencySignals are in the form and save correctly.

3. **Control Panel save flow** -- Save scraper settings (interval + headless) on `/control`. Verify they persist after page reload. Verify `reloadConfig()` is called.

4. **Agent start/stop** -- Start and stop both agents from the Control Panel. Verify redirects go to `/control`, not `/`.

5. **Compact nav dots** -- Start an agent, go to Dashboard, verify the green pulsing dot appears. Stop the agent, verify the dot goes grey. Verify clicking the dot navigates to `/control`.

6. **Profile cleanup** -- Visit `/profile`. Verify no preferences section, no AI cache section. Verify personal info, experience, education, skills, and documents sections all work.

7. **Import/export round-trip** -- Export settings, change something, import the exported file. Verify all settings (including interval and headless) are restored correctly.

8. **Telegram test** -- If Telegram is configured, verify the test button works from the Control Panel.

9. **Log viewers** -- Open scraper and enricher log viewers on the Control Panel. Verify they poll and display logs correctly.

## Migration / Breaking Changes

- **No database migrations.** No schema changes.
- **No new npm dependencies.**
- **Breaking URL change:** Agent start/stop now redirect to `/control` instead of `/`. This only affects browser redirects, not API consumers (the JSON status endpoints remain unchanged).
- **Removed UI-only:** The Telegram section, resume upload section on Settings, and preferences section on Profile are removed from the UI but the underlying API routes and backend logic remain functional.

## Open Questions

1. **Should the `POST /profile/preferences` route handler be removed?** Current recommendation is to leave it (harmless dead code). The implementing agent can remove it if instructed, but should be aware that doing so removes a functional API endpoint.

2. **Should there be a visual hint on Settings pointing users to the Control Panel for interval/headless?** Something like "Scraper timing settings have moved to the Control Panel" as a small note. Optional -- only if the user finds it confusing during testing.

3. **Should the LinkedIn session badge also appear on the Control Panel nav (in addition to the main content area)?** Current plan puts it only in the Control Panel body. The Dashboard nav only shows agent dots.
