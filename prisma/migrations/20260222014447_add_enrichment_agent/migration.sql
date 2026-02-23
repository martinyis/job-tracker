-- CreateTable
CREATE TABLE "EnricherState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "isProcessing" BOOLEAN NOT NULL DEFAULT false,
    "pid" INTEGER,
    "totalEnriched" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkedinId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "link" TEXT NOT NULL,
    "applyLink" TEXT NOT NULL DEFAULT '',
    "postedDate" TEXT NOT NULL DEFAULT '',
    "matchScore" INTEGER NOT NULL DEFAULT 0,
    "matchReason" TEXT NOT NULL DEFAULT '',
    "keyMatches" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "enrichmentStatus" TEXT NOT NULL DEFAULT 'pending',
    "enrichedAt" DATETIME,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "priorityReason" TEXT NOT NULL DEFAULT '',
    "actionItems" TEXT NOT NULL DEFAULT '[]',
    "redFlags" TEXT NOT NULL DEFAULT '[]',
    "companyInfo" TEXT NOT NULL DEFAULT '',
    "applicantCount" TEXT NOT NULL DEFAULT '',
    "seniorityLevel" TEXT NOT NULL DEFAULT '',
    "employmentType" TEXT NOT NULL DEFAULT '',
    "jobFunction" TEXT NOT NULL DEFAULT '',
    "postedBy" TEXT NOT NULL DEFAULT '',
    "postedByTitle" TEXT NOT NULL DEFAULT '',
    "postedByProfile" TEXT NOT NULL DEFAULT '',
    "contactPeople" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Job" ("applyLink", "company", "createdAt", "description", "id", "keyMatches", "link", "linkedinId", "location", "matchReason", "matchScore", "notes", "postedDate", "status", "title", "updatedAt") SELECT "applyLink", "company", "createdAt", "description", "id", "keyMatches", "link", "linkedinId", "location", "matchReason", "matchScore", "notes", "postedDate", "status", "title", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE UNIQUE INDEX "Job_linkedinId_key" ON "Job"("linkedinId");
CREATE INDEX "Job_status_idx" ON "Job"("status");
CREATE INDEX "Job_matchScore_idx" ON "Job"("matchScore");
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");
CREATE INDEX "Job_enrichmentStatus_idx" ON "Job"("enrichmentStatus");
CREATE INDEX "Job_priority_idx" ON "Job"("priority");
CREATE TABLE "new_UserProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "firstName" TEXT NOT NULL DEFAULT '',
    "lastName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "linkedinUrl" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "zipCode" TEXT NOT NULL DEFAULT '',
    "preferredName" TEXT NOT NULL DEFAULT '',
    "pronouns" TEXT NOT NULL DEFAULT '',
    "dateOfBirth" TEXT NOT NULL DEFAULT '',
    "yearsOfExperience" INTEGER NOT NULL DEFAULT 0,
    "desiredSalary" TEXT NOT NULL DEFAULT '',
    "availableStartDate" TEXT NOT NULL DEFAULT '',
    "coverLetterNotes" TEXT NOT NULL DEFAULT '',
    "missionStatement" TEXT NOT NULL DEFAULT '',
    "urgencySignals" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "profileSummaryCache" TEXT,
    "profileSummaryCachedAt" DATETIME,
    "remoteOnly" BOOLEAN NOT NULL DEFAULT false,
    "willingToRelocate" BOOLEAN NOT NULL DEFAULT false,
    "openToContract" BOOLEAN NOT NULL DEFAULT false,
    "visaSponsorshipNeeded" BOOLEAN NOT NULL DEFAULT false,
    "minSalary" INTEGER NOT NULL DEFAULT 0,
    "preferredCompanySize" TEXT NOT NULL DEFAULT '[]',
    "avoidIndustries" TEXT NOT NULL DEFAULT '[]',
    "preferredTechStack" TEXT NOT NULL DEFAULT '[]',
    "targetSeniority" TEXT NOT NULL DEFAULT '[]',
    "excludeTitleKeywords" TEXT NOT NULL DEFAULT '[]',
    "includeTitlePatterns" TEXT NOT NULL DEFAULT '[]',
    "jobSearchDescription" TEXT NOT NULL DEFAULT '',
    "keyInterests" TEXT NOT NULL DEFAULT '[]',
    "dealbreakers" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserProfile" ("availableStartDate", "avoidIndustries", "city", "country", "coverLetterNotes", "dateOfBirth", "dealbreakers", "desiredSalary", "email", "excludeTitleKeywords", "firstName", "id", "includeTitlePatterns", "jobSearchDescription", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredName", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "pronouns", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "yearsOfExperience", "zipCode") SELECT "availableStartDate", "avoidIndustries", "city", "country", "coverLetterNotes", "dateOfBirth", "dealbreakers", "desiredSalary", "email", "excludeTitleKeywords", "firstName", "id", "includeTitlePatterns", "jobSearchDescription", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredName", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "pronouns", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "yearsOfExperience", "zipCode" FROM "UserProfile";
DROP TABLE "UserProfile";
ALTER TABLE "new_UserProfile" RENAME TO "UserProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
