/**
 * reviewLead.js
 *
 * Applies the owner's decision on leads held in "needs_review":
 *   approve -> status "enriched" (goes out on the next send run)
 *   reject  -> status "no_email_found" (moves to the manual call queue)
 *
 * Env vars (set by the Review Lead workflow):
 *   PLACE_IDS - one or more placeIds, comma/space separated
 *   DECISION  - "approve" or "reject"
 */

const fs = require("fs");
const path = require("path");

const LEADS_PATH = path.join(__dirname, "..", "data", "leads.json");

const ids = (process.env.PLACE_IDS || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const decision = process.env.DECISION;

if (ids.length === 0 || !["approve", "reject"].includes(decision)) {
  console.error("Need PLACE_IDS and DECISION (approve or reject).");
  process.exit(1);
}

const leads = JSON.parse(fs.readFileSync(LEADS_PATH, "utf-8"));
const now = new Date().toISOString();
let changed = 0;
const missing = [];

for (const id of ids) {
  const lead = leads.find((l) => l.placeId === id);
  if (!lead) {
    missing.push(id);
    continue;
  }
  if (lead.status !== "needs_review") {
    console.log(`Skipping ${lead.name}: not awaiting review (status is "${lead.status}").`);
    continue;
  }
  if (decision === "approve") {
    lead.status = "enriched";
    lead.emailConfidence = "approved";
    console.log(`Approved: ${lead.name} <${lead.email}> -- will send on the next send run.`);
  } else {
    lead.rejectedEmail = lead.email;
    delete lead.email;
    lead.status = "no_email_found";
    lead.emailConfidence = "rejected";
    console.log(`Rejected: ${lead.name} -- moved to the manual call queue.`);
  }
  lead.emailReviewedAt = now;
  lead.lastUpdatedAt = now;
  changed++;
}

fs.writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2));
console.log(`---\nUpdated ${changed} lead(s).`);

if (missing.length) {
  console.error(`::error::No lead found for ID(s): ${missing.join(", ")}`);
  process.exit(1);
}
