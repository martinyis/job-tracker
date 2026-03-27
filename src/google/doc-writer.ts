import { docs_v1 } from 'googleapis';
import {
  ResumeSection,
  DocumentBodyStyle,
  RichResumeSection,
  CapturedTextStyle,
  CapturedParagraphStyle,
  RichParagraph,
  ResumeEntry,
  SkillCategory,
} from './doc-parser';
import { OptimizationResult, OptimizedEntry, OptimizedSkillCategory } from '../ai/resume-optimizer';

// ─── Saved state types for surgical revert ───────────────────────────────────

export interface SavedBulletState {
  text: string;
  textStyle: CapturedTextStyle;
}

export interface SavedEntryState {
  bullets: SavedBulletState[];
}

export interface SavedSkillState {
  skillsText: string;
  skillTextStyle: CapturedTextStyle;
}

export interface SavedSummaryParaState {
  text: string;
  textStyle: CapturedTextStyle;
}

export interface SavedSectionState {
  type: string;
  entries: SavedEntryState[];
  skills: SavedSkillState[];
  summaryParagraphs: SavedSummaryParaState[];
}

export type SavedResumeState = SavedSectionState[];

// ─── Old bulk replacement (kept for revert path) ────────────────────────────

interface SectionReplacement {
  section: ResumeSection;
  newContent: string;
}

function isHeaderLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return trimmed.includes(' | ') || trimmed.includes(' — ');
}

/**
 * Original "nuke and rebuild" replacement function.
 * Used for reverting the template back to original content.
 */
export function buildBulkReplacementRequests(
  replacements: SectionReplacement[],
  bodyStyle?: DocumentBodyStyle,
): docs_v1.Schema$Request[] {
  const sorted = [...replacements].sort(
    (a, b) => b.section.contentStartIndex - a.section.contentStartIndex,
  );

  const requests: docs_v1.Schema$Request[] = [];
  const fontFamily = bodyStyle?.fontFamily || 'Arial';
  const fontSize = bodyStyle?.fontSize || 10;

  for (const { section, newContent } of sorted) {
    if (section.contentStartIndex >= section.contentEndIndex) continue;

    requests.push({
      deleteContentRange: {
        range: {
          startIndex: section.contentStartIndex,
          endIndex: section.contentEndIndex - 1,
        },
      },
    });

    requests.push({
      insertText: {
        location: { index: section.contentStartIndex },
        text: newContent,
      },
    });

    const insertedEnd = section.contentStartIndex + newContent.length;

    requests.push({
      updateTextStyle: {
        range: {
          startIndex: section.contentStartIndex,
          endIndex: insertedEnd,
        },
        textStyle: {
          bold: false,
          weightedFontFamily: { fontFamily, weight: 400 },
          fontSize: { magnitude: fontSize, unit: 'PT' },
        },
        fields: 'bold,weightedFontFamily,fontSize',
      },
    });

    const lines = newContent.split('\n');
    let offset = section.contentStartIndex;

    let bulletStart: number | null = null;
    let bulletEnd: number | null = null;
    const bulletRanges: Array<{ start: number; end: number }> = [];

    const flushBullets = () => {
      if (bulletStart !== null) {
        bulletRanges.push({ start: bulletStart, end: bulletEnd! });
        bulletStart = null;
        bulletEnd = null;
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === lines.length - 1 && line === '') break;

      const lineStart = offset;
      const lineTextEnd = offset + line.length;
      offset = lineTextEnd + 1;

      const trimmed = line.trim();
      if (!trimmed) {
        flushBullets();
        continue;
      }

      if (section.type === 'experience' || section.type === 'projects') {
        if (isHeaderLine(trimmed)) {
          flushBullets();
          requests.push({
            updateTextStyle: {
              range: { startIndex: lineStart, endIndex: lineTextEnd },
              textStyle: { bold: true },
              fields: 'bold',
            },
          });
        } else {
          if (bulletStart === null) bulletStart = lineStart;
          bulletEnd = lineTextEnd + 1;
        }
      } else if (section.type === 'skills') {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          requests.push({
            updateTextStyle: {
              range: { startIndex: lineStart, endIndex: lineStart + colonIdx + 1 },
              textStyle: { bold: true },
              fields: 'bold',
            },
          });
        }
      }
    }

    flushBullets();

    if (
      (section.type === 'experience' || section.type === 'projects') &&
      bulletRanges.length > 0
    ) {
      for (const range of bulletRanges) {
        requests.push({
          createParagraphBullets: {
            range: { startIndex: range.start, endIndex: range.end },
            bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
          },
        });
      }
    }
  }

  return requests;
}

