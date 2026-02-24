/**
 * Hybrid scoring engine: deterministic + AI sub-scores.
 * Combines 16 weighted dimensions into a 0-100 final score.
 */

// ─── Types ───────────────────────────────────────────────

export interface DealbreakersResult {
  seniorityTooHigh: boolean;
  clearanceRequired: boolean;
  wrongTechDomain: boolean;
  experienceMinYears: number | null;
}

export interface AIScores {
  techStack: number;
  roleType: number;
  aiRelevance: number;
  fullStackBreadth: number;
  productOwnership: number;
  companyStage: number;
  growthPotential: number;
  descriptionQuality: number;
  postingFreshness: number;
  posterRole: number;
}

export interface ExtractedSignals {
  workArrangement: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  applicationMethod: 'easyApply' | 'externalSite' | 'directReferral' | 'unknown';
  urgencySignalMatched: boolean;
  isFoundingRole: boolean;
  recentFunding: boolean;
  dmInvitation: boolean;
  exactStackCount: number;
  isStaffingAgency: boolean;
  highApplicantCount: boolean;
  ghostListingSignals: boolean;
  repostSignal: boolean;
}

export interface ScoreBreakdown {
  // AI-scored dimensions (0-10)
  techStack: number;
  roleType: number;
  aiRelevance: number;
  fullStackBreadth: number;
  productOwnership: number;
  companyStage: number;
  growthPotential: number;
  descriptionQuality: number;
  postingFreshness: number;
  posterRole: number;
  // Deterministic dimensions (0-10)
  experienceMatch: number;
  seniorityAlignment: number;
  applicantCompetition: number;
  remotePosition: number;
  directContact: number;
  applicationMethod: number;
  // Modifiers
  bonuses: string[];
  penalties: string[];
  baseScore: number;
  finalScore: number;
  minYearsExtracted: number | null;
}

export interface ProfileContext {
  yearsOfExperience: number;
  willingToRelocate: boolean;
  remoteOnly: boolean;
}

export interface JobContext {
  seniorityLevel: string;
  applicantCount: string;
  postedBy: string;
  postedByProfile: string;
}

// ─── Weights ─────────────────────────────────────────────

export const DIMENSION_WEIGHTS: Record<string, number> = {
  techStack: 0.10,
  roleType: 0.09,
  aiRelevance: 0.12,
  fullStackBreadth: 0.05,
  productOwnership: 0.06,
  companyStage: 0.12,
  growthPotential: 0.06,
  experienceMatch: 0.08,
  seniorityAlignment: 0.05,
  applicantCompetition: 0.04,
  descriptionQuality: 0.03,
  postingFreshness: 0.02,
  remotePosition: 0.12,
  directContact: 0.03,
  posterRole: 0.02,
  applicationMethod: 0.01,
};

// ─── Dealbreaker Check ───────────────────────────────────

/**
 * Returns the dealbreaker ID string if one was triggered, or null if none.
 * candidateYears enables a relative experience gap check (gap >= 3 years = dealbreaker).
 */
export function checkDealbreakers(dealbreakers: DealbreakersResult, candidateYears?: number): string | null {
  if (dealbreakers.seniorityTooHigh) return 'seniorityTooHigh';
  if (dealbreakers.clearanceRequired) return 'clearanceRequired';
  if (dealbreakers.wrongTechDomain) return 'wrongTechDomain';
  if (dealbreakers.experienceMinYears !== null) {
    if (dealbreakers.experienceMinYears >= 6) return 'experienceRequires6Plus';
    if (candidateYears !== undefined && dealbreakers.experienceMinYears - candidateYears >= 3) {
      return 'experienceGapTooLarge';
    }
  }
  return null;
}

// ─── Deterministic Scores ────────────────────────────────

/**
 * Calculates scores for the 6 deterministic dimensions.
 */
export function calculateDeterministicScores(
  job: JobContext,
  profile: ProfileContext,
  extracted: ExtractedSignals,
  minYearsRequired: number | null,
): Record<string, number> {
  return {
    experienceMatch: scoreExperienceMatch(minYearsRequired, profile.yearsOfExperience),
    seniorityAlignment: scoreSeniorityAlignment(job.seniorityLevel),
    applicantCompetition: scoreApplicantCompetition(job.applicantCount),
    remotePosition: scoreRemotePosition(extracted.workArrangement, profile.willingToRelocate),
    directContact: scoreDirectContact(job.postedBy, job.postedByProfile, extracted.dmInvitation),
    applicationMethod: scoreApplicationMethod(extracted.applicationMethod),
  };
}

function scoreExperienceMatch(minRequired: number | null, candidateYears: number): number {
  if (minRequired === null) return 7;
  if (minRequired <= 2) return 10;
  if (minRequired <= 3) return 9;
  if (minRequired <= 4) return 8;
  if (minRequired <= 5) return 6;
  // 5-6 is a stretch (should not normally reach here due to dealbreaker at 6+)
  return 3;
}

function scoreSeniorityAlignment(seniorityLevel: string): number {
  const level = seniorityLevel.toLowerCase().trim();
  if (!level || level === 'not applicable') return 6;
  if (level === 'entry level' || level === 'internship') return 9;
  if (level === 'associate') return 9;
  if (level === 'mid-senior level') return 3;
  if (level === 'director' || level === 'executive') return 1;
  return 6; // Unknown / other
}

