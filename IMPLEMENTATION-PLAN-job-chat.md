# Implementation Plan: Job Chat Assistant

## Summary

Add an AI chat interface to the job detail panel on the `/jobs` page that helps users craft LinkedIn InMail and email application messages. The chat has full context about the user's profile/resume and the selected job's data. Chat sessions are stored in-memory (no database) with a 30-minute TTL. The detail panel is also restructured: Action Items and Contacts are promoted to the top, while Score Breakdown, Key Matches, and Summary become collapsible accordion sections to free up space for the chat UI.

## Context & Problem

The jobs tab (`/jobs`) currently shows a split-pane view: job list on the left, detail panel on the right. The detail panel shows all job information but has no interactive AI capability. Users want help crafting concise, personalized outreach messages (LinkedIn InMail and email) when applying to jobs. The detail panel also needs decluttering -- Score Breakdown, Key Matches, and Summary take up significant vertical space but are reference-only, so they should collapse by default.

## Chosen Approach

- **In-memory chat sessions** (no DB, no schema changes, no migrations) stored in a server-side `Map<string, ChatSession>` keyed by job ID. A background interval evicts sessions idle for 30+ minutes.
- **Non-streaming API responses** -- the user sends a message, waits 2-4 seconds, gets the full reply at once. This is simpler to implement and sufficient for the short outreach messages being generated.
- **System prompt built once** per session at creation time, loaded with the full user profile (via `getProfileForEnrichmentAI()`) and full job data (via `getJobById()`). Not rebuilt on each message.
- **Temperature 0.7** for the chat model calls (vs 0.3 used for job matching) to allow creative, natural-sounding outreach messages.
- **Two API endpoints**: `GET /api/chat/:jobId/history` (load existing session) and `POST /api/chat/:jobId` (send message, get reply).
- **Detail panel restructured**: Action Items + Contacts promoted right below the verdict section; Score Breakdown, Key Matches, Summary wrapped in collapsible accordions (default closed).

## Detailed Implementation Steps

### Step 1: Create the Chat Store Module

**Create new file:** `src/chat/chat-store.ts`

This module manages in-memory chat sessions with TTL-based cleanup.

**Data structures:**
```
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatSession {
  jobId: string
  messages: ChatMessage[]     // full OpenAI-format message history (including system prompt at index 0)
  createdAt: number           // Date.now()
  lastActivityAt: number      // Date.now(), updated on each message
}
```

**Storage:** A module-level `Map<string, ChatSession>` (key = job ID).

**Exported functions:**

1. `getSession(jobId: string): ChatSession | undefined` -- returns the session if it exists and is not expired. If expired, deletes it and returns undefined.

2. `createSession(jobId: string, systemPrompt: string): ChatSession` -- creates a new session with the system prompt as the first message. If a session already exists for this job ID, it is replaced. Sets `createdAt` and `lastActivityAt` to `Date.now()`.

3. `addUserMessage(jobId: string, content: string): void` -- appends a user message to the session and updates `lastActivityAt`.

4. `addAssistantMessage(jobId: string, content: string): void` -- appends an assistant message and updates `lastActivityAt`.

5. `getHistory(jobId: string): Array<{ role: 'user' | 'assistant', content: string }>` -- returns only user/assistant messages (strips the system prompt) for frontend display. Returns empty array if no session.

6. `clearSession(jobId: string): void` -- deletes the session for a job ID.

7. `startCleanupInterval(): NodeJS.Timeout` -- starts a `setInterval` that runs every 5 minutes. On each tick, iterates all sessions and deletes any where `Date.now() - lastActivityAt > 30 * 60 * 1000`. Returns the interval handle so the caller can clear it on shutdown if needed.

8. `stopCleanupInterval(handle: NodeJS.Timeout): void` -- clears the interval.

**Constants:** `SESSION_TTL_MS = 30 * 60 * 1000` (30 minutes), `CLEANUP_INTERVAL_MS = 5 * 60 * 1000` (5 minutes).