// ─── Style conversion helpers ────────────────────────────────────────────────

function textStyleToApi(captured: CapturedTextStyle): docs_v1.Schema$TextStyle {
  const style: docs_v1.Schema$TextStyle = {};
  if (captured.bold !== undefined) style.bold = captured.bold;
  if (captured.italic !== undefined) style.italic = captured.italic;
  if (captured.fontSize !== undefined) {
    style.fontSize = { magnitude: captured.fontSize, unit: 'PT' };
  }
  if (captured.fontFamily !== undefined) {
    style.weightedFontFamily = { fontFamily: captured.fontFamily, weight: 400 };
  }
  if (captured.foregroundColor !== undefined) {
    style.foregroundColor = captured.foregroundColor;
  }
  return style;
}

function textStyleFields(captured: CapturedTextStyle): string {
  const fields: string[] = [];
  if (captured.bold !== undefined) fields.push('bold');
  if (captured.italic !== undefined) fields.push('italic');
  if (captured.fontSize !== undefined) fields.push('fontSize');
  if (captured.fontFamily !== undefined) fields.push('weightedFontFamily');
  if (captured.foregroundColor !== undefined) fields.push('foregroundColor');
  return fields.join(',') || 'bold,fontSize,weightedFontFamily';
}

function paragraphStyleToApi(captured: CapturedParagraphStyle): docs_v1.Schema$ParagraphStyle {
  const style: docs_v1.Schema$ParagraphStyle = {};
  if (captured.spacingBefore !== undefined) {
    style.spaceAbove = { magnitude: captured.spacingBefore, unit: 'PT' };
  }
  if (captured.spacingAfter !== undefined) {
    style.spaceBelow = { magnitude: captured.spacingAfter, unit: 'PT' };
  }
  if (captured.indentFirstLine !== undefined) {
    style.indentFirstLine = { magnitude: captured.indentFirstLine, unit: 'PT' };
  }
  if (captured.indentStart !== undefined) {
    style.indentStart = { magnitude: captured.indentStart, unit: 'PT' };
  }
  if (captured.alignment !== undefined) {
    style.alignment = captured.alignment;
  }
  if (captured.lineSpacing !== undefined) {
    style.lineSpacing = captured.lineSpacing;
  }
  return style;
}

function paragraphStyleFields(captured: CapturedParagraphStyle): string {
  const fields: string[] = [];
  if (captured.spacingBefore !== undefined) fields.push('spaceAbove');
  if (captured.spacingAfter !== undefined) fields.push('spaceBelow');
  if (captured.indentFirstLine !== undefined) fields.push('indentFirstLine');
  if (captured.indentStart !== undefined) fields.push('indentStart');
  if (captured.alignment !== undefined) fields.push('alignment');
  if (captured.lineSpacing !== undefined) fields.push('lineSpacing');
  return fields.join(',');
}

// ─── Paragraph range computation ─────────────────────────────────────────────

interface ParagraphRange {
  text: string;
  startIndex: number;
  endIndex: number; // end of text (before \n)
  fullEndIndex: number; // end including \n
}

function computeParagraphRanges(text: string, startIndex: number): ParagraphRange[] {
  const lines = text.split('\n');
  const ranges: ParagraphRange[] = [];
  let offset = startIndex;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip trailing empty element from split (text ends with \n)
    if (i === lines.length - 1 && line === '') break;

    const lineStart = offset;
    const lineTextEnd = offset + line.length;
    offset = lineTextEnd + 1; // +1 for \n

    ranges.push({
      text: line,
      startIndex: lineStart,
      endIndex: lineTextEnd,
      fullEndIndex: offset,
    });
  }

  return ranges;
}

// ─── Entry matching ──────────────────────────────────────────────────────────

