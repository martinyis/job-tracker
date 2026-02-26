/**
 * In-memory chat session store with TTL-based cleanup.
 * Sessions are keyed by job ID and evicted after 30 minutes of inactivity.
 * All sessions are lost on server restart (by design).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  jobId: string;
  messages: ChatMessage[];
  createdAt: number;
  lastActivityAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const sessions = new Map<string, ChatSession>();

export function getSession(jobId: string): ChatSession | undefined {
  const session = sessions.get(jobId);
  if (!session) return undefined;

  if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
    sessions.delete(jobId);
    return undefined;
  }

  return session;
}

export function createSession(jobId: string, systemPrompt: string): ChatSession {
  const session: ChatSession = {
    jobId,
    messages: [{ role: 'system', content: systemPrompt }],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
  sessions.set(jobId, session);
  return session;
}

export function addUserMessage(jobId: string, content: string): void {
  const session = sessions.get(jobId);
  if (!session) return;
  session.messages.push({ role: 'user', content });
  session.lastActivityAt = Date.now();
}

export function addAssistantMessage(jobId: string, content: string): void {
  const session = sessions.get(jobId);
  if (!session) return;
  session.messages.push({ role: 'assistant', content });
  session.lastActivityAt = Date.now();
}

export function getHistory(jobId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const session = getSession(jobId);
  if (!session) return [];

  return session.messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } =>
      m.role === 'user' || m.role === 'assistant',
    );
}

export function clearSession(jobId: string): void {
  sessions.delete(jobId);
}

export function startCleanupInterval(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [jobId, session] of sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS) {
        sessions.delete(jobId);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopCleanupInterval(handle: NodeJS.Timeout): void {
  clearInterval(handle);
}