**No dependencies** beyond Node.js built-ins.

---

### Step 2: Create the Chat Prompt Builder

**Create new file:** `src/chat/chat-prompt.ts`

This module builds the system prompt for a chat session from profile + job data.

**Exported function:** `buildChatSystemPrompt(profile, job): string`

**Parameters:**
- `profile` -- the return type of `getProfileForEnrichmentAI()` from `src/database/profile-queries.ts`
- `job` -- a full Job record from `getJobById()` from `src/database/queries.ts`

**System prompt structure** (the exact text below should be used, with template interpolation for the dynamic parts):

```
You are a career coach helping {{firstName}} craft job application messages. You have full context about their background and the job they are applying to.

YOUR ROLE:
- Help write concise LinkedIn InMail messages (3-5 sentences max)
- Help write concise email application messages (5-8 sentences max)
- Answer questions about the job, suggest what to emphasize, and help strategize the approach
- Reference SPECIFIC experience from the candidate's background that maps to this role
- Sound like a real person, conversational and direct. Never use phrases like "I am writing to express my interest in..." or "I am excited to apply for..."
- When drafting messages, make them ready to copy-paste. Do not include placeholder brackets like [Your Name] -- use the candidate's real name.

CANDIDATE PROFILE:
Name: {{firstName}} {{lastName}}
Summary: {{profileSummaryCache or "Not available"}}

What they are looking for: {{jobSearchDescription or "Not specified"}}

Mission / what excites them: {{missionStatement or "Not specified"}}

Key skills: {{skills joined by comma}}

Recent experience:
{{for each workExperience: "- {{title}} at {{employer}} ({{startDate}} - {{endDate or 'Present'}})"}}

JOB DETAILS:
Title: {{job.title}}
Company: {{job.company}}
Location: {{job.location}}
Seniority: {{job.seniorityLevel or "Not specified"}}
Type: {{job.employmentType or "Not specified"}}
Applicants: {{job.applicantCount or "Unknown"}}

Description:
{{job.description or "No description available"}}

Company Info:
{{job.companyInfo or "Not available"}}

Posted by: {{job.postedBy or "Unknown"}}{{if postedByTitle: " ({{postedByTitle}})"}}
{{if postedByProfile: "Poster profile: {{postedByProfile}}"}}

AI Match Score: {{job.matchScore}}/100
Match Reason: {{job.matchReason or "Not available"}}
Priority: {{job.priority}}
Priority Reason: {{job.priorityReason or "N/A"}}
Action Items: {{job.actionItems (parsed from JSON) joined by "; " or "None"}}
Red Flags: {{job.redFlags (parsed from JSON) joined by "; " or "None"}}
Key Matches: {{job.keyMatches (parsed from JSON) joined by ", " or "None"}}

Contact People:
{{for each contact in contactPeople (parsed from JSON): "- {{name}}, {{title}}{{if profileUrl: ' ({{profileUrl}})'  }}"}}
{{if no contacts: "None found"}}

INSTRUCTIONS:
When the user asks you to write a message, determine from context whether it is a LinkedIn InMail or email:
- For LinkedIn InMail: Keep it to 3-5 sentences. Be casual but professional. Lead with a specific connection point (something about their work, a technology match, a shared interest). Mention 1-2 concrete things from the candidate's experience that are relevant. End with a soft ask, not a demand.
- For email: Keep it to 5-8 sentences. Slightly more formal than InMail but still direct. Include a clear subject line suggestion. Mention the specific role. Highlight 2-3 relevant experience points. End with a call to action.
- For general questions: Be helpful, direct, and reference the actual job data and candidate background. Do not be generic.
```

The function assembles this string by reading from the `profile` and `job` objects. JSON string fields on the job (like `actionItems`, `redFlags`, `keyMatches`, `contactPeople`) must be parsed with `JSON.parse()` wrapped in try/catch (falling back to empty arrays), matching the existing `safeParseJsonArray` / `safeParseJson` pattern used in `routes.ts`.

