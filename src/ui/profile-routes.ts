import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import {
  getOrCreateProfile,
  updateProfile,
  invalidateProfileSummaryCache,
  getWorkExperience,
  addWorkExperience,
  updateWorkExperience,
  deleteWorkExperience,
  getEducation,
  addEducation,
  updateEducation,
  deleteEducation,
  getSkills,
  addSkill,
  deleteSkill,
  getReferences,
  addReference,
  updateReference,
  deleteReference,
  getDocuments,
  addDocument,
  deleteDocument,
  getDemographicAnswers,
  upsertDemographicAnswer,
  parseJsonArray,
  toJsonArray,
} from '../database/profile-queries';
import { DEMOGRAPHIC_CATEGORIES } from '../constants/demographic-categories';

export const profileRouter = Router();

// Multer config for document uploads → data/documents/
const DOCUMENTS_DIR = path.resolve('./data/documents');
const documentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(DOCUMENTS_DIR)) {
        fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
      }
      cb(null, DOCUMENTS_DIR);
    },
    filename: (_req, file, cb) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
      cb(null, `${base}-${timestamp}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents are accepted'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** Helper: splits a comma-separated string into a trimmed array. */
function splitComma(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Helper: safely get a string from req.body (Express can return string | string[]) */
function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] || '';
  return '';
}

// ─── Profile Overview Page ────────────────────────────────

profileRouter.get('/profile', async (_req: Request, res: Response) => {
  try {
    const profile = await getOrCreateProfile();
    const demographicAnswers = await getDemographicAnswers();

    // Build a map of category -> { answer, notes } for the template
    const demographicMap: Record<string, { answer: string; notes: string }> = {};
    for (const a of demographicAnswers) {
      demographicMap[a.category] = { answer: a.answer, notes: a.notes };
    }

    res.render('profile', {
      profile,
      parseJsonArray,
      demographicCategories: DEMOGRAPHIC_CATEGORIES,
      demographicMap,
    });
  } catch (error) {
    logger.error('Error rendering profile page', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Internal Server Error');
  }
});

// ─── Personal Info ────────────────────────────────────────

profileRouter.post('/profile/personal', async (req: Request, res: Response) => {
  try {
    await updateProfile({
      firstName: str(req.body.firstName),
      lastName: str(req.body.lastName),
      email: str(req.body.email),
      phone: str(req.body.phone),
      linkedinUrl: str(req.body.linkedinUrl),
      website: str(req.body.website),
      city: str(req.body.city),
      state: str(req.body.state),
      country: str(req.body.country),
      zipCode: str(req.body.zipCode),
      summary: str(req.body.summary),
    });
    logger.info('Profile personal info updated');
    res.redirect('/profile#personal');
  } catch (error) {
    logger.error('Failed to update personal info', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

// ─── Preferences ──────────────────────────────────────────

profileRouter.post('/profile/preferences', async (req: Request, res: Response) => {
  try {
    await updateProfile({
      remoteOnly: str(req.body.remoteOnly) === 'on',
      willingToRelocate: str(req.body.willingToRelocate) === 'on',
      openToContract: str(req.body.openToContract) === 'on',
      visaSponsorshipNeeded: str(req.body.visaSponsorshipNeeded) === 'on',
      minSalary: parseInt(str(req.body.minSalary), 10) || 0,
      preferredCompanySize: toJsonArray(splitComma(str(req.body.preferredCompanySize))),
      avoidIndustries: toJsonArray(splitComma(str(req.body.avoidIndustries))),
      preferredTechStack: toJsonArray(splitComma(str(req.body.preferredTechStack))),
      targetSeniority: toJsonArray(splitComma(str(req.body.targetSeniority))),
      excludeTitleKeywords: toJsonArray(splitComma(str(req.body.excludeTitleKeywords))),
      keyInterests: toJsonArray(splitComma(str(req.body.keyInterests))),
      dealbreakers: toJsonArray(splitComma(str(req.body.dealbreakers))),
    });
    logger.info('Profile preferences updated');
    res.redirect('/profile#preferences');
  } catch (error) {
    logger.error('Failed to update preferences', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

// ─── Work Experience CRUD ─────────────────────────────────

profileRouter.post('/profile/experience', async (req: Request, res: Response) => {
  try {
    await addWorkExperience({
      employer: str(req.body.employer),
      title: str(req.body.title),
      location: str(req.body.location),
      startDate: str(req.body.startDate),
      endDate: str(req.body.isCurrent) === 'on' ? null : (str(req.body.endDate) || null),
      isCurrent: str(req.body.isCurrent) === 'on',
      description: str(req.body.description),
    });
    res.redirect('/profile#experience');
  } catch (error) {
    logger.error('Failed to add work experience', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/experience/:id', async (req: Request, res: Response) => {
  try {
    await updateWorkExperience(req.params.id as string, {
      employer: str(req.body.employer),
      title: str(req.body.title),
      location: str(req.body.location),
      startDate: str(req.body.startDate),
      endDate: str(req.body.isCurrent) === 'on' ? null : (str(req.body.endDate) || null),
      isCurrent: str(req.body.isCurrent) === 'on',
      description: str(req.body.description),
    });
    res.redirect('/profile#experience');
  } catch (error) {
    logger.error('Failed to update work experience', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/experience/:id/delete', async (req: Request, res: Response) => {
  try {
    await deleteWorkExperience(req.params.id as string);
    res.redirect('/profile#experience');
  } catch (error) {
    logger.error('Failed to delete work experience', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to delete');
  }
});

// ─── Education CRUD ───────────────────────────────────────

profileRouter.post('/profile/education', async (req: Request, res: Response) => {
  try {
    await addEducation({
      institution: str(req.body.institution),
      degree: str(req.body.degree),
      fieldOfStudy: str(req.body.fieldOfStudy),
      startDate: str(req.body.startDate) || null,
      endDate: str(req.body.endDate) || null,
      gpa: str(req.body.gpa) || null,
    });
    res.redirect('/profile#education');
  } catch (error) {
    logger.error('Failed to add education', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/education/:id', async (req: Request, res: Response) => {
  try {
    await updateEducation(req.params.id as string, {
      institution: str(req.body.institution),
      degree: str(req.body.degree),
      fieldOfStudy: str(req.body.fieldOfStudy),
      startDate: str(req.body.startDate) || null,
      endDate: str(req.body.endDate) || null,
      gpa: str(req.body.gpa) || null,
    });
    res.redirect('/profile#education');
  } catch (error) {
    logger.error('Failed to update education', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/education/:id/delete', async (req: Request, res: Response) => {
  try {
    await deleteEducation(req.params.id as string);
    res.redirect('/profile#education');
  } catch (error) {
    logger.error('Failed to delete education', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to delete');
  }
});

// ─── Skills CRUD ──────────────────────────────────────────

profileRouter.post('/profile/skill', async (req: Request, res: Response) => {
  try {
    await addSkill({
      name: str(req.body.name),
      category: str(req.body.category) || 'technical',
      yearsOfExperience: str(req.body.yearsOfExperience) ? parseInt(str(req.body.yearsOfExperience), 10) : null,
      proficiency: str(req.body.proficiency) || null,
    });
    res.redirect('/profile#skills');
  } catch (error) {
    logger.error('Failed to add skill', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/skill/:id/delete', async (req: Request, res: Response) => {
  try {
    await deleteSkill(req.params.id as string);
    res.redirect('/profile#skills');
  } catch (error) {
    logger.error('Failed to delete skill', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to delete');
  }
});

// ─── References CRUD ──────────────────────────────────────

profileRouter.post('/profile/reference', async (req: Request, res: Response) => {
  try {
    await addReference({
      name: str(req.body.name),
      relationship: str(req.body.relationship),
      company: str(req.body.company),
      email: str(req.body.email),
      phone: str(req.body.phone),
      notes: str(req.body.notes),
    });
    res.redirect('/profile#references');
  } catch (error) {
    logger.error('Failed to add reference', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/reference/:id', async (req: Request, res: Response) => {
  try {
    await updateReference(req.params.id as string, {
      name: str(req.body.name),
      relationship: str(req.body.relationship),
      company: str(req.body.company),
      email: str(req.body.email),
      phone: str(req.body.phone),
      notes: str(req.body.notes),
    });
    res.redirect('/profile#references');
  } catch (error) {
    logger.error('Failed to update reference', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

profileRouter.post('/profile/reference/:id/delete', async (req: Request, res: Response) => {
  try {
    await deleteReference(req.params.id as string);
    res.redirect('/profile#references');
  } catch (error) {
    logger.error('Failed to delete reference', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to delete');
  }
});

// ─── Document Upload & Management ─────────────────────────

profileRouter.post('/profile/document', documentUpload.single('document'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).send('No file uploaded.');
    return;
  }

  try {
    const docType = str(req.body.docType) || 'other';
    const isPrimary = str(req.body.isPrimary) === 'on';

    await addDocument({
      type: docType,
      filename: req.file.originalname,
      storagePath: `documents/${req.file.filename}`,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      isPrimary,
    });

    if (docType === 'resume' && isPrimary) {
      await invalidateProfileSummaryCache();
    }

    logger.info('Document uploaded', { filename: req.file.originalname, type: docType });
    res.redirect('/profile#documents');
  } catch (error) {
    logger.error('Failed to upload document', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to upload');
  }
});

profileRouter.post('/profile/document/:id/delete', async (req: Request, res: Response) => {
  try {
    // Find the document to get its file path
    const docs = await getDocuments();
    const doc = docs.find((d) => d.id === req.params.id as string);

    if (doc) {
      // Delete file from disk
      const filePath = path.resolve('./data', doc.storagePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      } else {
        logger.warn('Document file not found on disk', { path: filePath });
      }
      // Delete DB row
      await deleteDocument(req.params.id as string);
      logger.info('Document deleted', { filename: doc.filename });
    }

    res.redirect('/profile#documents');
  } catch (error) {
    logger.error('Failed to delete document', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to delete');
  }
});

profileRouter.post('/profile/document/:id/primary', async (req: Request, res: Response) => {
  try {
    const docs = await getDocuments();
    const doc = docs.find((d) => d.id === req.params.id as string);

    if (doc) {
      // Clear other primaries of same type
      const { prisma } = await import('../database/client');
      await prisma.document.updateMany({
        where: { profileId: 'singleton', type: doc.type, isPrimary: true },
        data: { isPrimary: false },
      });
      await prisma.document.update({
        where: { id: req.params.id as string },
        data: { isPrimary: true },
      });

      if (doc.type === 'resume') {
        await invalidateProfileSummaryCache();
      }

      logger.info('Document set as primary', { filename: doc.filename });
    }

    res.redirect('/profile#documents');
  } catch (error) {
    logger.error('Failed to set primary document', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to update');
  }
});

// ─── Application Info (additional profile fields) ────────

profileRouter.post('/profile/application-info', async (req: Request, res: Response) => {
  try {
    await updateProfile({
      preferredName: str(req.body.preferredName),
      pronouns: str(req.body.pronouns),
      dateOfBirth: str(req.body.dateOfBirth),
      yearsOfExperience: parseInt(str(req.body.yearsOfExperience), 10) || 0,
      desiredSalary: str(req.body.desiredSalary),
      availableStartDate: str(req.body.availableStartDate),
      coverLetterNotes: str(req.body.coverLetterNotes),
    });
    logger.info('Application info updated');
    res.redirect('/profile#application-info');
  } catch (error) {
    logger.error('Failed to update application info', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});

// ─── Demographic Answers ─────────────────────────────────

profileRouter.post('/profile/demographics', async (req: Request, res: Response) => {
  try {
    for (const cat of DEMOGRAPHIC_CATEGORIES) {
      const answer = str(req.body[`demographic_${cat.id}`]);
      const customAnswer = str(req.body[`demographic_${cat.id}_custom`]);
      const notes = str(req.body[`demographic_${cat.id}_notes`]);

      // Use custom answer if the dropdown was set to "__custom__"
      const finalAnswer = answer === '__custom__' ? customAnswer : answer;

      await upsertDemographicAnswer(cat.id, finalAnswer, notes);
    }
    logger.info('Demographic answers updated');
    res.redirect('/profile#demographics');
  } catch (error) {
    logger.error('Failed to update demographic answers', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).send('Failed to save');
  }
});
