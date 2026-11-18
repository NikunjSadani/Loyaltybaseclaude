# Runbook — activating the daily internal email reports

The scheduled internal Gifsy email — since 2026-11-13 ONE **Daily Operations Digest** (all-tenant summary + one
section per tenant; design `platform/docs/plans/DAILY-OPS-DIGEST.md`), daily Mon–Sat 09:30 IST — replaced the two
earlier emails (**Credits/Payouts summary** + **KYC actionables digest**). It ships **fail-closed**: the trigger endpoint 403s until `REPORTS_RUN_SECRET` is set, and
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
  --message-body=" " \
  --attempt-deadline=300s --max-retry-attempts=0
```
`30 9 * * 1-6` = 09:30 IST, Mon–Sat. (For staging, target `gifsy-api-staging` + name `reports-run-staging`.)
- `--attempt-deadline=300s`: matches Cloud Run's request timeout (300 s on `gifsy-api` and `gifsy-api-staging`).
  The run limits itself to a 240 s budget — sections not started by then are marked "not loaded (time budget)" (the
  run is then `degraded` and its window repeated tomorrow) and the email is sent within the request. The run lease
  is 6 min, so a dead attempt never blocks the next day.
- `--max-retry-attempts=0`: no automatic retries — a failure must be SEEN (the job shows failed and alerts) and re-run
  by a person. The endpoint is idempotent anyway (a second call the same IST day after a success answers
  `200 skipped`), but a retried `degraded`/`error` run would just repeat the same failure.
- An existing job: `gcloud scheduler jobs update http reports-run-prod --project "$PROJECT" --location "$REGION"
  --attempt-deadline=300s --max-retry-attempts=0`.

## 4. Configure recipients (Gifsy admin)
Log in as GIFSY_ADMIN → **`/gifsy/settings` → Report Recipients** → the single **Daily Operations Digest** list → add
the internal Gifsy addresses → Save. **Internal addresses only, enforced:** allowed domains = env
`REPORTS_RECIPIENT_DOMAINS` (comma-separated, exact match after `@`; unset → `gifsy.in`). The card rejects other
addresses inline and the PUT refuses them (400); any non-internal address already in a list (e.g. inherited from a
legacy list) is NOT sent to — the email footer and the API log name it. Until the first save the card labels the list
"Inherited from the two old daily emails' lists".

**Storage + fallback:** one platform row `program_settings` (`clientId='gifsy'`, `settingKey='reportRecipients'`),
value `{ "dailyDigest": [...] }`. **If the row has no `dailyDigest` key** (i.e. nobody has saved the new card yet),
the digest goes to the **union of the legacy `creditsPayouts` + `kycActionables` lists** — so whoever received the
old emails keeps receiving the digest with no action. The card shows that effective list; the first Save writes
`{ dailyDigest }` (dropping the legacy keys) and from then on that list is used as-is — an explicitly empty list =
nobody, no email.

## 5. Verify the real send
```bash
# manual trigger (same as the scheduler)
curl -s -w '\nHTTP %{http_code}\n' -X POST "${API_URL}/v1/reports/run" -H "x-reports-run-secret: ${SECRET}"
# re-send a day that already went out (re-covers today's window up to now)
curl -s -w '\nHTTP %{http_code}\n' -X POST "${API_URL}/v1/reports/run?force=true" -H "x-reports-run-secret: ${SECRET}"
```
The body is `{ ok, dateLabel, reports:[{ key:"dailyDigest", status, window, recipients, tenants, tenantsNeedingAttention,
attentionItems, notices?, droppedRecipients?, error? }] }`. Status → HTTP:
- `sent` → **200** — emailed with complete data (check the inbox). Sent EVERY run, even on an all-quiet day. The window
  ran from the end of the last successful send (first run: since the previous working day; capped at 7 days, with a
  red notice naming any uncovered gap).
- `skipped` → **200** `{ skipped:"already-sent" }` — an email (complete or incomplete) already went out today; use
  `?force=true` to re-send.
- `degraded` → **500** — emailed, but something did not load (any section, a section skipped by the 240 s budget, or a
  shared input: tenant list / holiday calendar / SLA targets / run history). The email has a red "This digest is
  incomplete" box; the window is NOT advanced, so the next email repeats it and says so at the top ("This email repeats
  … Don't add these figures to that day's."). Same section failing 3 runs in a row → subject `INCOMPLETE 3 days`.
- `no-recipients` → **409** — the effective list is empty, or every address was non-internal (`droppedRecipients`).
- `in-progress` → **409** — another run holds the lease (TTL 6 min; `?force=true` may break one older than 240 s).
- `error` → **500** — `error` has the reason (recipient read failed, SMTP failure, or "the email WAS sent, but the
  run could not be recorded"). A failing DATA section does NOT fail the run: that tenant's section renders "Couldn't
  load this section (reason)" and the run is `sent`.
A non-2xx body is `{ success:false, error:"Daily operations digest: <status> — reason: … — not loaded: … — not sent to
(non-internal): … — notices: … — window: … — full outcome in the API log line \"daily-digest-run <id>\"" }`. Find the
full outcome in Cloud Logging: `textPayload:"daily-digest-run <id>"` (one line per run).
Run history: `program_settings` row `clientId='gifsy'`, `settingKey='dailyDigestRunState'` (`lastSuccess`,
`lastAttempted`, `failStreaks`, `lastAttempt`, `running`).

Confirm a recipient actually received it and it rendered (summary table, per-tenant sections, ₹ amounts). A
rendered sample lives at `platform/docs/plans/samples/daily-ops-digest-sample.html`.

## Notes
- **Subject:** `[Gifsy] Daily operations — <date> — all quiet`, or `… — <N> items need attention (<T> tenants +
  Gifsy-wide)` where N counts EVERY attention item (tenant items, OTP failures, standing open items, run notices);
  `INCOMPLETE — ` is inserted when a run notice is present. It never says "all quiet" while the body shows red.
- **Window:** since the end of the last successful send (≤ 7 days); the first tracked run uses "since the same time on
  the previous working day" (Monday: Saturday 09:30 → Monday 09:30).
- **All-tenant + platform recipients:** the digest summarises every tenant (ACTIVE always; ONBOARDING/INACTIVE when they
  have activity or open items, the rest named) and goes to one Gifsy-configured internal list. Tenant admins cannot
  read or set it (GET + PUT are Gifsy-operator-only) and never receive it.
- **Rollback:** delete the scheduler job (`gcloud scheduler jobs delete reports-run-prod`) or blank
  `REPORTS_RUN_SECRET` → the endpoint 403s and nothing sends. ⚠️ Rolling the CODE back to before the digest after the
  new card has been saved would leave the old two reports with no recipients (the saved row only holds `dailyDigest`)
  — re-enter the two legacy lists in that case.
