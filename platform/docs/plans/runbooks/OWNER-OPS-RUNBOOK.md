# Owner-Ops Runbook — Go-Live (Backups · Alerting · Secret Rotation · MSG91)

> Task #74 / GO-LIVE-READINESS §3.1. Owner-only ops to run before real customers land on prod.
> **Grounded in today's gcloud recon** — this doc OVERRIDES `GO-LIVE-READINESS.md §3.1`, which is STALE
> (it says PITR is OFF; it is in fact already ON — see §1).
>
> **Verified environment (do not re-derive):**
> - GCP project `gifsy-platform`, region `asia-south1`.
> - Cloud SQL: instance `gifsy-db` (POSTGRES_15, **ZONAL**), connection name `gifsy-platform:asia-south1:gifsy-db`. **Shared** by staging + prod via different DB names (`gifsy_prod` / `gifsy_staging`).
> - Prod Cloud Run: `gifsy-api`, `gifsy-frontend`. Staging: `gifsy-api-staging`, `gifsy-frontend-staging`.
> - Prod secrets (unsuffixed) + `_STAGING` variants already exist in Secret Manager. Prod API injects them via `valueFrom.secretKeyRef` / `--set-secrets …:latest` (see `.github/workflows/deploy.yml`).
> - Cloud Run service accounts: `gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com`, `gifsy-frontend-sa@gifsy-platform.iam.gserviceaccount.com`.
>
> **Roles in this doc:** **Owner** = holds real credentials / GCP account, runs the commands that touch real secret values, owner email, MSG91 account. **Orchestrator** = prepared these commands; can run pure read-only verification if granted gcloud access, but does NOT hold the real values.
>
> Run everything from a shell authenticated to the project:
> ```bash
> gcloud config set project gifsy-platform
> gcloud config set run/region asia-south1
> ```

---

## 1. Backups + PITR — VERIFY-ONLY (already enabled)

**Goal:** confirm automated daily backups + point-in-time recovery are on for `gifsy-db` before real data lands. No change needed — this is a sign-off.

**Who runs:** Owner or Orchestrator (read-only).

**Verified state (recon today):** automated backups ENABLED, **14** backups retained, `pointInTimeRecoveryEnabled=true`, `transactionLogRetentionDays=7`, daily backup `startTime=20:30` (UTC). `availabilityType=ZONAL`.

### Verify
```bash
# One-shot: print all the backup/PITR knobs
gcloud sql instances describe gifsy-db \
  --format="yaml(settings.backupConfiguration, settings.availabilityType)"
```
Expect:
- `settings.backupConfiguration.enabled: true`
- `settings.backupConfiguration.pointInTimeRecoveryEnabled: true`
- `settings.backupConfiguration.transactionLogRetentionDays: 7`
- `settings.backupConfiguration.backupRetentionSettings.retainedBackups: 14`
- `settings.backupConfiguration.startTime: "20:30"`
- `settings.availabilityType: ZONAL`

```bash
# Confirm real backups actually exist (not just configured)
gcloud sql backups list --instance=gifsy-db --limit=5
```
Expect ≥1 `SUCCESSFUL` row with a recent `windowStartTime`.

### Optional: take a manual on-demand backup right before the prod data load (#76)
```bash
gcloud sql backups create --instance=gifsy-db \
  --description="pre-deoleo-data-load $(date -u +%Y%m%dT%H%M%SZ)"
```

### Rollback / caveat
- This section makes **no changes** — nothing to roll back.
- **ZONAL caveat (optional upgrade, NOT required for launch):** `availabilityType=ZONAL` = single-zone; a zone outage means downtime until recovery. Regional HA (failover replica) is an optional resilience upgrade. **Do NOT run this casually** — it is a chargeable change and triggers an instance restart:
  ```bash
  # OPTIONAL — owner decision only; causes a brief restart + extra cost
  gcloud sql instances patch gifsy-db --availability-type=REGIONAL
  ```
  PITR/backups already cover data-loss recovery; HA only addresses zone-availability. Recommend deferring to post-launch.

---

## 2. Cloud Monitoring alerting — REAL TODO (currently nothing notifies)

**Goal:** a prod problem actively pages the owner. **Recon found ZERO notification channels** — this is the one genuinely-missing piece. Build: (1) an email notification channel, (2) a Cloud Run **5xx error-rate** alert on `gifsy-api`, (3) an **uptime check + alert** on the prod API `/health`.

