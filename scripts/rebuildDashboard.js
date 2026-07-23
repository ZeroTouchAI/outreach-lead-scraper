/**
 * rebuildDashboard.js
 *
 * Zero-cost step (no external API calls). Rebuilds data/dashboardData.json
 * from the current state of leads.json, categoryQueue.json, cityQueue.json,
 * and apiUsageLog.json -- WITHOUT advancing any queues or logging new
 * usage. This is the read-only counterpart to finalizeDailyRun.js.
 *
 * Why this exists: finalizeDailyRun.js (which rebuilds the dashboard AND
 * advances the scrape queue) only runs as part of the daily scrape
 * pipeline. That meant the dashboard went stale whenever the SEND workflow
 * ran on its own -- e.g. a send firing hours after that day's scrape
 * already finished. This script lets any workflow (send-outreach.yml
 * included) refresh the dashboard snapshot after it makes changes, without
 * duplicating the queue-advancement logic that only belongs to the scrape
 * pipeline.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const CATEGORY_QUEUE_PATH = path.join(__dirname, "..", "data", "categoryQueue.json");
const CITY_QUEUE_PATH = path.join(__dirname, "..", "data", "cityQueue.json");
const USAGE_LOG_PATH = path.join(__dirname, "..", "data", "apiUsageLog.json");
const DASHBOARD_PATH = path.join(__dirname, "..", "data", "dashboardData.json");

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

function buildDashboard(categoryQueue, cityQueue, leads, usageLog) {
  const active = categoryQueue.find((c) => c.status === "active");
  const completed = categoryQueue
    .filter((c) => c.status === "completed")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const queued = categoryQueue.filter((c) => c.status === "queued");

  const today = todayDateString();
  const thisMonth = monthKey(today);

  const realLeads = leads.filter((l) => !l.isTest);

  const totalLeadsFound = realLeads.length;
  // "Found" means we ever discovered a real email for this lead, regardless
  // of whether it's since been sent -- so this includes enriched, emailed,
  // AND email_failed (the email was real, the send attempt just errored).
  const totalEmailsFound = realLeads.filter((l) => ["enriched", "emailed", "email_failed"].includes(l.status)).length;
  const totalEmailsSent = realLeads.filter((l) => l.status === "emailed").length;

  const reachedCompanies = realLeads
    .filter((l) => ["enriched", "emailed", "email_failed"].includes(l.status))
    .map((l) => ({
      name: l.name,
      category: l.category,
      location: l.searchLocation,
      email: l.email,
      emailSource: l.emailSource || null,
      phone: l.phone || null,
      foundAt: l.foundAt || null,
      sent: l.status === "emailed",
      sendFailed: l.status === "email_failed",
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
        verdict: c.verdict || "pending",
        sampleType: c.sampleType || "full_cycle",
      })),
      active: active
        ? {
            category: active.category,
            leadsEnriched: active.leadsEnriched,
            emailsFound: active.emailsFound,
            // Live/interim hit rate while still mid-cycle -- not a final verdict.
            hitRate: active.leadsEnriched > 0 ? active.emailsFound / active.leadsEnriched : null,
          }
        : null,
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
      totalEmailsSent,
      totalCategories: categoryQueue.length,
      categoriesCompleted: completed.length,
      categoriesKept: categoryQueue.filter((c) => c.verdict === "keep").length,
      categoriesRejected: categoryQueue.filter((c) => c.verdict === "reject").length,
      categoriesPending: categoryQueue.length - categoryQueue.filter((c) => c.verdict === "keep").length - categoryQueue.filter((c) => c.verdict === "reject").length,
    },
    dailyHistory: usageLog.daily,
    reachedCompanies,
  };
}

function main() {
  const categoryQueue = loadJson(CATEGORY_QUEUE_PATH, []);
  const cityQueue = loadJson(CITY_QUEUE_PATH, { cities: [], currentIndex: 0 });
  const leads = loadJson(LEADS_PATH, []);
  const usageLog = loadJson(USAGE_LOG_PATH, { daily: [], monthlyTotals: {} });

  const dashboard = buildDashboard(categoryQueue, cityQueue, leads, usageLog);
  saveJson(DASHBOARD_PATH, dashboard);

  console.log("Dashboard rebuilt.");
  console.log(`Real leads: ${dashboard.totals.totalLeadsFound}, emails found: ${dashboard.totals.totalEmailsFound}`);
  console.log(`Companies reached (incl. sent): ${dashboard.reachedCompanies.length}`);
}

main();
