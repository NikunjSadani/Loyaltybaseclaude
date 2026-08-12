# Runbook — activating the daily internal email reports

The scheduled internal Gifsy email reports (**Credits/Payouts summary** + **KYC actionables digest**,
daily Mon–Sat) ship **fail-closed**: the trigger endpoint 403s until `REPORTS_RUN_SECRET` is set, and
`sendEmail` no-ops if `MSG91_AUTH_KEY` is unset. So the code is safe to deploy with nothing configured.
This runbook turns it on. Mirrors the push-drain provisioning pattern (schedulers are created via
`gcloud`, NOT terraform).

## Prerequisites (owner)
- ✅ MSG91 **Email** product active on the account (Free plan, 5,000/mo).
- ✅ Sending domain **`notify.gifsy.in`** verified in MSG91 (SPF/DKIM/MX/CNAME) + DMARC live.
- ⚠️ **Confirm the MSG91 email API payload.** `api/src/notifications/msg91.service.ts` `sendEmail()` has a
  block flagged `⚠️ CONFIRM against MSG91 dashboard → API Integration tab`. Paste the API Integration
  tab's endpoint + sample request; adjust that one block if the field names differ, then re-run the gate.

## 1. Create the shared trigger secret (Secret Manager)
> **✅ ALREADY DONE (2026-08-12):** both `REPORTS_RUN_SECRET` (prod) and `REPORTS_RUN_SECRET_STAGING` exist and were
> **cleaned to v2** (see the CR warning below). Steps 1–2 are complete; the staging test-send passed. What's left is
> step 3 (prod cron) after the prod cutover carries the SMTP commits.
```bash
PROJECT=gifsy-platform
SECRET=$(python -c "import secrets;print(secrets.token_hex(32))")   # 64-hex
printf "%s" "$SECRET" | gcloud secrets create REPORTS_RUN_SECRET --project "$PROJECT" --data-file=- \
  || printf "%s" "$SECRET" | gcloud secrets versions add REPORTS_RUN_SECRET --project "$PROJECT" --data-file=-
```
Keep `$SECRET` — the Cloud Scheduler job (step 3) needs the same value.
> **🐛 TRAILING-`\r` TRAP (bit us on both run-secrets, 2026-08-12):** `printf "%s"` above is safe, but any value created
> from a Windows/PowerShell shell (or `echo`) can carry a trailing carriage-return. Cloud Run keeps the `\r` in the env
> value, but **no HTTP client can send a trailing `\r` in a header** → the gate 403s forever even with the "right" secret.
> Whenever you set `SECRET` from the store for step 3, strip it: `SECRET=$(gcloud secrets versions access latest
> --secret=REPORTS_RUN_SECRET | tr -d '\r\n')`, and byte-verify a stored secret with `… | wc -c` (expect 64) +
> `tail -c1 | od -An -tx1` (must NOT be `0d`/`0a`). If a stored version is dirty, add a stripped version and roll a new
> Cloud Run revision so instances re-read `:latest`.

## 2. Bind the secret + from-address onto Cloud Run (CI)
In **`.github/workflows/deploy.yml`** (prod) and **`.github/workflows/deploy-staging.yml`** (staging):
- Append to the `--set-secrets` list: `REPORTS_RUN_SECRET=REPORTS_RUN_SECRET:latest`
- Append to the `--set-env-vars` list: `REPORTS_FROM_EMAIL=reports@notify.gifsy.in`

Do this **after** step 1 (a `--set-secrets` reference to a non-existent secret fails the deploy). Push →
the next deploy binds them.

## 3. Create the Cloud Scheduler job (daily Mon–Sat, IST)
```bash
PROJECT=gifsy-platform ; REGION=asia-south1
API_URL=$(gcloud run services describe gifsy-api --project "$PROJECT" --region "$REGION" --format='value(status.url)')
gcloud scheduler jobs create http reports-run-prod \
  --project "$PROJECT" --location "$REGION" \
  --schedule="30 9 * * 1-6" --time-zone="Asia/Kolkata" \
  --uri="${API_URL}/v1/reports/run" --http-method=POST \
  --headers="Content-Type=application/octet-stream,x-reports-run-secret=${SECRET}" \
  --message-body=" "
```
`30 9 * * 1-6` = 09:30 IST, Mon–Sat. (For staging, target `gifsy-api-staging` + name `reports-run-staging`.)

## 4. Configure recipients (Gifsy admin)
Log in as GIFSY_ADMIN → **Settings → Report Recipients** → add the email addresses for each report
(Credits & Payouts summary, KYC actionables digest) → Save. Empty list = that report is skipped.

## 5. Verify the real send
```bash
# manual trigger (same as the scheduler)
curl -s -X POST "${API_URL}/v1/reports/run" -H "x-reports-run-secret: ${SECRET}" | jq
```
Expect `{ ok:true, dateLabel, reports:[{key,status}, ...] }`. `status`:
- `sent` — emailed (check the recipient inbox).
- `suppressed-empty` — credits report skipped (no activity today; expected on a quiet day).
- `no-recipients` — nobody configured for that report.
- `error` — the `error` field has the reason (e.g. MSG91 payload mismatch → fix the block in step-0 prereq).

Confirm a recipient actually received the email and it rendered (tables, ₹ amounts, KYC counts).

## Notes
- **Suppression:** Credits/Payouts is suppress-if-empty (no email on a quiet day); KYC actionables always
  sends (a daily digest — "all clear" when nothing is pending).
- **All-tenant + platform recipients:** both reports summarise ALL tenants and go to one Gifsy-configured
  list. They are internal Gifsy reports — tenant admins can READ the recipient list but cannot set it
  (PUT is GIFSY-only) and do not receive the reports unless explicitly added.
- **Rollback:** delete the scheduler job (`gcloud scheduler jobs delete reports-run-prod`) or blank
  `REPORTS_RUN_SECRET` → the endpoint 403s and nothing sends.
