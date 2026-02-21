# Implementation Plan: UI / Scraper Process Separation

## Summary

Split the monolithic entry point into two independent processes: the Express UI server and the LinkedIn scraper agent. The UI becomes the primary process (always running), with the ability to spawn and kill the scraper agent as a detached child process. Process coordination uses the existing SQLite `ScraperState` table with a new `pid` column, plus OS-level PID probing for liveness checks.

## Context & Problem

Currently `npm run dev` starts both the UI and scraper in the same Node process via `src/index.ts`. This couples their lifecycles -- you cannot restart the UI without killing the scraper mid-cycle, and there is no way to start/stop the scraper independently from the dashboard. The user wants the UI to run standalone for browsing jobs and managing settings, with a button to start/stop the scraper agent on demand. This also lays groundwork for future multi-agent support (Indeed scraper, auto-apply agent, etc.).

## Chosen Approach

**Raw `child_process.spawn` with detached mode + PID stored in the database.**

The UI spawns the scraper as a detached, unref'd child process. The scraper's PID is stored in the `ScraperState` table. On every dashboard page load, the UI probes the PID with `process.kill(pid, 0)` to determine if the scraper is alive. To stop the scraper, the UI sends `SIGTERM` to the stored PID. The scraper handles `SIGTERM` gracefully: it stops scheduling new cycles, waits for any in-progress cycle to finish, closes the Playwright browser, and exits.

This was chosen over pm2 (too heavy, awkward API) and a DB-flag-only approach (user specifically wants literal process start/stop). No new dependencies are required.

## Detailed Implementation Steps

### Step 1: Add `pid` column to ScraperState schema

**File: `prisma/schema.prisma`**

Add a nullable `pid` field to the `ScraperState` model:

```
model ScraperState {
  id            String   @id @default("singleton")
  lastRunAt     DateTime @default(now())
  lastSuccessAt DateTime?
  errorCount    Int      @default(0)
  isRunning     Boolean  @default(false)
  pid           Int?
}
```

After editing the schema, run:
```
npm run prisma:migrate
```

This creates the migration. The column is nullable so existing data is fine.

### Step 2: Create the scraper agent entry point

**New file: `src/scraper-agent.ts`**

This is the long-running scraper process, meant to be spawned by the UI or run directly from the terminal. It replaces the role that `src/index.ts` used to play for the scraper.

Responsibilities:
1. Write its own PID (`process.pid`) to `ScraperState.pid` on startup.
2. Call `resetScraperStateOnStartup()` (existing function) to clear stale `isRunning` flags.
3. Call `startScheduler()` but capture the interval ID it returns (requires a small refactor to `scheduler.ts` -- see Step 3).
4. Listen for `SIGTERM` and `SIGINT`. On signal:
   - Set a module-level `shutdownRequested` flag to `true`.
   - Clear the scheduler interval so no new cycles start.
   - Log that shutdown was requested.
   - If no cycle is in progress (check `ScraperState.isRunning` from DB), immediately clean up and exit.
   - If a cycle IS in progress, log "waiting for current cycle to finish" and let the cycle's `finally` block handle it. After the cycle finishes, the scheduler loop checks `shutdownRequested` and exits.
5. On exit (whether from signal or natural completion), clear `ScraperState.pid` to `null` and call `disconnectDatabase()`.

The file should also validate config before starting (same checks as current `index.ts` lines 20-34), and exit with a clear error message if config is invalid.

The `require.main === module` guard is not needed since this file will only ever be run directly.

### Step 3: Refactor `scheduler.ts` to support graceful shutdown

**File: `src/scheduler.ts`**

The current `startScheduler()` fires off `setInterval` and never exposes a way to stop it. Refactor as follows:

1. `startScheduler()` should return an object (or the interval ID) that allows the caller to stop the loop. A clean approach:

```typescript
export interface SchedulerHandle {
  stop: () => void;
}
```

`startScheduler()` returns a `SchedulerHandle`. The `stop()` method clears the interval.