---

### Step 3: Create the Chat API Route Module

**Create new file:** `src/ui/chat-routes.ts`

This module defines the Express router for chat endpoints. Import pattern should match the existing route modules (see `routes.ts`, `setup-routes.ts`, `profile-routes.ts`).

```typescript
import { Router } from 'express';
export const chatRouter = Router();
```

**Endpoint 1: `GET /api/chat/:jobId/history`**

Purpose: Load existing chat history when the user switches to a job that already has an active session.

Logic:
1. Extract `jobId` from `req.params.jobId`.
2. Call `getHistory(jobId)` from the chat store.
3. Return `res.json({ messages })` where `messages` is the array of `{ role, content }` objects (user and assistant messages only, no system prompt).

If no session exists, return `{ messages: [] }`.

**Endpoint 2: `POST /api/chat/:jobId`**

Purpose: Send a user message and get an AI reply.

Request body: `{ message: string }`

Logic:
1. Extract `jobId` from `req.params.jobId` and `message` from `req.body.message`.
2. Validate that `message` is a non-empty string. Return 400 if not.
3. Check if a session exists via `getSession(jobId)`.
4. If no session exists:
   a. Fetch the job via `getJobById(jobId)` from `src/database/queries.ts`. Return 404 if job not found.
   b. Fetch the profile via `getProfileForEnrichmentAI()` from `src/database/profile-queries.ts`.
   c. Build the system prompt via `buildChatSystemPrompt(profile, job)`.
   d. Create the session via `createSession(jobId, systemPrompt)`.
5. Add the user message via `addUserMessage(jobId, message)`.
6. Get the current session (which now includes the new user message).
7. Call the NVIDIA API:
   - Create an OpenAI client using the same pattern as `job-matcher.ts`: `new OpenAI({ apiKey: config.nvidia.apiKey, baseURL: config.nvidia.baseURL })`.
   - Call `client.chat.completions.create()` with:
     - `model: config.nvidia.model`
     - `messages: session.messages` (the full array including system prompt and all history)
     - `max_tokens: 1024` (shorter than the 4096 used for job matching -- outreach messages are brief)
     - `temperature: 0.7`
   - Wrap in a timeout using the same `Promise.race` pattern as `job-matcher.ts`, with a 30-second timeout.
8. Extract the response content from `response.choices[0]?.message?.content`.
9. If the content is empty or the call fails, return `res.status(500).json({ error: 'Failed to get AI response' })`. Log the error.
10. Add the assistant message via `addAssistantMessage(jobId, content)`.
11. Return `res.json({ reply: content })`.

**Endpoint 3: `DELETE /api/chat/:jobId`**

Purpose: Clear a chat session (for the "Clear chat" button).

Logic:
1. Call `clearSession(jobId)`.
2. Return `res.json({ success: true })`.

**Error handling:** All endpoints should be wrapped in try/catch with `logger.error()` and appropriate status codes, matching the pattern in `routes.ts`.

---

### Step 4: Register the Chat Router and Start Cleanup

**Modify file:** `src/ui/server.ts`

Changes:
1. Import `chatRouter` from `./chat-routes`.
2. Import `startCleanupInterval` from `../chat/chat-store`.
3. Mount the chat router: `app.use('/', chatRouter);` -- place it alongside the other router mounts, after the setup/profile routes and before the main router. (The routes already have `/api/chat` prefix baked in, so mounting at `/` is correct.)
4. In the `startServer()` function, after `const app = createServer()`, call `startCleanupInterval()`. No need to store the handle since the cleanup naturally stops when the process exits.

---

### Step 5: Restructure the Detail Panel Body Rendering

**Modify file:** `src/ui/views/kanban.ejs`

