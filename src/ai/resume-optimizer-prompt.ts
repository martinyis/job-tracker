import { RichResumeSection } from '../google/doc-parser';

interface PromptInput {
  sections: RichResumeSection[];
  jobTitle: string;
  jobCompany: string;
  jobDescription: string;
  jobLocation: string;
  profileSummaryCache: string;
  contextFiles: string;
}

/**
 * Builds structured resume text showing explicit entry structure
 * so Claude returns per-entry output that maps back to template formatting.
 */
function buildStructuredResume(sections: RichResumeSection[]): string {
  const parts: string[] = [];

  for (const section of sections) {
    if (section.type === 'experience' || section.type === 'projects') {
      parts.push(`## ${section.headingText}`);
      for (let i = 0; i < section.entries.length; i++) {
        const entry = section.entries[i];
        parts.push(`[ENTRY ${i + 1}]`);
        parts.push(`HEADER: ${entry.header.text.trim()}`);
        if (entry.bullets.length > 0) {
          parts.push('BULLETS:');
          for (const bullet of entry.bullets) {
            parts.push(`- ${bullet.text.trim()}`);
          }
        }
        parts.push('');
      }
    } else if (section.type === 'skills') {
      parts.push(`## ${section.headingText}`);
      for (const cat of section.skillCategories) {
        if (cat.categoryName) {
          parts.push(`${cat.categoryName}: ${cat.skillsText}`);
        } else {
          parts.push(cat.skillsText);
        }
      }
      parts.push('');
    } else if (section.type === 'summary') {
      parts.push(`## ${section.headingText}`);
      for (const para of section.summaryParagraphs) {
        parts.push(para.text.trim());
      }
      parts.push('');
    } else {
      // education or unknown — show as-is
      parts.push(`## ${section.headingText}`);
      for (const para of section.allParagraphs) {
        parts.push(para.text.trimEnd());
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

export function buildResumeOptimizerPrompt(input: PromptInput): string {
  const {
    sections,
    jobTitle,
    jobCompany,
    jobDescription,
    jobLocation,
    profileSummaryCache,
    contextFiles,
  } = input;

  const currentResume = buildStructuredResume(sections);

  return `You are an expert resume optimizer. Your goal: make this resume look like it was WRITTEN SPECIFICALLY for the target role. Every bullet should feel tailored. Optimize content aggressively within truthful bounds.

## RULES
1. NEVER fabricate experience, skills, certifications, or company names
2. NEVER change company names, job titles, dates, or education details
3. NEVER add skills the candidate doesn't actually have (but DO surface real skills from the Deep Context)
4. Keep the resume to ONE PAGE of content
5. ONLY reorder, reword, and emphasize existing truthful content — but do so AGGRESSIVELY
6. Do NOT reorder entries — keep chronological order for experience, keep project order as given
7. You MAY reorder bullets WITHIN an entry to lead with the most relevant one

## TARGET JOB
- Title: ${jobTitle}
- Company: ${jobCompany}
- Location: ${jobLocation}

### Job Description
${jobDescription}

## CURRENT RESUME
${currentResume}

## DEEP CONTEXT (candidate's real background — mine this for relevant experience to highlight)
${profileSummaryCache ? `### Profile Summary\n${profileSummaryCache}\n` : ''}
${contextFiles ? `### Additional Context\n${contextFiles}\n` : ''}

## OPTIMIZATION STRATEGY

**Step 1 — Analyze the JD.** Identify:
- Core tech requirements (languages, frameworks, infra)
- Domain themes (e.g., "real-time", "AI-native", "consumer", "productivity", "scale")
- Culture signals (pace, ownership, craft)
- Bonus/nice-to-have skills

**Step 2 — Rewrite with intent.** For each bullet, ask: "Does this sound like someone who'd thrive at ${jobCompany}?" If not, transform it.

### Experience Section
- REWRITE bullets to incorporate the JD's own keywords and themes where truthful
- LEAD each role with the most relevant bullet for this specific job (reorder within entry OK)
- Use the JD's exact language when the candidate's experience supports it
  Example: JD says "real-time collaboration" → if candidate built real-time features, say "real-time collaborative features", not just "built features"
- Quantify results where data supports it (users, latency, throughput, time saved)
- CUT or shorten bullets about technologies/domains irrelevant to this role to make room
- Return the SAME NUMBER of entries in the SAME ORDER with the SAME NUMBER of bullets per entry — only rewrite bullet text

### Projects Section
- REWRITE bullets to emphasize overlap with JD requirements
- Frame each project in terms the target company would value
- Return the SAME NUMBER of entries in the SAME ORDER with the SAME NUMBER of bullets per entry — only rewrite bullet text

### Skills Section
- REORDER: skills mentioned in the JD appear FIRST in each category
- SURFACE relevant skills from Deep Context that are truthful but missing from original
- CUT or deprioritize skills irrelevant to this role
- Return the SAME categories with the same names

### Education Section
- Do NOT modify at all — omit from output

## OUTPUT FORMAT
Respond with ONLY a JSON object. No markdown fences, no explanation before or after.

{
  "experience": {
    "entries": [
      {
        "headerText": "Exact header text — copy from input, do NOT modify",
        "bullets": ["Rewritten bullet 1 text (no bullet character)", "Rewritten bullet 2 text"]
      }
    ]
  },
  "projects": {
    "entries": [
      {
        "headerText": "Exact header text — copy from input",
        "bullets": ["Rewritten bullet 1", "Rewritten bullet 2"]
      }
    ]
  },
  "skills": {
    "categories": [
      { "name": "Languages", "skills": "TypeScript, Python, Go" }
    ]
  },
  "summary": "Rewritten summary text or empty string if not modified",
  "sectionsModified": ["experience", "projects", "skills"],
  "optimizationNotes": "2-3 sentences: what key themes from the JD you targeted and how you reframed the content"
}

CRITICAL: Do NOT include bullet characters (•, -, *) at the start of bullet text. Just write the text. Bullet formatting is applied automatically.

CRITICAL: Return the SAME number of entries in the SAME order as the input with the SAME number of bullets per entry. Do NOT add or remove bullets — only rewrite their text. Header text must be copied EXACTLY from the input (they contain " | " separators — do not modify these).

CRITICAL: The output must feel NOTICEABLY different from the input. If someone compared the original and optimized versions side by side, they should immediately see that the optimized version was tailored for ${jobCompany}'s ${jobTitle} role.`;
}
