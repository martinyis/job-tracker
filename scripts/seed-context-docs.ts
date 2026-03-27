/**
 * One-time script to import existing context files into the ContextDocument table.
 * Run with: npx tsx scripts/seed-context-docs.ts
 *
 * Safe to re-run — uses upsert so existing content won't be duplicated.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  // Ensure profile exists
  await prisma.userProfile.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

  const dataDir = path.join(process.cwd(), 'data');

  // 1. Personal Context
  let personalContent = '';
  try {
    personalContent = fs.readFileSync(path.join(dataDir, 'martin-context.md'), 'utf-8');
    console.log(`Read personal context: ${personalContent.length} chars`);
  } catch {
    console.log('No martin-context.md found, using empty string');
  }

  await prisma.contextDocument.upsert({
    where: { profileId_slug: { profileId: 'singleton', slug: 'personal-context' } },
    update: { content: personalContent },
    create: {
      profileId: 'singleton',
      name: 'Personal Context',
      slug: 'personal-context',
      content: personalContent,
      sortOrder: 0,
    },
  });

  // 2. Project Details
  let projectContent = '';
  try {
    projectContent = fs.readFileSync(path.join(dataDir, 'project-details.md'), 'utf-8');
    console.log(`Read project details: ${projectContent.length} chars`);
  } catch {
    console.log('No project-details.md found, using empty string');
  }

  await prisma.contextDocument.upsert({
    where: { profileId_slug: { profileId: 'singleton', slug: 'project-details' } },
    update: { content: projectContent },
    create: {
      profileId: 'singleton',
      name: 'Project Details',
      slug: 'project-details',
      content: projectContent,
      sortOrder: 1,
    },
  });

  // 3. Writing/Voice Samples (concatenate all .txt files)
  let voiceContent = '';
  try {
    const samplesDir = path.join(dataDir, 'writing-samples');
    const files = fs.readdirSync(samplesDir)
      .filter((f) => f.endsWith('.txt'))
      .sort();
    voiceContent = files
      .map((f) => fs.readFileSync(path.join(samplesDir, f), 'utf-8'))
      .join('\n\n---\n\n');
    console.log(`Read voice samples: ${voiceContent.length} chars from ${files.length} files`);
  } catch {
    console.log('No writing-samples/ directory found, using empty string');
  }

  await prisma.contextDocument.upsert({
    where: { profileId_slug: { profileId: 'singleton', slug: 'voice-samples' } },
    update: { content: voiceContent },
    create: {
      profileId: 'singleton',
      name: 'Voice Samples',
      slug: 'voice-samples',
      content: voiceContent,
      sortOrder: 2,
    },
  });

  console.log('Done! Context documents seeded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