This is the largest change. The `selectJob()` JavaScript function currently builds `bodyHtml` as a long string. The new rendering order and structure is:

**New body rendering order inside `selectJob()`:**

1. **Dealbreaker banner** -- unchanged, stays at top.

2. **Priority callout + Red flags ("verdict")** -- unchanged, stays visible.

3. **Action Items** -- PROMOTED from its current position. Render right after the verdict section (or after the dealbreaker banner if no verdict). Use the same `cy-detail-section` wrapper but add a new CSS class `jb-action-items-prominent` for slightly more visual weight (larger text, accent left-border). Only render if `job.enrichmentStatus === 'enriched'` and `actionItemsParsed.length > 0`.

4. **Contacts ("People to Reach Out To")** -- PROMOTED, rendered right after Action Items. Same content as current, same conditions.

5. **Score Breakdown** -- WRAPPED in a collapsible accordion. The section title becomes a clickable toggle. Default state: **closed**. Use a new CSS class `jb-collapsible` on the section wrapper, with `jb-collapsible-header` for the clickable title row and `jb-collapsible-body` for the content (hidden by default via `display: none`). The header should include a chevron icon that rotates when expanded.

6. **Key Matches** -- WRAPPED in a collapsible accordion, same pattern. Default: **closed**.

7. **Summary** (status, company, location, posted) -- WRAPPED in a collapsible accordion, same pattern. Default: **closed**.

8. **AI Match Reason** -- WRAPPED in a collapsible accordion, same pattern. Default: **closed**.

9. **Job Detail chips** (seniority, employment type, job function, applicant count) -- WRAPPED in a collapsible accordion, same pattern. Default: **closed**.

10. **Chat interface** -- a new static HTML region (not part of `bodyHtml`). See Step 6.

**Collapsible accordion HTML pattern:**

Each collapsible section should render as:
```html
<div class="cy-detail-section jb-collapsible">
  <div class="jb-collapsible-header" onclick="toggleCollapsible(this)">
    <span class="cy-detail-section-title">Section Title</span>
    <svg class="jb-collapsible-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </div>
  <div class="jb-collapsible-body" style="display: none;">
    <!-- section content -->
  </div>
</div>
```

**Add a new JavaScript function `toggleCollapsible(headerEl)`:**
```javascript
function toggleCollapsible(headerEl) {
  var body = headerEl.nextElementSibling;
  var chevron = headerEl.querySelector('.jb-collapsible-chevron');
  if (body.style.display === 'none') {
    body.style.display = '';
    chevron.classList.add('jb-collapsible-chevron--open');
  } else {
    body.style.display = 'none';
    chevron.classList.remove('jb-collapsible-chevron--open');
  }
}
```

Place this function alongside the existing `selectJob`, `deselectJob`, and `escapeHtml` functions in the `<script>` block.

---

### Step 6: Add the Chat UI to the Detail Panel

**Modify file:** `src/ui/views/kanban.ejs`

The chat UI lives in a new dedicated `<div>` inside the `jb-detail-content` structure. It should be placed **between** the existing `jb-detail-body` div and the `jb-detail-notes` div. This is a structural HTML change, not part of the `bodyHtml` string built by `selectJob()`.

**Add this HTML block in the `jb-detail-content` div, right after `<div class="jb-detail-body" id="jb-detail-body"></div>`:**

```html
<!-- Chat interface -->
<div class="jb-chat" id="jb-chat" style="display: none;">
  <div class="jb-chat-header">
    <span class="jb-chat-header-title">Chat</span>
    <button class="jb-chat-clear" id="jb-chat-clear" onclick="clearChat()" title="Clear chat">Clear</button>
  </div>
  <div class="jb-chat-messages" id="jb-chat-messages">
    <!-- Messages are appended here dynamically -->
  </div>
  <div class="jb-chat-input-row">
    <textarea class="jb-chat-input" id="jb-chat-input" placeholder="Ask about this job or request a message draft..." rows="1" onkeydown="handleChatKeydown(event)"></textarea>
    <button class="jb-chat-send" id="jb-chat-send" onclick="sendChatMessage()" title="Send">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>
```

