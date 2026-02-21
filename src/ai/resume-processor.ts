import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { config } from '../config';
import { logger } from '../logger';
import { buildResumeSummaryPrompt } from './prompts';
import {
  getProfileSummaryCache,
  setProfileSummaryCache,
  getProfileForAI,
  getPrimaryResume,
} from '../database/profile-queries';

/**
 * Extracts text content from a PDF file.
 */
async function extractPdfText(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

/**
 * Processes the user's resume PDF and profile context once,
 * generating a structured profile summary cached in the database.
 * Subsequent runs reuse the cached summary.
 */
export async function getOrCreateProfileSummary(): Promise<string> {
  // Check DB cache first
  const cached = await getProfileSummaryCache();
  if (cached.cache) {
    logger.info('Using cached profile summary');
    return cached.cache;
  }

  logger.info('Generating profile summary from resume...');

  // Find primary resume document
  const resumeDoc = await getPrimaryResume();
  const resumePath = resumeDoc
    ? path.resolve('./data', resumeDoc.storagePath)
    : path.resolve('./data/resume.pdf'); // fallback for legacy location

  if (!fs.existsSync(resumePath)) {
    throw new Error(`Resume not found at ${resumePath}. Upload a resume via the Profile page.`);
  }
  const resumeText = await extractPdfText(resumePath);

  // Get profile context from DB instead of settings.json
  const profileData = await getProfileForAI();
  const additionalContext = JSON.stringify(profileData, null, 2);

  const client = new OpenAI({
    apiKey: config.nvidia.apiKey,
    baseURL: config.nvidia.baseURL,
  });

  const prompt = buildResumeSummaryPrompt(additionalContext);

  const response = await client.chat.completions.create({
    model: config.nvidia.model,
    max_tokens: 4096,
    temperature: config.nvidia.temperature,
    top_p: 1,
    messages: [
      {
        role: 'user',
        content: `RESUME CONTENT:\n${resumeText}\n\n${prompt}`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Model did not return a text response for resume processing');
  }

  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    JSON.parse(cleaned);
  } catch {
    logger.error('Model returned invalid JSON for profile summary', { response: cleaned });
    throw new Error('Profile summary is not valid JSON. Please check model response.');
  }

  // Cache in DB instead of writing to disk
  await setProfileSummaryCache(cleaned);

  logger.info('Profile summary generated and cached');
  return cleaned;
}
