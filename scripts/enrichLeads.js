/**
 * enrichLeads.js
 *
 * Phase 2: for every lead with status "found", tries to find a real email
 * address using Google's Custom Search API (free tier: 100 queries/day).
 * This searches the public web broadly (directories, social pages, listings
 * -- wherever the business's contact info happens to be indexed), rather
 * than scraping any single platform directly.
 *
 * Requires env vars:
 *   GOOGLE_SEARCH_API_KEY  - API key restricted to "Custom Search API"
 *   GOOGLE_SEARCH_CX       - your Programmable Search Engine ID
 *
 * On the free tier, if you have more "found" leads than remaining daily
 * quota, this script stops cleanly partway through -- whatever it couldn't
 * get to just stays "found" and picks up again next run.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");

const API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const CX = process.env.GOOGLE_SEARCH_CX;
const SEARCH_URL = "https://www.googleapis.com/customsearch/v1";

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
 *   { quotaExceeded: true } if the daily free quota is used up
 *   null if no email found (but quota still available)
 */
async function searchForEmail(lead) {
  const query = `"${lead.name}" "${lead.address}" email contact`;
  const url = `${SEARCH_URL}?key=${API_KEY}&cx=${CX}&q=${encodeURIComponent(query)}`;

  const res = await fetch(url);

  if (!res.ok) {
    const errText = await res.text();

    // Only treat this as "out of free quota" if Google's error body actually
    // says so -- a bare 403 can just as easily mean the API isn't enabled,
    // the key is restricted wrong, or billing isn't linked. Those need to
    // surface as real errors, not get silently treated as quota.
    const isRealQuotaError =
      res.status === 429 ||
      /rateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i.test(errText);

    if (isRealQuotaError) {
      return { quotaExceeded: true };
    }

    throw new Error(`Custom Search API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const items = data.items || [];

  for (const item of items) {
    const candidate =
      extractEmail(item.snippet) || extractEmail(item.title) || null;
    if (candidate) {
      return { email: candidate, source: item.link || "google_search" };
    }
  }

  return null;
}

async function main() {
  if (!API_KEY || !CX) {
    console.error("Missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX environment variable.");
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
        console.log("Daily search quota reached -- stopping here, will resume next run.");
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
    console.log("Stopped early due to daily quota -- remaining leads still marked 'found', will retry next run.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
