/**
 * finalizeDailyRun.js
 *
 * Zero-cost step (no external API calls). Runs last each day, after
 * findLeads.js and enrichLeads.js have finished.
 *
 * 1. Logs today's (approximate) API usage to data/apiUsageLog.json, one
 *    entry per city processed today (prepareDailyRun.js may target more
 *    than one city per day -- see CITIES_PER_DAY there).
 * 2. Updates that category's running totals in data/categoryQueue.json.
 * 3. Advances the city pointer / scores completed category cycles.
 * 4. Rebuilds data/dashboardData.json, including the full list of every
 *    company where a real email was found (name, category, location,
 *    email, source) for the dashboard's "Companies Reached" table.
 */

const fs = require("fs");
const path = require("path");
const { buildDashboard, todayDateString, monthKey } = require("./lib/dashboard");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const CATEGORY_QUEUE_PATH = path.join(__dirname, "..", "data", "categoryQueue.json");
const CITY_QUEUE_PATH = path.join(__dirname, "..", "data", "cityQueue.json");
const USAGE_LOG_PATH = path.join(__dirname, "..", "data", "apiUsageLog.json");
const DASHBOARD_PATH = path.join(__dirname, "..", "data", "dashboardData.json");

const MAX_DAILY_HISTORY = 120;

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

function main() {
  const config = loadJson(CONFIG_PATH, {});
  const categoryQueue = loadJson(CATEGORY_QUEUE_PATH, []);
  const cityQueue = loadJson(CITY_QUEUE_PATH, { cities: [], currentIndex: 0 });
  const leads = loadJson(LEADS_PATH, []);
  const usageLog = loadJson(USAGE_LOG_PATH, { daily: [], monthlyTotals: {} });

  const activeEntry = categoryQueue.find((c) => c.status === "active");

  if (!activeEntry) {
    console.log("No active category -- nothing to finalize today (queue may be empty).");
    saveJson(DASHBOARD_PATH, buildDashboard(categoryQueue, cityQueue, leads, usageLog));
    return;
  }

  // The cities prepareDailyRun.js targeted today (may be more than one --
  // see CITIES_PER_DAY in prepareDailyRun.js). Falls back to the single
  // queue city if config.json wasn't written by that script for some reason.
  const todaysCities = config.searchLocations && config.searchLocations.length
    ? config.searchLocations
    : [cityQueue.cities[cityQueue.currentIndex]].filter(Boolean);

  const date = todayDateString();
  let leadsToday = 0;
  let enrichedToday = 0;
  let emailsToday = 0;

  for (const city of todaysCities) {
    const cityLeads = leads.filter((l) => l.category === activeEntry.category && l.searchLocation === city);
    const cityEnriched = cityLeads.filter((l) => l.status === "enriched" || l.status === "no_email_found");
    const cityEmails = cityLeads.filter((l) => l.status === "enriched");

    usageLog.daily.push({
      date,
      category: activeEntry.category,
      city,
      placesApiCalls: 1,
      serpApiCalls: cityLeads.length,
      leadsFound: cityLeads.length,
      emailsFound: cityEmails.length,
    });

    activeEntry.citiesCovered.push(city);
    leadsToday += cityLeads.length;
    enrichedToday += cityEnriched.length;
    emailsToday += cityEmails.length;
  }

  if (usageLog.daily.length > MAX_DAILY_HISTORY) {
    usageLog.daily = usageLog.daily.slice(-MAX_DAILY_HISTORY);
  }

  const mKey = monthKey(date);
  if (!usageLog.monthlyTotals[mKey]) {
    usageLog.monthlyTotals[mKey] = { placesApiCalls: 0, serpApiCalls: 0 };
  }
  usageLog.monthlyTotals[mKey].placesApiCalls += todaysCities.length;
  usageLog.monthlyTotals[mKey].serpApiCalls += leadsToday;

  activeEntry.leadsFound += leadsToday;
  activeEntry.leadsEnriched += enrichedToday;
  activeEntry.emailsFound += emailsToday;

  cityQueue.currentIndex += todaysCities.length;

  if (cityQueue.currentIndex >= cityQueue.cities.length) {
    activeEntry.status = "completed";
    activeEntry.completedAt = new Date().toISOString();
    activeEntry.hitRate = activeEntry.leadsEnriched > 0
      ? activeEntry.emailsFound / activeEntry.leadsEnriched
      : 0;
    activeEntry.verdict = activeEntry.emailsFound > 0 ? "keep" : "reject";

    cityQueue.currentIndex = 0;

    const nextEntry = categoryQueue.find((c) => c.status === "queued");
    if (nextEntry) {
      nextEntry.status = "active";
      nextEntry.startedAt = new Date().toISOString();
    }

    console.log(`Category cycle complete: "${activeEntry.category}" -> verdict: ${activeEntry.verdict} (${activeEntry.emailsFound}/${activeEntry.leadsEnriched} hit rate)`);
    console.log(nextEntry ? `Next category activated: "${nextEntry.category}"` : "No more categories queued -- pull from data/reserveCategoryPool.json to continue.");
  }

  saveJson(CATEGORY_QUEUE_PATH, categoryQueue);
  saveJson(CITY_QUEUE_PATH, cityQueue);
  saveJson(USAGE_LOG_PATH, usageLog);

  saveJson(DASHBOARD_PATH, buildDashboard(categoryQueue, cityQueue, leads, usageLog));

  console.log("--- Today's Results ---");
  console.log(`${activeEntry.category} in ${todaysCities.join(", ")}: ${leadsToday} leads, ${emailsToday} emails found`);
}

main();
