-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "includeTitlePatterns" TEXT NOT NULL DEFAULT '[]',
    "jobSearchDescription" TEXT NOT NULL DEFAULT '',
    "keyInterests" TEXT NOT NULL DEFAULT '[]',
    "dealbreakers" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_UserProfile" ("availableStartDate", "avoidIndustries", "city", "country", "coverLetterNotes", "dateOfBirth", "dealbreakers", "desiredSalary", "email", "excludeTitleKeywords", "firstName", "id", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredName", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "pronouns", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "yearsOfExperience", "zipCode") SELECT "availableStartDate", "avoidIndustries", "city", "country", "coverLetterNotes", "dateOfBirth", "dealbreakers", "desiredSalary", "email", "excludeTitleKeywords", "firstName", "id", "keyInterests", "lastName", "linkedinUrl", "minSalary", "openToContract", "phone", "preferredCompanySize", "preferredName", "preferredTechStack", "profileSummaryCache", "profileSummaryCachedAt", "pronouns", "remoteOnly", "state", "summary", "targetSeniority", "updatedAt", "visaSponsorshipNeeded", "website", "willingToRelocate", "yearsOfExperience", "zipCode" FROM "UserProfile";
DROP TABLE "UserProfile";
ALTER TABLE "new_UserProfile" RENAME TO "UserProfile";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
