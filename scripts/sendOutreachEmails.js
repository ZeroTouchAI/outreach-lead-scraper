/**
 * sendOutreachEmails.js
 *
 * Phase 5: sends the actual outreach emails -- the "free website demo"
 * offer -- to every lead with a real email on file that hasn't been
 * contacted yet. Uses static, pre-written templates per business category
 * (data/emailTemplates.json) -- no AI generation, by design. Every lead
 * in a given category gets the same reviewed template, with just the
 * business name substituted in.
 *
 * Uses Resend (https://resend.com) rather than Gmail API -- see the repo
 * README for why. Sends "from" the verified subdomain but with a separate
 * "reply-to" address, so replies land wherever you actually check email.
 *
 * Requires env vars:
 *   RESEND_API_KEY     - from resend.com, after verifying the sending domain
 *   OUTREACH_FROM       - e.g. "Rapid Rank Agency <hello@mail.rapidrankagency.com>"
 *   OUTREACH_REPLY_TO   - e.g. "info@rapidrankagency.com"
 *   TEST_MODE            - "true" or "false". When "true", ONLY sends to
 *                           leads flagged isTest:true in leads.json --
 *                           real leads are completely skipped. Defaults to
 *                           "true" if unset, as a safety net.
 *
 * Rate limiting: reads dailySendCap from data/outreachConfig.json.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const OUTREACH_CONFIG_PATH = path.join(__dirname, "..", "data", "outreachConfig.json");
const TEMPLATES_PATH = path.join(__dirname, "..", "data", "emailTemplates.json");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OUTREACH_FROM = process.env.OUTREACH_FROM;
const OUTREACH_REPLY_TO = process.env.OUTREACH_REPLY_TO;
const TEST_MODE = (process.env.TEST_MODE || "true") === "true";
const RESEND_URL = "https://api.resend.com/emails";

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, "utf-8").trim();
  if (!raw) return fallback;
  return JSON.parse(raw);
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Government / military / educational / institutional addresses are never
// valid cold-outreach targets (and usually mean the enrichment step scraped
// the wrong page). These leads are marked "skipped" instead of being sent.
function isBlockedEmail(email) {
  const domain = String(email || "").split("@")[1];
  if (!domain) return true;
  const d = domain.toLowerCase();
  return (
    /(^|\.)(gov|mil|edu)(\.[a-z]{2,3})?$/.test(d) ||
    /(^|\.)(gc|gouv)\.ca$/.test(d) ||
    /(^|\.)gov\.[a-z]{2}\.ca$/.test(d)
  );
}

// A failed send is worth retrying automatically when the cause is on our
// side or temporary: unverified sending domain (403), rate limit (429), or a
// Resend server error (5xx). Anything else (e.g. invalid recipient) stays
// failed. Capped so a persistent problem can't retry forever.
// Total attempts per lead, counting the first send. Keep in sync with
// maxAttempts in scripts/lib/dashboard.js.
const MAX_SEND_ATTEMPTS = 5;
function isRetryableFailure(lead) {
  if (lead.status !== "email_failed") return false;
  if ((lead.sendAttempts || 0) >= MAX_SEND_ATTEMPTS) return false;
  const msg = String(lead.emailError || "");
  return /\((429|5\d\d)\)/.test(msg) || (/\(403\)/.test(msg) && /domain/i.test(msg));
}

function fillTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

/**
 * Builds subject/text/html from the static per-category template. Falls
 * back to templates.defaultDetails if a lead's category doesn't have
 * specific details written yet (e.g. a reserve-pool category not
 * templated).
 */
function buildEmailContent(lead, templates) {
  const details = templates.categoryDetails[lead.category] || templates.defaultDetails;
  const values = {
    businessName: lead.name,
    businessTypeArticle: details.businessTypeArticle,
    businessNoun: details.businessNoun,
    clientNeeds: details.clientNeeds,
    showcaseWhat: details.showcaseWhat,
  };

  const subject = fillTemplate(templates.sharedTemplate.subjectTemplate, values);
  const text = fillTemplate(templates.sharedTemplate.bodyTemplate, values);
  const html = text
    .split("\n\n")
    .map((para) => `<p>${para.replace(/\n/g, "<br/>")}</p>`)
    .join("\n");

  return { subject, text, html };
}

