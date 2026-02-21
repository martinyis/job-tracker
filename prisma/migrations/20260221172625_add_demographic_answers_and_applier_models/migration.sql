-- CreateTable
CREATE TABLE "DemographicAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT NOT NULL DEFAULT 'singleton',
    "category" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DemographicAnswer_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "UserProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplierState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastRunAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" DATETIME,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "isRunning" BOOLEAN NOT NULL DEFAULT false,
    "pid" INTEGER,
    "totalApplied" INTEGER NOT NULL DEFAULT 0,
    "totalSkipped" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ApplicationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "formType" TEXT NOT NULL DEFAULT '',
    "fieldsFilledCount" INTEGER NOT NULL DEFAULT 0,
    "aiCallsUsed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "screenshotPath" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApplicationLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "searchKeywords" TEXT NOT NULL DEFAULT '[]',
    "searchLocations" TEXT NOT NULL DEFAULT '["United States"]',
    "geoId" TEXT NOT NULL DEFAULT '103644278',
    "intervalMinutes" INTEGER NOT NULL DEFAULT 2,
    "headless" BOOLEAN NOT NULL DEFAULT true,
    "minMatchScore" INTEGER NOT NULL DEFAULT 50,
    "maxMinutesAgo" INTEGER NOT NULL DEFAULT 10,
    "autoApplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoApplyDryRun" BOOLEAN NOT NULL DEFAULT true,
    "autoApplyBatchSize" INTEGER NOT NULL DEFAULT 5,
    "autoApplyDelaySeconds" INTEGER NOT NULL DEFAULT 10,
    "autoApplyPollMinutes" INTEGER NOT NULL DEFAULT 2,
    "autoApplySkipDomains" TEXT NOT NULL DEFAULT '[]',
    "uiPort" INTEGER NOT NULL DEFAULT 3000,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "minMatchScore", "searchKeywords", "searchLocations", "uiPort", "updatedAt") SELECT "geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "minMatchScore", "searchKeywords", "searchLocations", "uiPort", "updatedAt" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
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
    "keyInterests" TEXT NOT NULL DEFAULT '[]',
    "dealbreakers" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserProfile" ("avoidIndustries", "city", "country", "dealbreakers", "email", "excludeTitleKeywords", "firstName", "id", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "zipCode") SELECT "avoidIndustries", "city", "country", "dealbreakers", "email", "excludeTitleKeywords", "firstName", "id", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "zipCode" FROM "UserProfile";
DROP TABLE "UserProfile";
ALTER TABLE "new_UserProfile" RENAME TO "UserProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DemographicAnswer_profileId_idx" ON "DemographicAnswer"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "DemographicAnswer_profileId_category_key" ON "DemographicAnswer"("profileId", "category");

-- CreateIndex
CREATE INDEX "ApplicationLog_jobId_idx" ON "ApplicationLog"("jobId");

-- CreateIndex
CREATE INDEX "ApplicationLog_status_idx" ON "ApplicationLog"("status");

-- CreateIndex
CREATE INDEX "ApplicationLog_createdAt_idx" ON "ApplicationLog"("createdAt");