**Who runs:** **Owner** (owner email + GCP account). Orchestrator can pre-stage the policy JSON.

> The backend exposes `GET /health` → `{ status: 'ok' }` (`api/src/app.controller.ts`). The prod API base URL is the value of the `NEXT_PUBLIC_API_URL` GitHub secret; confirm the live host with:
> ```bash
> gcloud run services describe gifsy-api --format="value(status.url)"
> ```
> Use that host below as `<PROD_API_HOST>` (e.g. `gifsy-api-xxxx-el.a.run.app`, no scheme).

### 2a. Email notification channel
```bash
gcloud beta monitoring channels create \
  --display-name="Owner — prod alerts" \
  --type=email \
  --channel-labels=email_address=<OWNER_EMAIL>
```
Capture the returned channel id:
```bash
gcloud beta monitoring channels list \
  --filter='type="email"' \
  --format="value(name)"
```
→ `<CHANNEL_ID>` looks like `projects/gifsy-platform/notificationChannels/0123456789`.
The owner must **click the verification link** emailed to `<OWNER_EMAIL>` — an unverified channel does not deliver. Confirm:
```bash
gcloud beta monitoring channels describe <CHANNEL_ID> --format="value(verificationStatus)"
# expect: VERIFIED
```

### 2b. Alert (a): Cloud Run 5xx error-rate on gifsy-api
Save as `alert-api-5xx.json` (replace `<CHANNEL_ID>`):
```json
{
  "displayName": "gifsy-api 5xx error rate (prod)",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "gifsy-api 5xx responses > 5 in 5m",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"gifsy-api\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\"",
        "aggregations": [
          { "alignmentPeriod": "60s", "perSeriesAligner": "ALIGN_RATE", "crossSeriesReducer": "REDUCE_SUM" }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 5,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["<CHANNEL_ID>"]
}
```
```bash
gcloud alpha monitoring policies create --policy-from-file=alert-api-5xx.json
```

### 2c. Alert (b): uptime / health check on the prod API
First create the uptime check on `/health`. Easiest via console (Monitoring → Uptime checks → Create) using host `<PROD_API_HOST>`, path `/health`, protocol HTTPS, port 443. Or via gcloud, save `uptime-api-health.json`:
```json
{
  "displayName": "gifsy-api /health (prod)",
  "monitoredResource": {
    "type": "uptime_url",
    "labels": { "host": "<PROD_API_HOST>", "project_id": "gifsy-platform" }
  },
  "httpCheck": { "path": "/health", "port": 443, "useSsl": true, "validateSsl": true },
  "period": "60s",
  "timeout": "10s"
}
```
```bash
gcloud monitoring uptime create-from-file uptime-api-health.json 2>/dev/null \
  || gcloud alpha monitoring uptime create-config-from-file uptime-api-health.json
# If neither subcommand exists in your gcloud version, create the uptime check in the console.
```
Then an alert that fires when the uptime check fails (save `alert-api-uptime.json`, replace `<CHANNEL_ID>`):
```json
{
  "displayName": "gifsy-api uptime failing (prod)",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "gifsy-api /health check failed",
      "conditionThreshold": {
        "filter": "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.labels.check_id = \"<UPTIME_CHECK_ID>\"",
        "aggregations": [
          { "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_FRACTION_TRUE", "crossSeriesReducer": "REDUCE_MEAN" }
        ],
        "comparison": "COMPARISON_LT",
        "thresholdValue": 1,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["<CHANNEL_ID>"]
}
```
```bash
gcloud alpha monitoring policies create --policy-from-file=alert-api-uptime.json
```
(`<UPTIME_CHECK_ID>` = the `check_id` of the uptime check created above; `gcloud monitoring uptime list-configs` to find it.)

### Verify
```bash
gcloud alpha monitoring policies list --format="table(displayName, enabled)"
# expect both policies, enabled=True
```
Optional live test: open `https://<PROD_API_HOST>/health` and confirm `200 {"status":"ok"}`. To prove the channel delivers, temporarily lower a threshold or use the console "Test" button on the notification channel.

### Rollback / caveat
- Delete a policy: `gcloud alpha monitoring policies delete <POLICY_ID>`. Delete the channel: `gcloud beta monitoring channels delete <CHANNEL_ID>`.
- **Console fallback is fine** — Monitoring → Alerting → Create policy is less error-prone than the JSON if a gcloud subcommand version-mismatches. The JSON above is the source of truth for thresholds.
- Tune thresholds after observing real traffic; the starting values are deliberately conservative.

