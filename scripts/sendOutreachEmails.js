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

function fillTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

/**
 * Builds subject/text/html from the static per-category template. Falls
 * back to templates.defaultHook if a lead's category doesn't have a
 * specific hook written yet (e.g. a reserve-pool category not templated).
 */
function buildEmailContent(lead, templates) {
  const hook = templates.categoryHooks[lead.category] || templates.defaultHook;
  const values = { businessName: lead.name, hook };

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

  let readyToSend = leads.filter((l) => l.status === "enriched");

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
    try {
      const result = await sendEmail(lead, templates);
      lead.status = "emailed";
      lead.emailedAt = new Date().toISOString();
      lead.resendId = result.id || null;
      sentCount++;
      console.log(`  Sent to ${lead.name} <${lead.email}> (category: ${lead.category})`);
    } catch (err) {
      lead.status = "email_failed";
      lead.emailError = err.message;
      failedCount++;
      console.error(`  Failed for ${lead.name} <${lead.email}>:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  saveJson(LEADS_PATH, leads);

  console.log("---");
  console.log(`Sent: ${sentCount}`);
  console.log(`Failed: ${failedCount}`);
  console.log(`Remaining (over today's cap, will send next run): ${readyToSend.length - capped.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
