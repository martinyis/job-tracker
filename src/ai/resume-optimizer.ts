import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../logger';
import { RichResumeSection } from '../google/doc-parser';
import { buildResumeOptimizerPrompt } from './resume-optimizer-prompt';

export interface OptimizedEntry {
  headerText: string;
  bullets: string[];
}

export interface OptimizedSkillCategory {
  name: string;
  skills: string;
}

export interface OptimizationResult {
  experience?: { entries: OptimizedEntry[] };
  projects?: { entries: OptimizedEntry[] };
  skills?: { categories: OptimizedSkillCategory[] };
  summary?: string;
  sectionsModified: string[];
  optimizationNotes: string;
}

interface OptimizeInput {
  sections: RichResumeSection[];
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  jobLocation: string;
  profileSummaryCache: string;
  contextFiles: string;
}

export async function optimizeResume(input: OptimizeInput): Promise<OptimizationResult> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const prompt = buildResumeOptimizerPrompt(input);

  logger.info('Calling Claude for resume optimization', {
    company: input.jobCompany,
    title: input.jobTitle,
    model: config.anthropic.model,
  });

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    temperature: config.anthropic.temperature,
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract text content from response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const rawText = textBlock.text.trim();

  // Parse JSON — handle potential markdown code fences
  let jsonStr = rawText;
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let result: OptimizationResult;
  try {
    result = JSON.parse(jsonStr);
  } catch (e) {
    logger.error('Failed to parse Claude response as JSON', { rawText: rawText.substring(0, 500) });
    throw new Error('Claude returned invalid JSON response');
  }

  // Validate required fields
  if (typeof result.optimizationNotes !== 'string') {
    throw new Error('Invalid optimization result: missing optimizationNotes');
  }

  if (!Array.isArray(result.sectionsModified)) {
    throw new Error('Invalid optimization result: missing sectionsModified array');
  }

  // Validate entry structures if present
  if (result.experience) {
    if (!Array.isArray(result.experience.entries)) {
      throw new Error('Invalid optimization result: experience.entries must be an array');
    }
    for (const entry of result.experience.entries) {
      if (typeof entry.headerText !== 'string' || !Array.isArray(entry.bullets)) {
        throw new Error('Invalid optimization result: each experience entry needs headerText and bullets');
      }
    }
  }

  if (result.projects) {
    if (!Array.isArray(result.projects.entries)) {
      throw new Error('Invalid optimization result: projects.entries must be an array');
    }
    for (const entry of result.projects.entries) {
      if (typeof entry.headerText !== 'string' || !Array.isArray(entry.bullets)) {
        throw new Error('Invalid optimization result: each project entry needs headerText and bullets');
      }
    }
  }

  if (result.skills) {
    if (!Array.isArray(result.skills.categories)) {
      throw new Error('Invalid optimization result: skills.categories must be an array');
    }
    for (const cat of result.skills.categories) {
      if (typeof cat.name !== 'string' || typeof cat.skills !== 'string') {
        throw new Error('Invalid optimization result: each skill category needs name and skills');
      }
    }
  }

  logger.info('Resume optimization completed', {
    sectionsModified: result.sectionsModified,
    notesPreview: result.optimizationNotes.substring(0, 100),
  });

  return result;
}