function normalizeHeader(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Matches optimized entries to template entries by header text.
 * Returns a map from optimized entry index → template entry (or undefined if unmatched).
 */
function matchEntries(
  templateEntries: ResumeEntry[],
  optimizedEntries: OptimizedEntry[],
): Map<number, ResumeEntry> {
  const matched = new Map<number, ResumeEntry>();
  const usedTemplate = new Set<number>();

  // First pass: exact match by normalized header
  for (let oi = 0; oi < optimizedEntries.length; oi++) {
    const optHeader = normalizeHeader(optimizedEntries[oi].headerText);
    for (let ti = 0; ti < templateEntries.length; ti++) {
      if (usedTemplate.has(ti)) continue;
      if (normalizeHeader(templateEntries[ti].header.text) === optHeader) {
        matched.set(oi, templateEntries[ti]);
        usedTemplate.add(ti);
        break;
      }
    }
  }

  // Second pass: unmatched optimized entries get formatting from positional match or nearest
  for (let oi = 0; oi < optimizedEntries.length; oi++) {
    if (matched.has(oi)) continue;
    // Try positional match
    if (oi < templateEntries.length && !usedTemplate.has(oi)) {
      matched.set(oi, templateEntries[oi]);
      usedTemplate.add(oi);
    } else {
      // Clone from nearest existing entry (first available)
      const fallback = templateEntries[0];
      if (fallback) matched.set(oi, fallback);
    }
  }

  return matched;
}

function matchSkillCategories(
  templateCategories: SkillCategory[],
  optimizedCategories: OptimizedSkillCategory[],
): Map<number, SkillCategory> {
  const matched = new Map<number, SkillCategory>();
  const usedTemplate = new Set<number>();

  for (let oi = 0; oi < optimizedCategories.length; oi++) {
    const optName = optimizedCategories[oi].name.toLowerCase().trim();
    for (let ti = 0; ti < templateCategories.length; ti++) {
      if (usedTemplate.has(ti)) continue;
      if (templateCategories[ti].categoryName.toLowerCase().trim() === optName) {
        matched.set(oi, templateCategories[ti]);
        usedTemplate.add(ti);
        break;
      }
    }
  }

  // Unmatched — positional or first fallback
  for (let oi = 0; oi < optimizedCategories.length; oi++) {
    if (matched.has(oi)) continue;
    if (oi < templateCategories.length && !usedTemplate.has(oi)) {
      matched.set(oi, templateCategories[oi]);
      usedTemplate.add(oi);
    } else if (templateCategories[0]) {
      matched.set(oi, templateCategories[0]);
    }
  }

  return matched;
}

// ─── Format application helpers ──────────────────────────────────────────────

function applyTextStyle(
  requests: docs_v1.Schema$Request[],
  range: { startIndex: number; endIndex: number },
  captured: CapturedTextStyle,
): void {
  const fields = textStyleFields(captured);
  if (!fields) return;
  requests.push({
    updateTextStyle: {
      range: { startIndex: range.startIndex, endIndex: range.endIndex },
      textStyle: textStyleToApi(captured),
      fields,
    },
  });
}

function applyParagraphStyle(
  requests: docs_v1.Schema$Request[],
  range: { startIndex: number; endIndex: number },
  captured: CapturedParagraphStyle,
): void {
  const fields = paragraphStyleFields(captured);
  if (!fields) return;
  requests.push({
    updateParagraphStyle: {
      range: { startIndex: range.startIndex, endIndex: range.endIndex },
      paragraphStyle: paragraphStyleToApi(captured),
      fields,
    },
  });
}

function applyBullet(
  requests: docs_v1.Schema$Request[],
  range: { startIndex: number; endIndex: number },
): void {
  requests.push({
    createParagraphBullets: {
      range: { startIndex: range.startIndex, endIndex: range.endIndex },
      bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
    },
  });
}

// ─── Build entry text ────────────────────────────────────────────────────────

function buildEntryText(entry: OptimizedEntry, isLast: boolean): string {
  let text = entry.headerText + '\n';
  for (const bullet of entry.bullets) {
    text += bullet + '\n';
  }
  // Add spacer between entries (but not after the last one)
  if (!isLast) text += '\n';
  return text;
}

// ─── New format-cloning writer ───────────────────────────────────────────────

/**
 * Builds batchUpdate requests that preserve the original template's formatting.
 * Instead of applying hardcoded styles, clones the exact text style, paragraph style,
 * and bullet formatting from the corresponding template paragraph.
 *
 * Processes sections in reverse document order to preserve index validity.
 */
export function buildFormattedReplacementRequests(
  richSections: RichResumeSection[],
  result: OptimizationResult,
  bodyStyle: DocumentBodyStyle,
): docs_v1.Schema$Request[] {
  // Build section-to-result mapping
  const sectionWork: Array<{
    section: RichResumeSection;
    work: 'entries' | 'skills' | 'summary';
  }> = [];

  for (const section of richSections) {
    if (
      (section.type === 'experience' && result.experience) ||
      (section.type === 'projects' && result.projects)
    ) {
      sectionWork.push({ section, work: 'entries' });
    } else if (section.type === 'skills' && result.skills) {
      sectionWork.push({ section, work: 'skills' });
    } else if (section.type === 'summary' && result.summary) {
      sectionWork.push({ section, work: 'summary' });
    }
  }

  // Sort reverse by contentStartIndex
  sectionWork.sort((a, b) => b.section.contentStartIndex - a.section.contentStartIndex);

  const requests: docs_v1.Schema$Request[] = [];

  for (const { section, work } of sectionWork) {
    if (section.contentStartIndex >= section.contentEndIndex) continue;

    // Step 1: Delete existing section content
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: section.contentStartIndex,
          endIndex: section.contentEndIndex - 1,
        },
      },
    });

    if (work === 'entries') {
      buildEntryRequests(requests, section, result, bodyStyle);
    } else if (work === 'skills') {
      buildSkillsRequests(requests, section, result.skills!, bodyStyle);
    } else if (work === 'summary') {
      buildSummaryRequests(requests, section, result.summary!, bodyStyle);
    }
  }

  return requests;
}

