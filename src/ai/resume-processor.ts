import Anthropic from '@anthropic-ai/sdk';
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

  // Return cached summary if it exists
  if (fs.existsSync(summaryPath)) {
    logger.info('Using cached profile summary');
    return fs.readFileSync(summaryPath, 'utf-8');
  }

  logger.info('Generating profile summary from resume...');

  // Read and parse resume PDF
  if (!fs.existsSync(config.paths.resume)) {
    throw new Error(`Resume not found at ${config.paths.resume}. Place your resume.pdf in the data/ directory.`);
  }
  const resumeText = await extractPdfText(config.paths.resume);

  // Read profile context from settings.json
  const settings = loadSettings();
  const additionalContext = JSON.stringify(settings.profile, null, 2);

  // Call Claude with extracted resume text
  const client = new Anthropic({ apiKey: config.claude.apiKey });

  const prompt = buildResumeSummaryPrompt(additionalContext);

  const response = await client.messages.create({
    model: config.claude.model,
    max_tokens: 2000,
    temperature: config.claude.temperature,
    messages: [
      {
        role: 'user',
        content: `RESUME CONTENT:\n${resumeText}\n\n${prompt}`,
      },
    ],
  });

  // Extract text response
  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude did not return a text response for resume processing');
  }

  const summary = textBlock.text.trim();

  // Validate it's valid JSON
  try {
    JSON.parse(summary);
  } catch {
    logger.error('Claude returned invalid JSON for profile summary', { response: summary });
    throw new Error('Profile summary is not valid JSON. Please check Claude response.');
  }

  // Cache to disk
  const summaryDir = path.dirname(summaryPath);
  if (!fs.existsSync(summaryDir)) {
    fs.mkdirSync(summaryDir, { recursive: true });
  }
  fs.writeFileSync(summaryPath, summary, 'utf-8');

  logger.info('Profile summary generated and cached');
  return summary;
}
