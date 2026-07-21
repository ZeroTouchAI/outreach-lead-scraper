/**
 * prepareDailyRun.js
 *
 * Zero-cost step (no external API calls). Runs first each day, before
 * findLeads.js or enrichLeads.js touch any paid/quota'd API.
 *
 * Reads the category queue and city queue, figures out which single
 * category + single city today's run should target, and writes that into
 * config.json as single-item arrays so findLeads.js only ever processes
 * one combination per day.
 *
 * If the category queue is fully exhausted (everything completed, nothing
 * queued left), this writes an EMPTY searchCategories array -- findLeads.js
 * will then just do nothing (zero API calls) instead of erroring, and this
 * script prints a clear message so it's obvious the queue needs attention.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const CATEGORY_QUEUE_PATH = path.join(__dirname, "..", "data", "categoryQueue.json");
const CITY_QUEUE_PATH = path.join(__dirname, "..", "data", "cityQueue.json");

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function main() {
  const categoryQueue = loadJson(CATEGORY_QUEUE_PATH, []);
  const cityQueue = loadJson(CITY_QUEUE_PATH, { cities: [], currentIndex: 0 });

  let activeEntry = categoryQueue.find((c) => c.status === "active");

  // If nothing is marked active (e.g. very first run, or the previous
  // category just completed and nothing was queued to replace it), try to
  // activate the next queued one.
  if (!activeEntry) {
    activeEntry = categoryQueue.find((c) => c.status === "queued");
    if (activeEntry) {
      activeEntry.status = "active";
      activeEntry.startedAt = new Date().toISOString();
      saveJson(CATEGORY_QUEUE_PATH, categoryQueue);
    }
  }

  if (!activeEntry) {
    console.log("No active or queued category left -- category queue is exhausted.");
    console.log("Writing an empty search list, so today's run will do nothing (zero API calls).");
    console.log("Add more categories from data/reserveCategoryPool.json to data/categoryQueue.json to continue.");

    const emptyConfig = loadJson(CONFIG_PATH, {});
    emptyConfig.searchCategories = [];
    emptyConfig.searchLocations = [];
    saveJson(CONFIG_PATH, emptyConfig);
    return;
  }

  const todaysCity = cityQueue.cities[cityQueue.currentIndex];

  if (!todaysCity) {
    console.error("City queue index out of range -- this shouldn't happen. Check data/cityQueue.json.");
    process.exit(1);
  }

  const config = loadJson(CONFIG_PATH, {});
  config.searchCategories = [activeEntry.category];
  config.searchLocations = [todaysCity];
  config.maxResultsPerQuery = config.maxResultsPerQuery || 20;
  config.requireNoWebsite = true;
  config.requirePhone = true;
  saveJson(CONFIG_PATH, config);

  console.log("--- Today's Run ---");
  console.log(`Category: ${activeEntry.category} (${cityQueue.currentIndex + 1} of ${cityQueue.cities.length} cities in this cycle)`);
  console.log(`City: ${todaysCity}`);
}

main();