function buildEntryRequests(
  requests: docs_v1.Schema$Request[],
  section: RichResumeSection,
  result: OptimizationResult,
  bodyStyle: DocumentBodyStyle,
): void {
  const optimizedEntries =
    section.type === 'experience'
      ? result.experience!.entries
      : result.projects!.entries;

  // Build the full text content
  let newContent = '';
  for (let i = 0; i < optimizedEntries.length; i++) {
    newContent += buildEntryText(optimizedEntries[i], i === optimizedEntries.length - 1);
  }
  if (!newContent.endsWith('\n')) newContent += '\n';

  // Insert all text at once
  requests.push({
    insertText: {
      location: { index: section.contentStartIndex },
      text: newContent,
    },
  });

  // Reset all inserted text to body defaults first (clear inherited heading bold)
  const insertedEnd = section.contentStartIndex + newContent.length;
  requests.push({
    updateTextStyle: {
      range: { startIndex: section.contentStartIndex, endIndex: insertedEnd },
      textStyle: {
        bold: false,
        weightedFontFamily: { fontFamily: bodyStyle.fontFamily, weight: 400 },
        fontSize: { magnitude: bodyStyle.fontSize, unit: 'PT' },
      },
      fields: 'bold,weightedFontFamily,fontSize',
    },
  });

  // Match optimized entries to template entries for formatting
  const entryMap = matchEntries(section.entries, optimizedEntries);

  // Compute paragraph ranges in the inserted text
  const paraRanges = computeParagraphRanges(newContent, section.contentStartIndex);

  // Walk through paragraph ranges and apply formatting from matched template paragraphs
  let paraIdx = 0;
  for (let ei = 0; ei < optimizedEntries.length; ei++) {
    const optEntry = optimizedEntries[ei];
    const templateEntry = entryMap.get(ei);

    if (paraIdx >= paraRanges.length) break;

    // Header paragraph
    const headerRange = paraRanges[paraIdx];
    paraIdx++;

    if (templateEntry) {
      // Clone header formatting from template
      applyTextStyle(requests, headerRange, templateEntry.header.textStyle);
      applyParagraphStyle(requests, headerRange, templateEntry.header.paragraphStyle);
    } else {
      // Fallback: bold the header
      requests.push({
        updateTextStyle: {
          range: { startIndex: headerRange.startIndex, endIndex: headerRange.endIndex },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }

    // Bullet paragraphs
    const templateBulletStyle = templateEntry?.bullets[0]?.textStyle;
    const templateBulletParaStyle = templateEntry?.bullets[0]?.paragraphStyle;
    const templateHasBullets = templateEntry?.bullets.some((b) => b.bullet);

    let bulletRangeStart: number | null = null;
    let bulletRangeEnd: number | null = null;

    for (let bi = 0; bi < optEntry.bullets.length; bi++) {
      if (paraIdx >= paraRanges.length) break;
      const bulletRange = paraRanges[paraIdx];
      paraIdx++;

      // Use the specific template bullet's style if available, otherwise first bullet's style
      const specificTemplate = templateEntry?.bullets[bi];
      const bTextStyle = specificTemplate?.textStyle || templateBulletStyle;
      const bParaStyle = specificTemplate?.paragraphStyle || templateBulletParaStyle;

      if (bTextStyle) applyTextStyle(requests, bulletRange, bTextStyle);
      if (bParaStyle) applyParagraphStyle(requests, bulletRange, bParaStyle);

      // Track contiguous bullet range for createParagraphBullets
      if (templateHasBullets) {
        if (bulletRangeStart === null) {
          bulletRangeStart = bulletRange.startIndex;
        }
        bulletRangeEnd = bulletRange.fullEndIndex;
      }
    }

    // Apply bullet formatting for this entry's bullets
    if (bulletRangeStart !== null && bulletRangeEnd !== null) {
      applyBullet(requests, { startIndex: bulletRangeStart, endIndex: bulletRangeEnd });
    }

    // Skip spacer paragraph (empty line between entries)
    if (ei < optimizedEntries.length - 1 && paraIdx < paraRanges.length) {
      const spacerRange = paraRanges[paraIdx];
      if (!spacerRange.text.trim()) {
        // Apply spacer paragraph style from template if available
        const templateSpacer = section.allParagraphs.find((p) => p.role === 'spacer');
        if (templateSpacer) {
          applyParagraphStyle(requests, spacerRange, templateSpacer.paragraphStyle);
        }
        paraIdx++;
      }
    }
  }
}

function buildSkillsRequests(
  requests: docs_v1.Schema$Request[],
  section: RichResumeSection,
  skills: { categories: OptimizedSkillCategory[] },
  bodyStyle: DocumentBodyStyle,
): void {
  // Build text: "Category: skill1, skill2\n" per category
  let newContent = '';
  for (const cat of skills.categories) {
    if (cat.name) {
      newContent += `${cat.name}: ${cat.skills}\n`;
    } else {
      newContent += `${cat.skills}\n`;
    }
  }

  requests.push({
    insertText: {
      location: { index: section.contentStartIndex },
      text: newContent,
    },
  });

  // Reset to body defaults
  const insertedEnd = section.contentStartIndex + newContent.length;
  requests.push({
    updateTextStyle: {
      range: { startIndex: section.contentStartIndex, endIndex: insertedEnd },
      textStyle: {
        bold: false,
        weightedFontFamily: { fontFamily: bodyStyle.fontFamily, weight: 400 },
        fontSize: { magnitude: bodyStyle.fontSize, unit: 'PT' },
      },
      fields: 'bold,weightedFontFamily,fontSize',
    },
  });

  // Match and apply formatting
  const catMap = matchSkillCategories(section.skillCategories, skills.categories);
  const paraRanges = computeParagraphRanges(newContent, section.contentStartIndex);

  for (let ci = 0; ci < skills.categories.length; ci++) {
    if (ci >= paraRanges.length) break;
    const range = paraRanges[ci];
    const templateCat = catMap.get(ci);

    if (templateCat) {
      // Apply paragraph style from template
      applyParagraphStyle(requests, range, templateCat.paragraph.paragraphStyle);

      // Apply text style for the whole line
      applyTextStyle(requests, range, templateCat.paragraph.textStyle);

      // Bold the category label (text before and including colon)
      const colonIdx = range.text.indexOf(':');
      if (colonIdx > 0) {
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: range.startIndex,
              endIndex: range.startIndex + colonIdx + 1,
            },
            textStyle: { bold: true },
            fields: 'bold',
          },
        });

        // Un-bold the skills text after the colon (in case template label was bold)
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: range.startIndex + colonIdx + 1,
              endIndex: range.endIndex,
            },
            textStyle: { bold: false },
            fields: 'bold',
          },
        });
      }
    } else {
      // Fallback: bold category label
      const colonIdx = range.text.indexOf(':');
      if (colonIdx > 0) {
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: range.startIndex,
              endIndex: range.startIndex + colonIdx + 1,
            },
            textStyle: { bold: true },
            fields: 'bold',
          },
        });
      }
    }
  }
}

