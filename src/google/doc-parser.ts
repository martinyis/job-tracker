import { docs_v1 } from 'googleapis';

// ─── Rich formatting interfaces ──────────────────────────────────────────────

export interface CapturedTextStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontFamily?: string;
  foregroundColor?: docs_v1.Schema$OptionalColor;
}

export interface CapturedParagraphStyle {
  spacingBefore?: number;
  spacingAfter?: number;
  indentFirstLine?: number;
  indentStart?: number;
  alignment?: string;
  lineSpacing?: number;
  namedStyleType?: string;
}

export interface CapturedBullet {
  listId: string;
  nestingLevel: number;
}

export type ParagraphRole = 'header' | 'bullet' | 'spacer' | 'text';

export interface RichParagraph {
  text: string;
  role: ParagraphRole;
  textStyle: CapturedTextStyle;
  paragraphStyle: CapturedParagraphStyle;
  bullet?: CapturedBullet;
  startIndex: number;
  endIndex: number;
}

export interface ResumeEntry {
  header: RichParagraph;
  bullets: RichParagraph[];
}

export interface SkillCategory {
  paragraph: RichParagraph;
  categoryName: string;
  skillsText: string;
}

export interface RichResumeSection {
  type: ResumeSection['type'];
  headingText: string;
  headingStartIndex: number;
  headingEndIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  entries: ResumeEntry[];
  skillCategories: SkillCategory[];
  summaryParagraphs: RichParagraph[];
  allParagraphs: RichParagraph[];
}

// ─── Original flat interfaces (kept for backward compat / revert path) ───────

export interface ResumeSection {
  type: 'summary' | 'experience' | 'skills' | 'education' | 'projects' | 'unknown';
  headingText: string;
  headingStartIndex: number;
  headingEndIndex: number;
  contentStartIndex: number;
  contentEndIndex: number;
  paragraphs: Array<{
    startIndex: number;
    endIndex: number;
    text: string;
    isBullet: boolean;
  }>;
}

const SECTION_PATTERNS: Array<{ type: ResumeSection['type']; pattern: RegExp }> = [
  { type: 'summary', pattern: /^(summary|objective|profile|about)\s*$/i },
  { type: 'experience', pattern: /^(professional\s+)?experience|work\s+history|employment/i },
  { type: 'skills', pattern: /^technical\s+skills|skills|technologies|competencies/i },
  { type: 'education', pattern: /^education|academic/i },
  { type: 'projects', pattern: /^(relevant\s+)?projects/i },
];

function classifyHeading(text: string): ResumeSection['type'] {
  const trimmed = text.trim();
  for (const { type, pattern } of SECTION_PATTERNS) {
    if (pattern.test(trimmed)) return type;
  }
  return 'unknown';
}

/**
 * Checks if a paragraph is a section header.
 * Detects both formal heading styles AND bold-only standalone text
 * (common in resumes that don't use Google Docs heading styles).
 */
function isSectionHeader(element: docs_v1.Schema$StructuralElement): boolean {
  if (!element.paragraph) return false;
  const para = element.paragraph;

  // Method 1: formal heading style
  const style = para.paragraphStyle?.namedStyleType || '';
  if (style.startsWith('HEADING')) return true;

  // Method 2: bold-only paragraph that matches a known section name
  // Must be: all text runs are bold, no bullets, short text, matches a pattern
  if (para.bullet) return false;

  const elements = para.elements || [];
  if (elements.length === 0) return false;

  const text = elements.map((e) => e.textRun?.content || '').join('').trim();
  if (!text || text.length > 40) return false;

  // Check all non-whitespace text runs are bold
  const allBold = elements.every((e) => {
    const content = (e.textRun?.content || '').trim();
    if (!content) return true; // skip whitespace-only runs
    return e.textRun?.textStyle?.bold === true;
  });

  if (!allBold) return false;

  // Must match a known section pattern
  return classifyHeading(text) !== 'unknown';
}

/**
 * Parses a Google Docs API document response into resume sections.
 * Identifies sections by heading styles OR bold standalone text matching section names.
 */
export interface DocumentBodyStyle {
  fontFamily: string;
  fontSize: number;
}

/**
 * Extracts the default body text style from the document's named styles.
 * Used to restore correct font/size after insertText operations.
 */
export function getDocumentBodyStyle(doc: docs_v1.Schema$Document): DocumentBodyStyle {
  const normalStyle = (doc.namedStyles?.styles || []).find(
    (s) => s.namedStyleType === 'NORMAL_TEXT',
  );

  return {
    fontFamily: normalStyle?.textStyle?.weightedFontFamily?.fontFamily || 'Arial',
    fontSize: normalStyle?.textStyle?.fontSize?.magnitude || 10,
  };
}

