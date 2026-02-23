-- DropIndex
DROP INDEX "ApplicationLog_createdAt_idx";

-- DropIndex
DROP INDEX "ApplicationLog_status_idx";

-- DropIndex
DROP INDEX "ApplicationLog_jobId_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ApplicationLog";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ApplierState";
PRAGMA foreign_keys=on;

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
    "uiPort" INTEGER NOT NULL DEFAULT 3000,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AppSettings" ("geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "minMatchScore", "searchKeywords", "searchLocations", "uiPort", "updatedAt") SELECT "geoId", "headless", "id", "intervalMinutes", "maxMinutesAgo", "minMatchScore", "searchKeywords", "searchLocations", "uiPort", "updatedAt" FROM "AppSettings";
DROP TABLE "AppSettings";
ALTER TABLE "new_AppSettings" RENAME TO "AppSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
