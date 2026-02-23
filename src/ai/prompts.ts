/**
 * Prompt templates for AI interactions (NVIDIA Kimi K2.5).
 * Separated for easy tuning and maintenance.
 */

/**
 * Prompt to generate a structured profile summary from a resume and context.
 * Used once on first run; result is cached in profile-summary.json.
 */
export function buildResumeSummaryPrompt(additionalContext: string): string {
  return `Analyze the provided resume PDF and additional context below. Create a concise profile summary for job matching.

Include the following in your summary:
- Skills (technical and soft)
- Years of experience per technology
- Previous roles and industries
- Career goals and preferences
- Education background
- Key achievements

ADDITIONAL CONTEXT:
${additionalContext}

Output ONLY valid JSON (no markdown, no code fences). Use this exact structure:
{
  "skills": {
    "technical": ["skill1", "skill2"],
    "soft": ["skill1", "skill2"]
  },
  "experience": {
    "totalYears": <number>,
    "byTechnology": { "tech": <years> },
    "roles": [
      { "title": "...", "company": "...", "duration": "...", "industry": "..." }
    ]
  },
  "education": [
    { "degree": "...", "institution": "...", "year": "..." }
  ],
  "achievements": ["achievement1", "achievement2"],
  "careerGoals": "...",
  "preferences": {
    "preferredRoles": ["..."],
    "preferredIndustries": ["..."],
    "avoidIndustries": ["..."],
    "remotePreference": "...",
    "techStack": ["..."]
  }
}`;
}

/**
 * Prompt to score a job posting against the candidate profile.
 * Used for every new job discovered by the scraper.
 */
export function buildJobMatchPrompt(
  profileSummary: string,
  job: { title: string; company: string; location: string; description: string },
): string {
  return `You are an expert job matcher. Score this job against the candidate profile.

CANDIDATE PROFILE:
${profileSummary}

JOB POSTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description}

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "score": <number 0-100>,
  "reason": "<2-3 sentence explanation>",
  "keyMatches": ["match1", "match2", "match3"]
}

Scoring criteria:
- Required skills match (40 points)
- Experience level match (20 points)
- Industry/domain relevance (20 points)
- Role alignment with career goals (20 points)

Be strict: 50 = decent match, 70 = good match, 85+ = excellent match.
A score below 50 means the job is not a strong fit.`;
}

/** Filtering rules passed alongside the profile summary */
export interface FilteringRules {
  targetSeniority: string[];
  excludeTitleKeywords: string[];
  preferredTechStack: string[];
  includeTitlePatterns: string[];
  jobSearchDescription: string;
}

/**
 * Prompt to batch-filter a list of job titles for relevance.
 * Makes ONE call instead of scoring each job individually.
 * Returns only the IDs of jobs that are relevant to the candidate.
 *
 * This version is STRICT — anchored around what the candidate is looking for,
 * with explicit reject/accept categories and fail-toward-rejection bias.
 */
