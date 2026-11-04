# Resend domain issue: investigation notes

Written 2026-11-03 so the investigation can be picked up later. No secrets in this file.

## Symptom
Every send fails with Resend HTTP 403 (validation_error):
"The mail.rapidrankagency.com domain is not verified. Please, add and verify your domain on https://resend.com/domains"

## Timeline
- Early Oct: domain was verified and 7 emails went out. Then the 403 started.
- Oct 21-24: scheduled sends failed. Oct 24 run was green only because the queue was empty.
- Oct 25: attempt counters reset on 3 leads; all 5 attempts burned again by Oct 29.
- Nov 2, 6:00 PM EST: scheduled send failed for 3 leads (same 403).
- Nov 3, 4:20 PM EST: manual run (test_mode=false), 5 leads attempted, 0 sent, 5 failed (same 403).

## Where the leads stand (attempts used of 5)
- Barberyn Catering 3, Katrina's Kitchen 3, The Lunch Company 3
- Cosenza Bakery 2, Sixteen Mile Catering 2
- Retries are one per send run. A lead gives up at 5. Counters can be reset by setting sendAttempts to 0 in data/leads.json.

## What we know
- The error names the subdomain mail.rapidrankagency.com. The sender address comes from the GitHub secret OUTREACH_FROM (not readable from the repo).
- The root domain rapidrankagency.com was verified in Resend. That does NOT cover the mail. subdomain; Resend treats them as separate domains.
- Resend page for mail.rapidrankagency.com (as pasted Nov 3):
  - DKIM TXT resend._domainkey.mail: verified
  - CNAME rsend.mail -> rsend.forge.rmta.net (DNS only): verified
  - CNAME send.mail -> send.forge.rmta.net (DNS only): ACTION NEEDED
  - Resend banner: "Sending isn't on Forge yet. Add or update the send.mail CNAME record. Your emails are still being sent."
- DNS is managed in Cloudflare. Proxy must be DNS only (gray cloud) for these records.

## Open theories (not confirmed)
1. send.mail CNAME is missing, wrong, proxied, or blocked by an old MX/TXT record on the same name (a CNAME cannot share a name with other record types). Resend may have moved to new "forge" records, which would explain why a previously verified domain stopped working.
2. RESEND_API_KEY secret may belong to a different Resend team than the one that owns the domain.
3. OUTREACH_FROM secret may not match the verified domain.
4. Fallback: set OUTREACH_FROM to an address on the verified root domain (e.g. info@rapidrankagency.com). Works immediately but puts cold-outreach complaint risk on the main domain.

## Next steps when resuming
1. In Cloudflare: remove any other records on send.mail, add CNAME send.mail -> send.forge.rmta.net, DNS only.
2. In Resend: Verify DNS Records, wait for the whole domain to show Verified.
3. Confirm RESEND_API_KEY and OUTREACH_FROM point at that same team and domain.
4. Reset sendAttempts to 0 for the 5 leads above, then run Actions > Send Outreach Emails with test_mode=false and check the log.
5. Optional: add a read-only check to scripts/sendOutreachEmails.js that logs the domains visible to the API key when this 403 happens.

## Dashboard notes
- The Companies Reached table shows "attempt N of 5" with Eastern times, and a red Email send errors block with a Copy error details button.
- GitHub starts the scheduled send (cron 15:00 UTC) about 4-8 hours late, so it does not run at the scheduled time.
