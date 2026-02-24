import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import {
  buildEnrichmentAnalysisPrompt,
  EnrichmentProfileContext,
  EnrichmentJobData,
} from './prompts';
import type { AIScores, DealbreakersResult, ExtractedSignals } from './scoring-engine';

export interface EnrichmentAnalysis {
  dealbreakers: DealbreakersResult;
  scores: AIScores;
  extracted: ExtractedSignals;
  analysis: {
    matchReason: string;
    keyMatches: string[];
    actionItems: string[];
    redFlags: string[];
  };
  aiFailed?: boolean;
}

const VALID_WORK_ARRANGEMENTS = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
const VALID_APP_METHODS = ['easyApply', 'externalSite', 'directReferral', 'unknown'] as const;

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.nvidia.apiKey,
    baseURL: config.nvidia.baseURL,
  });
}

/** Clamp a number to 0-10, defaulting to a fallback if invalid. */
function clampScore(value: unknown, fallback = 5): number {
  const n = Number(value);
  if (isNaN(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n)));
}

/** Ensure a value is a boolean. */
function ensureBool(value: unknown): boolean {
  return value === true;
}

/** Ensure a value is in a set of valid strings. */
function ensureEnum<T extends string>(value: unknown, valid: readonly T[], fallback: T): T {
  if (typeof value === 'string' && (valid as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

/**
 * Calls the AI with the enrichment prompt and returns a structured analysis.
 * On failure, returns a default result with aiFailed=true.
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
      max_tokens: 8192,
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
    const parsed = JSON.parse(cleaned);

    // Validate and normalize the response
    const result = validateResponse(parsed);

    logger.info('Enrichment AI analysis complete', {
      title: jobData.title,
      company: jobData.company,
      dealbreakers: result.dealbreakers,
      scores: result.scores,
      actionItems: result.analysis.actionItems.length,
      redFlags: result.analysis.redFlags.length,
    });

    return result;
  } catch (error) {
    logger.error('Enrichment AI call failed', {
      title: jobData.title,
      company: jobData.company,
      error: error instanceof Error ? error.message : String(error),
    });

    return getDefaultAnalysis();
  }
}

function validateResponse(parsed: any): EnrichmentAnalysis {
  const db = parsed.dealbreakers || {};
  const sc = parsed.scores || {};
  const ex = parsed.extracted || {};
  const an = parsed.analysis || {};

  return {
    dealbreakers: {
      seniorityTooHigh: ensureBool(db.seniorityTooHigh),
      clearanceRequired: ensureBool(db.clearanceRequired),
      wrongTechDomain: ensureBool(db.wrongTechDomain),
      experienceMinYears: typeof db.experienceMinYears === 'number' ? db.experienceMinYears : null,
    },
    scores: {
      techStack: clampScore(sc.techStack),
      roleType: clampScore(sc.roleType),
      aiRelevance: clampScore(sc.aiRelevance),
      fullStackBreadth: clampScore(sc.fullStackBreadth),
      productOwnership: clampScore(sc.productOwnership),
      companyStage: clampScore(sc.companyStage),
      growthPotential: clampScore(sc.growthPotential),
      descriptionQuality: clampScore(sc.descriptionQuality),
      postingFreshness: clampScore(sc.postingFreshness),
      posterRole: clampScore(sc.posterRole),
    },
    extracted: {
      workArrangement: ensureEnum(ex.workArrangement, VALID_WORK_ARRANGEMENTS, 'unknown'),
      applicationMethod: ensureEnum(ex.applicationMethod, VALID_APP_METHODS, 'unknown'),
      urgencySignalMatched: ensureBool(ex.urgencySignalMatched),
      isFoundingRole: ensureBool(ex.isFoundingRole),
      recentFunding: ensureBool(ex.recentFunding),
      dmInvitation: ensureBool(ex.dmInvitation),
      exactStackCount: Math.max(0, Math.round(Number(ex.exactStackCount) || 0)),
      isStaffingAgency: ensureBool(ex.isStaffingAgency),
      highApplicantCount: ensureBool(ex.highApplicantCount),
      ghostListingSignals: ensureBool(ex.ghostListingSignals),
      repostSignal: ensureBool(ex.repostSignal),
    },
    analysis: {
      matchReason: typeof an.matchReason === 'string' ? an.matchReason : '',
      keyMatches: Array.isArray(an.keyMatches) ? an.keyMatches.filter((x: any) => typeof x === 'string') : [],
      actionItems: Array.isArray(an.actionItems) ? an.actionItems.filter((x: any) => typeof x === 'string') : [],
      redFlags: Array.isArray(an.redFlags) ? an.redFlags.filter((x: any) => typeof x === 'string') : [],
    },
  };
}

function getDefaultAnalysis(): EnrichmentAnalysis {
  return {
    dealbreakers: {
      seniorityTooHigh: false,
      clearanceRequired: false,
      wrongTechDomain: false,
      experienceMinYears: null,
    },
    scores: {
      techStack: 0,
      roleType: 0,
      aiRelevance: 0,
      fullStackBreadth: 0,
      productOwnership: 0,
      companyStage: 0,
      growthPotential: 0,
      descriptionQuality: 0,
      postingFreshness: 0,
      posterRole: 0,
    },
    extracted: {
      workArrangement: 'unknown',
      applicationMethod: 'unknown',
      urgencySignalMatched: false,
      isFoundingRole: false,
      recentFunding: false,
      dmInvitation: false,
      exactStackCount: 0,
      isStaffingAgency: false,
      highApplicantCount: false,
      ghostListingSignals: false,
      repostSignal: false,
    },
    analysis: {
      matchReason: '',
      keyMatches: [],
      actionItems: [],
      redFlags: [],
    },
    aiFailed: true,
  };
}
