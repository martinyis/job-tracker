/**
 * Client-side location filter.
 *
 * LinkedIn's public search URL `location=...&geoId=...` params are unreliable —
 * foreign jobs still leak through. We inspect each card's location text.
 *
 * Strategy (evaluated in order):
 *   1. Explicit US marker present (state abbrev, state name, "United States",
 *      "USA", or US-territory code) → ACCEPT. This protects US cities with
 *      foreign-sounding names (e.g. "Paris, TX", "Holland, MI", "Moscow, ID",
 *      "Lebanon, TN", "Athens, GA", "Mexico, MO").
 *   2. A known non-US country name appears (whole-word, case-insensitive) → REJECT.
 *      Word-boundary matching prevents false positives like "india" triggering
 *      on "Indianapolis" or "china" on "Chinatown".
 *   3. Otherwise → ACCEPT. The AI relevance filter is the next line of defense,
 *      so ambiguous entries ("Remote", bare cities, unknown regions) still get
 *      a chance to be reviewed rather than silently dropped.
 */

/** US state names (full) + DC. Whole-word, case-insensitive matching. */
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

/**
 * USPS two-letter codes for all 50 states + DC + US territories.
 * Case-sensitive (uppercase) match — "Foo, CA" is US, "Foo, ca" is noise.
 */
const US_STATE_ABBREVS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
  "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
  "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
  "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
  // US territories — treated as US for our purposes
  "PR", "VI", "GU", "AS", "MP",
]);

/**
 * Non-US countries, territories, and common language variants.
 * Alphabetical for scannability. Matched as a whole word (case-insensitive).
 *
 * NOTE: "georgia" is deliberately OMITTED here — it conflicts with the US
 * state. Step 1 treats it as US. Georgia (the country) is a rare appearance
 * on LinkedIn and the AI filter will catch it.
 */
const NON_US_COUNTRIES = [
  // A
  "afghanistan", "albania", "algeria", "andorra", "angola", "antigua",
  "argentina", "armenia", "australia", "austria", "azerbaijan",
  // B
  "bahamas", "bahrain", "bangladesh", "barbados", "barbuda", "belarus",
  "belgium", "belize", "benin", "bhutan", "bolivia", "bosnia", "botswana",
  "brasil", "brazil", "brunei", "bulgaria", "burkina faso", "burma", "burundi",
  // C
  "cambodia", "cameroon", "canada", "cape verde", "central african republic",
  "chad", "chile", "china", "colombia", "comoros", "congo", "costa rica",
  "croatia", "cuba", "cyprus", "czechia", "czech republic", "côte d'ivoire",
  // D
  "denmark", "deutschland", "djibouti", "dominica", "dominican republic",
  // E
  "east timor", "ecuador", "egypt", "el salvador", "england",
  "equatorial guinea", "eritrea", "españa", "espana", "estonia", "eswatini",
  "ethiopia",
  // F
  "fiji", "finland", "france",
  // G
  "gabon", "gambia", "germany", "ghana", "great britain", "greece", "grenada",
  "guatemala", "guinea", "guinea-bissau", "guyana",
  // H
  "haiti", "herzegovina", "holland", "honduras", "hong kong", "hungary",
  // I
  "iceland", "india", "indonesia", "iran", "iraq", "ireland", "israel",
  "italia", "italy", "ivory coast",
  // J
  "jamaica", "japan", "jordan",
  // K
  "kazakhstan", "kenya", "kiribati", "korea", "kosovo", "kuwait", "kyrgyzstan",
  // L
  "laos", "latvia", "lebanon", "lesotho", "liberia", "libya", "liechtenstein",
  "lithuania", "luxembourg",
  // M
  "macao", "macau", "macedonia", "madagascar", "malawi", "malaysia", "maldives",
  "mali", "malta", "marshall islands", "mauritania", "mauritius", "mexico",
  "méxico", "micronesia", "moldova", "monaco", "mongolia", "montenegro",
  "morocco", "mozambique", "myanmar",
  // N
  "namibia", "nauru", "nepal", "netherlands", "new zealand", "nicaragua",
  "niger", "nigeria", "north korea", "north macedonia", "northern ireland",
  "norway",
  // O
  "oman",
  // P
  "pakistan", "palau", "palestine", "panama", "papua new guinea", "paraguay",
  "peru", "philippines", "poland", "polska", "portugal",
  // Q
  "qatar",
  // R
  "romania", "russia", "rwanda",
  // S
  "saint kitts", "saint lucia", "saint vincent", "samoa", "san marino",
  "saudi arabia", "scotland", "senegal", "serbia", "seychelles",
  "sierra leone", "singapore", "slovakia", "slovenia", "solomon islands",
  "somalia", "south africa", "south korea", "south sudan", "spain",
  "sri lanka", "sudan", "suriname", "swaziland", "sweden", "switzerland",
  "syria",
  // T
  "taiwan", "tajikistan", "tanzania", "thailand", "timor-leste", "tobago",
  "togo", "tonga", "trinidad", "tunisia", "turkey", "turkmenistan", "tuvalu",
  "türkiye",
  // U
  "uae", "uganda", "uk", "ukraine", "united arab emirates", "united kingdom",
  "uruguay", "uzbekistan",
  // V
  "vanuatu", "venezuela", "vietnam",
  // W
  "wales",
  // Y
  "yemen",
  // Z
  "zambia", "zimbabwe",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Single compiled regex for efficient whole-word matching of any non-US country. */
const NON_US_COUNTRY_REGEX = new RegExp(
  "\\b(?:" + NON_US_COUNTRIES.map(escapeRegex).join("|") + ")\\b",
  "i",
);

/** Pre-compiled regex for each US state full name (whole-word, case-insensitive). */
const US_STATE_NAME_REGEX = new RegExp(
  "\\b(?:" + US_STATE_NAMES.map(escapeRegex).join("|") + ")\\b",
  "i",
);

export function isUSLocation(rawLocation: string): boolean {
  const loc = (rawLocation || "").trim();
  if (!loc) return true;

  const lower = loc.toLowerCase();

  // 1. Explicit US markers — accept immediately so US cities with
  //    foreign-sounding names ("Paris, TX", "Moscow, ID") survive Step 2.
  if (/\bunited states\b/.test(lower)) return true;
  if (/\busa?\b/.test(lower)) return true;            // "US" or "USA"
  if (/\bu\.s\.a?\.?\b/.test(lower)) return true;     // "U.S." / "U.S.A."
  if (US_STATE_NAME_REGEX.test(loc)) return true;

  //    USPS state / territory abbreviation, comma-preceded uppercase.
  const abbrevMatch = loc.match(/,\s*([A-Z]{2})\b/);
  if (abbrevMatch && US_STATE_ABBREVS.has(abbrevMatch[1])) return true;

  // 2. Known non-US country → reject.
  if (NON_US_COUNTRY_REGEX.test(lower)) return false;

  // 3. Ambiguous → accept; let the AI relevance filter be the final authority.
  return true;
}