**Chat JavaScript functions to add in the `<script>` block:**

1. **`loadChatHistory(jobId)`** -- called inside `selectJob()` after rendering the body content. Makes a `GET` request to `/api/chat/${jobId}/history`. If messages are returned, renders them in the `jb-chat-messages` container. Always shows the chat section (`jb-chat` div set to `display: flex`). This function should:
   - Clear the messages container.
   - Fetch from the history endpoint.
   - For each message, call `appendChatBubble(role, content)`.

2. **`sendChatMessage()`** -- reads the input value from `jb-chat-input`, trims it. If empty, return. Disables the send button and input. Appends a user bubble via `appendChatBubble('user', message)`. Shows a typing indicator via `showTypingIndicator()`. Makes a `POST` to `/api/chat/${selectedJobId}` with `{ message }`. On success, removes the typing indicator, appends `appendChatBubble('assistant', reply)`. On error, removes the typing indicator, appends an error bubble. Re-enables the input and send button. Clears the input. Auto-scrolls to bottom.

3. **`appendChatBubble(role, content)`** -- creates a `div` with class `jb-chat-bubble jb-chat-bubble--${role}` and sets its `textContent` to the content. Appends it to `jb-chat-messages`. Scrolls the messages container to the bottom. **Important:** Use `textContent` for user messages (to prevent XSS). For assistant messages, since they may contain markdown-like formatting, use `innerHTML` but only after a minimal sanitization (replace `<` with `&lt;`, `>` with `&gt;`, then convert `\n` to `<br>`). Alternatively, just use `textContent` for both and set `white-space: pre-wrap` on the bubble CSS -- this is the simpler and safer option. **Go with the simpler option: use `textContent` for both roles, and `white-space: pre-wrap` on `.jb-chat-bubble`.**

4. **`showTypingIndicator()`** -- appends a div with class `jb-chat-typing` and id `jb-chat-typing` containing three animated dots. Returns nothing.

5. **`removeTypingIndicator()`** -- removes the element with id `jb-chat-typing` if it exists.

6. **`clearChat()`** -- makes a `DELETE` to `/api/chat/${selectedJobId}`. Clears the `jb-chat-messages` container. Focus the input.

7. **`handleChatKeydown(event)`** -- if `event.key === 'Enter'` and not `event.shiftKey`, prevent default and call `sendChatMessage()`. This allows Shift+Enter for newlines.

**Integration with `selectJob()`:** At the end of the existing `selectJob()` function (after the notes form rendering, before `document.getElementById('jb-detail-body').scrollTop = 0`), add a call to `loadChatHistory(id)` and show the chat panel (`document.getElementById('jb-chat').style.display = 'flex'`).

**Integration with `deselectJob()`:** Hide the chat panel and clear its messages: `document.getElementById('jb-chat').style.display = 'none'` and `document.getElementById('jb-chat-messages').innerHTML = ''`.

**Auto-resize textarea:** The chat input textarea should auto-expand as the user types (up to a max height). Add an `oninput` handler:
```javascript
document.getElementById('jb-chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 120) + 'px';
});
```

---

### Step 7: Add Chat and Collapsible CSS

**Modify file:** `src/ui/views/styles.css`

Add all the following styles at the end of the file, before the responsive media queries section (before `@media (max-width: 1100px)`).

**Collapsible accordion styles:**