function buildSummaryRequests(
  requests: docs_v1.Schema$Request[],
  section: RichResumeSection,
  summary: string,
  bodyStyle: DocumentBodyStyle,
): void {
  let newContent = summary;
  if (!newContent.endsWith('\n')) newContent += '\n';

  requests.push({
    insertText: {
      location: { index: section.contentStartIndex },
      text: newContent,
    },
  });

  // Reset to body defaults
  const insertedEnd = section.contentStartIndex + newContent.length;
  requests.push({
    updateTextStyle: {
      range: { startIndex: section.contentStartIndex, endIndex: insertedEnd },
      textStyle: {
        bold: false,
        weightedFontFamily: { fontFamily: bodyStyle.fontFamily, weight: 400 },
        fontSize: { magnitude: bodyStyle.fontSize, unit: 'PT' },
      },
      fields: 'bold,weightedFontFamily,fontSize',
    },
  });

  // Apply formatting from template summary paragraphs
  const paraRanges = computeParagraphRanges(newContent, section.contentStartIndex);

  for (let pi = 0; pi < paraRanges.length; pi++) {
    const range = paraRanges[pi];
    // Use corresponding template paragraph style, or fallback to first
    const templatePara = section.summaryParagraphs[pi] || section.summaryParagraphs[0];
    if (templatePara) {
      applyTextStyle(requests, range, templatePara.textStyle);
      applyParagraphStyle(requests, range, templatePara.paragraphStyle);
    }
  }
}