---

## 3. Prod secret rotation — replace any dev-era values with fresh prod-only ones

**Goal:** ensure no dev-era credential is reused in prod. Rotation = **publish a new version** of each existing prod secret, then **restart the consuming service** so it re-reads `:latest`. Cloud Run resolves `…:latest` at deploy/start time, so a new secret version is NOT picked up until the service is redeployed/updated.

**Who runs:** **Owner** (holds the real values).

**Which secrets, and what each needs:**

| Secret | Consumed by | Real value needed? | Notes |
|---|---|---|---|
| `DATABASE_URL` | api (`--set-secrets DATABASE_URL=DATABASE_URL:latest`) | **Yes** — new DB password | Must also `set-password` on the SQL user. Use `@localhost/` host form (see §3a caveat). |
| `JWT_SECRET` | api + frontend (both `--set-secrets JWT_SECRET=JWT_SECRET:latest`) | **Yes** — fresh random | Rotating **invalidates ALL existing prod sessions** (acceptable pre-launch). Rotate api + frontend together. |
| `MSG91_AUTH_KEY` | api | **Yes** — from MSG91 (see §4) | |
| `MSG91_SENDER_ID` | api | **Yes** — from MSG91 | |
| `MSG91_OTP_TEMPLATE_ID` | api | **Yes** — from MSG91 | |
| `MSG91_SMS_TEMPLATE_ID` | api | **Yes** — from MSG91 | |

> Rotate the **unsuffixed** (prod) secrets only. Do NOT touch the `_STAGING` variants here.

### 3a. DATABASE_URL (DB password rotation — TWO steps, ordered)
The DB password lives both in Cloud SQL and inside the `DATABASE_URL` connection string. They must match, so do the SQL change and the secret-version add as one atomic operation, then restart.

1. Change the Postgres user's password in Cloud SQL (find the username inside the current `DATABASE_URL`, commonly `gifsy` or `postgres`):
```bash
gcloud sql users set-password <DB_USER> \
  --instance=gifsy-db \
  --password='<NEW_DB_PASSWORD>'
```
2. Build the new connection string and publish a new secret version. Prod connects via the Cloud SQL Unix socket, so the host is `localhost` and the socket path is appended (mirrors the existing prod secret form — see migration-model note):
```bash
NEW_URL='postgresql://<DB_USER>:<NEW_DB_PASSWORD>@localhost/gifsy_prod?host=/cloudsql/gifsy-platform:asia-south1:gifsy-db&schema=public'
printf '%s' "$NEW_URL" | gcloud secrets versions add DATABASE_URL --data-file=-
```
> ⚠️ **Use `@localhost/` (not an empty `@/host=…` host)** — the Prisma **migrate** engine rejects an empty-host URL with `P1013` even though the query engine tolerates it (this exact bug took down staging once). The migration Cloud Run job (`gifsy-migrate`) reads `DATABASE_URL:latest`, so a malformed value breaks the next prod deploy's migrate step.

### 3b. JWT_SECRET
```bash
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add JWT_SECRET --data-file=-
```

### 3c. MSG91_* (values come from MSG91 — see §4)
```bash
printf '%s' '<MSG91_AUTH_KEY_VALUE>'        | gcloud secrets versions add MSG91_AUTH_KEY        --data-file=-
printf '%s' '<MSG91_SENDER_ID_VALUE>'       | gcloud secrets versions add MSG91_SENDER_ID       --data-file=-
printf '%s' '<MSG91_OTP_TEMPLATE_ID_VALUE>' | gcloud secrets versions add MSG91_OTP_TEMPLATE_ID --data-file=-
printf '%s' '<MSG91_SMS_TEMPLATE_ID_VALUE>' | gcloud secrets versions add MSG91_SMS_TEMPLATE_ID --data-file=-
```
> ⚠️ Use `printf '%s'` (no trailing newline). The backend `.trim()`s `MSG91_AUTH_KEY` to defend against a BOM/newline, but a trailing newline in any secret is still bad hygiene. Do NOT paste through an editor that adds a BOM.