export function buildRelevanceFilterPrompt(
  profileSummary: string,
  jobs: { linkedinId: string; title: string; company: string }[],
  rules: FilteringRules,
): string {
  const jobList = jobs
    .map((j) => `- ID: ${j.linkedinId} | Title: "${j.title}" | Company: "${j.company}"`)
    .join('\n');

  const jobSearchSection = rules.jobSearchDescription
    ? `\nWHAT THE CANDIDATE IS LOOKING FOR:
${rules.jobSearchDescription}

A job is RELEVANT only if the role clearly involves the kind of work described above. The title must indicate a hands-on product development or engineering role. When in doubt, REJECT.`
    : '';

  const senioritySection = rules.targetSeniority.length > 0
    ? `\nSENIORITY RULES:
- The candidate targets: ${rules.targetSeniority.join(', ')} level roles.
- REJECT any title containing "Senior", "Sr", "Staff", "Principal", "Lead", "Director", "VP", "Head of", "Manager", or "Architect" unless the candidate's target seniority explicitly includes that level.
- REJECT titles with level numbers III, IV, V or higher (e.g., "Software Engineer III" = senior level).`
    : '';

  const techSection = rules.preferredTechStack.length > 0
    ? `\nTECH CONTEXT: The candidate works with ${rules.preferredTechStack.join(', ')}.
- REJECT roles focused on unrelated technology domains (embedded systems, hardware, ERP platforms like Guidewire/SAP/Salesforce/ServiceNow, mainframe, COBOL) unless the title is clearly a general software development role.`
    : '';

  const whitelistSection = rules.includeTitlePatterns.length > 0
    ? `\nTITLE GUIDANCE: The candidate is interested in roles matching these patterns: ${rules.includeTitlePatterns.join(', ')}.
- Use this as a signal for what the candidate considers relevant. Titles that are far outside these patterns are likely irrelevant.`
    : '';

  return `You are a STRICT job relevance filter. Given a candidate profile and a list of job postings (title + company only), return ONLY the IDs of jobs that are genuinely relevant.

RULES -- follow these exactly:
1. A job is RELEVANT only if it is a hands-on technical role where the person builds, develops, or engineers software products, features, or systems.
2. When in doubt, REJECT. It is far better to miss a borderline job than to include an irrelevant one. The scraper runs frequently -- missed jobs will appear again.
3. REJECT these categories regardless of how the title is worded:
   - Sales/presales roles (Solutions Engineer, Sales Engineer, Solutions Architect)
   - Developer relations/advocacy (Developer Advocate, Developer Evangelist, Community Engineer)
   - IT support/operations (IT Engineer, IT Specialist, Support Engineer, Systems Administrator)
   - QA/testing-only roles (QA Engineer, Test Engineer, SDET) unless the title says "Software Engineer in Test"
   - Non-software engineering (Mechanical, Electrical, Civil, Chemical, Industrial, Manufacturing, Hardware)
   - Data-only roles with no software development (Data Analyst, Business Analyst, Data Scientist) unless combined with engineering (Data Engineer is borderline -- reject unless it clearly involves software development)
   - Niche platform administration (Salesforce Admin, ServiceNow Admin, SAP Consultant)
   - Research-only roles (Research Scientist) unless combined with engineering
4. REJECT titles that are vague or clearly non-development (Programmer Analyst, Product Developer with no tech context, Specialist, Coordinator)
5. ACCEPT standard software development roles: Software Engineer, Developer, Frontend/Backend/Full Stack Engineer, Mobile Developer/Engineer, Web Developer, AI/ML Engineer (if building products), Platform Engineer (if building software platforms), DevOps Engineer (if it involves building tooling/infrastructure code)
${jobSearchSection}
${senioritySection}
${techSection}
${whitelistSection}

CANDIDATE PROFILE:
${profileSummary}

JOB POSTINGS:
${jobList}

Respond with ONLY valid JSON (no markdown, no code fences). Return ONLY the linkedinId values for jobs that are genuinely relevant:
{
  "relevantIds": ["id1", "id2", "id3"]
}

If NONE of the jobs are relevant, return: { "relevantIds": [] }`;
}

/** Profile context for enrichment AI analysis */
export interface EnrichmentProfileContext {
  profileSummaryCache: string;
  jobSearchDescription: string;
  missionStatement: string;
  urgencySignals: string;
  keyInterests: string[];
  dealbreakers: string[];
  preferredTechStack: string[];
  targetSeniority: string[];
  workExperience: Array<{
    title: string;
    employer: string;
    startDate: string;
    endDate: string | null;
    isCurrent: boolean;
  }>;
  skills: string[];
}

/** Job data for enrichment AI analysis */
export interface EnrichmentJobData {
  title: string;
  company: string;
  location: string;
  description: string;
  companyInfo: string;
  contactPeople: Array<{ name: string; title: string; profileUrl: string }>;
  postedBy: string;
  postedByTitle: string;
  applicantCount: string;
  seniorityLevel: string;
  employmentType: string;
  jobFunction: string;
}

/**
 * Builds the enrichment analysis prompt that scores a fully-scraped job
 * against the user's profile and priorities.
 */