2. Add a module-level `shutdownRequested` flag (exported so the agent entry point can set it). At the top of `runScrapeCycle()`, check this flag and return early if true. This prevents a new cycle from doing real work if a shutdown was requested between the interval firing and the cycle starting.

3. The return type of `startScheduler()` changes from `Promise<void>` to `Promise<SchedulerHandle>`.

4. The initial immediate `runScrapeCycle()` call should be awaited or at least tracked so the caller knows when it finishes. Currently it is fire-and-forget with `.catch()`. Change it so the caller can await the first cycle if needed, but keep the `.catch()` for error handling so a failed first cycle does not prevent the interval from starting.

Minimal change: store the interval ID in a variable, return it wrapped in a `SchedulerHandle`.

```typescript
export async function startScheduler(): Promise<SchedulerHandle> {
  // ... existing setup code ...

  await resetScraperStateOnStartup();

  // Run immediately
  runScrapeCycle().catch((error) => { /* existing error handling */ });

  // Then on interval
  const intervalId = setInterval(() => {
    if (shutdownRequested) return;
    runScrapeCycle().catch((error) => { /* existing error handling */ });
  }, intervalMs);

  return {
    stop: () => clearInterval(intervalId),
  };
}
```

Note: `index.ts` currently calls `await startScheduler()` and does not use the return value, so this is backward-compatible. Just ignore the returned handle there (or update `index.ts` -- see Step 4).

### Step 4: Simplify `index.ts` to be UI-only

**File: `src/index.ts`**

This file becomes the UI-only entry point. Remove the scraper startup logic. The new version:

1. Starts the UI server (same as now).
2. Checks `isConfigured()` and logs a message if not configured (same as now, but no longer starts the scraper).
3. Remove the `startScheduler()` import and call entirely.
4. Keep the graceful shutdown handler for database disconnect.
5. Keep uncaught exception and unhandled rejection handlers.

The scraper-related imports (`startScheduler`, `validateConfig`) should be removed. The `validateConfig` check can optionally stay as a warning log, but it should NOT block the UI from starting. The UI must always start regardless of config state.

### Step 5: Create the process manager module

**New file: `src/ui/agent-manager.ts`**

This module encapsulates all process management logic. The UI routes call into it. It should NOT be imported by the scraper.

**Exports:**

- `startAgent(): Promise<{ pid: number }>` -- Spawns the scraper agent process.
- `stopAgent(): Promise<void>` -- Sends SIGTERM to the running agent.
- `getAgentStatus(): Promise<AgentStatus>` -- Returns current status.

**`AgentStatus` type:**

```typescript
interface AgentStatus {
  running: boolean;
  pid: number | null;
  lastRunAt: Date;
  lastSuccessAt: Date | null;
  errorCount: number;
  isRunningCycle: boolean; // ScraperState.isRunning (mid-cycle flag)
}
```

**`startAgent()` implementation details:**

