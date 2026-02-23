import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import {
  buildEnrichmentAnalysisPrompt,
  EnrichmentProfileContext,
  EnrichmentJobData,
} from './prompts';

export interface EnrichmentAnalysis {
  priority: 'urgent' | 'high' | 'normal' | 'low';
  priorityReason: string;
  matchScore: number;
  matchReason: string;
  keyMatches: string[];
  actionItems: string[];
  redFlags: string[];
  aiFailed?: boolean;
}

const VALID_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.nvidia.apiKey,
    baseURL: config.nvidia.baseURL,
  });
}

/**
 * Calls the AI with the enrichment prompt and returns a structured analysis.
 * On failure, returns a default result with priority "normal" and aiFailed=true.
 */
export async function analyzeEnrichedJob(
  profileContext: EnrichmentProfileContext,
  jobData: EnrichmentJobData,
): Promise<EnrichmentAnalysis> {
  const client = createClient();
  const prompt = buildEnrichmentAnalysisPrompt(profileContext, jobData);

  try {
    const AI_TIMEOUT_MS = 90_000;
    const callStart = Date.now();

    const aiPromise = client.chat.completions.create({
      model: config.nvidia.model,
      max_tokens: config.nvidia.maxTokens,
      temperature: config.nvidia.temperature,
      top_p: 1,
      messages: [{ role: 'user', content: prompt }],
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Enrichment AI timed out after ${AI_TIMEOUT_MS / 1000}s`)),
        AI_TIMEOUT_MS,
      ),
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);
    const content = response.choices[0]?.message?.content;

    logger.info('Enrichment AI raw response', {
      elapsed: `${Date.now() - callStart}ms`,
      contentLength: content?.length ?? 0,
    });

    if (!content) {
      throw new Error('Model did not return a text response');
    }

    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as EnrichmentAnalysis;

    // Validate response structure
    if (!VALID_PRIORITIES.includes(parsed.priority as any)) {
      parsed.priority = 'normal';
    }
    if (typeof parsed.matchScore !== 'number' || parsed.matchScore < 0 || parsed.matchScore > 100) {
      parsed.matchScore = Math.max(0, Math.min(100, Math.round(Number(parsed.matchScore) || 0)));
    }
    if (typeof parsed.priorityReason !== 'string') parsed.priorityReason = '';
    if (typeof parsed.matchReason !== 'string') parsed.matchReason = '';
    if (!Array.isArray(parsed.keyMatches)) parsed.keyMatches = [];
    if (!Array.isArray(parsed.actionItems)) parsed.actionItems = [];
    if (!Array.isArray(parsed.redFlags)) parsed.redFlags = [];

    logger.info('Enrichment AI analysis complete', {
      title: jobData.title,
      company: jobData.company,
      priority: parsed.priority,
      matchScore: parsed.matchScore,
      actionItems: parsed.actionItems.length,
      redFlags: parsed.redFlags.length,
    });

    return parsed;
  } catch (error) {
    logger.error('Enrichment AI call failed', {
      title: jobData.title,
      company: jobData.company,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      priority: 'normal',
      priorityReason: '',
      matchScore: 0,
      matchReason: '',
      keyMatches: [],
      actionItems: [],
      redFlags: [],
      aiFailed: true,
    };
  }
}
