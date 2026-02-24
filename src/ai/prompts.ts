/**
 * Prompt templates for AI interactions (NVIDIA Kimi K2.5).
 * Separated for easy tuning and maintenance.
 */

/**
 * Prompt to generate a structured profile summary from a resume and context.
 * Used once on first run; result is cached in the database.
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
  willingToRelocate: boolean;
  visaSponsorshipNeeded: boolean;
  remoteOnly: boolean;
  openToContract: boolean;
  yearsOfExperience: number;
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
 * against the user's profile and priorities. Returns structured JSON with
 * dealbreaker detection, 10 AI sub-scores, extracted signals, and analysis.
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

  return `You are a structured job analysis engine. Analyze this job posting against the candidate profile below and return a detailed structured JSON response.

CANDIDATE PROFILE:
${profile.profileSummaryCache || 'No profile summary available.'}

CANDIDATE FACTS (use these for scoring -- do NOT contradict):
- Years of professional experience: ${profile.yearsOfExperience}
- Visa status: Has green card (does NOT need sponsorship)
- Willing to relocate: ${profile.willingToRelocate ? 'Yes, anywhere in the US' : 'No'}
- Remote preference: ${profile.remoteOnly ? 'Remote only' : 'Remote preferred but open to hybrid/onsite'}
- Open to contract: ${profile.openToContract ? 'Yes' : 'No, full-time only'}

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

URGENCY TRIGGERS (if ANY match, set urgencySignalMatched to true):
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

RESPOND WITH THREE SECTIONS IN A SINGLE JSON OBJECT:

SECTION 1 -- DEALBREAKER DETECTION:
Check these four dealbreakers. If ANY is true, the job scores 0.

- seniorityTooHigh: True if the role clearly requires Senior, Staff, Principal, Lead, Director, VP, Head of, Architect, or Manager level experience based on the DESCRIPTION (not just the title). Look for phrases like "8+ years", "lead a team", "architect solutions", "mentor junior engineers" that indicate senior expectations.
- clearanceRequired: True if ANY security clearance is required (Secret, Top Secret, TS/SCI, DoD, "must be clearable").
- wrongTechDomain: True if the PRIMARY required stack is C++/CUDA, Java/Spring, C#/.NET, Embedded systems, or COBOL with zero meaningful overlap to the candidate's skills. A job that MENTIONS Java secondarily but primarily uses Python/TypeScript is NOT wrong-tech-domain.
- experienceMinYears: Extract the MINIMUM years of experience mentioned in the description as a number, whether labeled required, preferred, desired, expected, or ideal. "3-6 years" = 3. "5+ years" = 5. "6 years minimum" = 6. "7+ years preferred" = 7. If two different year counts apply to different skills (e.g., "7+ years software, 3+ years AI"), use the HIGHEST number. Only return null if the description mentions NO years of experience at all. IMPORTANT: this field drives automatic dealbreaker detection — always extract a number if any year count appears in the posting.

SECTION 2 -- DIMENSION SUB-SCORES (0-10 each):
Score these 10 dimensions using the exact rubric below.

1. techStack: 0 = zero overlap with candidate's skills. 5 = some overlap (1-2 technologies match). 8 = strong overlap (3+ core technologies). 10 = exact stack match (React/Next.js/Node/Python/FastAPI all listed).
2. roleType: 0 = purely advisory/consulting/maintaining legacy. 5 = mixed building and maintenance. 8 = primarily building new features/products. 10 = greenfield product development, building from scratch.
3. aiRelevance: 0 = no AI/ML mention at all. 3 = vague "we use AI" without specifics. 6 = AI is part of the product but not the core job. 8 = building AI features, LLM integration, agents. 10 = core AI product role (RAG, prompt engineering, AI agents, LLM applications).
4. fullStackBreadth: 0 = extremely narrow scope. 5 = frontend OR backend only. 8 = frontend + backend. 10 = true full-stack (frontend + backend + infrastructure/deployment).
5. productOwnership: 0 = "implement tickets from Jira." 5 = standard team contributor. 8 = "own features end-to-end." 10 = "ship the product, work directly with founders, wear many hats."
6. companyStage: 0 = large enterprise (5000+ employees). 3 = mid-to-large (1000-5000). 5 = mid-size (200-1000). 7 = growth-stage startup (50-200). 9 = early-stage (<50). 10 = founding team, first engineer, recently funded, <20 people.
7. growthPotential: 0 = dead-end ticket-grinding. 5 = standard corporate career path. 8 = work with senior engineers, exposure to architecture. 10 = work directly with founders/CTO, mentorship, rapid skill growth.
8. descriptionQuality: 0 = empty/vague boilerplate, buzzword soup, likely ghost listing. 5 = adequate but generic. 8 = specific requirements, clear team context. 10 = detailed projects, named technologies, real team description.
9. postingFreshness: 0 = clear repost signals (huge applicants for "new" listing). 5 = no signal either way. 10 = clearly fresh, low applicant count, specific/timely language.
10. posterRole: Founder/CTO = 10. Engineering manager = 8. In-house recruiter = 6. External recruiter/staffing agency = 3. No info = 4.

SECTION 3 -- EXTRACTED SIGNALS AND ANALYSIS:
Extract these boolean/string signals from the posting:

- workArrangement: "remote" | "hybrid" | "onsite" | "unknown"
- applicationMethod: "easyApply" | "externalSite" | "directReferral" | "unknown"
- urgencySignalMatched: true if any of the candidate's urgency triggers match this posting
- isFoundingRole: true if description mentions founding engineer, first hire, first engineer
- recentFunding: true if company recently raised money (mentioned in description/company info)
- dmInvitation: true if poster explicitly invites direct outreach ("DM me", "reach out directly", email in post)
- exactStackCount: count of candidate's core technologies (React, Next.js, Node, Python, FastAPI) explicitly listed in the description (0-5+)
- isStaffingAgency: true if posted by a recruiting/staffing firm, not the actual company
- highApplicantCount: true if 500+ applicants
- ghostListingSignals: true if multiple signs of inactivity (huge applicants + vague description + no poster info)
- repostSignal: true if clear indicators this is a recycled/re-posted listing

Also provide human-readable analysis:
- matchReason: 2-3 sentence summary of overall fit
- keyMatches: array of specific matching qualifications/technologies
- actionItems: 1-3 SPECIFIC action items (not generic). Examples: "DM [name] on LinkedIn", "Mention your experience with [tech]", "Apply through their careers page at [URL]". Do NOT generate generic items like "apply to this job".
- redFlags: array of factual red flags (see rules below)

RED FLAGS RULES -- follow these EXACTLY:
A red flag is ONLY a factual problem verifiable from the posting text. It must be something the candidate needs to know that is NOT already captured by the scoring dimensions.

VALID red flags (examples):
- "Requires 5 years of Java experience (candidate has 0 Java experience)"
- "Posting mentions this is a re-opening after previous hire left"
- "350+ applicants already"
- "Description appears copy-pasted from a different company's listing"

NEVER flag ANY of the following (these are scored via dimensions, not red flags):
- Company size or type (scored in companyStage dimension)
- Industry not being AI or startup (scored in aiRelevance and companyStage)
- On-site, hybrid, or relocation requirement (candidate has green card and is willing to relocate ANYWHERE in the US)
- Visa sponsorship not offered (candidate has a GREEN CARD and does NOT need sponsorship)
- Lack of direct contact info (scored in directContact dimension)
- The role not being at a startup (scored in companyStage dimension)
- Any PREFERENCE mismatch already reflected in a scoring dimension
- The ABSENCE of a positive signal (e.g., "no mention of AI" is not a red flag -- it's a low aiRelevance score)

If there are no legitimate red flags, return an empty array.

---

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "dealbreakers": {
    "seniorityTooHigh": false,
    "clearanceRequired": false,
    "wrongTechDomain": false,
    "experienceMinYears": null
  },
  "scores": {
    "techStack": 0,
    "roleType": 0,
    "aiRelevance": 0,
    "fullStackBreadth": 0,
    "productOwnership": 0,
    "companyStage": 0,
    "growthPotential": 0,
    "descriptionQuality": 0,
    "postingFreshness": 0,
    "posterRole": 0
  },
  "extracted": {
    "workArrangement": "unknown",
    "applicationMethod": "unknown",
    "urgencySignalMatched": false,
    "isFoundingRole": false,
    "recentFunding": false,
    "dmInvitation": false,
    "exactStackCount": 0,
    "isStaffingAgency": false,
    "highApplicantCount": false,
    "ghostListingSignals": false,
    "repostSignal": false
  },
  "analysis": {
    "matchReason": "",
    "keyMatches": [],
    "actionItems": [],
    "redFlags": []
  }
}`;
}
