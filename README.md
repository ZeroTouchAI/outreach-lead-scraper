# Lead Scraper — Phase 1

Finds B2B businesses that have **no website on file with Google**, as the
first stage of the outreach automation pipeline (scrape → enrich → email →
capture replies → auto-build demo site).

## What it does

1. Reads `config.json` for a list of business categories x locations to search.
2. Calls the Google Places API (New) `searchText` endpoint for each combo.
3. Keeps only results with **no `websiteUri`** (and, optionally, that have a
   phone number on file — since we'll need *some* contact channel even before
   email is found in Phase 2).
4. Dedupes against `data/leads.json` (by Google `placeId`) and appends new
   leads without touching the status of ones already in the pipeline.

Each lead is stored with a `status` field (`found` → later phases will move
this to `enriched`, `emailed`, `replied`, `demo_sent`, `closed`) so this same
file becomes the source of truth for every later stage.

## Setup

1. **Get a Google Places API key:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create/select a project, enable **"Places API (New)"**
   - Create an API key under Credentials, restrict it to Places API
   - ⚠️ Places API is a paid API past the free tier — check current pricing
     for Text Search + Contact Data (website field) in your Cloud console
     before running this against a large category/location list.

2. **Add the key as a GitHub Secret** (since GitHub Actions runs this on a
   schedule, not your local machine):
   - In your repo: Settings → Secrets and variables → Actions → New repository secret
   - Name: `GOOGLE_PLACES_API_KEY`
   - Value: the key from step 1

3. **Adjust `config.json`** — set the categories and cities you actually want
   to target. Start small (1-2 categories, 1 city) to sanity check costs and
   result quality before widening it.

## Running it

- **Automatically:** the included GitHub Actions workflow
  (`.github/workflows/scrape-leads.yml`) runs daily at 9am ET and commits any
  new leads straight to `data/leads.json`.
- **Manually:** go to the Actions tab in GitHub → "Scrape Leads" → "Run workflow".
- **Locally:** `GOOGLE_PLACES_API_KEY=xxx npm run find-leads`

## Output

`data/leads.json` — an array of lead objects like:

```json
{
  "placeId": "ChIJ...",
  "name": "Example Plumbing Co",
  "address": "123 Main St, Richmond Hill, ON",
  "phone": "+1 905-555-0100",
  "category": "plumber",
  "searchLocation": "Richmond Hill, ON",
  "googleMapsUrl": "https://maps.google.com/?cid=...",
  "hasWebsite": false,
  "status": "found",
  "email": null,
  "emailSource": null,
  "foundAt": "2026-07-18T00:00:00.000Z",
  "lastUpdatedAt": "2026-07-18T00:00:00.000Z"
}
```

## What's next (Phase 2)

Right now every lead has `email: null` — Places API doesn't give us emails.
Phase 2 is a separate enrichment script that tries, per lead:
1. Facebook/Instagram business page lookup (many no-website businesses still
   run a social page with a listed email)
2. Optional: a paid enrichment API (e.g. Apollo) as a fallback for higher fill rate
3. Marks leads it can't find an email for as `status: "no_email_found"` — this
   becomes a manual call queue (their phone number is already on file), not
   an automated SMS queue. Cold SMS to businesses without consent has real
   CASL exposure in Canada, so that channel is intentionally not automated.

Let me know when you want to move to that, and I'll build it against this
same `leads.json` structure.
