import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../logger';
import { getJobById } from '../database/queries';
import { getOrCreateProfile } from '../database/profile-queries';
import { buildChatSystemPrompt } from '../chat/chat-prompt';
import {
  getSession,
  createSession,
  addUserMessage,
  addAssistantMessage,
  getHistory,
  clearSession,
} from '../chat/chat-store';

export const chatRouter = Router();

const MAX_MESSAGES = 40;
const AI_TIMEOUT_MS = 30_000;

function createClient(): Anthropic {
  return new Anthropic({ apiKey: config.anthropic.apiKey });
}

/**
 * GET /api/chat/:jobId/history
 * Load existing chat history for a job.
 */
chatRouter.get('/api/chat/:jobId/history', (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const messages = getHistory(jobId);
    res.json({ messages });
  } catch (error) {
    logger.error('Error fetching chat history', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

/**
 * POST /api/chat/:jobId
 * Send a user message and get an AI reply.
 */
chatRouter.post('/api/chat/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    const { message } = req.body as { message: string };

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (!config.anthropic.apiKey) {
      res.status(503).json({ error: 'AI not configured. Add ANTHROPIC_API_KEY to your .env file.' });
      return;
    }

    let session = getSession(jobId);

    if (!session) {
      const job = await getJobById(jobId);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      const profile = await getOrCreateProfile();
      const systemPrompt = buildChatSystemPrompt(
        {
          firstName: profile.firstName,
          lastName: profile.lastName,
          profileSummaryCache: profile.profileSummaryCache,
          jobSearchDescription: profile.jobSearchDescription,
          missionStatement: profile.missionStatement,
          skills: profile.skills,
          workExperience: profile.workExperience.slice(0, 5),
        },
        job,
      );
      session = createSession(jobId, systemPrompt);
    }

    addUserMessage(jobId, message.trim());

    // Get updated session with the new message
    session = getSession(jobId)!;

    // Trim conversation if too long (keep system prompt at index 0)
    if (session.messages.length > MAX_MESSAGES) {
      const systemMsg = session.messages[0];
      const recentMessages = session.messages.slice(-(MAX_MESSAGES - 1));
      session.messages = [systemMsg, ...recentMessages];
    }

    const client = createClient();

    // Anthropic API: system prompt is a separate param, messages are user/assistant only
    const systemPrompt = session.messages[0]?.content || '';
    const chatMessages = session.messages.slice(1).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const aiPromise = client.messages.create({
      model: config.anthropic.model,
      system: systemPrompt,
      messages: chatMessages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Chat AI timed out after 30s')), AI_TIMEOUT_MS),
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const firstBlock = response.content[0];
    const content = firstBlock?.type === 'text' ? firstBlock.text : null;

    if (!content) {
      res.status(500).json({ error: 'Failed to get AI response' });
      return;
    }

    addAssistantMessage(jobId, content);
    res.json({ reply: content });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Chat API error', { error: message });

    if (message.includes('timed out')) {
      res.status(504).json({ error: 'AI took too long to respond. Please try again.' });
      return;
    }

    res.status(502).json({ error: 'AI service unavailable. Please try again in a moment.' });
  }
});

/**
 * DELETE /api/chat/:jobId
 * Clear a chat session.
 */
chatRouter.delete('/api/chat/:jobId', (req: Request, res: Response) => {
  try {
    const jobId = req.params.jobId as string;
    clearSession(jobId);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error clearing chat session', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to clear chat session' });
  }
});
