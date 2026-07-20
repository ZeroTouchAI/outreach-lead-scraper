/**
 * findLeads.js
 *
 * Searches Google Places API (New) for businesses matching configured
 * categories + locations, and keeps only ones that have NO website listed.
 * Dedupes against previously found leads and appends new ones to
 * data/leads.json, preserving pipeline status for existing leads.
 *
 * Requires env var: GOOGLE_PLACES_API_KEY
 *
 * Notes on cost: Text Search + the "websiteUri" field are billed by Google
 * (Places API "Contact Data" SKU). Check current pricing in your Google
 * Cloud console before running this at scale — costs scale with the
 * number of category x location combinations in config.json.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Fields we ask Google for. Keep this minimal -- each field category
// (Basic / Contact / Atmosphere) is billed separately.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.primaryType",
].join(",");

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function searchPlaces(query, maxResults) {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: maxResults,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Places API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.places || [];
}

function toLead(place, category, location) {
  return {
    placeId: place.id,
    name: place.displayName?.text || "Unknown",
    address: place.formattedAddress || "",
    phone: place.internationalPhoneNumber || "",
    category,
    searchLocation: location,
    primaryType: place.primaryType || "",
    googleMapsUrl: place.googleMapsUri || "",
    hasWebsite: Boolean(place.websiteUri),
    // Pipeline status, used by downstream scripts (enrichment, outreach, etc.)
    status: "found",
    email: null,
    emailSource: null,
    foundAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!API_KEY) {
    console.error("Missing GOOGLE_PLACES_API_KEY environment variable.");
    process.exit(1);
  }

  const config = loadJson(CONFIG_PATH, {});
  const existingLeads = loadJson(LEADS_PATH, []);
  const existingByPlaceId = new Map(existingLeads.map((l) => [l.placeId, l]));

  const { searchCategories = [], searchLocations = [], maxResultsPerQuery = 20, categoryOverrides = {} } = config;

  let newCount = 0;
  let skippedHasWebsite = 0;
  let skippedNoPhone = 0;

  for (const category of searchCategories) {
    const effectiveMaxResults = categoryOverrides[category]?.maxResultsPerQuery || maxResultsPerQuery;

    for (const location of searchLocations) {
      const query = `${category} in ${location}`;
      console.log(`Searching: "${query}" (max ${effectiveMaxResults})`);

      try {
        const places = await searchPlaces(query, effectiveMaxResults);

        for (const place of places) {
          if (existingByPlaceId.has(place.id)) continue; // already tracked

          if (place.websiteUri) {
            skippedHasWebsite++;
            continue; // has a website, not a lead for this system
          }

          if (config.requirePhone && !place.internationalPhoneNumber) {
            skippedNoPhone++;
            continue;
          }

          const lead = toLead(place, category, location);
          existingByPlaceId.set(lead.placeId, lead);
          newCount++;
        }
      } catch (err) {
        console.error(`  Failed on "${query}":`, err.message);
      }

      // Gentle pacing to avoid hammering the API
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const allLeads = Array.from(existingByPlaceId.values());
  saveJson(LEADS_PATH, allLeads);

  console.log("---");
  console.log(`New leads added: ${newCount}`);
  console.log(`Skipped (already had a website): ${skippedHasWebsite}`);
  console.log(`Skipped (no phone on file): ${skippedNoPhone}`);
  console.log(`Total leads in data/leads.json: ${allLeads.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
