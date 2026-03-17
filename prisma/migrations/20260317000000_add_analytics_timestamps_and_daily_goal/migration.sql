-- AlterTable
ALTER TABLE "Job" ADD COLUMN "appliedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "rejectedAt" DATETIME;

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
    "maxMinutesAgo" INTEGER NOT NULL DEFAULT 10,
    "uiPort" INTEGER NOT NULL DEFAULT 3000,
    "dailyApplicationGoal" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "searchKeywords", "searchLocations", "uiPort", "updatedAt") SELECT "geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "searchKeywords", "searchLocations", "uiPort", "updatedAt" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Job_appliedAt_idx" ON "Job"("appliedAt");

-- CreateIndex
CREATE INDEX "Job_rejectedAt_idx" ON "Job"("rejectedAt");

-- Backfill: set appliedAt/rejectedAt from updatedAt for existing jobs
UPDATE "Job" SET "appliedAt" = "updatedAt" WHERE "status" = 'applied' AND "appliedAt" IS NULL;
UPDATE "Job" SET "rejectedAt" = "updatedAt" WHERE "status" = 'rejected' AND "rejectedAt" IS NULL;
