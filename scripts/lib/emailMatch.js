/**
 * lib/emailMatch.js
 *
 * Decides whether an email found in a Google search result really belongs
 * to the lead we searched for. Returns one of three verdicts:
 *
 *   accept - address matches the business AND the result mentions it.
 *            Safe to auto-send.
 *   review - borderline (e.g. a Gmail address next to the business name).
 *            Held on the dashboard until the owner approves or rejects it.
 *   reject - clearly unrelated (directory/list pages, government sites,
 *            another company's address). Dropped; the lead goes to the
 *            manual call queue instead.
 *
 * Why this exists: businesses without websites mostly show up on
 * directories, blogs and spreadsheets, and the old logic grabbed the first
 * email-looking text on any of them -- which often belonged to a different
 * company entirely.
 */

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com",
  "hotmail.com", "hotmail.ca", "outlook.com", "live.com", "live.ca",
  "msn.com", "icloud.com", "me.com", "aol.com", "proton.me",
  "protonmail.com", "rogers.com", "bell.net", "sympatico.ca", "shaw.ca",
  "telus.net", "videotron.ca",
]);

// Words that describe the kind of business or place rather than identify
// it ("Zen Nails Spa" is identified by "zen", not "nails" or "spa").
const GENERIC_WORDS = new Set([
  "the", "and", "of", "inc", "ltd", "llc", "co", "corp", "company", "group",
  "enterprises", "enterprise", "family", "services", "service", "shop",
  "store", "studio", "salon", "spa", "nail", "nails", "bakery", "bakeries",
  "pastry", "cafe", "restaurant", "kitchen", "catering", "caterers",
  "european", "auto", "repair", "repairs", "motors", "clinic", "centre",
  "center", "plaza", "toronto", "vaughan", "caledon", "mississauga",
  "brampton", "ajax", "oshawa", "markham", "richmond", "hill", "gta",
]);

// Pages that list many businesses -- an email on one of these rarely
// belongs to the business we're looking for.
const DIRECTORY_PATTERN =
  /(directory|directories|yellowpages|yellow-pages|canpages|opendi|cylex|hotfrog|brownbook|infobel|bdir\.|yelp\.|mapquest|foursquare|tripadvisor|manta\.|bbb\.org|dnb\.com|zoominfo|glassdoor|indeed\.|kijiji|craigslist|wikipedia|blog|legion\.ca|healthline|digitalmarketingdeal)/i;
const SOCIAL_PATTERN = /(instagram|facebook|linkedin|twitter|x\.com|tiktok|pinterest|youtube)/i;

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function distinctiveTokens(name) {
  const all = norm(name).split(" ").filter(Boolean);
  const distinct = all.filter((t) => t.length >= 3 && !GENERIC_WORDS.has(t));
  return distinct.length ? distinct : all.filter((t) => t.length >= 2);
}

function containsWord(haystackNorm, token) {
  return (" " + haystackNorm + " ").includes(" " + token + " ");
}

function nameAppearsIn(lead, text) {
  const h = norm(text);
  const tokens = distinctiveTokens(lead.name);
  return tokens.length > 0 && tokens.every((t) => containsWord(h, t));
}

function domainLabel(domain) {
  const parts = domain.split(".");
  if (parts.length <= 1) return domain;
  const secondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
  const drop =
    parts.length >= 3 &&
    parts[parts.length - 1].length === 2 &&
    secondLevel.has(parts[parts.length - 2])
      ? 2
      : 1;
  return parts.slice(0, parts.length - drop).join("");
}

// Does the address itself look like it belongs to this business?
// (cosenzabakery.ca -> yes for "Cosenza Bakery"; mcdermottmotors.com -> no.)
// EVERY distinctive word of the business name must appear in the address,
// so "grandtravel.ca" does not match "The Grand Spice" just because of "grand".
function emailTiesToName(lead, email) {
  const [local = "", domain = ""] = String(email).toLowerCase().split("@");
  const tokens = distinctiveTokens(lead.name);
  if (tokens.length === 0) return false;
  const compactName = tokens.join("");
  const localCompact = local.replace(/[^a-z0-9]/g, "");

  // e.g. cosenzabakery@gmail.com -- a free-mail address named after the business.
  if (compactName.length >= 5 && tokens.every((t) => localCompact.includes(t))) return true;
  if (FREE_MAIL_DOMAINS.has(domain)) return false;

  const label = domainLabel(domain).replace(/[^a-z0-9]/g, "");
  if (!label) return false;
  // Short words (e.g. "zen") must be at the start of the domain to count.
  const inLabel = (t) => (t.length >= 4 ? label.includes(t) : label.startsWith(t));
  if (tokens.every(inLabel)) return true;
  // Domain is a shortened form of the name (e.g. mandarino.ca for "Mandarino Foods").
  return label.length >= 6 && compactName.includes(label);
}

function isInstitutionalEmail(email) {
  const domain = String(email || "").split("@")[1];
  if (!domain) return true;
  const d = domain.toLowerCase();
  return (
    /(^|\.)(gov|mil|edu)(\.[a-z]{2,3})?$/.test(d) ||
    /(^|\.)(gc|gouv)\.ca$/.test(d) ||
    /(^|\.)gov\.[a-z]{2}\.ca$/.test(d)
  );
}

function sourceKind(link) {
  const url = String(link || "").toLowerCase();
  if (!url) return "unknown";
  if (/\.(xlsx?|pdf|docx?|csv|pptx?)(\?|#|$)/.test(url)) return "document";
  if (DIRECTORY_PATTERN.test(url)) return "directory";
  if (SOCIAL_PATTERN.test(url)) return "social";
  return "web";
}

function urlText(link) {
  try {
    const u = new URL(link);
    return decodeURIComponent(u.hostname + " " + u.pathname);
  } catch {
    return String(link || "");
  }
}

const accept = (reason) => ({ verdict: "accept", reason });
const review = (reason) => ({ verdict: "review", reason });
const reject = (reason) => ({ verdict: "reject", reason });

/**
 * emailsInResult: every distinct email found in the same search result
 * (a result listing 3+ emails is almost certainly a directory/list page).
 */
function classifyEmail({ lead, email, title = "", snippet = "", link = "", emailsInResult = [] }) {
  const addr = String(email || "").toLowerCase();
  if (!addr.includes("@")) return reject("Not a valid email address.");
  if (isInstitutionalEmail(addr)) return reject("Government/institutional address.");

  const many = emailsInResult.length >= 3;
  const ties = emailTiesToName(lead, addr);
  const named = nameAppearsIn(lead, `${title} ${snippet}`) || nameAppearsIn(lead, urlText(link));
  const kind = sourceKind(link);

  if (ties && named && !many) {
    return accept("Address matches the business name and the page mentions the business.");
  }
  if (ties && named) {
    return review("Address matches the business name, but the page lists many emails.");
  }
  if (ties) {
    return review("Address looks like it belongs to this business, but the page doesn't mention its name.");
  }
  if (many) return reject("Page lists many unrelated emails (directory/list page).");
  if (kind === "directory" || kind === "document") {
    return reject(`Found on a ${kind} page and the address doesn't match the business.`);
  }
  if (named && emailsInResult.length <= 1) {
    const free = FREE_MAIL_DOMAINS.has(addr.split("@")[1]);
    return review(
      free
        ? "Free-mail address (e.g. Gmail) found next to the business name -- could be the owner's."
        : "Business name appears with this address, but the address doesn't match the business name -- could be a parent company or a directory."
    );
  }
  return reject("No clear tie between this address and the business.");
}

module.exports = { classifyEmail, distinctiveTokens, isInstitutionalEmail };
