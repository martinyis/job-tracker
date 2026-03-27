import fs from 'fs';
import path from 'path';
import { createDocsClient, createDriveClient } from '../google/google-auth';
import { parseRichResumeSections } from '../google/doc-parser';
import {
  buildSurgicalReplacementRequests,
  buildSavedState,
  buildSurgicalRevertRequests,
  SavedResumeState,
} from '../google/doc-writer';
import { optimizeResume, OptimizationResult } from '../ai/resume-optimizer';
import { createOptimizedResume, updateOptimizedResume } from '../database/resume-queries';
import { getJobById } from '../database/queries';
import { getOrCreateProfile } from '../database/profile-queries';
import { config } from '../config';
import { logger } from '../logger';

const PDF_DIR = path.resolve('./data/optimized-resumes');

/**
 * Reads optional context files from disk for the AI prompt.
 */
function loadContextFiles(): string {
  const files = ['data/martin-context.md', 'data/project-details.md'];
  const parts: string[] = [];

  for (const filePath of files) {
    const fullPath = path.resolve(filePath);
    try {
      if (fs.existsSync(fullPath)) {
        parts.push(fs.readFileSync(fullPath, 'utf-8'));
      }
    } catch {
      // Skip missing files
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Full resume optimization pipeline (edit-in-place strategy):
 * 1. Create DB record
 * 2. Read template doc structure + save original content
 * 3. Call Claude for optimization (structured per-entry format)
 * 4. Write optimized content to template with format cloning (temporary)
 * 5. Export PDF from template
 * 6. REVERT template to original content
 * 7. Save PDF locally + update DB
 *
 * The template is only modified for the brief window between steps 4-6.
 * Original content is always restored in a finally block.
 */
export async function runResumePipeline(jobId: string): Promise<string> {
  // Create the DB record immediately
  const record = await createOptimizedResume(jobId);
  const resumeId = record.id;

  // Run the pipeline async — don't await
  executePipeline(resumeId, jobId).catch((err) => {
    logger.error('Resume pipeline failed', { resumeId, jobId, error: String(err) });
  });

  return resumeId;
}

async function executePipeline(resumeId: string, jobId: string): Promise<void> {
  let templateModified = false;
  const docs = createDocsClient();
  const templateDocId = config.google.resumeTemplateDocId;
  let savedState: SavedResumeState | null = null;

  try {
    // 1. Load job data
    const job = await getJobById(jobId);
    if (!job) throw new Error('Job not found');
    if (!job.description) throw new Error('Job has no description — enrich it first');

    // 2. Read the template doc structure
    const docResponse = await docs.documents.get({ documentId: templateDocId });
    const richSections = parseRichResumeSections(docResponse.data);

    if (richSections.length === 0) {
      throw new Error('Could not parse any sections from the resume template');
    }

    // 3. Save state for revert (captures original text + styles per paragraph)
    savedState = buildSavedState(richSections);

    // 4. Load context
    const profile = await getOrCreateProfile();
    const contextFiles = loadContextFiles();
    const profileSummaryCache = profile.profileSummaryCache || '';

    // 5. Call AI for optimization (structured per-entry output)
    const result: OptimizationResult = await optimizeResume({
      sections: richSections,
      jobTitle: job.title,
      jobCompany: job.company,
      jobDescription: job.description,
      jobLocation: job.location,
      profileSummaryCache,
      contextFiles,
    });

    // 6. Build surgical replacement requests (preserves paragraph structure)
    const optimizedRequests = buildSurgicalReplacementRequests(richSections, result);

    if (optimizedRequests.length === 0) {
      throw new Error('No changes generated from optimization');
    }

    // 7. Write optimized content to the TEMPLATE (temporarily)
    await docs.documents.batchUpdate({
      documentId: templateDocId,
      requestBody: { requests: optimizedRequests },
    });
    templateModified = true;

    // 8. Export the modified template as PDF
    const drive = createDriveClient();
    const pdfResponse = await drive.files.export(
      { fileId: templateDocId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' },
    );

    // 9. REVERT: re-read doc (indices shifted after write), surgical revert to original
    await surgicalRevert(docs, templateDocId, savedState);
    templateModified = false;

    // 10. Save PDF locally
    if (!fs.existsSync(PDF_DIR)) {
      fs.mkdirSync(PDF_DIR, { recursive: true });
    }

    const sanitizedCompany = job.company.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const pdfFilename = `resume-${sanitizedCompany}-${timestamp}.pdf`;
    const pdfPath = path.join(PDF_DIR, pdfFilename);

    const pdfBuffer = Buffer.from(pdfResponse.data as ArrayBuffer);
    fs.writeFileSync(pdfPath, pdfBuffer);

    // 11. Update DB record with success
    const docUrl = `https://docs.google.com/document/d/${templateDocId}/edit`;
    await updateOptimizedResume(resumeId, {
      status: 'completed',
      googleDocId: templateDocId,
      googleDocUrl: docUrl,
      pdfFilename,
      pdfStoragePath: `data/optimized-resumes/${pdfFilename}`,
      pdfSizeBytes: pdfBuffer.length,
      sectionsModified: result.sectionsModified,
      optimizationNotes: result.optimizationNotes,
    });

    logger.info('Resume optimization completed', {
      resumeId,
      jobId,
      pdfFilename,
      sectionsModified: result.sectionsModified,
    });
  } catch (error) {
    if (templateModified && savedState) {
      logger.warn('Pipeline failed with template modified — attempting surgical revert');
      try {
        await surgicalRevert(docs, templateDocId, savedState);
        logger.info('Template reverted after pipeline failure');
      } catch (revertErr) {
        logger.error('Failed to revert template — may need manual restoration', {
          error: String(revertErr),
        });
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error('Resume pipeline error', { resumeId, jobId, error: message });

    await updateOptimizedResume(resumeId, {
      status: 'failed',
      errorMessage: message,
    }).catch(() => {});
  }
}

/**
 * Surgically reverts the template doc to its original state.
 * Re-reads the doc to get fresh indices (they shifted after the forward write),
 * then replaces each modified paragraph's text back to the saved original.
 * Preserves all paragraph-level properties (spacing, borders, bullets).
 */
async function surgicalRevert(
  docs: ReturnType<typeof createDocsClient>,
  templateDocId: string,
  savedState: SavedResumeState,
): Promise<void> {
  const freshDoc = await docs.documents.get({ documentId: templateDocId });
  const freshSections = parseRichResumeSections(freshDoc.data);
  const revertRequests = buildSurgicalRevertRequests(freshSections, savedState);

  if (revertRequests.length > 0) {
    await docs.documents.batchUpdate({
      documentId: templateDocId,
      requestBody: { requests: revertRequests },
    });
  }

  logger.info('Template reverted to original content');
}
