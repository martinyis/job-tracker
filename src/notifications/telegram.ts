import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

// ─── Types ───────────────────────────────────────────────

interface NotificationJobContext {
  title: string;
  company: string;
  link: string;
  applyLink: string | null;
  postedBy: string;
  postedByTitle: string;
}

interface NotificationAnalysisContext {
  priorityReason: string;
  matchReason: string;
  actionItems: string[];
}

interface TestNotificationJob {
  title: string;
  company: string;
  link: string;
  applyLink: string | null;
  postedBy: string | null;
  postedByTitle: string | null;
  priorityReason: string | null;
  matchReason: string | null;
  actionItems: string | null;
  priority: string | null;
}

// ─── Public API ──────────────────────────────────────────

/**
 * Returns true if both Telegram env vars are set and non-empty.
 */
export function isTelegramConfigured(): boolean {
  return !!(config.telegram.botToken && config.telegram.chatId);
}

/**
 * Sends a Telegram notification for an urgent job.
 * Called by the enricher after saving enrichment data.
 * Never throws — logs errors and returns silently.
 */
export async function sendUrgentJobNotification(
  job: NotificationJobContext,
  analysis: NotificationAnalysisContext,
): Promise<void> {
  try {
    const message = await generateNotificationMessage({
      title: job.title,
      company: job.company,
      priorityReason: analysis.priorityReason,
      matchReason: analysis.matchReason,
      actionItems: analysis.actionItems,
      applyLink: job.applyLink || job.link,
      linkedinLink: job.link,
      postedBy: job.postedBy
        ? `${job.postedBy}${job.postedByTitle ? ` (${job.postedByTitle})` : ''}`
        : '',
    });

    await sendTelegramMessage(message);
    logger.info('Telegram notification sent', { title: job.title, company: job.company });
  } catch (error) {
    logger.error('Failed to send Telegram notification', {
      title: job.title,
      company: job.company,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Sends a test notification using an existing enriched job.
 * Returns success/failure so the UI can show feedback.
 */
export async function sendTestNotification(
  job: TestNotificationJob,
): Promise<{ success: boolean; error?: string }> {
  try {
    let actionItems: string[] = [];
    if (job.actionItems) {
      try {
        actionItems = JSON.parse(job.actionItems);
      } catch {
        actionItems = [];
      }
    }

    const message = await generateNotificationMessage({
      title: job.title,
      company: job.company,
      priorityReason: job.priorityReason || 'This is a test notification',
      matchReason: job.matchReason || 'Testing Telegram integration',
      actionItems,
      applyLink: job.applyLink || job.link,
      linkedinLink: job.link,
      postedBy: job.postedBy
        ? `${job.postedBy}${job.postedByTitle ? ` (${job.postedByTitle})` : ''}`
        : '',
    });

    await sendTelegramMessage(message);
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Test notification failed', { error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

// ─── Internal ────────────────────────────────────────────

interface MessageContext {
  title: string;
  company: string;
  priorityReason: string;
  matchReason: string;
  actionItems: string[];
  applyLink: string;
  linkedinLink: string;
  postedBy: string;
}

/**
 * Generates a casual, friend-like notification message via AI.
 * Falls back to a template if the AI call fails.
 */
async function generateNotificationMessage(context: MessageContext): Promise<string> {
  try {
    const client = new OpenAI({
      apiKey: config.nvidia.apiKey,
      baseURL: config.nvidia.baseURL,
    });

    const actionItemsText = context.actionItems.length > 0
      ? context.actionItems.map((item) => `- ${item}`).join('\n')
      : '- Apply as soon as possible';

    const systemPrompt = `You are a text message generator. Your ONLY job is to output a short, casual text message (3-6 sentences). You are NOT a chatbot. You do NOT ask questions. You do NOT refuse. You do NOT add preamble, commentary, or explanations. You output ONLY the text message, nothing else.

RULES:
- Write like a real person texting a friend about a job they found. Be casual, be excited, be specific.
- Naturally weave in the action items -- don't list them robotically. For example, instead of "Action: DM @john on Instagram", say something like "oh and the hiring manager literally put their Instagram in the post, go DM them right now"
- Always include the apply link somewhere in the message so they can tap it immediately.
- If there's a specific person to contact, mention them by name.
- Do NOT use hashtags, do NOT use emojis, do NOT use bullet points or numbered lists.
- Do NOT start with "Hey!" every single time -- vary your openings.
- Keep it to 3-6 sentences max. This is a text, not an email.
- Use HTML for links: <a href="URL">text</a>. Use <b>bold</b> sparingly for the job title or company name only.
- Do NOT wrap the output in quotes or add any preamble. Just write the message text directly.
- NEVER ask for clarification. NEVER refuse to generate the message. NEVER output anything other than the text message itself.`;

    const userPrompt = `Generate a text message for this job:

Title: ${context.title}
Company: ${context.company}
Why it's urgent: ${context.priorityReason}
Why it's a great match: ${context.matchReason}
${context.postedBy ? `Posted by: ${context.postedBy}` : ''}

Things they should do:
${actionItemsText}

Apply link: ${context.applyLink}`;

    const AI_TIMEOUT_MS = 30_000;

    const aiPromise = client.chat.completions.create({
      model: config.nvidia.model,
      max_tokens: 512,
      temperature: 0.6,
      top_p: 1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Notification AI timed out')), AI_TIMEOUT_MS),
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const content = response.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new Error('AI returned empty response');
    }

    // Detect if the model got confused and returned a clarification/refusal
    // instead of a notification message
    const confusionSignals = [
      'clarification',
      'could you please',
      'i need more information',
      'i\'m not sure what',
      'are you asking me to',
      'please let me know',
      'i\'d be happy to help',
      'however, the',
      'to help you effectively',
    ];
    const lower = content.toLowerCase();
    const looksConfused = confusionSignals.some((signal) => lower.includes(signal));

    if (looksConfused) {
      logger.warn('Notification AI returned a confused response, using fallback', {
        responseSnippet: content.substring(0, 120),
      });
      return buildFallbackMessage(context);
    }

    return content;
  } catch (error) {
    logger.warn('Notification AI failed, using fallback template', {
      error: error instanceof Error ? error.message : String(error),
    });
    return buildFallbackMessage(context);
  }
}

/**
 * Builds a structured fallback message when the AI call fails.
 */
function buildFallbackMessage(context: MessageContext): string {
  const lines: string[] = [];

  lines.push(`Heads up -- <b>${context.title}</b> at <b>${context.company}</b> just came up and it looks urgent.`);
  lines.push('');

  if (context.priorityReason) {
    lines.push(context.priorityReason);
    lines.push('');
  }

  if (context.actionItems.length > 0) {
    for (const item of context.actionItems) {
      lines.push(item);
    }
    lines.push('');
  }

  lines.push(`<a href="${context.applyLink}">${context.applyLink}</a>`);

  return lines.join('\n');
}

/**
 * Sends a message via the Telegram Bot API.
 * Retries once without HTML if Telegram rejects the formatting.
 */
async function sendTelegramMessage(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;

  // First attempt with HTML parse mode
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegram.chatId,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (response.ok) return;

  const body = await response.text();
  let errorDescription = body;
  try {
    const parsed = JSON.parse(body);
    errorDescription = parsed.description || body;
  } catch {
    // Use raw body as error
  }

  // If HTML parsing failed, retry without parse_mode
  if (response.status === 400 && errorDescription.includes("can't parse entities")) {
    logger.warn('Telegram rejected HTML formatting, retrying as plain text');

    const plainText = text.replace(/<[^>]+>/g, '');
    const retryResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: plainText,
      }),
    });

    if (retryResponse.ok) return;

    const retryBody = await retryResponse.text();
    throw new Error(`Telegram API error (retry): ${retryBody}`);
  }

  throw new Error(`Telegram API error: ${errorDescription}`);
}
