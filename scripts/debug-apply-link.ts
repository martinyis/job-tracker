/**
 * Verification script: tests the new URL-pattern based apply link extraction.
 *
 * Usage: npx tsx scripts/debug-apply-link.ts
 */
import { LinkedInScraper, ScrapedJob } from "../src/scraper/linkedin-scraper";

// Job IDs from the failing logs — mix of Easy Apply and external
const TEST_JOBS: ScrapedJob[] = [
  { linkedinId: "4353485271", title: "Java Software Engineer", company: "BeaconFire Inc.", link: "https://www.linkedin.com/jobs/view/4353485271", postedDate: "", minutesAgo: 0 },
  { linkedinId: "4375467777", title: "Solutions Engineer, AI", company: "Valence", link: "https://www.linkedin.com/jobs/view/4375467777", postedDate: "", minutesAgo: 0 },
  { linkedinId: "4374306177", title: "Backend Engineer, Global E-commerce", company: "TikTok", link: "https://www.linkedin.com/jobs/view/4374306177", postedDate: "", minutesAgo: 0 },
  { linkedinId: "4375059094", title: "Full Stack Engineer", company: "Unknown", link: "https://www.linkedin.com/jobs/view/4375059094", postedDate: "", minutesAgo: 0 },
];

async function main() {
  const scraper = new LinkedInScraper();

  try {
    await scraper.launch();
    console.log(`Authenticated: ${scraper.authenticated}\n`);

    if (!scraper.authenticated) {
      console.error("Not authenticated. Run `npm run login` first.");
      return;
    }

    for (const job of TEST_JOBS) {
      console.log(`\n--- ${job.title} (${job.linkedinId}) ---`);
      const applyLink = await scraper.extractApplyLink(job);

      if (applyLink) {
        console.log(`  EXTERNAL: ${applyLink}`);
      } else {
        console.log(`  EASY APPLY (or not found) — will use LinkedIn link: ${job.link}`);
      }
    }

    console.log("\n\nAll tests complete.");
  } finally {
    await scraper.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
