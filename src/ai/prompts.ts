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
}

/**
 * Prompt to batch-filter a list of job titles for relevance.
 * Makes ONE call instead of scoring each job individually.
 * Returns only the IDs of jobs that are relevant to the candidate.
 *
 * This version is STRICT — it rejects seniority mismatches,
 * unrelated domains, and niche enterprise tech the candidate has no interest in.
 */
export function buildRelevanceFilterPrompt(
  profileSummary: string,
  jobs: { linkedinId: string; title: string; company: string }[],
  rules: FilteringRules,
): string {
  const jobList = jobs
    .map((j) => `- ID: ${j.linkedinId} | Title: "${j.title}" | Company: "${j.company}"`)
    .join('\n');

  const senioritySection = rules.targetSeniority.length > 0
    ? `\nTARGET SENIORITY LEVELS: ${rules.targetSeniority.join(', ')}
SENIORITY RULES:
- REJECT any job with "Senior", "Sr.", "Staff", "Principal", "Lead", "Director", "VP", "Head of", "Manager", or "Architect" in the title UNLESS the candidate's target seniority includes that level.
- The candidate is targeting: ${rules.targetSeniority.join(', ')} level roles. Do NOT include roles above this level.`
    : '';

  const techSection = rules.preferredTechStack.length > 0
    ? `\nCANDIDATE'S TECH STACK: ${rules.preferredTechStack.join(', ')}
- The candidate works with web/software technologies. REJECT roles focused on unrelated tech domains (e.g., embedded systems, hardware, ERP platforms like Guidewire/SAP/Salesforce, mainframe, COBOL, etc.) unless the title is a generic software role.`
    : '';

  return `You are a STRICT job relevance filter. Given a candidate profile and a list of job postings (title + company only), determine which jobs are RELEVANT.

RULES — follow these exactly:
1. A job is RELEVANT only if the title directly matches the candidate's skills, experience level, and target role type.
2. When in doubt, REJECT. It is better to miss a marginal job than to include garbage.
3. REJECT jobs in unrelated engineering fields (embedded, mechanical, electrical, civil, hardware, systems/network engineering, test/QA engineering).
4. REJECT jobs for niche enterprise platforms the candidate has no experience with (Guidewire, SAP, Salesforce, Mainframe, etc.).
5. REJECT duplicate-looking entries (same title + same company appearing multiple times) — keep only ONE.
${senioritySection}
${techSection}

CANDIDATE PROFILE:
${profileSummary}

JOB POSTINGS:
${jobList}

Respond with ONLY valid JSON (no markdown, no code fences). Return ONLY the linkedinId values for jobs that genuinely match this candidate:
{
  "relevantIds": ["id1", "id2", "id3"]
}`;
}
