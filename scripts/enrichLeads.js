/**
 * enrichLeads.js
 *
 * Phase 2: for every lead with status "found", tries to find a real email
 * address using SerpApi's Google Search endpoint (free tier: 250
 * searches/month). This searches the public web broadly (directories,
 * social pages, listings -- wherever the business's contact info happens
 * to be indexed), rather than scraping any single platform directly.
 *
 * NOTE: this originally used Google's Custom Search JSON API directly, but
 * as of Jan 2026 Google closed that API to new projects entirely (confirmed
 * via multiple 403 "This project does not have the access to Custom Search
 * JSON API" errors even with correct setup) -- it's not usable for a new
 * project like this one, so we switched to SerpApi, which you already have
 * an account for from the flight-watcher project.
 *
 * Requires env var:
 *   SERPAPI_API_KEY  - same key type used in flight-watcher; you can reuse
 *                       that account, just add the key as a secret in THIS
 *                       repo too (secrets don't carry over between repos)
 *
 * On the free tier, if you have more "found" leads than remaining monthly
 * quota, this script stops cleanly partway through -- whatever it couldn't
 * get to just stays "found" and picks up again next run.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");

const API_KEY = process.env.SERPAPI_API_KEY;
const SEARCH_URL = "https://serpapi.com/search.json";

// Domains that show up in search results but are never a business's real
// contact email -- platform/support addresses, schema boilerplate, etc.
const EXCLUDED_EMAIL_DOMAINS = [
  "example.com",
  "sentry.io",
  "wixpress.com",
  "godaddy.com",
  "schema.org",
  "w3.org",
  "google.com",
  "facebook.com",
  "instagram.com",
  "yourdomain.com",
  "domain.com",
  "email.com",
  "fresha.com",
  "booksy.com",
  "vagaro.com",
  "mindbodyonline.com",
  "styleseat.com",
  "square.site",
  "squareup.com",
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function isPlausibleEmail(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return !EXCLUDED_EMAIL_DOMAINS.some((bad) => domain.endsWith(bad));
}

function extractEmail(text) {
  if (!text) return null;
  const matches = text.match(EMAIL_REGEX);
  if (!matches) return null;
  const plausible = matches.find(isPlausibleEmail);
  return plausible || null;
}

/**
 * Returns:
 *   { email, source } on success
 *   { quotaExceeded: true } if the monthly free quota is used up
 *   null if no email found (but quota still available)
 */
async function searchForEmail(lead) {
  const query = `"${lead.name}" "${lead.address}" email contact`;
  const url = `${SEARCH_URL}?engine=google&q=${encodeURIComponent(query)}&api_key=${API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  // SerpApi returns 200 with an "error" field in the body for many failure
  // cases (including running out of searches), rather than always using
  // HTTP status codes -- so check the body first.
  if (data.error) {
    const isRealQuotaError = /run out of searches|rate limit|quota/i.test(data.error);
    if (isRealQuotaError) {
      return { quotaExceeded: true };
    }
    throw new Error(`SerpApi error: ${data.error}`);
  }

  if (!res.ok) {
    throw new Error(`SerpApi HTTP error (${res.status}): ${JSON.stringify(data)}`);
  }

  const results = data.organic_results || [];

  for (const item of results) {
    const candidate =
      extractEmail(item.snippet) || extractEmail(item.title) || null;
    if (candidate) {
      return { email: candidate, source: item.link || "google_search" };
    }
  }

  return null;
}

async function main() {
  if (!API_KEY) {
    console.error("Missing SERPAPI_API_KEY environment variable.");
    process.exit(1);
  }

  const leads = loadJson(LEADS_PATH, []);
  const toEnrich = leads.filter((l) => l.status === "found");

  console.log(`Leads pending enrichment: ${toEnrich.length}`);

  let enrichedCount = 0;
  let notFoundCount = 0;
  let stoppedOnQuota = false;

  for (const lead of toEnrich) {
    console.log(`Searching for email: "${lead.name}" (${lead.address})`);

    try {
      const result = await searchForEmail(lead);

      if (result?.quotaExceeded) {
        console.log("Monthly search quota reached -- stopping here, will resume next run.");
        stoppedOnQuota = true;
        break;
      }

      if (result?.email) {
        lead.email = result.email;
        lead.emailSource = result.source;
        lead.status = "enriched";
        lead.lastUpdatedAt = new Date().toISOString();
        enrichedCount++;
        console.log(`  Found: ${result.email}`);
      } else {
        lead.status = "no_email_found";
        lead.lastUpdatedAt = new Date().toISOString();
        notFoundCount++;
        console.log("  No email found -- routed to manual call queue.");
      }
    } catch (err) {
      console.error(`  Failed on "${lead.name}":`, err.message);
    }

    // Gentle pacing
    await new Promise((r) => setTimeout(r, 300));
  }

  saveJson(LEADS_PATH, leads);

  console.log("---");
  console.log(`Emails found: ${enrichedCount}`);
  console.log(`No email found (-> manual call queue): ${notFoundCount}`);
  if (stoppedOnQuota) {
    console.log("Stopped early due to monthly quota -- remaining leads still marked 'found', will retry next run.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
