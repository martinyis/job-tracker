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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Job" ("company", "createdAt", "description", "id", "keyMatches", "link", "linkedinId", "location", "matchReason", "matchScore", "notes", "postedDate", "status", "title", "updatedAt") SELECT "company", "createdAt", "description", "id", "keyMatches", "link", "linkedinId", "location", "matchReason", "matchScore", "notes", "postedDate", "status", "title", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE UNIQUE INDEX "Job_linkedinId_key" ON "Job"("linkedinId");
CREATE INDEX "Job_status_idx" ON "Job"("status");
CREATE INDEX "Job_matchScore_idx" ON "Job"("matchScore");
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