### 3d. Make the running services pick up the new versions
Adding a secret version does nothing until the service restarts. Either re-run the prod deploy workflow (push to `main` / `workflow_dispatch` → it redeploys with `…:latest`), or force an in-place update:
```bash
# API picks up DATABASE_URL + JWT_SECRET + MSG91_* :latest
gcloud run services update gifsy-api --region=asia-south1 \
  --update-secrets="DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest,MSG91_AUTH_KEY=MSG91_AUTH_KEY:latest,MSG91_SENDER_ID=MSG91_SENDER_ID:latest,MSG91_OTP_TEMPLATE_ID=MSG91_OTP_TEMPLATE_ID:latest,MSG91_SMS_TEMPLATE_ID=MSG91_SMS_TEMPLATE_ID:latest"

# Frontend uses JWT_SECRET only
gcloud run services update gifsy-frontend --region=asia-south1 \
  --update-secrets="JWT_SECRET=JWT_SECRET:latest"
```

### Verify
```bash
# New version exists + is enabled
gcloud secrets versions list DATABASE_URL --limit=3
gcloud secrets versions list JWT_SECRET   --limit=3

# Service is serving a new revision after the update
gcloud run services describe gifsy-api --format="value(status.latestReadyRevisionName)"

# Smoke: API still boots + DB connects (health is liveness; do a real login to prove DB+JWT)
curl -s https://<PROD_API_HOST>/health   # expect {"status":"ok"}
```
After JWT rotation, confirm a fresh login issues a working token and old tokens are rejected (expected).

### Rollback / caveat
- **Rotating `JWT_SECRET` logs everyone out** of prod — fine pre-launch, coordinate if done after users exist.
- **`DATABASE_URL` is the dangerous one:** if the new password / URL is wrong, the API won't connect AND the migration job will fail. To roll back, re-point the secret to the previous good version (you cannot delete a version that's in use; add the old value back as a new version) and re-`set-password` to the old password, then `gcloud run services update`. Test on a non-peak window.
- Disable a leaked version (does not delete history): `gcloud secrets versions disable <VERSION> --secret=DATABASE_URL`.
- The service account `gifsy-api-sa@…` must retain `roles/secretmanager.secretAccessor` (already granted — deploys read these today).

---

## 4. Real prod MSG91 — confirm live sender/template/auth, then test one OTP

**Goal:** verify the four `MSG91_*` prod secrets hold **real production** values (registered sender ID + approved DLT templates + a live auth key), and prove one real OTP sends on prod.

