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
const { buildDashboard } = require("./lib/dashboard");

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