export function parseResumeSections(doc: docs_v1.Schema$Document): ResumeSection[] {
  const body = doc.body;
  if (!body?.content) return [];

  // First pass: find all section headers
  const headings: Array<{
    type: ResumeSection['type'];
    text: string;
    startIndex: number;
    endIndex: number;
  }> = [];

  for (const element of body.content) {
    if (!isSectionHeader(element)) continue;

    const text = (element.paragraph!.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('')
      .trim();

    if (!text) continue;

    const type = classifyHeading(text);
    if (type === 'unknown') continue;

    headings.push({
      type,
      text,
      startIndex: element.startIndex || 0,
      endIndex: element.endIndex || 0,
    });
  }

  if (headings.length === 0) return [];

  // Second pass: build sections from heading pairs
  const sections: ResumeSection[] = [];
  const docEndIndex = body.content[body.content.length - 1]?.endIndex || 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeadingStart = i + 1 < headings.length ? headings[i + 1].startIndex : docEndIndex;

    // Collect paragraphs between this heading and the next
    const paragraphs: ResumeSection['paragraphs'] = [];

    for (const element of body.content) {
      const startIdx = element.startIndex || 0;
      const endIdx = element.endIndex || 0;

      if (startIdx < heading.endIndex || startIdx >= nextHeadingStart) continue;
      if (!element.paragraph) continue;

      const text = (element.paragraph.elements || [])
        .map((e) => e.textRun?.content || '')
        .join('');

      const isBullet = !!element.paragraph.bullet;

      paragraphs.push({
        startIndex: startIdx,
        endIndex: endIdx,
        text,
        isBullet,
      });
    }

    sections.push({
      type: heading.type,
      headingText: heading.text,
      headingStartIndex: heading.startIndex,
      headingEndIndex: heading.endIndex,
      contentStartIndex: heading.endIndex,
      contentEndIndex: nextHeadingStart,
      paragraphs,
    });
  }

  return sections;
}

// ─── Rich formatting extraction ──────────────────────────────────────────────

function extractTextStyle(style?: docs_v1.Schema$TextStyle): CapturedTextStyle {
  if (!style) return {};
  return {
    bold: style.bold ?? undefined,
    italic: style.italic ?? undefined,
    fontSize: style.fontSize?.magnitude ?? undefined,
    fontFamily: style.weightedFontFamily?.fontFamily ?? undefined,
    foregroundColor: style.foregroundColor ?? undefined,
  };
}

function extractParagraphStyle(style?: docs_v1.Schema$ParagraphStyle): CapturedParagraphStyle {
  if (!style) return {};
  return {
    spacingBefore: style.spaceAbove?.magnitude ?? undefined,
    spacingAfter: style.spaceBelow?.magnitude ?? undefined,
    indentFirstLine: style.indentFirstLine?.magnitude ?? undefined,
    indentStart: style.indentStart?.magnitude ?? undefined,
    alignment: style.alignment ?? undefined,
    lineSpacing: style.lineSpacing ?? undefined,
    namedStyleType: style.namedStyleType ?? undefined,
  };
}

function classifyParagraphRole(text: string, hasBullet: boolean): ParagraphRole {
  const trimmed = text.trim();
  if (!trimmed) return 'spacer';
  if (hasBullet) return 'bullet';
  // Headers typically contain " | " or " — " separators (company | title | dates)
  if (trimmed.includes(' | ') || trimmed.includes(' — ')) return 'header';
  return 'text';
}

function parseRichParagraph(element: docs_v1.Schema$StructuralElement): RichParagraph | null {
  if (!element.paragraph) return null;
  const para = element.paragraph;
  const elements = para.elements || [];

  const text = elements.map((e) => e.textRun?.content || '').join('');
  const hasBullet = !!para.bullet;

  // Capture text style from the first non-empty text run (representative style)
  let textStyle: CapturedTextStyle = {};
  for (const el of elements) {
    const content = (el.textRun?.content || '').trim();
    if (content) {
      textStyle = extractTextStyle(el.textRun?.textStyle);
      break;
    }
  }

  const paragraphStyle = extractParagraphStyle(para.paragraphStyle);

  let bullet: CapturedBullet | undefined;
  if (para.bullet) {
    bullet = {
      listId: para.bullet.listId || '',
      nestingLevel: para.bullet.nestingLevel || 0,
    };
  }

  const role = classifyParagraphRole(text, hasBullet);

  return {
    text,
    role,
    textStyle,
    paragraphStyle,
    bullet,
    startIndex: element.startIndex || 0,
    endIndex: element.endIndex || 0,
  };
}