// ─── Saved state capture ─────────────────────────────────────────────────────

/**
 * Captures the current state of all modifiable paragraphs before optimization.
 * Used to surgically revert after PDF export.
 */
export function buildSavedState(richSections: RichResumeSection[]): SavedResumeState {
  return richSections.map((section) => {
    const state: SavedSectionState = {
      type: section.type,
      entries: [],
      skills: [],
      summaryParagraphs: [],
    };

    if (section.type === 'experience' || section.type === 'projects') {
      state.entries = section.entries.map((entry) => ({
        bullets: entry.bullets.map((bullet) => ({
          text: bullet.text.replace(/\n$/, ''),
          textStyle: { ...bullet.textStyle },
        })),
      }));
    } else if (section.type === 'skills') {
      state.skills = section.skillCategories.map((cat) => ({
        skillsText: cat.skillsText,
        skillTextStyle: { ...cat.paragraph.textStyle, bold: false },
      }));
    } else if (section.type === 'summary') {
      state.summaryParagraphs = section.summaryParagraphs.map((para) => ({
        text: para.text.replace(/\n$/, ''),
        textStyle: { ...para.textStyle },
      }));
    }

    return state;
  });
}

// ─── Surgical paragraph replacement helpers ──────────────────────────────────

/**
 * Builds requests to replace a paragraph's text content without destroying the paragraph.
 * Deletes text (preserves trailing \n paragraph boundary), inserts new text, applies text style.
 */
function buildParagraphReplaceOps(
  para: RichParagraph,
  newText: string,
  textStyle: CapturedTextStyle,
): docs_v1.Schema$Request[] {
  const reqs: docs_v1.Schema$Request[] = [];

  // Delete existing text (preserve paragraph boundary \n at endIndex - 1)
  if (para.endIndex - 1 > para.startIndex) {
    reqs.push({
      deleteContentRange: {
        range: {
          startIndex: para.startIndex,
          endIndex: para.endIndex - 1,
        },
      },
    });
  }

  // Insert new text at the paragraph start
  if (newText) {
    reqs.push({
      insertText: {
        location: { index: para.startIndex },
        text: newText,
      },
    });

    // Re-apply text style to the inserted text
    const fields = textStyleFields(textStyle);
    if (fields) {
      reqs.push({
        updateTextStyle: {
          range: {
            startIndex: para.startIndex,
            endIndex: para.startIndex + newText.length,
          },
          textStyle: textStyleToApi(textStyle),
          fields,
        },
      });
    }
  }

  return reqs;
}

