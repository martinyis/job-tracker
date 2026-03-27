/**
 * Quick test script for chat prompt voice tuning.
 *
 * Usage:
 *   pbpaste | npx tsx test-chat-prompt.ts "What interests you about this role?"
 *   cat job.txt | npx tsx test-chat-prompt.ts "Describe a challenging project"
 *   npx tsx test-chat-prompt.ts "Why this company?" < job.txt
 *
 * Job description: piped via stdin (copy it, then pbpaste |)
 * Question: first CLI argument (defaults to "What interests you about working for this company?")
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { buildChatSystemPrompt } from './src/chat/chat-prompt';
import { getOrCreateProfile } from './src/database/profile-queries';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const question = process.argv[2] || 'What interests you about working for this company?';
  const description = await readStdin();

  if (!description) {
    console.error('No job description provided. Pipe it via stdin:');
    console.error('  pbpaste | npx tsx test-chat-prompt.ts "Your question here"');
    process.exit(1);
  }

  const profile = await getOrCreateProfile();

  const job = {
    title: '',
    company: '',
    location: '',
    description,
    seniorityLevel: '',
    employmentType: '',
    applicantCount: '',
    companyInfo: '',
    postedBy: '',
    postedByTitle: '',
    postedByProfile: '',
    matchScore: 0,
    matchReason: '',
    priority: 'medium',
    priorityReason: '',
    actionItems: '[]',
    redFlags: '[]',
    keyMatches: '[]',
    contactPeople: '[]',
  };

  const sp = buildChatSystemPrompt(
    {
      firstName: profile.firstName,
      lastName: profile.lastName,
      profileSummaryCache: profile.profileSummaryCache,
      jobSearchDescription: profile.jobSearchDescription,
      missionStatement: profile.missionStatement,
      skills: profile.skills,
      workExperience: profile.workExperience.slice(0, 5),
      contextDocuments: profile.contextDocuments.map((d) => ({ slug: d.slug, content: d.content })),
    },
    job,
  );

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`--- "${question}" ---\n`);

  const r = await client.messages.create({
    model: 'claude-sonnet-4-6',
    system: sp,
    messages: [{ role: 'user', content: question }],
    max_tokens: 1024,
    temperature: 0.7,
  });

  const t = r.content[0]?.type === 'text' ? r.content[0].text : '(no text)';
  console.log(t);
  console.log(`\n--- ${t.split(/\s+/).length} words ---`);

  const { PrismaClient } = await import('@prisma/client');
  await new PrismaClient().$disconnect();
}

main().catch(console.error);