export function buildEnrichmentAnalysisPrompt(
  profile: EnrichmentProfileContext,
  job: EnrichmentJobData,
): string {
  const experienceLines = profile.workExperience
    .map((exp) => {
      const duration = exp.isCurrent
        ? `${exp.startDate} – Present`
        : `${exp.startDate} – ${exp.endDate || '?'}`;
      return `- ${exp.title} at ${exp.employer} (${duration})`;
    })
    .join('\n');

  const contactLines = job.contactPeople.length > 0
    ? job.contactPeople
        .map((p) => `- ${p.name}, ${p.title}${p.profileUrl ? ` (${p.profileUrl})` : ''}`)
        .join('\n')
    : 'None found';

  return `You are an intelligent job analyst. Analyze this job posting against the candidate's profile and priorities, then assign a priority level and provide actionable insights.

CANDIDATE PROFILE:
${profile.profileSummaryCache || 'No profile summary available.'}

WHAT THE CANDIDATE IS LOOKING FOR:
${profile.jobSearchDescription || 'Not specified.'}

THE CANDIDATE'S MISSION (what excites and motivates them):
${profile.missionStatement || 'Not specified.'}

KEY INTERESTS: ${profile.keyInterests.join(', ') || 'Not specified'}
DEALBREAKERS: ${profile.dealbreakers.join(', ') || 'None specified'}
PREFERRED TECH STACK: ${profile.preferredTechStack.join(', ') || 'Not specified'}
TARGET SENIORITY: ${profile.targetSeniority.join(', ') || 'Not specified'}

RECENT EXPERIENCE:
${experienceLines || 'No work experience listed.'}

SKILLS: ${profile.skills.join(', ') || 'Not specified'}

URGENCY TRIGGERS (if ANY of these are present, strongly consider "urgent" priority):
${profile.urgencySignals || 'No urgency triggers specified.'}

---

JOB POSTING:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Seniority: ${job.seniorityLevel || 'Not specified'}
Type: ${job.employmentType || 'Not specified'}
Function: ${job.jobFunction || 'Not specified'}
Applicants: ${job.applicantCount || 'Unknown'}

Description:
${job.description || 'No description available.'}

About the Company:
${job.companyInfo || 'No company info available.'}

Posted by: ${job.postedBy || 'Unknown'}${job.postedByTitle ? ` (${job.postedByTitle})` : ''}
People to Reach Out To:
${contactLines}

---

ANALYSIS INSTRUCTIONS:
1. Assign a PRIORITY based on these definitions:
   - "urgent": This job has time-sensitive advantages. One or more urgency triggers match, OR there is a unique opportunity to make direct contact, OR this is an exceptionally strong match for the candidate's stated mission. The candidate should act on this TODAY.
   - "high": Strong overall match. The role aligns well with the candidate's skills, interests, and career goals. Worth applying soon.
   - "normal": Decent match. The candidate could apply, but there's nothing that sets this apart.
   - "low": Borderline match. Saved by the title filter but the full description reveals it's not a great fit (wrong focus area, too senior/junior, unexciting domain, etc.).

2. If ANY dealbreakers are found in the description, the priority should be "low" regardless of other factors.

3. Pay special attention to:
   - Direct contact opportunities (poster name, social media handles, "DM me", email addresses in description)
   - Startup/small team signals ("founding", "first engineer", team size mentions)
   - Alignment with key interests (especially if the company is building products in those areas)
   - Red flags (years of experience mismatch, required skills the candidate lacks, on-site only when remote preferred)

4. Generate 1-3 specific ACTION ITEMS when applicable. These should be concrete next steps:
   - "DM [name] on [platform] -- they invited direct messages"
   - "Mention your experience with [specific tech] -- it's their primary stack"
   - "Apply through their company website at [URL] for faster response"
   - "Check if [name] ([LinkedIn URL]) is a mutual connection"
   Do NOT generate generic action items like "apply to this job" or "update your resume". Only include actions that are specific to THIS posting.

5. Note any RED FLAGS -- things that might make this job worse than it appears:
   - Required experience significantly above candidate's level
   - Skills requirements that don't match
   - High applicant count (200+) reducing chances
   - Signs of a re-post or long-unfilled position

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "priority": "urgent" | "high" | "normal" | "low",
  "priorityReason": "<1-2 sentence explanation of why this priority was assigned>",
  "matchScore": <number 0-100>,
  "matchReason": "<2-3 sentence analysis of how well this job fits the candidate>",
  "keyMatches": ["specific match 1", "specific match 2"],
  "actionItems": ["concrete action 1", "concrete action 2"],
  "redFlags": ["red flag 1"]
}`;
}
