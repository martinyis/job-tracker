import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { config, loadSettings } from '../config';
import { logger } from '../logger';
import { buildResumeSummaryPrompt } from './prompts';

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
 * generating a structured profile summary cached to disk.
 * Subsequent runs reuse the cached summary.
 */
export async function getOrCreateProfileSummary(): Promise<string> {
  const summaryPath = config.paths.profileSummary;

  if (fs.existsSync(summaryPath)) {
    logger.info('Using cached profile summary');
    return fs.readFileSync(summaryPath, 'utf-8');
  }

  logger.info('Generating profile summary from resume...');

  if (!fs.existsSync(config.paths.resume)) {
    throw new Error(`Resume not found at ${config.paths.resume}. Place your resume.pdf in the data/ directory.`);
  }
  const resumeText = await extractPdfText(config.paths.resume);

  const settings = loadSettings();
  const additionalContext = JSON.stringify(settings.profile, null, 2);

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

  const summaryDir = path.dirname(summaryPath);
  if (!fs.existsSync(summaryDir)) {
    fs.mkdirSync(summaryDir, { recursive: true });
  }
  fs.writeFileSync(summaryPath, cleaned, 'utf-8');

  logger.info('Profile summary generated and cached');
  return cleaned;
}
