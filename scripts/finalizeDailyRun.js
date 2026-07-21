/**
 * finalizeDailyRun.js
 *
 * Zero-cost step (no external API calls). Runs last each day, after
 * findLeads.js and enrichLeads.js have finished.
 *
 * 1. Logs today's (approximate) API usage to data/apiUsageLog.json --
 *    1 Places API call for the single category+city searched, and one
 *    SerpApi call per new lead that got enriched. This is our own internal
 *    ledger, not pulled from Google/SerpApi's own billing dashboards, so
 *    treat it as a close estimate rather than a byte-perfect number.
 * 2. Updates that category's running totals in data/categoryQueue.json.
 * 3. Advances the city pointer. If the 22-city cycle just completed for
 *    this category, scores it (verdict: keep/reject), marks it completed,
 *    resets the city pointer, and activates the next queued category.
 * 4. Rebuilds data/dashboardData.json, the file the GitHub Pages dashboard
 *    reads from.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const CATEGORY_QUEUE_PATH = path.join(__dirname, "..", "data", "categoryQueue.json");
const CITY_QUEUE_PATH = path.join(__dirname, "..", "data", "cityQueue.json");
const USAGE_LOG_PATH = path.join(__dirname, "..", "data", "apiUsageLog.json");
const DASHBOARD_PATH = path.join(__dirname, "..", "data", "dashboardData.json");

const MAX_DAILY_HISTORY = 120; // keep the dashboard file from growing forever

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function main() {
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

  const todaysCity = cityQueue.cities[cityQueue.currentIndex];

  // Leads from today's specific category+city combination. Since each
  // combination only ever runs once across a category's full cycle, this
  // match is unambiguous without needing a date filter.
  const todaysLeads = leads.filter(
    (l) => l.category === activeEntry.category && l.searchLocation === todaysCity
  );
  const todaysEnriched = todaysLeads.filter((l) => l.status === "enriched" || l.status === "no_email_found");
  const todaysEmails = todaysLeads.filter((l) => l.status === "enriched");

  // --- 1. Usage log ---
  const date = todayDateString();
  const placesCallsToday = todaysCity ? 1 : 0; // one category x one city = one Places Text Search call
  const serpApiCallsToday = todaysLeads.length; // enrichLeads.js attempts one search per new lead

  usageLog.daily.push({
    date,
    category: activeEntry.category,
    city: todaysCity,
    placesApiCalls: placesCallsToday,
    serpApiCalls: serpApiCallsToday,
    leadsFound: todaysLeads.length,
    emailsFound: todaysEmails.length,
  });
  if (usageLog.daily.length > MAX_DAILY_HISTORY) {
    usageLog.daily = usageLog.daily.slice(-MAX_DAILY_HISTORY);
  }

  const mKey = monthKey(date);
  if (!usageLog.monthlyTotals[mKey]) {
    usageLog.monthlyTotals[mKey] = { placesApiCalls: 0, serpApiCalls: 0 };
  }
  usageLog.monthlyTotals[mKey].placesApiCalls += placesCallsToday;
  usageLog.monthlyTotals[mKey].serpApiCalls += serpApiCallsToday;

  // --- 2. Update category running totals ---
  activeEntry.leadsFound += todaysLeads.length;
  activeEntry.leadsEnriched += todaysEnriched.length;
  activeEntry.emailsFound += todaysEmails.length;
  if (todaysCity) activeEntry.citiesCovered.push(todaysCity);

  // --- 3. Advance city pointer / possibly complete the category ---
  cityQueue.currentIndex += 1;

  if (cityQueue.currentIndex >= cityQueue.cities.length) {
    // Full cycle complete for this category
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

  // --- 4. Rebuild dashboard snapshot ---
  saveJson(DASHBOARD_PATH, buildDashboard(categoryQueue, cityQueue, leads, usageLog));

  console.log("--- Today's Results ---");
  console.log(`${activeEntry.category} in ${todaysCity}: ${todaysLeads.length} leads, ${todaysEmails.length} emails found`);
}

function buildDashboard(categoryQueue, cityQueue, leads, usageLog) {
  const active = categoryQueue.find((c) => c.status === "active");
  const completed = categoryQueue
    .filter((c) => c.status === "completed")
    .sort((a, b) => (b.hitRate || 0) - (a.hitRate || 0));
  const queued = categoryQueue.filter((c) => c.status === "queued");

  const today = todayDateString();
  const thisMonth = monthKey(today);

  const totalLeadsFound = leads.length;
  const totalEmailsFound = leads.filter((l) => l.status === "enriched").length;

  return {
    lastUpdated: new Date().toISOString(),
    current: active
      ? {
          category: active.category,
          cityIndex: cityQueue.currentIndex + 1,
          totalCities: cityQueue.cities.length,
          nextCity: cityQueue.cities[cityQueue.currentIndex] || null,
        }
      : null,
    leaderboard: {
      completed: completed.map((c) => ({
        category: c.category,
        leadsEnriched: c.leadsEnriched,
        emailsFound: c.emailsFound,
        hitRate: c.hitRate,
        verdict: c.verdict,
      })),
      active: active ? { category: active.category, leadsEnriched: active.leadsEnriched, emailsFound: active.emailsFound } : null,
      queuedCount: queued.length,
    },
    usage: {
      today: usageLog.daily.length ? usageLog.daily[usageLog.daily.length - 1] : null,
      thisMonth: usageLog.monthlyTotals[thisMonth] || { placesApiCalls: 0, serpApiCalls: 0 },
      serpApiFreeTierLimit: 250,
    },
    totals: {
      totalLeadsFound,
      totalEmailsFound,
      categoriesCompleted: completed.length,
      categoriesKept: completed.filter((c) => c.verdict === "keep").length,
      categoriesRejected: completed.filter((c) => c.verdict === "reject").length,
    },
    dailyHistory: usageLog.daily,
  };
}

main();