- `.jb-collapsible` -- no special styles needed beyond existing `cy-detail-section`.
- `.jb-collapsible-header` -- `display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; padding: 2px 0;`. On hover, the title text color should lighten slightly.
- `.jb-collapsible-header:hover .cy-detail-section-title` -- `color: var(--text-secondary);`.
- `.jb-collapsible-header .cy-detail-section-title` -- `margin-bottom: 0;` (override the default margin since the header handles spacing).
- `.jb-collapsible-chevron` -- `transition: transform var(--t-fast) var(--ease); color: var(--text-muted); flex-shrink: 0;`.
- `.jb-collapsible-chevron--open` -- `transform: rotate(180deg);`.
- `.jb-collapsible-body` -- `padding-top: var(--sp-3);`.

**Prominent Action Items style:**

- `.jb-action-items-prominent` -- `border-left: 3px solid var(--accent); padding-left: var(--sp-4); margin-bottom: var(--sp-5);`. The `ul` inside should use `list-style: none` and each `li` should have a small accent-colored dot or checkmark prefix, matching the existing `.cy-action-list` style if it already has this.

**Chat interface styles:**

- `.jb-chat` -- `display: flex; flex-direction: column; border-top: 1px solid var(--border-subtle); flex-shrink: 0; max-height: 400px; min-height: 200px;`. This creates a fixed-height chat region within the detail panel. The detail panel uses `flex-direction: column` with `jb-detail-body` taking `flex: 1` -- the chat should NOT take flex, it should be a fixed region below the scrollable body.

- `.jb-chat-header` -- `display: flex; align-items: center; justify-content: space-between; padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border-subtle); flex-shrink: 0;`.

- `.jb-chat-header-title` -- `font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted);`. This matches the `cy-detail-section-title` style.

- `.jb-chat-clear` -- `font-size: 11px; color: var(--text-tertiary); background: none; border: none; cursor: pointer; padding: 2px 6px; border-radius: var(--r-sm);`. On hover: `color: var(--text-secondary); background: var(--bg-elevated);`.

- `.jb-chat-messages` -- `flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2);`.

- `.jb-chat-bubble` -- `max-width: 85%; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word;`.

- `.jb-chat-bubble--user` -- `align-self: flex-end; background: var(--accent-subtle); color: var(--text-primary); border: 1px solid var(--accent-border);`.

- `.jb-chat-bubble--assistant` -- `align-self: flex-start; background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border-default);`.

- `.jb-chat-bubble--error` -- `align-self: flex-start; background: var(--red-dim); color: var(--red-text); border: 1px solid var(--red-border); font-size: 12px;`.

- `.jb-chat-input-row` -- `display: flex; align-items: flex-end; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border-subtle); flex-shrink: 0;`.

- `.jb-chat-input` -- `flex: 1; background: var(--bg-input); border: 1px solid var(--border-default); border-radius: var(--r-md); padding: var(--sp-2) var(--sp-3); color: var(--text-primary); font-size: 13px; font-family: var(--font-sans); resize: none; line-height: 1.5; min-height: 36px; max-height: 120px; overflow-y: auto;`. On focus: `border-color: var(--accent-border); outline: none; box-shadow: 0 0 0 2px var(--accent-subtle);`.

- `.jb-chat-send` -- `width: 36px; height: 36px; border-radius: var(--r-md); background: var(--accent); border: none; color: var(--bg-body); cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background var(--t-fast) var(--ease);`. On hover: `background: var(--accent-hover);`. When disabled: `opacity: 0.4; cursor: not-allowed;`.

- `.jb-chat-typing` -- `align-self: flex-start; padding: var(--sp-2) var(--sp-3); display: flex; gap: 4px; align-items: center;`.

- `.jb-chat-typing-dot` -- `width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); animation: chatTypingBounce 1.4s infinite ease-in-out;`.

- `.jb-chat-typing-dot:nth-child(2)` -- `animation-delay: 0.2s;`.
- `.jb-chat-typing-dot:nth-child(3)` -- `animation-delay: 0.4s;`.

- `@keyframes chatTypingBounce` -- `0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; }`.

