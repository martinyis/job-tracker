import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import pdfParse from 'pdf-parse';
import { config, initConfig, validateConfig } from './config';
import { logger } from './logger';
import { prisma } from './database/client';
import { getPrimaryResume, invalidateProfileSummaryCache, parseJsonArray } from './database/profile-queries';

interface ExtractedSkill {
  name: string;
  category: string;
  yearsOfExperience: number | null;
  proficiency: string | null;
}

function buildSkillExtractionPrompt(data: {
  resumeText: string;
  workExperience: { employer: string; title: string; startDate: string; endDate: string | null; description: string }[];
  education: { institution: string; degree: string; fieldOfStudy: string }[];
  summary: string;
  preferredTechStack: string[];
}): string {
  const workSection = data.workExperience
    .map((w) => `${w.title} at ${w.employer} (${w.startDate} – ${w.endDate ?? 'present'})\n${w.description}`)
    .join('\n\n');

  const eduSection = data.education
    .map((e) => `${e.degree} in ${e.fieldOfStudy} — ${e.institution}`)
    .join('\n');

  return `You are a skill extraction expert. Analyze ALL of the following data about a candidate and extract EVERY skill they possess.

RESUME TEXT:
${data.resumeText}

WORK EXPERIENCE:
${workSection}

EDUCATION:
${eduSection}

PERSONAL SUMMARY:
${data.summary}

PREFERRED TECH STACK:
${data.preferredTechStack.join(', ')}

INSTRUCTIONS:
1. Extract ALL technical and soft skills mentioned or implied across ALL data sources.
2. For each skill, estimate years of experience based on work history dates and descriptions.
3. Assign a proficiency level based on how prominently and frequently the skill appears.
4. Categorize each skill into exactly one of these categories:
   - "language" — programming languages (TypeScript, Python, JavaScript, etc.)
   - "frontend" — frontend frameworks and libraries (React, Next.js, React Native, etc.)
   - "backend" — backend frameworks and tools (Node.js, Express, FastAPI, Django, etc.)
   - "database" — databases and data stores (MongoDB, SQLite, Redis, PostgreSQL, etc.)
   - "cloud" — cloud platforms and services (AWS, GCP, S3, App Engine, etc.)
   - "devops" — DevOps, CI/CD, containers (Docker, Cloud Build, Git, etc.)
   - "ai/ml" — AI, ML, LLM tools and concepts (OpenAI API, RAG, prompt engineering, etc.)
   - "tool" — development tools, libraries, and APIs (Stripe, Playwright, Selenium, tRPC, etc.)
   - "soft" — soft skills (leadership, system design, communication, etc.)
5. Proficiency levels: "beginner", "intermediate", "advanced", "expert"
6. Be thorough — include skills from EVERY mention across all data sources.
7. Do NOT include generic/vague entries like "programming" or "software" — be specific.

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "skills": [
    { "name": "TypeScript", "category": "language", "yearsOfExperience": 2, "proficiency": "advanced" },
    { "name": "React", "category": "frontend", "yearsOfExperience": 2, "proficiency": "advanced" }
  ]
}`;
}

