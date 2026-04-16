/**
 * Client-side location filter.
 *
 * LinkedIn's public search URL `location=...&geoId=...` params are unreliable —
 * foreign jobs still leak through. This module inspects the location text
 * extracted from each card and accepts only US-based jobs.
 */

/** US state names (full) and DC. */
const US_STATE_NAMES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia",
];

/** US state USPS abbreviations + DC. Case-sensitive match (uppercase only). */
const US_STATE_ABBREVS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

/**
 * Countries / regions that are NOT the US.
 * Kept conservative — only well-known country/region names.
 * Matched as case-insensitive substring on a lowercased location string.
 */
const NON_US_MARKERS = [
  "germany", "deutschland", "france", "united kingdom", " uk", "(uk)",
  "england", "scotland", "wales", "ireland", "northern ireland",
  "spain", "españa", "italy", "italia", "portugal", "netherlands", "holland",
  "belgium", "luxembourg", "switzerland", "austria", "sweden", "norway",
  "denmark", "finland", "iceland", "poland", "czech", "slovakia", "hungary",
  "romania", "bulgaria", "greece", "turkey", "ukraine", "russia", "belarus",
  "estonia", "latvia", "lithuania", "serbia", "croatia", "slovenia", "bosnia",
  "north macedonia", "albania", "moldova", "georgia (country)", "armenia",
  "canada", "mexico", "brazil", "brasil", "argentina", "chile", "colombia",
  "peru", "venezuela", "uruguay", "paraguay", "bolivia", "ecuador",
  "costa rica", "panama", "guatemala", "honduras", "nicaragua",
  "el salvador", "dominican republic", "jamaica", "trinidad", "haiti",
  "india", "pakistan", "bangladesh", "sri lanka", "nepal",
  "china", "hong kong", "taiwan", "japan", "korea", "south korea",
  "north korea", "singapore", "malaysia", "indonesia", "vietnam",
  "thailand", "philippines", "cambodia", "laos", "myanmar",
  "australia", "new zealand",
  "united arab emirates", " uae", "(uae)", "saudi arabia", "qatar", "kuwait",
  "bahrain", "oman", "israel", "jordan", "lebanon", "egypt", "morocco",
  "tunisia", "algeria", "south africa", "nigeria", "kenya", "ghana",
  "ethiopia", "uganda", "tanzania", "zimbabwe",
];

/**
 * Common US-specific metro / region phrases.
 * LinkedIn sometimes shows these without a state suffix.
 * Matched as case-insensitive substring.
 */
const US_METRO_HINTS = [
  "bay area", "silicon valley", "greater boston", "greater chicago",
  "greater new york", "greater seattle", "greater atlanta", "greater miami",
  "greater houston", "greater dallas", "greater denver", "greater phoenix",
  "greater philadelphia", "greater los angeles", "greater san diego",
  "greater minneapolis", "greater detroit", "greater st. louis",
  "dc metro", "washington metro", "tri-state area",
];

/** Some cities that LinkedIn sometimes lists without a country suffix. */
const NON_US_CITY_HINTS = [
  "são paulo", "sao paulo", "rio de janeiro", "buenos aires",
  "thessaloniki", "bucharest", "warsaw", "prague", "budapest",
  "lisbon", "porto", "madrid", "barcelona", "paris", "lyon",
  "berlin", "munich", "hamburg", "frankfurt", "dusseldorf", "stuttgart",
  "amsterdam", "rotterdam", "brussels", "zurich", "geneva", "vienna",
  "stockholm", "oslo", "copenhagen", "helsinki", "dublin", "london",
  "manchester", "edinburgh", "glasgow", "bristol",
  "tokyo", "seoul", "beijing", "shanghai", "shenzhen", "mumbai", "bangalore",
  "bengaluru", "delhi", "new delhi", "hyderabad", "chennai", "pune",
  "kolkata", "ho chi minh", "hanoi", "bangkok", "manila", "jakarta",
  "kuala lumpur",
  "sydney", "melbourne", "auckland", "toronto", "vancouver", "montreal",
  "mexico city", "cdmx",
  "dubai", "abu dhabi", "riyadh", "doha", "istanbul", "ankara",
  "tel aviv", "cairo", "lagos", "nairobi", "johannesburg", "cape town",
];

/**
 * Returns true if the job's location text indicates it is US-based.
 *
 * Rules (in order — US checks run FIRST so cities like "Holland, MI" aren't
 * wrongly rejected just because "holland" is also a country name):
 *  1. Empty/unknown → treat as US (be permissive; AI filter is next line of defense).
 *  2. Explicit US markers ("United States" / "USA" / state name / state abbrev / US metro) → accept.
 *  3. Explicit non-US markers (country names, major foreign cities) → reject.
 *  4. Default → reject (unknown locations default to rejected so junk doesn't leak through).
 */
export function isUSLocation(rawLocation: string): boolean {
  const loc = (rawLocation || "").trim();
  if (!loc) return true;

  const lower = loc.toLowerCase();

  // 2. Explicit US markers — checked first so US cities with internationally-ambiguous
  //    names (e.g. "Holland, MI") are correctly accepted.
  if (/\bunited states\b/.test(lower)) return true;
  if (/\busa?\b/.test(lower)) return true; // matches "US" or "USA" (word-bounded)
  if (/\bu\.s\.a?\.?\b/.test(lower)) return true; // matches "U.S." / "U.S.A."

  for (const state of US_STATE_NAMES) {
    // whole-word match so "indiana" doesn't trigger on random substrings
    if (new RegExp(`\\b${state}\\b`, "i").test(loc)) return true;
  }

  for (const metro of US_METRO_HINTS) {
    if (lower.includes(metro)) return true;
  }

  // USPS abbreviation — must be comma-preceded, uppercase, word-bounded
  //   e.g., "San Francisco, CA", "Remote, NY", "Holland, MI"
  const abbrevMatch = loc.match(/,\s*([A-Z]{2})\b/);
  if (abbrevMatch && US_STATE_ABBREVS.has(abbrevMatch[1])) return true;

  // 3. Explicit non-US markers
  for (const marker of NON_US_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  for (const city of NON_US_CITY_HINTS) {
    if (lower.includes(city)) return false;
  }

  // 4. Default: reject unknown
  return false;
}
