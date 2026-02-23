import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { buildJobMatchPrompt, buildRelevanceFilterPrompt, FilteringRules } from './prompts';

/** Result returned from the AI model's job matching */
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

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: config.nvidia.apiKey,
    baseURL: config.nvidia.baseURL,
  });
}

/**
 * Scores a single job against the candidate profile using Kimi K2.5.
 * Returns a structured match result with score, reason, and key matches.
 */
export async function matchJob(
  profileSummary: string,
  job: JobForMatching,
): Promise<MatchResult> {
  const client = createClient();

  const truncatedDescription =
    job.description.length > config.scraper.maxDescriptionLength
      ? job.description.slice(0, config.scraper.maxDescriptionLength) + '...'
      : job.description;

  const prompt = buildJobMatchPrompt(profileSummary, {
    ...job,
    description: truncatedDescription,
  });

  try {
    const response = await client.chat.completions.create({
      model: config.nvidia.model,
      max_tokens: config.nvidia.maxTokens,
      temperature: config.nvidia.temperature,
      top_p: 1,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Model did not return a text response');
    }

    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as MatchResult;

    if (
      typeof parsed.score !== 'number' ||
      typeof parsed.reason !== 'string' ||
      !Array.isArray(parsed.keyMatches)
    ) {
      throw new Error('Invalid match result structure');
    }

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

/** Profile preferences passed into filtering functions */
export interface ProfilePreferences {
  excludeTitleKeywords: string[];
  includeTitlePatterns: string[];
  targetSeniority: string[];
  preferredTechStack: string[];
  jobSearchDescription: string;
}

/** Escapes special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Hard pre-filter: instantly rejects jobs whose titles contain excluded keywords.
 * Uses word-boundary matching so "sr" matches "Sr Engineer" without needing exact punctuation.
 * Special-character keywords (c++, .net) fall back to simple includes().
 */
function preFilterByKeywords(jobs: JobForFiltering[], excludeKeywords: string[]): {
  passed: JobForFiltering[];
  rejected: JobForFiltering[];
} {
  if (excludeKeywords.length === 0) return { passed: jobs, rejected: [] };

  // Build regexes for each keyword, handling punctuation gracefully
  const matchers = excludeKeywords.map((kw) => {
    const normalized = kw.trim().toLowerCase();
    // Strip trailing period for matching (so "sr." matches "sr ")
    const base = normalized.replace(/\.+$/, '');
    // If keyword is purely alphanumeric/spaces, use word boundaries
    if (/^[a-z0-9\s]+$/i.test(base)) {
      return new RegExp(`\\b${escapeRegex(base)}\\b`, 'i');
    }
    // For special-character keywords (c++, .net), use simple includes
    return null; // will fall back to includes
  });

  const rawKeywords = excludeKeywords.map((kw) => kw.trim().toLowerCase());

  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();
    const isExcluded = matchers.some((regex, i) => {
      if (regex) return regex.test(titleLower);
      return titleLower.includes(rawKeywords[i]);
    });
    if (isExcluded) {
      rejected.push(job);
    } else {
      passed.push(job);
    }
  }

  return { passed, rejected };
}

/**
 * Rejects jobs whose titles contain seniority level numbers (II, III, IV, 2, 3, 4, etc.)
 * that indicate mid-senior to senior level. Only active when targetSeniority is set
 * and does NOT include "senior" or "staff" levels.
 */
function preFilterBySeniorityLevel(
  jobs: JobForFiltering[],
  targetSeniority: string[],
): { passed: JobForFiltering[]; rejected: JobForFiltering[] } {
  if (targetSeniority.length === 0) return { passed: jobs, rejected: [] };

  const targets = targetSeniority.map((s) => s.toLowerCase());
  const allowsSenior = targets.some((t) => t.includes('senior') || t.includes('staff') || t.includes('principal'));
  if (allowsSenior) return { passed: jobs, rejected: [] };

  const allowsMid = targets.some((t) => t === 'mid' || t === 'mid-level' || t === 'intermediate');

  // Regex to match level indicators: "Engineer III", "Developer IV", "Engineer 3"
  const seniorLevelPattern = /\b(III|IV|V|VI|VII)\b|\b([3-9])\s*(?:\(|$|-|,|:)/i;
  const midLevelPattern = /\bII\b|\b2\s*(?:\(|$|-|,|:)/i;

  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const title = job.title;
    if (seniorLevelPattern.test(title)) {
      rejected.push(job);
    } else if (!allowsMid && midLevelPattern.test(title)) {
      rejected.push(job);
    } else {
      passed.push(job);
    }
  }

  return { passed, rejected };
}

/**
 * Whitelist pre-filter: keeps only jobs whose titles match at least one
 * inclusion pattern. When the whitelist is empty, all jobs pass (disabled).
 * Patterns are case-insensitive substring matches.
 */
function preFilterByWhitelist(
  jobs: JobForFiltering[],
  includePatterns: string[],
): { passed: JobForFiltering[]; rejected: JobForFiltering[] } {
  if (includePatterns.length === 0) return { passed: jobs, rejected: [] };

  const lowerPatterns = includePatterns.map((p) => p.trim().toLowerCase());
  const passed: JobForFiltering[] = [];
  const rejected: JobForFiltering[] = [];

  for (const job of jobs) {
    const titleLower = job.title.toLowerCase();
    const matches = lowerPatterns.some((pattern) => titleLower.includes(pattern));
    if (matches) {
      passed.push(job);
    } else {
      rejected.push(job);
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
 * Filters a list of jobs for relevance using a multi-layer pipeline:
 * 1. Keyword blacklist pre-filter (word-boundary matching, zero cost)
 * 2. Seniority level number filter (zero cost)
 * 3. Title whitelist inclusion filter (zero cost, optional)
 * 4. Deduplication (same title + company)
 * 5. AI batch filter (one API call, fail-closed on error)
 *
 * Returns the set of linkedinIds that passed all filters.
 */
export async function filterRelevantJobs(
  profileSummary: string,
  jobs: JobForFiltering[],
  preferences: ProfilePreferences,
): Promise<Set<string>> {
  if (jobs.length === 0) return new Set();

  // Layer 1: Keyword blacklist
  const { passed: afterKeywords, rejected: keywordRejected } =
    preFilterByKeywords(jobs, preferences.excludeTitleKeywords);
  if (keywordRejected.length > 0) {
    logger.info(`Keyword pre-filter: ${jobs.length} -> ${afterKeywords.length} (rejected ${keywordRejected.length})`, {
      rejectedTitles: keywordRejected.map((j) => j.title),
    });
  }

  // Layer 2: Seniority level numbers
  const { passed: afterSeniority, rejected: seniorityRejected } =
    preFilterBySeniorityLevel(afterKeywords, preferences.targetSeniority);
  if (seniorityRejected.length > 0) {
    logger.info(`Seniority level filter: ${afterKeywords.length} -> ${afterSeniority.length} (rejected ${seniorityRejected.length})`, {
      rejectedTitles: seniorityRejected.map((j) => j.title),
    });
  }

  // Layer 3: Title whitelist (skip if empty)
  const { passed: afterWhitelist, rejected: whitelistRejected } =
    preFilterByWhitelist(afterSeniority, preferences.includeTitlePatterns);
  if (whitelistRejected.length > 0) {
    logger.info(`Whitelist pre-filter: ${afterSeniority.length} -> ${afterWhitelist.length} (rejected ${whitelistRejected.length})`, {
      rejectedTitles: whitelistRejected.map((j) => j.title),
    });
  }

  // Layer 4: Deduplication
  const { unique: afterDedup, duplicates } = deduplicateJobs(afterWhitelist);
  if (duplicates > 0) {
    logger.info(`Dedup filter: ${afterWhitelist.length} -> ${afterDedup.length} (removed ${duplicates} duplicates)`);
  }

  if (afterDedup.length === 0) return new Set();

  // Layer 5: AI batch filter
  const client = createClient();

  const filteringRules: FilteringRules = {
    targetSeniority: preferences.targetSeniority,
    excludeTitleKeywords: preferences.excludeTitleKeywords,
    preferredTechStack: preferences.preferredTechStack,
    includeTitlePatterns: preferences.includeTitlePatterns,
    jobSearchDescription: preferences.jobSearchDescription,
  };

  const prompt = buildRelevanceFilterPrompt(profileSummary, afterDedup, filteringRules);

  try {
    // Log the jobs being sent to the AI for debugging
    logger.info(`AI filtering ${afterDedup.length} jobs (strict mode)...`, {
      jobsSentToAI: afterDedup.map(j => ({ id: j.linkedinId, title: j.title, company: j.company })),
    });
    const callStart = Date.now();

    // Add a timeout to the AI call to prevent it from hanging forever
    const AI_TIMEOUT_MS = 60_000; // 60 seconds max
    const aiPromise = client.chat.completions.create({
      model: config.nvidia.model,
      max_tokens: config.nvidia.maxTokens,
      temperature: config.nvidia.temperature,
      top_p: 1,
      messages: [{ role: 'user', content: prompt }],
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`AI filter timed out after ${AI_TIMEOUT_MS / 1000}s`)), AI_TIMEOUT_MS),
    );
    const response = await Promise.race([aiPromise, timeoutPromise]);

    const content = response.choices[0]?.message?.content;
    logger.info('AI filter raw response', {
      content: content?.slice(0, 500),
      elapsed: `${Date.now() - callStart}ms`,
    });

    if (!content) {
      throw new Error('Model did not return a text response');
    }

    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as { relevantIds: string[] };

    if (!Array.isArray(parsed.relevantIds)) {
      throw new Error('Invalid relevance filter response — expected { relevantIds: [...] }');
    }

    const relevantSet = new Set(parsed.relevantIds);

    // Log which jobs were kept vs rejected by AI
    const keptJobs = afterDedup.filter(j => relevantSet.has(j.linkedinId));
    const rejectedByAI = afterDedup.filter(j => !relevantSet.has(j.linkedinId));
    logger.info(`AI relevance filter complete`, {
      inputTotal: jobs.length,
      afterKeywordFilter: afterKeywords.length,
      afterSeniorityFilter: afterSeniority.length,
      afterWhitelistFilter: afterWhitelist.length,
      afterDedup: afterDedup.length,
      aiKept: relevantSet.size,
      aiKeptTitles: keptJobs.map(j => j.title),
      aiRejectedTitles: rejectedByAI.map(j => `${j.title} @ ${j.company}`),
      elapsed: `${Date.now() - callStart}ms`,
    });

    return relevantSet;
  } catch (error) {
    logger.error('AI filter failed -- rejecting all jobs (fail closed). They will be re-evaluated next cycle.', {
      jobCount: afterDedup.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}