function groupIntoEntries(paragraphs: RichParagraph[]): ResumeEntry[] {
  const entries: ResumeEntry[] = [];
  let currentEntry: ResumeEntry | null = null;

  for (const para of paragraphs) {
    if (para.role === 'header') {
      // Start a new entry
      if (currentEntry) entries.push(currentEntry);
      currentEntry = { header: para, bullets: [] };
    } else if (para.role === 'bullet' && currentEntry) {
      currentEntry.bullets.push(para);
    } else if (para.role === 'spacer') {
      // Spacer between entries — finalize current
      if (currentEntry) {
        entries.push(currentEntry);
        currentEntry = null;
      }
    } else if (para.role === 'text') {
      if (currentEntry) {
        // Non-bullet text under a header — treat as a bullet for structure
        currentEntry.bullets.push(para);
      } else {
        // Orphan text with no header — create a minimal entry
        currentEntry = { header: para, bullets: [] };
      }
    }
  }

  if (currentEntry) entries.push(currentEntry);
  return entries;
}

function groupIntoSkillCategories(paragraphs: RichParagraph[]): SkillCategory[] {
  const categories: SkillCategory[] = [];

  for (const para of paragraphs) {
    if (para.role === 'spacer') continue;
    const colonIdx = para.text.indexOf(':');
    if (colonIdx > 0) {
      categories.push({
        paragraph: para,
        categoryName: para.text.substring(0, colonIdx).trim(),
        skillsText: para.text.substring(colonIdx + 1).trim(),
      });
    } else {
      // No colon — treat as a generic category
      categories.push({
        paragraph: para,
        categoryName: '',
        skillsText: para.text.trim(),
      });
    }
  }

  return categories;
}

/**
 * Parses the document into RichResumeSections with full formatting data.
 * Uses the same section detection logic as parseResumeSections but captures
 * per-paragraph text styles, paragraph styles, and bullet info.
 */
export function parseRichResumeSections(doc: docs_v1.Schema$Document): RichResumeSection[] {
  const body = doc.body;
  if (!body?.content) return [];

  // Reuse the same heading detection from the flat parser
  const headings: Array<{
    type: ResumeSection['type'];
    text: string;
    startIndex: number;
    endIndex: number;
  }> = [];

  for (const element of body.content) {
    if (!isSectionHeader(element)) continue;

    const text = (element.paragraph!.elements || [])
      .map((e) => e.textRun?.content || '')
      .join('')
      .trim();

    if (!text) continue;
    const type = classifyHeading(text);
    if (type === 'unknown') continue;

    headings.push({ type, text, startIndex: element.startIndex || 0, endIndex: element.endIndex || 0 });
  }

  if (headings.length === 0) return [];

  const docEndIndex = body.content[body.content.length - 1]?.endIndex || 0;
  const sections: RichResumeSection[] = [];

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const nextHeadingStart = i + 1 < headings.length ? headings[i + 1].startIndex : docEndIndex;

    // Parse all paragraphs in this section with rich formatting
    const allParagraphs: RichParagraph[] = [];

    for (const element of body.content) {
      const startIdx = element.startIndex || 0;
      if (startIdx < heading.endIndex || startIdx >= nextHeadingStart) continue;
      if (!element.paragraph) continue;

      const richPara = parseRichParagraph(element);
      if (richPara) allParagraphs.push(richPara);
    }

    // Group paragraphs based on section type
    let entries: ResumeEntry[] = [];
    let skillCategories: SkillCategory[] = [];
    let summaryParagraphs: RichParagraph[] = [];

    if (heading.type === 'experience' || heading.type === 'projects') {
      entries = groupIntoEntries(allParagraphs);
    } else if (heading.type === 'skills') {
      skillCategories = groupIntoSkillCategories(allParagraphs);
    } else if (heading.type === 'summary') {
      summaryParagraphs = allParagraphs.filter((p) => p.role !== 'spacer');
    }

    sections.push({
      type: heading.type,
      headingText: heading.text,
      headingStartIndex: heading.startIndex,
      headingEndIndex: heading.endIndex,
      contentStartIndex: heading.endIndex,
      contentEndIndex: nextHeadingStart,
      entries,
      skillCategories,
      summaryParagraphs,
      allParagraphs,
    });
  }

  return sections;
}