**Who runs:** **Owner** (MSG91 dashboard access). The MSG91 values may already be real (recon couldn't read secret *contents*, only that the secrets exist) — owner confirms.

**How the backend uses them** (`api/src/notifications/msg91.service.ts`):
- `MSG91_AUTH_KEY` → `authkey` header to `https://control.msg91.com/api/v5/otp`.
- `MSG91_OTP_TEMPLATE_ID` → `template_id` in the body; mobile sent as `91<phone>`.
- Sender ID is configured **on the MSG91 template**, so `MSG91_SENDER_ID` is informational on the send path (template drives it). `MSG91_SMS_TEMPLATE_ID` is for transactional SMS, not the OTP path.
- **On prod (`NODE_ENV=production`) `FIXED_OTP` is ignored** (`isFixedOtpAllowed()` is false) — prod always calls real MSG91. If `MSG91_AUTH_KEY` is empty, the service **silently logs the OTP and returns** (no SMS) — so an empty/placeholder auth key = no OTPs reach users. That is the failure mode to rule out.

### What the owner must obtain / confirm from the MSG91 dashboard
1. A **production auth key** (Settings → API → Auth Key).
2. An **approved DLT OTP template** and its `template_id` (the `{{otp}}` variable must be wired) → `MSG91_OTP_TEMPLATE_ID`.
3. The **registered DLT sender ID** (6-char header) bound to that template → `MSG91_SENDER_ID`.
4. (If transactional SMS used) an approved SMS `template_id` → `MSG91_SMS_TEMPLATE_ID`.
5. **IP whitelisting / egress:** MSG91 may IP-restrict; Cloud Run egress is dynamic. Confirm whitelisting is OFF or that the prod egress is allowed (the service has a 10s timeout that fails the send if MSG91 is unreachable — manifests as "did not respond within 10s").

If any value is a dev/placeholder, rotate it via §3c then restart via §3d.

### Test one real OTP send on prod
1. Confirm the prod API is serving with the MSG91 secrets bound:
```bash
gcloud run services describe gifsy-api --region=asia-south1 \
  --format="value(spec.template.spec.containers[0].env)" | tr ',' '\n' | grep -i MSG91
```
2. Trigger a real send to a phone the owner controls (use the real login flow). Replace `<PROD_API_HOST>` and `<OWNER_TEST_PHONE>` (10-digit, no country code):
```bash
curl -s -X POST "https://<PROD_API_HOST>/v1/auth/send-otp" \
  -H "Content-Type: application/json" \
  -d '{"phone":"<OWNER_TEST_PHONE>"}'
```
> Confirm the exact send-otp route/body against the auth controller before running — the path may be versioned differently. The success signal is an **SMS actually arriving** on the device, not just an HTTP 200 (MSG91 can return 200 with `{type:"error"}`; the backend treats that as a failure and logs it).
3. If no SMS arrives, check logs for the MSG91 error message:
```bash
gcloud run services logs read gifsy-api --region=asia-south1 --limit=50 | grep -i msg91
```
Common causes: empty/placeholder auth key (logs `MSG91 not configured`), unapproved template, IP whitelist/egress timeout, wrong `template_id`.

### Rollback / caveat
- MSG91 secret changes only take effect after a service restart (§3d).
- **Do NOT** set `ALLOW_FIXED_OTP`/`FIXED_OTP` on prod to work around a misconfig — prod must use real MSG91. (Those are gated to `gifsy_staging` only.)
- Real OTP sends cost money and hit DLT rate rules — test sparingly.

---

## Owner must supply (placeholder checklist)
- [ ] `<OWNER_EMAIL>` — for the Monitoring notification channel (§2a) + click the verification link.
- [ ] `<PROD_API_HOST>` — confirm via `gcloud run services describe gifsy-api --format="value(status.url)"` (used throughout §2/§3/§4).
- [ ] `<DB_USER>` — the Postgres user inside the current `DATABASE_URL` (§3a).
- [ ] `<NEW_DB_PASSWORD>` — fresh prod DB password (§3a).
- [ ] `<MSG91_AUTH_KEY_VALUE>`, `<MSG91_SENDER_ID_VALUE>`, `<MSG91_OTP_TEMPLATE_ID_VALUE>`, `<MSG91_SMS_TEMPLATE_ID_VALUE>` — real values from the MSG91 dashboard (§3c/§4).
- [ ] `<OWNER_TEST_PHONE>` — a phone the owner controls, for the live OTP test (§4).
- [ ] Decision: rotate `JWT_SECRET`? (logs out all current prod sessions — do pre-launch). (§3b)
- [ ] Decision: ZONAL → REGIONAL HA upgrade? (optional, chargeable, not required). (§1)
- [ ] `<CHANNEL_ID>` / `<UPTIME_CHECK_ID>` / `<POLICY_ID>` — captured from the create commands as you go (§2).

## What's already done (verified — recon today, overrides stale docs)
- ✅ **Automated backups ON** — 14 retained, daily `startTime=20:30`.
- ✅ **PITR ON** — `pointInTimeRecoveryEnabled=true`, `transactionLogRetentionDays=7`. *(GO-LIVE-READINESS §3.1 says PITR is OFF — that is STALE; this doc corrects it.)*
- ✅ **Prod Cloud Run services live** — `gifsy-api`, `gifsy-frontend` (+ staging variants).
- ✅ **All prod secrets exist** in Secret Manager (`DATABASE_URL`, `JWT_SECRET`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_SMS_TEMPLATE_ID`, `GCS_BUCKET`, `GCP_PROJECT_ID`, `CORS_ORIGINS`, `REDIS_URL`, …) — rotation = new versions, not creation.
- ✅ **Prod injects secrets** via `--set-secrets …:latest` (deploy.yml) — the rotation+restart pattern in §3 matches how Cloud Run consumes them.
- ✅ **`/health` endpoint exists** (`api/src/app.controller.ts` → `{status:'ok'}`) — used for the uptime check.

## Still genuinely missing (the real to-do)
- 🔴 **Monitoring/alerting** — **ZERO notification channels and ZERO alert policies exist.** §2 is the main real work in this runbook.
- 🟡 **Secret-value freshness** — secrets exist but their *contents* (dev-era vs prod-only) are unverified; §3 rotates them.
- 🟡 **MSG91 realness** — secrets exist; whether they hold live production MSG91 values is owner-confirm (§4).