**Adjust the detail panel layout** to accommodate the chat region. Currently `jb-detail-body` has `flex: 1; overflow-y: auto;`. This should remain the same -- it will shrink to make room for the chat panel. The overall `jb-detail-content` is already `display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden;` which is correct. The chat div being `max-height: 400px` and `flex-shrink: 0` means the scrollable body gets whatever space is left.

---

### Step 8: Adjust the Detail Panel DOM Structure

**Modify file:** `src/ui/views/kanban.ejs`

The current `jb-detail-content` structure is:
```
jb-detail-content (flex column)
  jb-detail-header (flex-shrink: 0)
  jb-detail-actions (flex-shrink: 0)
  jb-detail-body (flex: 1, overflow-y: auto)
  jb-detail-notes (flex-shrink: 0)
```

Change it to:
```
jb-detail-content (flex column)
  jb-detail-header (flex-shrink: 0)
  jb-detail-actions (flex-shrink: 0)
  jb-detail-body (flex: 1, overflow-y: auto)
  jb-chat (flex-shrink: 0, max-height: 400px) -- NEW
  jb-detail-notes (flex-shrink: 0)
```

The chat HTML block described in Step 6 goes between `jb-detail-body` and `jb-detail-notes`.

---

## Files Affected

| File | Action | Description |
|------|--------|-------------|
| `src/chat/chat-store.ts` | **CREATE** | In-memory chat session store with TTL cleanup |
| `src/chat/chat-prompt.ts` | **CREATE** | System prompt builder for chat sessions |
| `src/ui/chat-routes.ts` | **CREATE** | Express router with GET/POST/DELETE chat endpoints |
| `src/ui/server.ts` | **MODIFY** | Import and mount chat router, start cleanup interval |
| `src/ui/views/kanban.ejs` | **MODIFY** | Restructure detail body (collapsibles, promoted sections), add chat HTML, add chat JS functions |
| `src/ui/views/styles.css` | **MODIFY** | Add collapsible, chat, and prominent action items CSS |

**No schema changes. No migrations. No new dependencies.**

## Data Flow / Architecture

### Chat Message Flow

```
User types message in chat input
  -> Frontend JS: sendChatMessage()
    -> POST /api/chat/:jobId { message }
      -> chat-routes.ts handler:
        -> If no session: getJobById() + getProfileForEnrichmentAI() + buildChatSystemPrompt() + createSession()
        -> addUserMessage()
        -> OpenAI API call (NVIDIA Kimi K2.5, temp 0.7, max_tokens 1024)
        -> addAssistantMessage()
        -> Return { reply }
    -> Frontend: appendChatBubble('assistant', reply)
```

### Session Lifecycle

```
Session created on first message for a job
  -> Stored in Map<jobId, ChatSession>
  -> lastActivityAt updated on every message
  -> Every 5 minutes: cleanup interval deletes sessions idle > 30 min
  -> clearSession() called on "Clear chat" button click
  -> All sessions lost on server restart (by design)
```

### Detail Panel Rendering Flow (updated)

```
selectJob(id) called
  -> Render body:
    1. Dealbreaker banner (if applicable)
    2. Priority/verdict callout (always visible when enriched)
    3. Action Items (prominent, with accent border)
    4. Contacts
    5. Score Breakdown (collapsible, closed by default)
    6. Key Matches (collapsible, closed by default)
    7. Summary (collapsible, closed by default)
    8. AI Match Reason (collapsible, closed by default)
    9. Job Detail chips (collapsible, closed by default)
  -> Render notes form
  -> loadChatHistory(id) -> show chat panel with any existing messages
```

## Edge Cases & Error Handling

1. **API key not set:** The chat endpoint should check `config.nvidia.apiKey` before making the API call. If empty, return `{ error: 'AI not configured. Add NVIDIA_API_KEY to your .env file.' }` with status 503. The frontend should display this as an error bubble.

2. **API timeout:** Use the same `Promise.race` timeout pattern as `job-matcher.ts`. Use 30 seconds. On timeout, return a 504 with a user-friendly error message. The frontend shows it as an error bubble.

