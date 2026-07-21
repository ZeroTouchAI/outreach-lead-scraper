/**
 * finalizeDailyRun.js
 *
 * Zero-cost step (no external API calls). Runs last each day, after
 * findLeads.js and enrichLeads.js have finished.
 *
 * 1. Logs today's (approximate) API usage to data/apiUsageLog.json.
 * 2. Updates that category's running totals in data/categoryQueue.json.
 * 3. Advances the city pointer / scores completed category cycles.
 * 4. Rebuilds data/dashboardData.json, including the full list of every
 *    company where a real email was found (name, category, location,
 *    email, source) for the dashboard's "Companies Reached" table.
 */

const fs = require("fs");
const path = require("path");

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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
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

  const todaysLeads = leads.filter(
    (l) => l.category === activeEntry.category && l.searchLocation === todaysCity
  );
  const todaysEnriched = todaysLeads.filter((l) => l.status === "enriched" || l.status === "no_email_found");
  const todaysEmails = todaysLeads.filter((l) => l.status === "enriched");

  const date = todayDateString();
  const placesCallsToday = todaysCity ? 1 : 0;
  const serpApiCallsToday = todaysLeads.length;

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

  activeEntry.leadsFound += todaysLeads.length;
  activeEntry.leadsEnriched += todaysEnriched.length;
  activeEntry.emailsFound += todaysEmails.length;
  if (todaysCity) activeEntry.citiesCovered.push(todaysCity);

  cityQueue.currentIndex += 1;

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

  console.log("--- Today\'s Results ---");
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

  // Full list of every company where a real email was found -- feeds the
  // dashboard's "Companies Reached" table.
  const reachedCompanies = leads
    .filter((l) => l.status === "enriched")
    .map((l) => ({
      name: l.name,
      category: l.category,
      location: l.searchLocation,
      email: l.email,
      emailSource: l.emailSource || null,
      phone: l.phone || null,
      foundAt: l.foundAt || null,
    }))
    .sort((a, b) => new Date(b.foundAt || 0) - new Date(a.foundAt || 0));

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
        sampleType: c.sampleType || "full_cycle",
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
    reachedCompanies,
  };
}

main();
