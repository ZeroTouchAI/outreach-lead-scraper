/**
 * rebalanceCategories.js
 *
 * Phase 3: self-tuning category selection.
 *
 * Looks at how many leads each business category has produced and what
 * fraction actually got a real email during enrichment, then:
 *   - RETIRES categories that have a big enough sample (>= MIN_SAMPLE_SIZE)
 *     but a 0% email hit rate -- not worth continuing to scrape
 *   - SCALES UP categories with a strong hit rate (>= SCALE_THRESHOLD) by
 *     pulling more results per search next time
 *   - Leaves categories with too little data yet in "testing" until they
 *     cross MIN_SAMPLE_SIZE
 *   - Backfills any retired slots with fresh, never-tried categories from
 *     a candidate pool, so the active list stays roughly the same size
 *     and the system keeps exploring
 *
 * This is a deterministic scoring system (not an LLM call) -- cheap, fast,
 * and fully explainable: you can always see exactly why a category was
 * kept, dropped, or scaled by reading data/categoryStats.json.
 *
 * Run this AFTER an enrichLeads.js run, before the next findLeads.js run,
 * so the next scrape uses the updated category list.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const STATS_PATH = path.join(__dirname, "..", "data", "categoryStats.json");
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const MIN_SAMPLE_SIZE = 5; // don't judge a category until it's had at least this many leads enriched
const SCALE_THRESHOLD = 0.15; // >=15% email hit rate => scale up
const TARGET_ACTIVE_CATEGORIES = 10; // roughly how many categories to keep in rotation at once
const DEFAULT_MAX_RESULTS = 20;
const SCALED_MAX_RESULTS = 40; // pull more per search for high performers

// Full Greater Toronto Area -- replaces the narrower city list from earlier
// phases. NOTE: category count x location count = # of paid Places API
// calls per scrape run, so keep an eye on Places API billing after this.
const GTA_LOCATIONS = [
  "Toronto, ON",
  "Mississauga, ON",
  "Brampton, ON",
  "Vaughan, ON",
  "Richmond Hill, ON",
  "Markham, ON",
  "Oakville, ON",
  "Burlington, ON",
  "Oshawa, ON",
  "Whitby, ON",
  "Ajax, ON",
  "Pickering, ON",
  "Milton, ON",
  "Newmarket, ON",
];

// Categories not yet tried, pulled in automatically to backfill retired
// slots. Chosen for the same profile as the original list: local B2B/
// service businesses plausible enough to lack a website.
const CANDIDATE_POOL = [
  "bakery",
  "tailor",
  "dry cleaner",
  "locksmith",
  "appliance repair service",
  "pest control service",
  "pool cleaning service",
  "tutoring center",
  "driving school",
  "catering company",
  "florist",
  "upholstery shop",
  "tile contractor",
  "painter",
  "flooring contractor",
  "moving company",
  "junk removal service",
  "handyman service",
  "window cleaning service",
  "carpet cleaning service",
  "tax preparation service",
  "bookkeeping service",
  "notary public",
  "immigration consultant",
  "insurance broker",
  "mortgage broker",
  "photographer",
  "event planner",
  "bridal shop",
  "tattoo shop",
  "nail salon",
  "spa",
  "massage therapist",
  "chiropractor",
  "physiotherapy clinic",
  "veterinary clinic",
  "pet grooming service",
  "daycare",
  "martial arts studio",
  "yoga studio",
];

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function seedStats(existingCategories) {
  const stats = {};
  const now = new Date().toISOString();

  for (const category of existingCategories) {
    stats[category] = {
      status: "testing",
      leadsProcessed: 0,
      emailsFound: 0,
      hitRate: 0,
      addedAt: now,
      lastUpdatedAt: now,
    };
  }

  for (const category of CANDIDATE_POOL) {
    if (stats[category]) continue; // already an active category, not a candidate
    stats[category] = {
      status: "candidate",
      leadsProcessed: 0,
      emailsFound: 0,
      hitRate: 0,
      addedAt: null,
      lastUpdatedAt: now,
    };
  }

  return stats;
}

function main() {
  const config = loadJson(CONFIG_PATH, {});
  let stats = loadJson(STATS_PATH, null);

  if (!stats) {
    console.log("No categoryStats.json found -- seeding from current config.json + candidate pool.");
    stats = seedStats(config.searchCategories || []);
  }

  // Make sure every candidate pool category is at least present (in case
  // the pool has grown since this file was first created).
  const now = new Date().toISOString();
  for (const category of CANDIDATE_POOL) {
    if (!stats[category]) {
      stats[category] = {
        status: "candidate",
        leadsProcessed: 0,
        emailsFound: 0,
        hitRate: 0,
        addedAt: null,
        lastUpdatedAt: now,
      };
    }
  }

  const leads = loadJson(LEADS_PATH, []);

  // Recompute leadsProcessed/emailsFound fresh from leads.json each run --
  // leads.json is the source of truth, this avoids double-counting.
  const byCategory = {};
  for (const lead of leads) {
    const wasEnrichmentAttempted = lead.status === "enriched" || lead.status === "no_email_found";
    if (!wasEnrichmentAttempted) continue; // still "found", hasn't gone through enrichment yet

    if (!byCategory[lead.category]) {
      byCategory[lead.category] = { leadsProcessed: 0, emailsFound: 0 };
    }
    byCategory[lead.category].leadsProcessed++;
    if (lead.status === "enriched") {
      byCategory[lead.category].emailsFound++;
    }
  }

  const retiredThisRun = [];
  const scaledThisRun = [];
  const stillTesting = [];

  for (const [category, counts] of Object.entries(byCategory)) {
    if (!stats[category]) {
      stats[category] = { status: "testing", leadsProcessed: 0, emailsFound: 0, hitRate: 0, addedAt: now };
    }

    const entry = stats[category];
    entry.leadsProcessed = counts.leadsProcessed;
    entry.emailsFound = counts.emailsFound;
    entry.hitRate = counts.leadsProcessed > 0 ? counts.emailsFound / counts.leadsProcessed : 0;
    entry.lastUpdatedAt = now;

    // Only judge categories that aren't already retired/candidate-only
    if (entry.status === "retired" || entry.status === "candidate") continue;

    if (entry.leadsProcessed >= MIN_SAMPLE_SIZE) {
      if (entry.hitRate === 0) {
        entry.status = "retired";
        retiredThisRun.push(category);
      } else if (entry.hitRate >= SCALE_THRESHOLD) {
        entry.status = "scaling";
        scaledThisRun.push(category);
      } else {
        entry.status = "active";
      }
    } else {
      entry.status = "testing";
      stillTesting.push(category);
    }
  }

  // Backfill retired slots from the candidate pool to keep the active
  // roster at roughly TARGET_ACTIVE_CATEGORIES.
  const activeCategories = Object.entries(stats).filter(
    ([, e]) => e.status === "testing" || e.status === "active" || e.status === "scaling"
  );

  const slotsToFill = Math.max(0, TARGET_ACTIVE_CATEGORIES - activeCategories.length);
  const candidates = Object.entries(stats)
    .filter(([, e]) => e.status === "candidate")
    .slice(0, slotsToFill);

  const promoted = [];
  for (const [category, entry] of candidates) {
    entry.status = "testing";
    entry.addedAt = now;
    entry.lastUpdatedAt = now;
    promoted.push(category);
  }

  // Build the new config.json
  const finalActive = Object.entries(stats).filter(
    ([, e]) => e.status === "testing" || e.status === "active" || e.status === "scaling"
  );

  const searchCategories = finalActive.map(([category]) => category);
  const categoryOverrides = {};
  for (const [category, entry] of finalActive) {
    if (entry.status === "scaling") {
      categoryOverrides[category] = { maxResultsPerQuery: SCALED_MAX_RESULTS };
    }
  }

  const newConfig = {
    ...config,
    searchCategories,
    searchLocations: GTA_LOCATIONS,
    maxResultsPerQuery: config.maxResultsPerQuery || DEFAULT_MAX_RESULTS,
    categoryOverrides,
    requireNoWebsite: true,
    requirePhone: true,
  };

  saveJson(STATS_PATH, stats);
  saveJson(CONFIG_PATH, newConfig);

  console.log("--- Category Rebalance Summary ---");
  console.log(`Retired (0% hit rate, sample >= ${MIN_SAMPLE_SIZE}):`, retiredThisRun.length ? retiredThisRun.join(", ") : "none");
  console.log(`Scaling up (hit rate >= ${SCALE_THRESHOLD * 100}%):`, scaledThisRun.length ? scaledThisRun.join(", ") : "none");
  console.log("Still gathering data:", stillTesting.length ? stillTesting.join(", ") : "none");
  console.log("New candidates promoted in:", promoted.length ? promoted.join(", ") : "none");
  console.log(`Active category count: ${searchCategories.length}`);
  console.log(`Location count: ${GTA_LOCATIONS.length}`);
  console.log(`Places API calls next scrape run: ~${searchCategories.length * GTA_LOCATIONS.length}`);
}

main();