/**
 * Builds requests to replace only the skills text (after ": ") in a skill category paragraph.
 * Preserves the bold label and colon; only swaps the skills list.
 */
function buildSkillsReplaceOps(
  para: RichParagraph,
  newSkillsText: string,
  textStyle: CapturedTextStyle,
): docs_v1.Schema$Request[] {
  const reqs: docs_v1.Schema$Request[] = [];

  const colonIdx = para.text.indexOf(': ');
  if (colonIdx < 0) return reqs;

  const afterColonStart = para.startIndex + colonIdx + 2; // after ": "
  const textEnd = para.endIndex - 1; // before \n

  // Delete current skills text after colon
  if (textEnd > afterColonStart) {
    reqs.push({
      deleteContentRange: {
        range: {
          startIndex: afterColonStart,
          endIndex: textEnd,
        },
      },
    });
  }

  // Insert new skills text
  if (newSkillsText) {
    reqs.push({
      insertText: {
        location: { index: afterColonStart },
        text: newSkillsText,
      },
    });

    // Apply text style (non-bold, same font/size as original)
    const fields = textStyleFields(textStyle);
    if (fields) {
      reqs.push({
        updateTextStyle: {
          range: {
            startIndex: afterColonStart,
            endIndex: afterColonStart + newSkillsText.length,
          },
          textStyle: textStyleToApi(textStyle),
          fields,
        },
      });
    }
  }

  return reqs;
}

// ─── Surgical replacement (forward write) ────────────────────────────────────

/**
 * Builds batchUpdate requests that surgically replace text within existing paragraphs.
 * Never deletes or creates paragraph boundaries — only swaps text content.
 * This preserves all paragraph-level properties (spacing, borders, bullets, list membership).
 *
 * Operations are ordered in reverse document position so index shifts don't affect pending ops.
 */
export function buildSurgicalReplacementRequests(
  richSections: RichResumeSection[],
  result: OptimizationResult,
): docs_v1.Schema$Request[] {
  const ops: Array<{ sortIndex: number; requests: docs_v1.Schema$Request[] }> = [];

  for (const section of richSections) {
    if (
      (section.type === 'experience' && result.experience) ||
      (section.type === 'projects' && result.projects)
    ) {
      const optimizedEntries =
        section.type === 'experience' ? result.experience!.entries : result.projects!.entries;

      const entryMap = matchEntries(section.entries, optimizedEntries);

      for (let oi = 0; oi < optimizedEntries.length; oi++) {
        const templateEntry = entryMap.get(oi);
        if (!templateEntry) continue;
        const optEntry = optimizedEntries[oi];

        // Replace each bullet (up to the shared count — same count enforced by prompt)
        const bulletCount = Math.min(templateEntry.bullets.length, optEntry.bullets.length);
        for (let bi = 0; bi < bulletCount; bi++) {
          const para = templateEntry.bullets[bi];
          const newText = optEntry.bullets[bi];

          const oldText = para.text.replace(/\n$/, '');
          if (oldText === newText) continue;

          const reqs = buildParagraphReplaceOps(para, newText, para.textStyle);
          ops.push({ sortIndex: para.startIndex, requests: reqs });
        }
      }
    } else if (section.type === 'skills' && result.skills) {
      const catMap = matchSkillCategories(section.skillCategories, result.skills.categories);

      // Build reverse map: template category index → optimized category
      const reverseMap = new Map<number, OptimizedSkillCategory>();
      for (const [oi, templateCat] of catMap) {
        const ti = section.skillCategories.indexOf(templateCat);
        if (ti >= 0) reverseMap.set(ti, result.skills.categories[oi]);
      }

      for (let ti = 0; ti < section.skillCategories.length; ti++) {
        const optCat = reverseMap.get(ti);
        if (!optCat) continue;

        const templateCat = section.skillCategories[ti];
        if (templateCat.skillsText.trim() === optCat.skills.trim()) continue;

        const skillTextStyle: CapturedTextStyle = { ...templateCat.paragraph.textStyle, bold: false };
        const reqs = buildSkillsReplaceOps(templateCat.paragraph, optCat.skills, skillTextStyle);
        ops.push({ sortIndex: templateCat.paragraph.startIndex, requests: reqs });
      }
    } else if (section.type === 'summary' && result.summary) {
      const summaryLines = result.summary.split('\n').filter((l) => l.trim());
      const paraCount = Math.min(section.summaryParagraphs.length, summaryLines.length);

      for (let pi = 0; pi < paraCount; pi++) {
        const para = section.summaryParagraphs[pi];
        const newText = summaryLines[pi];

        const oldText = para.text.replace(/\n$/, '');
        if (oldText === newText) continue;

        const reqs = buildParagraphReplaceOps(para, newText, para.textStyle);
        ops.push({ sortIndex: para.startIndex, requests: reqs });
      }
    }
  }

  // Sort in reverse document order (highest index first)
  ops.sort((a, b) => b.sortIndex - a.sortIndex);

  return ops.flatMap((op) => op.requests);
}

