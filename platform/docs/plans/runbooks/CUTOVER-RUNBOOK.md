# Runbook — Production Cutover (`develop` → `main` = prod deploy)

> **Strictly sequential.** Each step gates the next — cutover is **not parallelizable**. Do not start
> a step until the prior step's verification passed. For each step: **Owner · Goal · Command(s) · Verify · Rollback.**
>
> **Execution model = HYBRID.** Every step is labelled **[claude]**, **[owner]**, or **[owner-go / claude-run]**:
> - **[claude]** — the orchestrator does all reversible prep, verification, and dry-runs autonomously.
> - **[owner]** — the **owner pulls every irreversible prod trigger** personally: approve+merge to `main`,
>   approve the GitHub `production` environment gate, and green-light the real-PII data load.
> - **[owner-go / claude-run]** — claude runs the (in-VPC) command **only on the owner's explicit per-step go**,
>   then verifies the result and reports back. No irreversible prod action happens without an owner go.
>
> Companions: [`PROD-DATA-LOAD.md`](PROD-DATA-LOAD.md) (#76 master-data load — the detailed Step 5) ·
> [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md) (migration mechanics) ·
> [`PROD-CUTOVER-RECORD.md`](PROD-CUTOVER-RECORD.md) (the 2026-06-20 baseline-reconcile cutover, as-run) ·
> [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md) (per-tenant launch config) ·
> [`../MIGRATIONS.md`](../MIGRATIONS.md) (the migration model) · [`../PWA-PLAN.md`](../PWA-PLAN.md).
>
> Authored 2026-06-29; **revised 2026-06-30** against live infra + code (all facts below re-verified this session).
> Verify any drifted fact against the repo / `gcloud` before executing.

---

## ⚠️ Reality check — read this first (corrects stale docs)

**Prod is ALREADY LIVE but EMPTY. This cutover is a routine UPDATE of an empty production — low risk.**

Verified live (2026-06-30):

- Cloud Run services **`gifsy-api`** and **`gifsy-frontend`** (region `asia-south1`, project `gifsy-platform`)
  are already serving (current `main` HEAD). Prod is up. Merging `develop`→`main` **updates the revision** of
  two existing, running services — it does **not** create them.
- Prod has **0 users and 0 data** (greenfield). So the pre-cutover backup (Step 2) is a **formality** and the
  rollback risk is **minimal** — there is nothing live to corrupt or lose. Older notes that framed this as a
  high-stakes/first-ever deploy are **stale**; treat it as a low-risk update of an empty DB.
- The DB (`gifsy_prod`) was **already reconciled to the squashed baseline** at the 2026-06-20 cutover
  (`_prisma_migrations` = 1 row: `00000000000000_baseline`). The **P3005 baseline-reconcile is DONE** and is
  **not** repeated here. This cutover applies **8 ordinary forward migrations** on top of that baseline (older
  text saying "6 migrations" is **stale** — see Step 3's table).

### Risk list (low overall — empty prod)
| Risk | Why it's low here | Mitigation in this runbook |
|---|---|---|
| **209-commit jump** `main`→`develop` | Large surface, but staging is already serving this exact candidate and it's been UAT'd. | Full gate green (Step 0); staging serves the candidate; smoke every role (Step 6); fast rollback (Rollback note). |
| **8 migrations applied at once** | All **additive** (new tables / constraints / one enum value) on an **empty** DB → zero-risk, no backfill, no rewrite. | See Step 3 table; `--wait` fails the deploy if any migration errors (broken-schema code never serves). |
| **Shared Cloud SQL instance** `gifsy-db` (staging + prod) | A mis-targeted command could hit `gifsy_staging`. | Every DB op is **double-guarded** by asserting `current_database()='gifsy_prod'` (Steps 2, 3, 4). Prod uses secret `DATABASE_URL`; staging uses `DATABASE_URL_STAGING`. |
| **Prod PWA secrets MISSING** | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `PUSH_DRAIN_SECRET` (prod) **do not exist yet** — only the `*_STAGING` ones do. If the prod pipeline references them before they exist, the deploy's secret refs fail. | **Step 1 creates them first**, and the `prep/prod-pwa-activation` branch (which adds the prod env/secret refs) must flow to `main` **with/after** the secrets exist — see the ordering note in Step 1. |
| **GitHub "production" approval gate** | The `main` pipeline **pauses** at a required-reviewer gate between tests and deploy. | Expected — **[owner]** approves it at Step 3. If unapproved, nothing deploys (safe). |

---

## 🧰 OWNER PREREQUISITES — do these before Step 0

A short checklist the **owner** completes up front (the rest of the runbook assumes these are true):

- [ ] **MSG91 DLT — DONE ✅.** Templates + credentials are registered. Residual: at smoke (Step 6) confirm the
      latest secret **versions** hold the real DLT values by sending **one real test OTP** (see Step 6).
- [ ] **Data files ready.** The Deoleo master-data files for the Step 5 load are prepared in the agreed
      template formats (outlet master, sales hierarchy, reward catalog, schemes) — per [`PROD-DATA-LOAD.md`](PROD-DATA-LOAD.md)
      + [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md).
- [ ] **GCP alert emails verified.** Click the **2 GCP alert-email verification links** so monitoring alerts can
      actually deliver (confirmed at Step 6).
- [ ] **Ready to approve the `production` gate.** The owner will personally approve the GitHub `production`
      environment gate at **Step 3** (and merge `develop`→`main`). Nothing irreversible happens without this.

---

## Secrets status (verified 2026-06-30)

| Secret | Prod status | Notes |
|---|---|---|
| `DATABASE_URL` | **Present ✅** | Referenced by prod `gifsy-api`. |
| `JWT_SECRET` | **Present ✅** | Referenced by prod `gifsy-api`. |
| `MSG91_AUTH_KEY` / `MSG91_SENDER_ID` / `MSG91_OTP_TEMPLATE_ID` / `MSG91_SMS_TEMPLATE_ID` | **All 4 present ✅** | Referenced by prod `gifsy-api`. Owner says DLT templates+creds are DONE — **prove with one real test OTP at Step 6** (confirms the latest versions hold real values). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `PUSH_DRAIN_SECRET` (prod) | **MISSING ❌** | Only `*_STAGING` exist. **Created in Step 1** — must exist before the pipeline references them, or the deploy fails. |
| `FIXED_OTP` / `DEMO_MODE` | **Do NOT exist (by design) ✅** | Prod uses **real MSG91 only**; `NODE_ENV=production`. No demo/fixed-OTP bypass in prod. |

---

## How the prod pipeline actually works (must understand before Step 3)

`.github/workflows/deploy.yml` runs on **push to `main`** with these jobs in order:

1. **`test`** — runs api + platform suites (`needs`-gated; a RED suite means the deploy jobs never run → **silent skip**, no deploy. `workflow_dispatch` has a `skip_tests` emergency input — do **not** use it for this cutover).
2. **`approve`** — `environment: production`, a **required-reviewer gate**. The run **pauses** here until the **owner** approves in the GitHub UI.
3. **`deploy-api`** — builds + pushes `api:<sha>` and `api:latest`, then **runs DB migrations** via the in-VPC Cloud Run Job (`gifsy-migrate`, `npx prisma migrate deploy`, prod `DATABASE_URL` secret, `--vpc-connector gifsy-connector`, `--set-cloudsql-instances`, `--execute-now --wait`) — **before** the new revision serves; `--wait` **fails the deploy if a migration fails**. Then `gcloud run deploy gifsy-api --image …:<sha>`.
4. **`deploy-frontend`** — builds + pushes `frontend:<sha>`, deploys `gifsy-frontend`.
5. **`health-check`** — waits 15s, curls `<NEXT_PUBLIC_API_URL>/health` (**advisory only** — it logs a warning but does not fail the deploy).

> 🔑 **The pipeline migrates automatically.** Because `deploy-api` runs `migrate deploy` against prod with the
> merged image **before** the service rolls, **merging `develop`→`main` (Step 3) applies the 8 migrations on its
> own.** `migrate deploy` is **idempotent** and forward-only — it applies only the not-yet-applied migrations and
> no-ops on the rest. This runbook lets the pipeline migrate (no separate manual migrate step). If you ever need
> to migrate-first for extra control, see [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md) — but on an empty prod
> there is no reason to.

---

## Step 0 — Pre-flight  **[claude]**

**Goal:** prove the candidate is releasable and the source branch is frozen, so nothing changes mid-cutover.

**Do:**
1. **Full gate green — all 4 suites** (targeted gate ≠ CI; run the *full* suites, per the staging-deploy-gate rule).
   Expected current counts: **api jest 1259 · nest 0 · FE vitest 1687 · tsc 0**.
   ```bash
   cd api && npm test -- --forceExit --no-coverage          # API (NestJS + Jest) — expect 1259, 0 fail
   cd platform && npm test                                   # Frontend (Vitest) — expect 1687
   cd api && npx tsc -p tsconfig.build.json --noEmit         # api tsc — 0 errors
   cd platform && npx tsc --noEmit                           # FE tsc — 0 errors
   ```
2. **Confirm staging is serving the cutover candidate SHA** (staging auto-deploys from `develop`):
   ```bash
   git rev-parse develop
   gcloud run services describe gifsy-api-staging --region=asia-south1 \
     --project=gifsy-platform --format='value(spec.template.spec.containers[0].image)'
   ```
   The `staging-<sha>` in the image must match `git rev-parse develop`.
3. **Confirm the 8-migration delta** (the `main`-missing migrations are exactly the 8 in Step 3's table):
   ```bash
   git fetch origin
   git diff --name-only origin/main origin/develop -- api/prisma/migrations | grep migration.sql
   git rev-list --count origin/main..origin/develop    # expect ~209
   ```
4. **Confirm prod PWA secrets created** (Step 1 done) — the 3 prod secrets exist:
   ```bash
   gcloud secrets list --project=gifsy-platform \
     --filter="name~VAPID_PUBLIC_KEY OR name~VAPID_PRIVATE_KEY OR name~PUSH_DRAIN_SECRET"
   # expect the non-staging-suffixed prod names present (see Step 1)
   ```
5. **Freeze `develop`** — announce: **no new merges to `develop` until cutover completes.** A merge mid-cutover
   changes the SHA the pipeline builds and de-syncs staging from what you verified.

**Verify:** 4 suites green · staging image SHA == `develop` HEAD · 8-migration delta confirmed · 209-commit delta ·
prod PWA secrets exist · freeze announced.

**Rollback:** none — nothing changed. If a suite is red, **stop**: fix on `develop`, re-verify on staging, restart
Step 0 (a red suite would silently skip the prod deploy anyway).

---

## Step 1 — Create the prod PWA secrets (one-time)  **[owner-go / claude-run]**

**Goal:** create the 3 missing prod PWA secrets **before** the pipeline references them, and land the prod-PWA
wiring on `main` at cutover — otherwise the deploy's secret refs fail.

> **⚠️ Ordering dependency (critical):** the prod-PWA pipeline wiring (the env vars + secret refs +
> `push-drain-prod` scheduler) lives on the **`prep/prod-pwa-activation`** branch. Both of these must be true
> **before** the prod deploy runs:
> 1. the 3 prod secrets below **exist** (this step), and
> 2. `prep/prod-pwa-activation` is **merged into `develop`** so it flows to `main` at Step 3 (or is otherwise
>    included in the cutover merge).
>
> If the wiring reaches `main` but the secrets are absent, the `gcloud run deploy` fails resolving secret refs.
> So: **create secrets first (this step) → ensure the branch is in the merge → then Step 3.** The exact
> deploy.yml diff (frontend build-args + api env/secret refs + scheduler) is in that branch's description —
> reference it; do not hand-edit deploy.yml here.

**Do** (on the owner's go):
1. **Generate a VAPID keypair** (single platform-wide pair) and store both halves as prod secrets — without
   printing the private key to logs:
   ```bash
   # generate a web-push VAPID keypair (e.g. `npx web-push generate-vapid-keys`), capture pub/priv into vars,
   # then create the secrets from the captured values:
   printf '%s' "$VAPID_PUBLIC"  | gcloud secrets create VAPID_PUBLIC_KEY  \
     --project gifsy-platform --replication-policy=automatic --data-file=-
   printf '%s' "$VAPID_PRIVATE" | gcloud secrets create VAPID_PRIVATE_KEY \
     --project gifsy-platform --replication-policy=automatic --data-file=-
   ```
2. **Create the drain secret:**
   ```bash
   printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create PUSH_DRAIN_SECRET \
     --project gifsy-platform --replication-policy=automatic --data-file=-
   ```
3. **Grant the api service account accessor** on each of the 3:
   ```bash
   for S in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY PUSH_DRAIN_SECRET; do
     gcloud secrets add-iam-policy-binding "$S" --project gifsy-platform \
       --member="serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com" \
       --role=roles/secretmanager.secretAccessor
   done
   ```
4. **Ensure `prep/prod-pwa-activation` is merged into `develop`** (so the prod env/secret refs + the
   `push-drain-prod` scheduler definition flow to `main` at Step 3). The scheduler job itself is created
   post-deploy in Step 7.

> Note: confirm the exact **secret names** the `prep/prod-pwa-activation` deploy.yml references (prod refs may be
> `VAPID_PUBLIC_KEY:latest` etc. — plain prod names, **not** `*_STAGING`). The names you create here must match
> the refs on that branch exactly.

> Note (WhatsApp KYC): the prod api env should also set **`MSG91_WHATSAPP_NUMBER=917003202293`** for the Deoleo
> WhatsApp KYC notifications. This **defaults to that value in code**, so it's belt-and-suspenders / explicit-is-better,
> not strictly required.

**Verify:** the 3 secrets list (Step 0.4) · the api SA has accessor on each · `prep/prod-pwa-activation` is in
`develop`.

**Rollback:** secrets are additive — if unused they cost nothing. To undo: `gcloud secrets delete <name>`.

---

## Step 2 — Backup the PROD database (double-guarded)  **[owner-go / claude-run]**

**Goal:** a labelled restore point taken immediately before any schema change. Backups + PITR are **already ON**
on `gifsy-db`, and prod is **empty**, so this is a **formality** — do it anyway for a clean labelled point.

> ⚠️ `gifsy-db` is **shared** between staging and prod. Confirm you're pointed at **`gifsy_prod`** before anything.
> The instance is private-IP — the confirm query runs from inside the VPC (the path the migrate job uses).

**Do** (on the owner's go):
1. **Confirm the prod DB name first** (read-only, via the in-VPC path with the prod `DATABASE_URL` secret):
   ```sql
   SELECT current_database();   -- MUST return: gifsy_prod   (abort if it says gifsy_staging)
   ```
   Mirror the canonical guard (`IF current_database() <> 'gifsy_prod' THEN RAISE EXCEPTION …`) used across
   `api/prisma/migrations-manual/*.sql` and `seed.ts` for any ad-hoc SQL.
2. **Take the on-demand backup of the shared instance** and note the timestamp:
   ```bash
   gcloud sql backups create --instance=gifsy-db --project=gifsy-platform \
     --description="pre-cutover $(date -u +%FT%TZ) develop->main"
   gcloud sql backups list --instance=gifsy-db --project=gifsy-platform --limit=3   # record the backup id
   ```
   > A Cloud SQL backup is **instance-level** (covers `gifsy_staging` too). Fine — restore is selective via
   > PITR/clone. The `current_database()` check is what proves which DB the migrations will hit.

**Verify:** `current_database()` returned `gifsy_prod`; backup id + UTC timestamp recorded; PITR remains ENABLED.

**Rollback:** none (read + backup only). If `current_database()` is **not** `gifsy_prod`, **STOP** — fix the
`DATABASE_URL` before going further.

---

## Step 3 — Merge `develop` → `main` (triggers the prod pipeline)  **[owner]**

**Goal:** ship the candidate. The push to `main` runs `deploy.yml`: tests → **approval gate** →
build+migrate(8)+deploy `gifsy-api` → build+deploy `gifsy-frontend` → advisory health-check. The two **existing**
prod services get a new revision tagged the **new `main` SHA**.

**The 8 migrations applied by the pipeline (all additive / lightweight — none destructive, none a backfill):**
| Migration | What it does | Weight |
|---|---|---|
| `20260621000000_uat_hardening_constraints` | CREATE partial UNIQUE indexes (credit reversal, TDS dedup) | Index builds on empty tables → trivial. |
| `20260621120000_go_live_fix_constraints` | DROP stale coarse TDS indexes (`IF EXISTS`); CREATE 1 partial unique (one payout per order) | Idempotent drops; light. |
| `20260621130000_credit_entry_reversed_status` | `ALTER TYPE "CreditEntryStatus" ADD VALUE IF NOT EXISTS 'REVERSED'` | **Enum add** — only statement in its file → Prisma runs it non-transactionally; safe on PG 12+, no table rewrite. |
| `20260622120000_kpi_one_primary_per_client` | Self-healing `UPDATE kpi_defs` (demote dup primaries) + CREATE partial unique | UPDATE is a no-op on empty/clean data; light. |
| `20260623120000_redemption_order_conversion_rate_centi` | ADD nullable `conversionRateCenti` column on `redemption_orders` | Additive nullable column — instant, no backfill. |
| `20260627120000_add_push_subscription` | CREATE `push_subscription` table + indexes + FK to `users` | Brand-new table — fully additive. |
| `20260629120000_add_pwa_install` | CREATE `pwa_install` table (adoption tracking) | Brand-new table — fully additive. |
| `20260630120000_add_user_activity_day` | CREATE `user_activity_day` table | Brand-new table — fully additive. |

**Do** (owner-driven):
```bash
git fetch origin
git checkout main
git merge --ff-only origin/develop     # prefer fast-forward; the 2026-06-20 cutover merged ff-only
# if ff-only is refused (main has commits develop lacks), use a deliberate merge commit:
#   git merge --no-ff origin/develop
git push origin main
```
Then in the **GitHub Actions UI**:
1. Watch the `test` job go green (if red → the deploy silently skips; fix on `develop`, re-verify staging, retry).
2. **[owner] Approve the `production` environment gate** (required reviewer) when the run pauses at `approve`.
3. Watch `deploy-api` → its **"Run DB migrations (production)"** step apply the 8 migrations → `gcloud run deploy`.
4. Watch `deploy-frontend` succeed.

**Verify:**
- Both deploy jobs succeeded; the migrate step inside `deploy-api` succeeded (`--wait`).
- New serving image SHA == merged `main` HEAD:
  ```bash
  git rev-parse main
  gcloud run services describe gifsy-api      --region=asia-south1 --project=gifsy-platform \
    --format='value(spec.template.spec.containers[0].image)'
  gcloud run services describe gifsy-frontend --region=asia-south1 --project=gifsy-platform \
    --format='value(spec.template.spec.containers[0].image)'
  ```
- (Optional) `_prisma_migrations` now ends with baseline + the 8 above (read-only, in-VPC, prod `DATABASE_URL`):
  ```sql
  SELECT current_database();  -- gifsy_prod
  SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 10;
  ```

**Rollback:** see the Rollback note below. If the run failed **before** `deploy-api` rolled the new revision
(tests red or unapproved gate), prod is untouched — no rollback needed; just don't approve / re-run.

---

## Step 4 — Bootstrap (first GIFSY_ADMIN + OutletType master rows)  **[owner-go / claude-run]**

**Goal:** insert the two seed-only rows that have **no app/API path** — the first `GIFSY_ADMIN` user and the 4
`OutletType` master rows — so the Step 5 client-creation + uploads can proceed. Idempotent, additive,
double-guarded. (Full rationale: [`PROD-DATA-LOAD.md` §0a](PROD-DATA-LOAD.md).)

> **Sequencing:** `prisma/bootstrap.js` only exists in images built from the cutover commit onward, so this runs
> **after** Step 3's deploy built the new prod `api` image. Mirrors exactly how `gifsy-migrate` runs.

**Do** (on the owner's go; `<SHA>` = the deployed `main` SHA from Step 3):
```bash
gcloud run jobs deploy gifsy-bootstrap \
  --image=asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:<SHA> \
  --region=asia-south1 \
  --command=node --args=prisma/bootstrap.js \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest \
  --set-env-vars=BOOTSTRAP_CONFIRM=gifsy_prod,GIFSY_ADMIN_NAME=Nikunj,GIFSY_ADMIN_PHONE=9830011252 \
  --vpc-connector=gifsy-connector \
  --set-cloudsql-instances=gifsy-platform:asia-south1:gifsy-db \
  --service-account=gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com \
  --execute-now --wait
```
The job logs `current_database()` and **refuses unless `BOOTSTRAP_CONFIRM` matches it** (shared instance guard).
Re-running is a safe no-op (already-present rows are skipped).

**Verify:** job exit 0; `GIFSY_ADMIN` (clientId `gifsy`, phone `9830011252`) can OTP-login to prod; after Step 5
creates the tenant, `GET /v1/admin/credits/outlet-types` returns the 4 codes (`WHOLESALER`, `SSS`, `SSS_TOT`,
`SUB_STOCKIST`).

**Rollback:** additive only — nothing to undo. If the guard refused (wrong DB), fix `BOOTSTRAP_CONFIRM` /
`DATABASE_URL` and re-run.

---

## Step 5 — Provision + load Deoleo data via the tested app UIs  **[owner / operator]**

**Goal:** create the Deoleo tenant and load its master data through the **same app screens UAT used** (the Prisma
seed is firewalled OFF in prod). This is the real-PII step — the **owner green-lights** it and an operator drives
it. Full per-method detail (endpoints, DTOs, file formats, gotchas): [`PROD-DATA-LOAD.md`](PROD-DATA-LOAD.md).

**Do** (owner-driven, in order — each needs the prior):
1. **Create the Deoleo client** — GIFSY_ADMIN logs into prod (real OTP) → Gifsy operator console create-client
   wizard. **`slug` MUST be `deoleo`** to match the deployed code-registry domain/branding (`deoleoloyalty.gifsy.in`).
   Side effect: auto-provisions `OutletTypeClientConfig` for every OutletType **and** is the prerequisite for the
   Deoleo CLIENT_ADMIN. (`POST /v1/gifsy/clients`; [`PROD-DATA-LOAD.md` §1](PROD-DATA-LOAD.md).)
2. **Create the first Deoleo CLIENT_ADMIN** — GIFSY_ADMIN, in Deoleo context (`POST /v1/admin/users`;
   [`PROD-DATA-LOAD.md` §2](PROD-DATA-LOAD.md)).
3. **Set Deoleo launch config in Gifsy Settings** — **before** the uploads:
   **conversion rate**, **POINTS_TO_INR_RATE**, **program/category lists**, **credit-field award maps**, and
   **visibility OFF** (Deoleo launches OFF). Full checklist: [`DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md`](DEOLEO-GO-LIVE-CONFIG-CHECKLIST.md)
   + [`PROD-DATA-LOAD.md` §3](PROD-DATA-LOAD.md).
4. **Load master data via the same UAT upload screens, in order:**
   1. **Outlet master** → `POST /v1/admin/outlets/upsert` (≤500/batch, FE auto-chunks).
   2. **Sales hierarchy** → `PUT /v1/admin/hierarchy-config` (one snapshot).
   3. **Reward catalog**.
   4. **Schemes**.
   (Detailed mechanics + verify per upload: [`PROD-DATA-LOAD.md` §4–§6](PROD-DATA-LOAD.md).)

**Verify:** tenant resolves (`GET /v1/gifsy/clients/deoleo`); the 4 outlet-types enabled; CLIENT_ADMIN can log in;
hierarchy snapshot returns + a sales user sees their downline; outlet list populated; reward catalog + schemes
present; visibility shows OFF.

**Rollback:** owner-driven. Newly created tenant/rows can be removed via the app/admin paths; the DB backup
(Step 2) is the floor. Because prod was empty, a clean re-load is straightforward.

---

## Step 6 — Smoke PROD  **[owner + claude]**

**Goal:** confirm prod is healthy and real users can log in and complete an end-to-end flow on the branded domain.

**Do / Verify:**
1. **API health = 200:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://api.gifsy.in/health    # expect 200
   ```
2. **Serving SHA matches** the merged `main` (re-confirm Step 3's `gcloud run services describe` == `git rev-parse main`).
3. **Real-OTP login per role on the branded domain** — prod uses **real MSG91 OTP** (NO `FIXED_OTP`). Deoleo prod
   domain = **`https://deoleoloyalty.gifsy.in`**; GIFSY operator on the platform host. Cover:
   - GIFSY operator (cross-tenant)
   - CLIENT_ADMIN (Deoleo admin) — whole tenant
   - a sales role (ISR/SO/XSR)
   - a partner — only their own wallet/redemptions

   For each: login → right role home → a real scoped read renders **real** data (no fabricated `8,550`/
   `Rajesh Kumar` values) → logout clears the session.
4. **One end-to-end money path:** a real **KYC → approval → wallet credit → redemption** completes.
5. **Real OTP delivered (proves MSG91 live values):** confirm at least one of the logins above received a **real
   SMS OTP** — this is the proof the latest MSG91 secret versions hold the real DLT credentials.
6. **Monitoring fires:** confirm the GCP alerts deliver (the 2 alert-email links must have been verified — owner
   prereq); trigger/observe at least one alert path.

**Rollback:** if smoke fails (health non-200, login broken, fabricated data, wrong SHA, OTP not delivered) → see
the Rollback note below.

---

## Step 7 — Activate / verify prod PWA  **[claude]**

**Goal:** confirm push delivery works in prod (the staging wiring is already device-verified; this replicates it).
Canonical build detail: [`../PWA-PLAN.md`](../PWA-PLAN.md).

**Pre-reqs already done:** Step 1 created the 3 prod secrets; `prep/prod-pwa-activation` brought the prod
build-args + api env/secret refs to `main` at Step 3; the `pwa_install` migration applied at Step 3.

**Do:**
1. **Create the prod scheduler job** (drives delivery — see the TRAP below):
   ```bash
   API_PROD=https://api.gifsy.in
   SECRET=$(gcloud secrets versions access latest --secret=PUSH_DRAIN_SECRET --project gifsy-platform)
   gcloud scheduler jobs create http push-drain-prod \
     --location asia-south1 --project gifsy-platform \
     --schedule "* * * * *" \
     --uri "$API_PROD/v1/push/drain" --http-method POST \
     --headers "x-drain-secret=$SECRET" --message-body '{}' --attempt-deadline 30s
   ```
2. **Drain endpoint smoke:** `POST $API_PROD/v1/push/drain` with **no** header → **403** (fail-closed); with the
   secret header → **201**.
3. **One real push reaches a device** — confirm `push-drain-prod` ticks and a notification is delivered.

> 🔑 **TRAP:** Cloud Run `min-instances=1` alone does **NOT** keep background `@Interval` workers ticking — CPU is
> throttled between requests. The **scheduler** (step 1) is what drives delivery.

**Verify:** scheduler job exists + ticking; 403/201 behaviour correct; a device received a real push.

**Rollback:** delete the scheduler job (`gcloud scheduler jobs delete push-drain-prod --location asia-south1`);
PWA is additive and flag-gated.

---

## Rollback note (low risk — empty prod, additive migrations)

Because prod was **empty** and the 8 migrations are **additive**, rollback is simple and a full DB restore is
almost never needed:

- **Code rollback (the normal path):** redeploy both services to the **prior Cloud Run revision** (no rebuild):
  ```bash
  gcloud run revisions list --service=gifsy-api      --region=asia-south1 --project=gifsy-platform
  gcloud run services update-traffic gifsy-api      --region=asia-south1 --to-revisions=<prev-revision>=100
  gcloud run services update-traffic gifsy-frontend --region=asia-south1 --to-revisions=<prev-revision>=100
  ```
  The older code runs fine against the migrated schema — extra columns/tables/indexes/enum values it doesn't use
  are harmless. **No down-migration is needed** on an empty DB.
- **DB rollback (rarely):** migrations are **forward-only — no down-migration.** Only if a migration corrupted
  data would you restore from the Step 2 backup / PITR. Because `gifsy-db` is **shared with staging**, do **not**
  do a blind in-place restore (it would revert `gifsy_staging`): **PITR-clone** to a new instance, validate
  `gifsy_prod` on the clone, then repoint the prod `DATABASE_URL`. Owner-driven.
  ```bash
  gcloud sql backups list --instance=gifsy-db --project=gifsy-platform
  gcloud sql instances clone gifsy-db gifsy-db-cutover-restore \
    --point-in-time=<UTC_TS_BEFORE_STEP_3> --project=gifsy-platform
  ```

---

## Done-criteria (all must be true)
- [ ] **Owner prereqs:** MSG91 done · data files ready · 2 GCP alert-email links verified · owner ready to approve the gate.
- [ ] **Step 0 [claude]:** 4 suites green (1259/0/1687/0) · staging SHA == `develop` HEAD · 8-migration + 209-commit delta confirmed · prod PWA secrets exist · `develop` frozen.
- [ ] **Step 1 [owner-go/claude]:** 3 prod PWA secrets created + SA accessor granted · `prep/prod-pwa-activation` in `develop`.
- [ ] **Step 2 [owner-go/claude]:** `current_database()='gifsy_prod'` confirmed · backup id + UTC timestamp logged.
- [ ] **Step 3 [owner]:** `main` updated · `production` gate approved by owner · both deploy jobs green · 8 migrations applied · serving SHA == `main` HEAD.
- [ ] **Step 4 [owner-go/claude]:** bootstrap job exit 0 · GIFSY_ADMIN logs in · 4 OutletTypes present.
- [ ] **Step 5 [owner/operator]:** Deoleo client (`slug=deoleo`) + CLIENT_ADMIN created · launch config set (visibility OFF) · outlet/hierarchy/catalog/schemes loaded.
- [ ] **Step 6 [owner+claude]:** `/health` 200 · real-OTP role-matrix login on branded domain · end-to-end KYC→redemption · real OTP delivered (MSG91 proven) · monitoring fires · no fabricated data · SHA matches.
- [ ] **Step 7 [claude]:** `push-drain-prod` scheduler ticking · 403/201 drain behaviour · one real push to a device.
- [ ] Rollback path understood (prior revision redeploy; additive migrations → no down-migration on empty DB).
