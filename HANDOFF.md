# Actions Storage Cleanup — Handoff Notes

## Why this exists
In August 2026 the ZeroTouchAI GitHub account hit 100% of its included Actions storage (0.5GB/month), shared across all repos. This repo was one of three contributors.

## What was consuming space here
- 183 stored workflow runs, of which **107 (58%)** were `pages-build-deployment` — auto-triggered by GitHub every time `daily-pipeline.yml` or `send-outreach.yml` committed data back to `main`.
- Artifacts were negligible (~1.5MB, 1-day retention already).

## What was changed (Aug 22, 2026)
1. Added `.github/workflows/cleanup-actions-storage.yml` — runs daily at 03:00 UTC. Keeps the 5 most recent completed runs of every workflow plus anything from the last 7 days; deletes the rest and sweeps any expired artifacts. Supports a `dry_run` manual mode.
2. One-time manual cleanup: deleted 145 old completed runs (all workflows) to free space immediately.
3. `scrape-leads.yml` and `enrich-leads.yml` were left untouched — they're intentional manual fallback tools, not dead code.

## Nothing else changed
No pipeline logic, no data files (`data/leads.json`, `config.json`, `data/dashboardData.json`), no other workflows were touched. Only run-history records and expired artifacts are affected, past or future.

## If storage issues come back
Run the cleanup workflow manually via Actions → "Cleanup Actions Storage" → Run workflow (`dry_run: true` to preview first). If it's not enough, lower `KEEP_DAYS` / `KEEP_PER_WORKFLOW` in the script.

See also: the cross-repo standard in `ACTIONS_STORAGE_STANDARD.md` (or ask for the master copy) — apply the same pattern to any new automation project from day one.