// ─── Surgical revert ─────────────────────────────────────────────────────────

/**
 * Builds batchUpdate requests to surgically revert the template to its original state.
 * Uses the same per-paragraph replacement approach as the forward write.
 *
 * @param currentRichSections - Fresh parse of the doc AFTER the forward write (has current indices)
 * @param savedState - State captured BEFORE the forward write (has original text + styles)
 */
export function buildSurgicalRevertRequests(
  currentRichSections: RichResumeSection[],
  savedState: SavedResumeState,
): docs_v1.Schema$Request[] {
  const ops: Array<{ sortIndex: number; requests: docs_v1.Schema$Request[] }> = [];

  for (const currentSection of currentRichSections) {
    const saved = savedState.find((s) => s.type === currentSection.type);
    if (!saved) continue;

    if (currentSection.type === 'experience' || currentSection.type === 'projects') {
      for (let ei = 0; ei < currentSection.entries.length && ei < saved.entries.length; ei++) {
        const currentEntry = currentSection.entries[ei];
        const savedEntry = saved.entries[ei];

        for (let bi = 0; bi < currentEntry.bullets.length && bi < savedEntry.bullets.length; bi++) {
          const para = currentEntry.bullets[bi];
          const savedBullet = savedEntry.bullets[bi];

          const currentText = para.text.replace(/\n$/, '');
          if (currentText === savedBullet.text) continue;

          const reqs = buildParagraphReplaceOps(para, savedBullet.text, savedBullet.textStyle);
          ops.push({ sortIndex: para.startIndex, requests: reqs });
        }
      }
    } else if (currentSection.type === 'skills') {
      for (let ci = 0; ci < currentSection.skillCategories.length && ci < saved.skills.length; ci++) {
        const cat = currentSection.skillCategories[ci];
        const savedSkill = saved.skills[ci];

        if (cat.skillsText.trim() === savedSkill.skillsText.trim()) continue;

        const reqs = buildSkillsReplaceOps(cat.paragraph, savedSkill.skillsText, savedSkill.skillTextStyle);
        ops.push({ sortIndex: cat.paragraph.startIndex, requests: reqs });
      }
    } else if (currentSection.type === 'summary') {
      for (
        let pi = 0;
        pi < currentSection.summaryParagraphs.length && pi < saved.summaryParagraphs.length;
        pi++
      ) {
        const para = currentSection.summaryParagraphs[pi];
        const savedSummary = saved.summaryParagraphs[pi];

        const currentText = para.text.replace(/\n$/, '');
        if (currentText === savedSummary.text) continue;

        const reqs = buildParagraphReplaceOps(para, savedSummary.text, savedSummary.textStyle);
        ops.push({ sortIndex: para.startIndex, requests: reqs });
      }
    }
  }

  ops.sort((a, b) => b.sortIndex - a.sortIndex);
  return ops.flatMap((op) => op.requests);
}