async function main(): Promise<void> {
  logger.info('Skill generation starting...');

  await initConfig();

  const { valid, errors } = validateConfig();
  if (!valid) {
    for (const error of errors) {
      logger.error(`Config error: ${error}`);
    }
    process.exit(1);
  }

  // 1. Gather all data sources
  // Resume PDF text
  const resumeDoc = await getPrimaryResume();
  const resumePath = resumeDoc ? path.resolve('./data', resumeDoc.storagePath) : null;

  let resumeText = '';
  if (resumePath && fs.existsSync(resumePath)) {
    const buffer = fs.readFileSync(resumePath);
    const data = await pdfParse(buffer);
    resumeText = data.text;
    logger.info(`Resume loaded: ${resumeText.length} chars`);
  } else {
    logger.warn('No resume PDF found — generating skills from DB data only');
  }

  // Work experience
  const workExperience = await prisma.workExperience.findMany({
    where: { profileId: 'singleton' },
    orderBy: { sortOrder: 'asc' },
  });

  // Education
  const education = await prisma.education.findMany({
    where: { profileId: 'singleton' },
    orderBy: { sortOrder: 'asc' },
  });

  // Profile
  const profile = await prisma.userProfile.findUnique({
    where: { id: 'singleton' },
    select: { summary: true, preferredTechStack: true },
  });

  if (!profile && !resumeText && workExperience.length === 0) {
    logger.error('No data available to extract skills from. Add a resume, work experience, or profile data first.');
    process.exit(1);
  }

  const prompt = buildSkillExtractionPrompt({
    resumeText,
    workExperience: workExperience.map((w) => ({
      employer: w.employer,
      title: w.title,
      startDate: w.startDate,
      endDate: w.endDate,
      description: w.description,
    })),
    education: education.map((e) => ({
      institution: e.institution,
      degree: e.degree,
      fieldOfStudy: e.fieldOfStudy,
    })),
    summary: profile?.summary ?? '',
    preferredTechStack: parseJsonArray(profile?.preferredTechStack ?? '[]'),
  });

  // 2. Call AI
  logger.info('Calling AI to extract skills...');
  const client = new OpenAI({
    apiKey: config.nvidia.apiKey,
    baseURL: config.nvidia.baseURL,
  });

  const response = await client.chat.completions.create({
    model: config.nvidia.model,
    max_tokens: 16384,
    temperature: 0.2,
    top_p: 1,
    messages: [{ role: 'user', content: prompt }],
  }, { timeout: 120_000 });

  const msg = response.choices[0]?.message as unknown as Record<string, unknown>;
  const content = (msg?.content ?? msg?.reasoning_content ?? '') as string;
  if (!content) {
    logger.error('AI returned no response', { message: JSON.stringify(msg) });
    process.exit(1);
  }

  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  let skills: ExtractedSkill[];
  try {
    const parsed = JSON.parse(cleaned);
    skills = parsed.skills;
    if (!Array.isArray(skills)) {
      throw new Error('Response missing "skills" array');
    }
  } catch (err) {
    logger.error('Failed to parse AI response', { response: cleaned, error: String(err) });
    process.exit(1);
  }

  // 3. Validate and clean
  const validCategories = new Set(['language', 'frontend', 'backend', 'database', 'cloud', 'devops', 'ai/ml', 'tool', 'soft']);
  const validProficiencies = new Set(['beginner', 'intermediate', 'advanced', 'expert']);

  const cleanedSkills = skills
    .filter((s) => s.name && typeof s.name === 'string')
    .map((s) => ({
      name: s.name.trim(),
      category: validCategories.has(s.category) ? s.category : 'technical',
      yearsOfExperience: typeof s.yearsOfExperience === 'number' ? s.yearsOfExperience : null,
      proficiency: validProficiencies.has(s.proficiency ?? '') ? s.proficiency : null,
    }));

  // Deduplicate by name (case-insensitive)
  const seen = new Set<string>();
  const uniqueSkills = cleanedSkills.filter((s) => {
    const key = s.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  logger.info(`Extracted ${uniqueSkills.length} unique skills from AI`);

  // 4. Replace all skills in DB
  await prisma.$transaction([
    prisma.skill.deleteMany({ where: { profileId: 'singleton' } }),
    ...uniqueSkills.map((s) =>
      prisma.skill.create({
        data: {
          profileId: 'singleton',
          name: s.name,
          category: s.category,
          yearsOfExperience: s.yearsOfExperience,
          proficiency: s.proficiency,
        },
      }),
    ),
  ]);

  await invalidateProfileSummaryCache();

  // 5. Print summary
  const byCat: Record<string, number> = {};
  for (const s of uniqueSkills) {
    byCat[s.category] = (byCat[s.category] || 0) + 1;
  }

  console.log(`\n✅ Generated ${uniqueSkills.length} skills:\n`);
  for (const [cat, count] of Object.entries(byCat).sort()) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log('');
  for (const s of uniqueSkills) {
    const years = s.yearsOfExperience ? ` (${s.yearsOfExperience}y)` : '';
    const prof = s.proficiency ? ` [${s.proficiency}]` : '';
    console.log(`  ${s.category.padEnd(10)} ${s.name}${years}${prof}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error('Skill generation failed', { error: String(err) });
  console.error('Failed:', err);
  process.exit(1);
});
