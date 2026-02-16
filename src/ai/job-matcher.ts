import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../logger';
import { buildJobMatchPrompt, buildRelevanceFilterPrompt } from './prompts';

/** Result returned from Claude's job matching */
export interface MatchResult {
  score: number;
  reason: string;
  keyMatches: string[];
}

/** Job data required for matching */
export interface JobForMatching {
  title: string;
  company: string;
  location: string;
  description: string;
}

/**
 * Scores a single job against the candidate profile using Claude.
 * Returns a structured match result with score, reason, and key matches.
 */
export async function matchJob(
  profileSummary: string,
  job: JobForMatching,
): Promise<MatchResult> {
  const client = new Anthropic({ apiKey: config.claude.apiKey });

  // Truncate description to limit token usage
  const truncatedDescription =
    job.description.length > config.scraper.maxDescriptionLength
      ? job.description.slice(0, config.scraper.maxDescriptionLength) + '...'
      : job.description;

  const prompt = buildJobMatchPrompt(profileSummary, {
    ...job,
    description: truncatedDescription,
  });

  try {
    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: config.claude.maxTokens,
      temperature: config.claude.temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude did not return a text response');
    }

    const parsed = JSON.parse(textBlock.text.trim()) as MatchResult;

    // Validate response shape
    if (
      typeof parsed.score !== 'number' ||
      typeof parsed.reason !== 'string' ||
      !Array.isArray(parsed.keyMatches)
    ) {
      throw new Error('Invalid match result structure');
    }

    // Clamp score to 0-100
    parsed.score = Math.max(0, Math.min(100, Math.round(parsed.score)));

    logger.info('Job matched', {
      title: job.title,
      company: job.company,
      score: parsed.score,
    });

    return parsed;
  } catch (error) {
    logger.error('Failed to match job', {
      title: job.title,
      company: job.company,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Matches multiple jobs in parallel with concurrency control.
 * Processes at most `maxConcurrent` jobs at a time.
 */
export async function matchJobsBatch(
  profileSummary: string,
  jobs: JobForMatching[],
  maxConcurrent: number = config.scraper.maxConcurrentMatches,
): Promise<(MatchResult | null)[]> {
  const results: (MatchResult | null)[] = new Array(jobs.length).fill(null);

  for (let i = 0; i < jobs.length; i += maxConcurrent) {
    const batch = jobs.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map((job) => matchJob(profileSummary, job)),
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result.status === 'fulfilled') {
        results[i + j] = result.value;
      } else {
        logger.error('Job match failed in batch', {
          job: jobs[i + j].title,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        results[i + j] = null;
      }
    }
  }

  return results;
}

/** Minimal job info needed for the batch relevance filter */
export interface JobForFiltering {
  linkedinId: string;
  title: string;
  company: string;
}

/**
 * Hard pre-filter: instantly rejects jobs whose titles contain excluded keywords.
 * Runs BEFORE the AI call — zero cost, zero latency.
 */
function preFilterByKeywords(jobs: JobForFiltering[]): {
  passed: JobForFiltering[];
  rejected: JobForFiltering[];
} {
  const excludeKeywords = config.profile.preferences.exclude_title_keywords;
  if (excludeKeywords.length === 0) return { passed: jobs, rejected: [] };

  const lowerKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();
    const isExcluded = lowerKeywords.some((kw) => titleLower.includes(kw));
    if (isExcluded) {
      rejected.push(job);
    } else {
      passed.push(job);
    }
  }

  return { passed, rejected };
}

/**
 * Deduplicates jobs that have the same title + company.
 * Keeps the first occurrence of each unique combo.
 */
function deduplicateJobs(jobs: JobForFiltering[]): {
  unique: JobForFiltering[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const unique: JobForFiltering[] = [];
  let duplicates = 0;

  for (const job of jobs) {
    const key = `${job.title.toLowerCase().trim()}|${job.company.toLowerCase().trim()}`;
    if (seen.has(key)) {
      duplicates++;
    } else {
      seen.add(key);
      unique.push(job);
    }
  }

  return { unique, duplicates };
}

/**
 * Filters a list of jobs for relevance using:
 * 1. Hard keyword pre-filter (instant, no AI cost)
 * 2. Deduplication (same title + company)
 * 3. AI call with strict prompt (seniority-aware, exclusion-aware)
 *
 * Returns the set of linkedinIds that passed all filters.
 */
export async function filterRelevantJobs(
  profileSummary: string,
  jobs: JobForFiltering[],
): Promise<Set<string>> {
  if (jobs.length === 0) return new Set();

  // Step 1: Hard keyword pre-filter
  const { passed: afterKeywords, rejected } = preFilterByKeywords(jobs);
  if (rejected.length > 0) {
    logger.info(`Keyword pre-filter: ${jobs.length} → ${afterKeywords.length} (rejected ${rejected.length})`, {
      rejectedTitles: rejected.map((j) => j.title),
    });
  }

  // Step 2: Deduplicate same title+company
  const { unique: afterDedup, duplicates } = deduplicateJobs(afterKeywords);
  if (duplicates > 0) {
    logger.info(`Dedup filter: ${afterKeywords.length} → ${afterDedup.length} (removed ${duplicates} duplicates)`);
  }

  if (afterDedup.length === 0) return new Set();

  // Step 3: AI relevance filter with strict rules
  const client = new Anthropic({ apiKey: config.claude.apiKey });

  const filteringRules = {
    targetSeniority: config.profile.preferences.target_seniority,
    excludeTitleKeywords: config.profile.preferences.exclude_title_keywords,
    preferredTechStack: config.profile.preferences.preferred_tech_stack,
  };

  const prompt = buildRelevanceFilterPrompt(profileSummary, afterDedup, filteringRules);

  try {
    logger.info(`AI filtering ${afterDedup.length} jobs (strict mode)...`);
    const callStart = Date.now();

    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: config.claude.maxTokens,
      temperature: config.claude.temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('Claude did not return a text response');
    }

    const parsed = JSON.parse(textBlock.text.trim()) as { relevantIds: string[] };

    if (!Array.isArray(parsed.relevantIds)) {
      throw new Error('Invalid relevance filter response — expected { relevantIds: [...] }');
    }

    const relevantSet = new Set(parsed.relevantIds);

    logger.info(`AI relevance filter complete`, {
      inputTotal: jobs.length,
      afterKeywordFilter: afterKeywords.length,
      afterDedup: afterDedup.length,
      aiKept: relevantSet.size,
      aiRejected: afterDedup.length - relevantSet.size,
      elapsed: `${Date.now() - callStart}ms`,
    });

    return relevantSet;
  } catch (error) {
    logger.error('Failed to filter jobs for relevance', {
      jobCount: afterDedup.length,
      error: error instanceof Error ? error.message : String(error),
    });
    // On failure, return the keyword-filtered set (don't lose pre-filter work)
    return new Set(afterDedup.map((j) => j.linkedinId));
  }
}