function scoreApplicantCompetition(applicantCount: string): number {
  if (!applicantCount) return 5;
  // Extract number from strings like "Be among the first 25 applicants" or "Over 200 applicants"
  const match = applicantCount.match(/(\d+)/);
  if (!match) return 5;
  const count = parseInt(match[1], 10);
  if (count <= 25) return 10;
  if (count <= 50) return 8;
  if (count <= 100) return 6;
  if (count <= 200) return 4;
  return 2;
}

function scoreRemotePosition(
  workArrangement: string,
  willingToRelocate: boolean,
): number {
  switch (workArrangement) {
    case 'remote': return 10;
    case 'hybrid': return 5;
    case 'onsite': return willingToRelocate ? 3 : 1;
    default: return 5; // unknown
  }
}

function scoreDirectContact(
  postedBy: string,
  postedByProfile: string,
  dmInvitation: boolean,
): number {
  if (postedBy && postedByProfile && dmInvitation) return 10;
  if (postedBy && postedByProfile) return 7;
  if (postedBy) return 5;
  return 3;
}

function scoreApplicationMethod(method: string): number {
  switch (method) {
    case 'directReferral': return 10;
    case 'externalSite': return 8;
    case 'easyApply': return 7;
    default: return 5;
  }
}

// ─── Bonuses & Penalties ─────────────────────────────────

export function calculateBonuses(extracted: ExtractedSignals): { bonuses: string[]; totalBonus: number } {
  const bonuses: string[] = [];
  let total = 0;

  if (extracted.urgencySignalMatched) {
    bonuses.push('urgencySignal');
    total += 5;
  }
  if (extracted.isFoundingRole) {
    bonuses.push('foundingRole');
    total += 5;
  }
  if (extracted.recentFunding) {
    bonuses.push('recentFunding');
    total += 3;
  }
  if (extracted.dmInvitation) {
    bonuses.push('dmInvitation');
    total += 3;
  }
  if (extracted.exactStackCount >= 4) {
    bonuses.push('exactStackMatch');
    total += 3;
  }

  return { bonuses, totalBonus: total };
}

export function calculatePenalties(extracted: ExtractedSignals): { penalties: string[]; totalPenalty: number } {
  const penalties: string[] = [];
  let total = 0;

  if (extracted.isStaffingAgency) {
    penalties.push('staffingAgency');
    total += 8;
  }
  if (extracted.highApplicantCount) {
    penalties.push('highApplicants');
    total += 5;
  }
  if (extracted.ghostListingSignals) {
    penalties.push('ghostListing');
    total += 5;
  }
  if (extracted.repostSignal) {
    penalties.push('repost');
    total += 3;
  }

  return { penalties, totalPenalty: total };
}

// ─── Final Score Computation ─────────────────────────────

/**
 * Computes the weighted final score from all sub-scores + bonuses/penalties.
 */
export function computeFinalScore(
  aiScores: AIScores,
  deterministicScores: Record<string, number>,
  extracted: ExtractedSignals,
): { baseScore: number; finalScore: number; breakdown: ScoreBreakdown; bonuses: string[]; penalties: string[] } {
  // Merge all scores into a single map
  const allScores: Record<string, number> = {
    ...aiScores,
    ...deterministicScores,
  };

  // Clamp all sub-scores to 0-10
  for (const key of Object.keys(allScores)) {
    allScores[key] = Math.max(0, Math.min(10, allScores[key]));
  }

  // Weighted sum: each subscore (0-10) * weight, weights sum to 1.0, max = 100
  let baseScore = 0;
  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    const score = allScores[dim] ?? 5; // default to neutral if missing
    baseScore += score * weight * 10;
  }
  baseScore = Math.round(baseScore);

  // Apply bonuses and penalties
  const { bonuses, totalBonus } = calculateBonuses(extracted);
  const { penalties, totalPenalty } = calculatePenalties(extracted);

  const finalScore = Math.max(0, Math.min(100, baseScore + totalBonus - totalPenalty));

  const breakdown: ScoreBreakdown = {
    techStack: allScores.techStack,
    roleType: allScores.roleType,
    aiRelevance: allScores.aiRelevance,
    fullStackBreadth: allScores.fullStackBreadth,
    productOwnership: allScores.productOwnership,
    companyStage: allScores.companyStage,
    growthPotential: allScores.growthPotential,
    descriptionQuality: allScores.descriptionQuality,
    postingFreshness: allScores.postingFreshness,
    posterRole: allScores.posterRole,
    experienceMatch: allScores.experienceMatch,
    seniorityAlignment: allScores.seniorityAlignment,
    applicantCompetition: allScores.applicantCompetition,
    remotePosition: allScores.remotePosition,
    directContact: allScores.directContact,
    applicationMethod: allScores.applicationMethod,
    bonuses,
    penalties,
    baseScore,
    finalScore,
    minYearsExtracted: null, // set by caller
  };

  return { baseScore, finalScore, breakdown, bonuses, penalties };
}

// ─── Priority Assignment ─────────────────────────────────

/**
 * Assigns priority based on final score and urgency signal.
 */
export function assignPriority(finalScore: number, urgencySignalMatched: boolean): string {
  if (finalScore >= 85 && urgencySignalMatched) return 'urgent';
  if (finalScore >= 75) return 'high';
  if (finalScore >= 50) return 'normal';
  return 'low';
}
