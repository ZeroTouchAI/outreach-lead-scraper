/**
 * lib/dashboard.js
 *
 * Shared dashboard-building logic used by both finalizeDailyRun.js (full
 * daily pipeline) and rebuildDashboard.js (read-only refresh after sends).
 * Extracted so the two callers can't drift out of sync with each other.
 */

const SERPAPI_FREE_TIER_LIMIT = 250;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

// Days in the month that dateStr (YYYY-MM-DD) falls in.
function daysInMonth(dateStr) {
  const [year, month] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDashboard(categoryQueue, cityQueue, leads, usageLog) {
  const active = categoryQueue.find((c) => c.status === "active");
  const completed = categoryQueue
    .filter((c) => c.status === "completed")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const queued = categoryQueue.filter((c) => c.status === "queued");

  const today = todayDateString();
  const thisMonth = monthKey(today);
  const thisMonthUsage = usageLog.monthlyTotals[thisMonth] || { placesApiCalls: 0, serpApiCalls: 0 };

  // Linear projection: at the current run rate, where will this month's
  // SerpApi usage land by month-end? Lets you catch an overage coming
  // before it happens instead of after.
  const dayOfMonth = Number(today.slice(8, 10));
  const projectedMonthlySerpApiCalls = Math.round(
    (thisMonthUsage.serpApiCalls / dayOfMonth) * daysInMonth(today)
  );

  // Exclude internal test leads (isTest:true) from all public dashboard
  // stats and lists -- they're not real scraped businesses, just used to
  // validate the outreach email flow before it touches real leads.
  const realLeads = leads.filter((l) => !l.isTest);

  const totalLeadsFound = realLeads.length;
  // "Found" means we ever discovered a real email for this lead, regardless
  // of whether it's since been sent -- so this includes enriched, emailed,
  // AND email_failed (the email was real, the send attempt just errored).
  const totalEmailsFound = realLeads.filter((l) => ["enriched", "emailed", "email_failed"].includes(l.status)).length;
  const totalEmailsSent = realLeads.filter((l) => l.status === "emailed").length;

  // Full list of every company where a real email was found -- feeds the
  // dashboard's "Companies Reached" table. Includes leads at ANY later
  // pipeline stage too (emailed, email_failed), not just "enriched" --
  // otherwise a company would vanish from this list the moment outreach
  // actually sends to them, which is backwards.
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
      thisMonth: thisMonthUsage,
      serpApiFreeTierLimit: SERPAPI_FREE_TIER_LIMIT,
      projectedMonthlySerpApiCalls,
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

module.exports = { buildDashboard, todayDateString, monthKey };