3. **API rate limiting / errors:** If the NVIDIA API returns a non-200, catch the error, log it, and return `{ error: 'AI service unavailable. Please try again in a moment.' }` with status 502.

4. **Job not found:** If `getJobById()` returns null when creating a session, return 404 with `{ error: 'Job not found' }`.

5. **Empty message:** If the POST body has no message or an empty string, return 400 with `{ error: 'Message is required' }`.

6. **Session expired mid-conversation:** If a session expires between messages (30-min gap), the next message will transparently create a new session. The user loses prior context but the chat starts fresh automatically. The frontend should handle the case where `loadChatHistory` returns empty even though the user previously had messages -- no special UI needed, it just starts fresh.

7. **Very long conversations:** The message history grows unbounded within a session. Since sessions are 30 minutes max and the model has a large context window, this is unlikely to be a problem. However, as a safety measure, if the total messages array exceeds 40 entries (20 back-and-forth exchanges), the endpoint should trim the oldest user/assistant message pairs (keeping the system prompt at index 0 always). Implement this in the POST handler before making the API call.

8. **Job data changes after session creation:** Since the system prompt is built once, if the job gets re-enriched during a chat session, the chat will use stale data. This is acceptable for 30-minute sessions. No action needed.

9. **Concurrent requests:** If the user somehow sends two messages simultaneously (double-click, etc.), the second request may arrive before the first AI response. The in-memory store is single-threaded in Node.js so there are no race conditions with the Map, but the message ordering could be wrong. Mitigate on the frontend by disabling the send button while a request is in-flight.

10. **Keyboard interaction:** The `handleChatKeydown` function must stop propagation of Enter key events so they do not trigger the existing keyboard navigation (j/k/arrow keys) while the chat input is focused. The existing keyboard handler already checks `if (e.target.tagName === 'TEXTAREA') return;` which covers this.

## Testing Considerations

1. **Manual test: basic chat flow** -- Select a job, type a message in the chat input, verify the response appears. Send 2-3 follow-up messages. Verify conversation history is maintained.

2. **Manual test: job switching** -- Chat with Job A, switch to Job B (chat should be empty or have its own history), switch back to Job A (previous conversation should reappear).

3. **Manual test: clear chat** -- Start a conversation, click "Clear", verify messages are gone. Send a new message, verify a fresh session is created.

4. **Manual test: collapsible sections** -- Click Score Breakdown header, verify it expands. Click again, verify it collapses. Same for Key Matches, Summary, etc. Verify they are all closed by default on job selection.

5. **Manual test: Action Items prominence** -- Select an enriched job with action items. Verify they appear near the top, right after the verdict section, with the accent border styling.

6. **Manual test: error handling** -- Temporarily remove the NVIDIA_API_KEY from .env, restart the server, try to chat. Verify the error message appears as a bubble.

7. **Manual test: TTL expiry** -- For testing, temporarily set `SESSION_TTL_MS` to 60 seconds and `CLEANUP_INTERVAL_MS` to 10 seconds. Start a chat, wait 70+ seconds, send another message. Verify a fresh session is created (old context is gone).

8. **Manual test: Enter/Shift+Enter** -- Verify Enter sends the message. Verify Shift+Enter inserts a newline in the input.

9. **Manual test: empty states** -- Select a job that has no enrichment data. Verify the chat still works (system prompt just has less context). Verify collapsible sections that have no data are not rendered at all (existing conditional logic should handle this).

## Migration / Breaking Changes

- **No database migrations.** The chat store is purely in-memory.
- **No breaking changes to existing functionality.** All current detail panel content is preserved, just reordered and wrapped in collapsibles.
- **No new npm dependencies.** Uses the existing `openai` package for API calls.
- **Server restart clears all chat sessions.** This is by design and should be expected behavior.

## Open Questions

None. All design decisions have been finalized.