1. First, call `getAgentStatus()`. If already running, throw an error (don't spawn a second instance).
2. Validate config using `validateConfig()`. If invalid, throw with the specific errors so the UI can display them.
3. Spawn the process:
   ```typescript
   const child = spawn('npx', ['tsx', path.resolve('./src/scraper-agent.ts')], {
     detached: true,
     stdio: 'ignore',  // Winston handles all logging
     cwd: path.resolve('.'),
     env: { ...process.env },
   });
   child.unref();
   ```
   - `detached: true` -- the child runs independently of the UI process.
   - `child.unref()` -- the UI process can exit without waiting for the child.
   - `stdio: 'ignore'` -- no pipe needed, Winston writes to log files directly.
   - Pass `process.env` so the child inherits `NVIDIA_API_KEY` from `.env` (the scraper agent loads dotenv itself, but passing env ensures it works if dotenv is not present).
4. The child's PID is available immediately as `child.pid`. However, do NOT write it to the DB here -- the scraper agent writes its own PID on startup (Step 2). This avoids a race condition where the UI writes a PID but the child fails to start.
5. Wait briefly (500ms) then probe the PID to confirm the process is alive. If it died immediately (e.g., syntax error, missing dependency), report the failure.
6. Return `{ pid: child.pid }`.

**`stopAgent()` implementation details:**

1. Read `ScraperState.pid` from the DB.
2. If no PID stored, return (nothing to stop).
3. Send `SIGTERM` to the PID: `process.kill(pid, 'SIGTERM')`.
4. Wait up to 15 seconds for the process to exit, polling every 500ms with `process.kill(pid, 0)` (which throws if the process is gone).
5. If still alive after 15 seconds, send `SIGKILL` as a last resort.
6. Clear `ScraperState.pid` to `null` and `ScraperState.isRunning` to `false` in the DB. (The scraper should have done this itself on graceful shutdown, but clear it here defensively.)
7. Wrap `process.kill()` calls in try-catch for `ESRCH` errors (process already dead).

**`getAgentStatus()` implementation details:**

1. Read the `ScraperState` row from the DB.
2. If `pid` is not null, probe it with `process.kill(pid, 0)`:
   - If alive: return `running: true` with the DB fields.
   - If dead (throws ESRCH): the process died unexpectedly. Clear `pid` to null, set `isRunning` to false in the DB, then return `running: false`.
3. If `pid` is null: return `running: false`.

This "probe and clean" pattern means stale PIDs from crashed processes are automatically cleaned up on the next status check (which happens on every dashboard page load).

### Step 6: Add agent control routes

**File: `src/ui/routes.ts`**

Add three new route handlers. Import the agent manager module.

**`POST /agent/start`**

1. Call `startAgent()`.
2. On success, redirect to `/` (dashboard will show updated status).
3. On error (already running, config invalid), redirect to `/` with an error query param or flash message. Keep it simple -- a query param like `?agentError=already_running` is fine for now; the EJS template can display it.

**`POST /agent/stop`**

1. Call `stopAgent()`.
2. Redirect to `/`.
3. On error, redirect to `/` with an error query param.

**`GET /agent/status`**

1. Call `getAgentStatus()`.
2. Return JSON response with the `AgentStatus` object.
3. This endpoint is useful for future AJAX polling but also for debugging.

### Step 7: Update the dashboard route to include agent status

**File: `src/ui/routes.ts`**

In the existing `GET /` handler:

1. Import and call `getAgentStatus()` alongside the existing `Promise.all` calls.
2. Pass the `agentStatus` object to the EJS template (in addition to the existing `scraperState`). The `agentStatus` includes `running` (boolean) which is the PID-verified alive check, unlike `scraperState.isRunning` which only indicates a cycle is in progress.
3. Also pass any `agentError` from query params so the template can display it.

### Step 8: Update the dashboard UI

**File: `src/ui/views/jobs.ejs`**

Replace the static scraper status badges in the navbar with an agent control section:

1. Show the agent's running state with a colored badge:
   - Green "Agent Running" badge when `agentStatus.running` is true.
   - Gray "Agent Stopped" badge when false.
2. Add a Start/Stop button (a form with POST to `/agent/start` or `/agent/stop` depending on current state). Use a simple HTML form -- no JavaScript needed.
3. Keep the existing "Scraper Running" badge for cycle-in-progress indication (renamed to "Cycle Running" for clarity, since "scraper running" now has two meanings).
4. Keep the existing error count and last-run-time displays.
5. If `agentError` query param is present, show a dismissible error message at the top of the page (e.g., "Could not start agent: configuration incomplete").

Example navbar section structure:
```html
<div class="nav-status">
  <% if (agentStatus.running) { %>
    <span class="badge badge-agent-running">Agent Running</span>
    <form method="POST" action="/agent/stop" class="inline-nav-form">
      <button type="submit" class="btn-agent-stop">Stop</button>
    </form>
  <% } else { %>
    <span class="badge badge-agent-stopped">Agent Stopped</span>
    <form method="POST" action="/agent/start" class="inline-nav-form">
      <button type="submit" class="btn-agent-start">Start</button>
    </form>
  <% } %>
  <!-- existing badges below -->
</div>
```

### Step 9: Add CSS for new UI elements

**File: `src/ui/views/styles.css`**

Add styles for the new badges and buttons, following existing conventions:

- `.badge-agent-running` -- green background, similar to `.badge-connected`.
- `.badge-agent-stopped` -- gray/dim background.
- `.btn-agent-start` -- green-tinted button, small, fits in navbar.
- `.btn-agent-stop` -- red-tinted button, small, fits in navbar.
- `.inline-nav-form` -- `display: inline` form so the button sits next to the badge in the navbar flow.
- `.agent-error` -- error banner style for the top-of-page error message.

### Step 10: Update database queries module

**File: `src/database/queries.ts`**

Add new functions for PID management:

- `setScraperPid(pid: number): Promise<void>` -- Updates `ScraperState.pid` to the given value.
- `clearScraperPid(): Promise<void>` -- Sets `ScraperState.pid` to `null` and `isRunning` to `false`.
- `getScraperPid(): Promise<number | null>` -- Reads and returns the current PID.

These are thin wrappers around Prisma calls. The `getScraperState()` function already exists and returns the full row -- the new `getScraperPid()` is a convenience but `getScraperState()` can also be used directly.

Also update `resetScraperStateOnStartup()` to also clear `pid` to `null` (it currently only resets `isRunning`). This handles the case where a previous scraper crashed without cleaning up its PID.

### Step 11: Update package.json scripts

**File: `package.json`**

Update and add scripts:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "ui": "tsx src/ui/server.ts",
    "agent": "tsx src/scraper-agent.ts",
    "scrape": "tsx src/scheduler.ts",
    "login": "tsx src/scraper/login-helper.ts",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:studio": "prisma studio"
  }
}
```

- `npm run dev` -- unchanged, still starts UI (but no longer starts scraper automatically; see Step 4).
- `npm run ui` -- unchanged, starts UI standalone.
- `npm run agent` -- new, starts the long-running scraper agent directly from terminal.
- `npm run scrape` -- unchanged, runs a single scrape cycle for testing.
- `npm run login` -- unchanged.

### Step 12: Update `npm run scrape` to work standalone

**File: `src/scheduler.ts`**

The current bottom of `scheduler.ts` has no `require.main === module` guard, which means `npm run scrape` actually calls `startScheduler()` (the infinite loop). Looking at `package.json`, the `scrape` script points to `src/scheduler.ts`.

For single-cycle testing, add a `require.main === module` block at the bottom of `scheduler.ts` that runs a single `runScrapeCycle()` call and then exits, rather than starting the infinite loop. Export `runScrapeCycle` so the agent entry point can use it too. The existing `startScheduler` export remains unchanged.

```typescript
if (require.main === module) {
  // Single cycle mode for testing
  runScrapeCycle()
    .then(() => {
      logger.info('Single scrape cycle complete, exiting');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Single scrape cycle failed', { error: ... });
      process.exit(1);
    });
}
```

Currently `runScrapeCycle` is not exported. Export it so the scraper agent entry point can also call it if needed, though the agent will primarily use `startScheduler`.

## Files Affected

### New Files
- `src/scraper-agent.ts` -- Scraper agent entry point (long-running process)
- `src/ui/agent-manager.ts` -- Process management logic (spawn, kill, status)

### Modified Files
- `prisma/schema.prisma` -- Add `pid Int?` to `ScraperState`
- `src/index.ts` -- Remove scraper startup, become UI-only entry point
- `src/scheduler.ts` -- Return `SchedulerHandle` from `startScheduler()`, export `runScrapeCycle`, add single-cycle `require.main` guard, add `shutdownRequested` flag
- `src/database/queries.ts` -- Add `setScraperPid`, `clearScraperPid`, `getScraperPid` functions; update `resetScraperStateOnStartup` to clear PID
- `src/ui/routes.ts` -- Add `POST /agent/start`, `POST /agent/stop`, `GET /agent/status` routes; pass `agentStatus` to dashboard template
- `src/ui/views/jobs.ejs` -- Add agent start/stop button and status display in navbar
- `src/ui/views/styles.css` -- Add styles for agent control elements
- `package.json` -- Add `agent` script

### Unchanged Files
- `src/ui/server.ts` -- No changes needed; it already imports routes
- `src/ui/setup-routes.ts` -- No changes needed
- `src/config.ts` -- No changes needed (scraper agent loads config itself)
- `src/scraper/linkedin-scraper.ts` -- No changes needed
- `src/database/client.ts` -- No changes needed
- `src/ai/*` -- No changes needed
- `src/logger.ts` -- No changes needed

## Data Flow / Architecture

### Before (monolithic)
```
npm run dev
  -> src/index.ts
    -> startServer()     (Express on :3000)
    -> startScheduler()  (setInterval loop in same process)
      -> runScrapeCycle() -> Playwright -> DB
```

### After (separated)
```
npm run dev  (or npm run ui)
  -> src/index.ts
    -> startServer()  (Express on :3000)
    -> UI can spawn/kill agent via routes

npm run agent  (or spawned by UI)
  -> src/scraper-agent.ts
    -> writes PID to ScraperState
    -> startScheduler()
      -> runScrapeCycle() -> Playwright -> DB
    -> listens for SIGTERM
    -> on exit: clears PID, disconnects DB
```

### Communication between processes
```
UI Process                          Scraper Agent Process
     |                                      |
     |--[spawn]--------------------------->|  (child_process.spawn, detached)
     |                                      |
     |--[reads ScraperState]--------------->|  (SQLite: pid, isRunning, lastRunAt)
     |                                      |
     |--[SIGTERM]------------------------->|  (process.kill(pid, 'SIGTERM'))
     |                                      |
     |<-[reads jobs]----------------------- |  (SQLite: Job table)
     |                                      |
   Both read: data/settings.json, data/resume.pdf
   Both write: logs/app.log (Winston, file-safe with append)
```

### SQLite concurrent access note
SQLite supports multiple readers and a single writer with WAL mode (which Prisma enables by default). Since the UI is read-heavy and the scraper writes infrequently (only when saving new jobs or updating ScraperState), contention is effectively zero for this workload. If either process gets a `SQLITE_BUSY` error, Prisma retries automatically with its default busy timeout.

## Edge Cases & Error Handling

### 1. UI restarts while scraper is running
The UI loses its in-memory reference to the child process. On next dashboard load, `getAgentStatus()` reads the PID from the DB and probes it. The scraper is still alive (it was detached/unref'd), so status correctly shows "running." The stop button works because it reads the PID from DB and sends SIGTERM.

### 2. Scraper crashes mid-cycle (uncaught exception, OOM, etc.)
The process dies. `ScraperState.isRunning` may be stuck as `true`, and `pid` is stale. On next dashboard load, `getAgentStatus()` probes the PID, finds it dead (`ESRCH`), and clears both `pid` and `isRunning` in the DB. Status correctly shows "stopped."

### 3. Scraper process exits normally (not expected, but possible)
Same as crash case -- PID probe detects it is gone, cleans up.

### 4. User clicks Start when agent is already running
`startAgent()` calls `getAgentStatus()` first. If `running` is true, it throws/returns an error. The route handler redirects with `?agentError=already_running`.

### 5. User clicks Stop when agent is already stopped
`stopAgent()` reads PID from DB. If null, it returns immediately (no-op). If non-null but probe shows dead, it cleans up the DB and returns.

### 6. PID reuse by OS
Extremely unlikely on macOS/Linux for a local tool (PIDs cycle through 30,000+ values). Additionally, the UI only stores a PID that it recently spawned. For extra safety, the `getAgentStatus` probe could check that the process name matches (e.g., via reading `/proc/<pid>/cmdline` on Linux), but this is unnecessary for a local tool and does not work portably on macOS. Accept this as a theoretical risk that is not worth mitigating.

### 7. SIGTERM sent during mid-cycle (Playwright browser open)
The scraper's `SIGTERM` handler sets `shutdownRequested = true` and clears the interval. The current cycle continues to completion (including the `finally { await scraper.close() }` block that closes the browser). The process exits after cleanup. The 15-second timeout in `stopAgent()` provides ample time for this -- a typical cycle finishes in under 60 seconds, but if it takes longer, the user can always check status and wait.

### 8. Config changes while scraper is running
The scraper reads config on startup and at the beginning of each cycle (via the functions it calls). Since `config.ts` reads from files and `settings.json` is written atomically by `saveSettings()`, the scraper picks up changes on the next cycle. This is acceptable per the user's stated requirements.

### 9. Multiple browser instances
Not a concern in this design. Only one scraper agent can run at a time (enforced by `startAgent()` checking status before spawning). The single-cycle `npm run scrape` command could theoretically run alongside the agent, but the `ScraperState.isRunning` flag prevents overlapping cycles from doing work.

## Testing Considerations

### Manual testing checklist

1. **Basic flow**: Start UI (`npm run dev`), verify dashboard loads with "Agent Stopped" badge. Click Start, verify badge changes to "Agent Running." Check logs for scraper activity. Click Stop, verify badge returns to "Agent Stopped."

2. **UI restart resilience**: Start agent via UI. Kill and restart the UI process. Verify dashboard correctly shows "Agent Running" (PID probe against DB). Click Stop -- verify it successfully kills the agent.

3. **Agent crash recovery**: Start agent via UI. Kill the agent process manually (`kill -9 <pid>`). Reload dashboard. Verify it shows "Agent Stopped" (stale PID was cleaned up).

4. **Config validation**: Remove the API key from `.env`. Try to start agent via UI. Verify it shows an error message, not a silent failure.

5. **Graceful shutdown**: Start agent. Wait for a cycle to begin (watch logs for "SCRAPE CYCLE: Starting"). Click Stop. Verify logs show the cycle completing, browser closing, and clean exit -- not an abrupt kill.

6. **Concurrent access**: Start agent. While it is running a cycle, refresh the dashboard repeatedly. Verify no SQLite busy errors.

7. **Single cycle mode**: Run `npm run scrape`. Verify it runs one cycle and exits (process terminates).

8. **Direct agent start**: Run `npm run agent` from terminal. Verify it runs the scheduler loop. Ctrl+C should trigger graceful shutdown.

## Migration / Breaking Changes

### Database migration
A Prisma migration is required to add the `pid` column. Run `npm run prisma:migrate` after updating the schema. This is a non-destructive additive change (nullable column, no data loss).

### `npm run dev` behavior change
Previously `npm run dev` started both UI and scraper. After this change, it starts only the UI. Users must start the scraper via the dashboard button or `npm run agent`. This is the intended behavior, but it is a breaking change in workflow. Update CLAUDE.md to reflect this.

### `startScheduler()` return type change
Changes from `Promise<void>` to `Promise<SchedulerHandle>`. This is backward-compatible since callers can ignore the return value. The only caller is `index.ts`, which will no longer call it anyway.

### No npm dependency changes
No new packages needed. `child_process` is a Node built-in.

## Open Questions

1. **Log separation**: Currently the UI and scraper both write to the same `logs/app.log` via Winston. This works fine (file appending is atomic at the OS level for reasonable line sizes), but it means scraper and UI logs are interleaved. A future enhancement could add a `service` or `process` field to log entries to distinguish them, or use separate log files. Not blocking for this implementation.

2. **Auto-restart on crash**: The current design does not auto-restart the scraper if it crashes. The user must click Start again. If this becomes annoying, a future enhancement could add a "restart on crash" option, where the `getAgentStatus()` function detects a dead PID and optionally respawns. Defer this -- the user can check the dashboard periodically.

3. **CLAUDE.md update**: After implementation, CLAUDE.md should be updated to reflect the new architecture, entry points, and commands. This is a documentation task, not a code task.