async function sendEmail(lead, templates) {
  const { subject, text, html } = buildEmailContent(lead, templates);

  const payload = {
    from: OUTREACH_FROM,
    to: [lead.email],
    subject,
    text,
    html,
  };
  if (OUTREACH_REPLY_TO) {
    payload.reply_to = OUTREACH_REPLY_TO;
  }

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }

  return res.json();
}

async function main() {
  if (!RESEND_API_KEY || !OUTREACH_FROM) {
    console.error("Missing RESEND_API_KEY or OUTREACH_FROM environment variable.");
    process.exit(1);
  }

  const config = loadJson(OUTREACH_CONFIG_PATH, { dailySendCap: 10 });
  const leads = loadJson(LEADS_PATH, []);
  const templates = loadJson(TEMPLATES_PATH, null);

  if (!templates) {
    console.error("Missing data/emailTemplates.json.");
    process.exit(1);
  }

  console.log(`TEST_MODE: ${TEST_MODE}`);

  let readyToSend = leads.filter((l) => l.status === "enriched" || isRetryableFailure(l));

  // Drop government/institutional addresses before they use up the daily cap.
  let skippedCount = 0;
  readyToSend = readyToSend.filter((l) => {
    if (isBlockedEmail(l.email)) {
      l.status = "skipped";
      l.emailError = "Skipped: government/institutional address";
      skippedCount++;
      console.log(`  Skipped ${l.name} <${l.email}> (government/institutional address)`);
      return false;
    }
    return true;
  });

  // Oldest leads first, so nothing sits waiting while newer ones go out.
  readyToSend.sort((a, b) => new Date(a.foundAt || 0) - new Date(b.foundAt || 0));

  if (TEST_MODE) {
    readyToSend = readyToSend.filter((l) => l.isTest === true);
    console.log("Test mode is ON -- only sending to leads flagged isTest:true. Real leads are skipped entirely.");
  } else {
    readyToSend = readyToSend.filter((l) => !l.isTest);
    console.log("Test mode is OFF -- sending to real leads.");
  }

  const capped = readyToSend.slice(0, config.dailySendCap);

  console.log(`Leads ready to email: ${readyToSend.length}`);
  console.log(`Daily send cap: ${config.dailySendCap} -- sending to ${capped.length} today.`);

  let sentCount = 0;
  let failedCount = 0;

  for (const lead of capped) {
    const attempt = (lead.sendAttempts || 0) + 1;
    console.log(`Attempt ${attempt} of ${MAX_SEND_ATTEMPTS}: ${lead.name} <${lead.email}>`);
    try {
      const result = await sendEmail(lead, templates);
      lead.status = "emailed";
      lead.emailedAt = new Date().toISOString();
      lead.resendId = result.id || null;
      delete lead.emailError;
      delete lead.failedAt;
      lead.sendAttempts = attempt;
      sentCount++;
      console.log(`  Sent to ${lead.name} <${lead.email}> (category: ${lead.category})`);
    } catch (err) {
      lead.status = "email_failed";
      lead.emailError = err.message;
      lead.failedAt = new Date().toISOString();
      lead.sendAttempts = attempt;
      failedCount++;
      console.error(`  Failed (attempt ${attempt} of ${MAX_SEND_ATTEMPTS}) for ${lead.name} <${lead.email}>:`, err.message);
      if (attempt >= MAX_SEND_ATTEMPTS) {
        console.error(`  Giving up on ${lead.name} -- reached ${MAX_SEND_ATTEMPTS} attempts, no more automatic retries.`);
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  saveJson(LEADS_PATH, leads);

  console.log("---");
  console.log(`Sent: ${sentCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Skipped (government/institutional): ${skippedCount}`);
  console.log(`Remaining (over today's cap, will send next run): ${readyToSend.length - capped.length}`);

  // Fail loudly. Data is already saved above; the workflow still commits
  // lead statuses and the dashboard, then marks the run as failed so GitHub
  // notifies you instead of showing a misleading green check.
  if (failedCount > 0) {
    console.error(`::error::${failedCount} outreach email(s) failed to send. See log above for the Resend error.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
