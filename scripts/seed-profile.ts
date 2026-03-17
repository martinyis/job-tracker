/**
 * One-time script to populate the database with profile data from resume.
 * Run with: npx tsx scripts/seed-profile.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding profile data...');

  // ─── Update UserProfile ────────────────────────────────
  await prisma.userProfile.upsert({
    where: { id: 'singleton' },
    update: {
      firstName: 'Stanislav',
      lastName: 'Babak',
      email: 'martinyis11@gmail.com',
      phone: '(603) 312-2047',
      linkedinUrl: 'https://linkedin.com/in/stanislav-babak',
      website: 'https://github.com/martinyis',
      city: '',
      state: 'NH',
      country: 'US',
      yearsOfExperience: 1,
      remoteOnly: false,
      willingToRelocate: true,
      openToContract: true,
      visaSponsorshipNeeded: false,
      minSalary: 70000,
      preferredCompanySize: JSON.stringify(['startup', 'small', 'medium']),
      avoidIndustries: JSON.stringify(['defense', 'gambling', 'tobacco']),
      preferredTechStack: JSON.stringify([
        'TypeScript', 'JavaScript', 'Python', 'React', 'Next.js', 'Node.js',
        'React Native', 'Django', 'FastAPI', 'MongoDB', 'PostgreSQL', 'Redis',
        'GCP', 'Docker', 'Kubernetes', 'Prisma', 'SQLite',
      ]),
      targetSeniority: JSON.stringify(['Entry level', 'Associate', 'Junior', 'Mid-Senior level']),
      excludeTitleKeywords: JSON.stringify([
        'Senior Staff', 'Principal', 'Director', 'VP', 'Head of',
        'Staff Engineer', 'Distinguished', 'Fellow', 'Architect',
        'Manager', 'Lead Manager', 'C-Suite', 'Chief',
        'Data Scientist', 'ML Engineer', 'Machine Learning',
        'DevOps', 'SRE', 'Site Reliability',
        'QA', 'Quality Assurance', 'Test Engineer',
        'Security Engineer', 'Cybersecurity',
        'Hardware', 'Embedded', 'Firmware',
        'SAP', 'Salesforce', 'Oracle', 'Mainframe', 'COBOL',
      ]),
      includeTitlePatterns: JSON.stringify([
        'Software Engineer', 'Software Developer', 'Full Stack',
        'Frontend', 'Front-End', 'Backend', 'Back-End',
        'Web Developer', 'Application Developer',
        'React Developer', 'Node.js Developer', 'TypeScript Developer',
        'Python Developer', 'Django Developer',
        'Mobile Developer', 'React Native Developer',
        'Junior Developer', 'Junior Engineer',
        'New Grad', 'Entry Level', 'Associate',
      ]),
      jobSearchDescription: 'New grad / early-career full-stack or frontend software engineer roles. I have hands-on experience building production apps with React, Next.js, Node.js, TypeScript, Python/Django, React Native, and cloud services (GCP). I thrive in fast-paced startup environments where I can ship features end-to-end. Looking for teams that value clean code, rapid iteration, and real user impact.',
      missionStatement: 'I want to join a team where I can grow as an engineer while building products that people actually use. I am excited about AI-powered applications, developer tools, and anything that automates tedious work. Startups and small companies where I can wear multiple hats and learn fast are ideal.',
      urgencySignals: 'Companies I have applied to before, roles at YC-backed startups, positions mentioning React Native + AI, teams building developer tools or automation, remote-friendly roles with strong mentorship, any role that explicitly says "new grad welcome".',
      keyInterests: JSON.stringify([
        'AI-powered applications', 'Developer tools', 'Automation',
        'Full-stack web development', 'Mobile development',
        'Startups', 'Open source', 'SaaS products',
      ]),
      dealbreakers: JSON.stringify([
        'No remote option at all', 'Requires 5+ years experience',
        'Unpaid or stipend-only', 'No engineering culture',
        'Legacy-only stack with no modernization plans',
      ]),
      // Invalidate cache so AI re-generates summary
      profileSummaryCache: null,
      profileSummaryCachedAt: null,
    },
    create: {
      id: 'singleton',
      firstName: 'Stanislav',
      lastName: 'Babak',
    },
  });
  console.log('  ✓ UserProfile updated');

  // ─── Clear existing work experience, education, skills ──
  await prisma.workExperience.deleteMany({ where: { profileId: 'singleton' } });
  await prisma.education.deleteMany({ where: { profileId: 'singleton' } });
  await prisma.skill.deleteMany({ where: { profileId: 'singleton' } });
  console.log('  ✓ Cleared existing entries');

  // ─── Work Experience ───────────────────────────────────
  const workEntries = [
    {
      employer: 'Mudface.ai',
      title: 'Full Stack Developer Intern',
      location: 'Remote',
      startDate: '2025-09',
      endDate: '2026-02',
      isCurrent: false,
      description: 'Built real-time messaging with WebSockets, developed onboarding flows in React Native, integrated Django/FastAPI backend with MongoDB and GCP. Implemented CI/CD pipelines and improved app performance.',
      sortOrder: 0,
    },
    {
      employer: 'TaskMind',
      title: 'Lead Software Engineer',
      location: 'Remote',
      startDate: '2025-06',
      endDate: '2026-01',
      isCurrent: false,
      description: 'Led development of AI SaaS platform using Next.js, Node.js, and Stripe. Built task management features with AI-powered prioritization. Managed GCP infrastructure and implemented real-time collaboration.',
      sortOrder: 1,
    },
    {
      employer: 'PractApp (Personal Project)',
      title: 'Full Stack Developer',
      location: 'Remote',
      startDate: '2024-06',
      endDate: '2025-08',
      isCurrent: false,
      description: 'Built a React Native language learning app with OpenAI integration and multilingual pipeline. Handled end-to-end development from mobile UI to backend APIs.',
      sortOrder: 2,
    },
    {
      employer: 'LinkedIn Job Tracker (Personal Project)',
      title: 'Creator & Developer',
      location: 'Remote',
      startDate: '2026-01',
      endDate: null,
      isCurrent: true,
      description: 'Built an automated AI agent that scrapes LinkedIn for job postings, uses AI to filter and score them, and presents results in a web dashboard. TypeScript, Playwright, Claude API, Prisma, SQLite.',
      sortOrder: 3,
    },
  ];

  for (const entry of workEntries) {
    await prisma.workExperience.create({
      data: { profileId: 'singleton', ...entry },
    });
  }
  console.log(`  ✓ Added ${workEntries.length} work experience entries`);

  // ─── Education ─────────────────────────────────────────
  await prisma.education.create({
    data: {
      profileId: 'singleton',
      institution: 'University of New Hampshire',
      degree: 'Bachelor of Science',
      fieldOfStudy: 'Computer Science',
      startDate: '2022-09',
      endDate: '2026-05',
      gpa: null,
      sortOrder: 0,
    },
  });
  console.log('  ✓ Added education entry');

  // ─── Skills ────────────────────────────────────────────
  const skills: Array<{ name: string; category: string; yearsOfExperience?: number; proficiency?: string }> = [
    // Languages
    { name: 'TypeScript', category: 'language', yearsOfExperience: 2, proficiency: 'advanced' },
    { name: 'JavaScript', category: 'language', yearsOfExperience: 3, proficiency: 'advanced' },
    { name: 'Python', category: 'language', yearsOfExperience: 2, proficiency: 'intermediate' },
    { name: 'HTML/CSS', category: 'language', yearsOfExperience: 3, proficiency: 'advanced' },
    { name: 'SQL', category: 'language', yearsOfExperience: 2, proficiency: 'intermediate' },

    // Frontend
    { name: 'React', category: 'frontend', yearsOfExperience: 2, proficiency: 'advanced' },
    { name: 'Next.js', category: 'frontend', yearsOfExperience: 1, proficiency: 'advanced' },
    { name: 'React Native', category: 'frontend', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Tailwind CSS', category: 'frontend', yearsOfExperience: 2, proficiency: 'advanced' },

    // Backend
    { name: 'Node.js', category: 'backend', yearsOfExperience: 2, proficiency: 'advanced' },
    { name: 'Express', category: 'backend', yearsOfExperience: 2, proficiency: 'advanced' },
    { name: 'Django', category: 'backend', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'FastAPI', category: 'backend', yearsOfExperience: 1, proficiency: 'intermediate' },

    // Databases
    { name: 'MongoDB', category: 'database', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'PostgreSQL', category: 'database', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'SQLite', category: 'database', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Redis', category: 'database', yearsOfExperience: 1, proficiency: 'beginner' },
    { name: 'Prisma', category: 'database', yearsOfExperience: 1, proficiency: 'intermediate' },

    // Cloud & DevOps
    { name: 'GCP', category: 'cloud', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Docker', category: 'devops', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Kubernetes', category: 'devops', yearsOfExperience: 1, proficiency: 'beginner' },
    { name: 'CI/CD', category: 'devops', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Git', category: 'devops', yearsOfExperience: 3, proficiency: 'advanced' },

    // AI & APIs
    { name: 'Claude API', category: 'ai', yearsOfExperience: 1, proficiency: 'advanced' },
    { name: 'OpenAI API', category: 'ai', yearsOfExperience: 1, proficiency: 'intermediate' },

    // Tools & Other
    { name: 'Stripe Integration', category: 'tool', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'WebSockets', category: 'tool', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'Playwright', category: 'tool', yearsOfExperience: 1, proficiency: 'intermediate' },
    { name: 'REST APIs', category: 'tool', yearsOfExperience: 2, proficiency: 'advanced' },
  ];

  for (const skill of skills) {
    await prisma.skill.create({
      data: { profileId: 'singleton', ...skill },
    });
  }
  console.log(`  ✓ Added ${skills.length} skills`);

  // ─── AppSettings (Search Keywords) ─────────────────────
  await prisma.appSettings.upsert({
    where: { id: 'singleton' },
    update: {
      searchKeywords: JSON.stringify([
        'software engineer new grad',
        'junior software engineer',
        'full stack developer',
        'frontend developer react',
        'software developer entry level',
        'react developer',
        'typescript developer',
        'node.js developer',
        'python developer junior',
        'web developer',
        'react native developer',
        'junior full stack engineer',
      ]),
    },
    create: {
      id: 'singleton',
      searchKeywords: JSON.stringify([
        'software engineer new grad',
        'junior software engineer',
        'full stack developer',
        'frontend developer react',
        'software developer entry level',
      ]),
    },
  });
  console.log('  ✓ AppSettings search keywords updated');

  console.log('\nDone! Profile fully populated.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
