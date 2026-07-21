/**
 * sendOutreachEmails.js
 *
 * Phase 5: sends the actual outreach emails -- the "free website demo"
 * offer -- to every lead with a real email on file that hasn't been
 * contacted yet.
 *
 * Uses Resend (https://resend.com) rather than Gmail API: Gmail's API is
 * built for sending from a Gmail-linked mailbox, not cleanly for an
 * arbitrary custom subdomain like mail.rapidrankagency.com without a paid
 * Google Workspace subscription. Resend has a real free tier (3,000
 * emails/month, 100/day) and verifies custom domains via simple DNS
 * records (SPF/DKIM), which is exactly what a dedicated sending subdomain
 * needs.
 *
 * Requires env vars:
 *   RESEND_API_KEY   - from resend.com, after verifying the sending domain
 *   OUTREACH_FROM     - e.g. "Rapid Rank Agency <hello@mail.rapidrankagency.com>"
 *
 * Rate limiting: reads dailySendCap from data/outreachConfig.json. This
 * matters a lot for a brand-new sending domain -- sending too many too
 * fast on an unproven domain is what triggers spam folder placement.
 * Start low (the default config ships with 10/day) and raise it gradually
 * over a couple of weeks once delivery looks clean.
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");
const OUTREACH_CONFIG_PATH = path.join(__dirname, "..", "data", "outreachConfig.json");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const OUTREACH_FROM = process.env.OUTREACH_FROM;
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

/**
 * The actual outreach copy. Deliberately not promising a live demo link
 * yet -- Phase 6 (auto-generating a real mockup site per lead) doesn't
 * exist yet, so this invites a reply instead of over-promising.
 */
function buildEmailContent(lead) {
  const subject = `Quick question about ${lead.name}'s website`;

  const text = `Hi there,

I came across ${lead.name} while looking at ${lead.category} businesses in the ${lead.searchLocation.replace(", ON", "")} area, and noticed you don't currently have a website.

I run Rapid Rank Agency -- we build fast, modern websites for local businesses. I'd like to put together a free custom demo of what a site for ${lead.name} could look like, no cost and no obligation. If it's not for you, no hard feelings either way.

Would you be open to seeing one? Just reply to this email and I'll get started.

Best,
Rapid Rank Agency`;

  const html = `<p>Hi there,</p>
<p>I came across <strong>${lead.name}</strong> while looking at ${lead.category} businesses in the ${lead.searchLocation.replace(", ON", "")} area, and noticed you don't currently have a website.</p>
<p>I run <strong>Rapid Rank Agency</strong> -- we build fast, modern websites for local businesses. I'd like to put together a <strong>free custom demo</strong> of what a site for ${lead.name} could look like, no cost and no obligation. If it's not for you, no hard feelings either way.</p>
<p>Would you be open to seeing one? Just reply to this email and I'll get started.</p>
<p>Best,<br/>Rapid Rank Agency</p>`;

  return { subject, text, html };
}

async function sendEmail(lead) {
  const { subject, text, html } = buildEmailContent(lead);

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: OUTREACH_FROM,
      to: [lead.email],
      subject,
      text,
      html,
    }),
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

  const readyToSend = leads.filter((l) => l.status === "enriched");
  const capped = readyToSend.slice(0, config.dailySendCap);

  console.log(`Leads ready to email: ${readyToSend.length}`);
  console.log(`Daily send cap: ${config.dailySendCap} -- sending to ${capped.length} today.`);

  let sentCount = 0;
  let failedCount = 0;

  for (const lead of capped) {
    try {
      const result = await sendEmail(lead);
      lead.status = "emailed";
      lead.emailedAt = new Date().toISOString();
      lead.resendId = result.id || null;
      sentCount++;
      console.log(`  Sent to ${lead.name} <${lead.email}>`);
    } catch (err) {
      lead.status = "email_failed";
      lead.emailError = err.message;
      failedCount++;
      console.error(`  Failed for ${lead.name} <${lead.email}>:`, err.message);
    }

    // Gentle pacing between sends
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
