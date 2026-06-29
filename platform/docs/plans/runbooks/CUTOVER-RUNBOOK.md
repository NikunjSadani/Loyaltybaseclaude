# Runbook — Production Cutover (`develop` → `main` = prod deploy)

> **Strictly sequential.** Each step gates the next — cutover is **not parallelizable**. Do not start
> a step until the prior step's verification passed. For each step: **Goal · Command(s) · Verify · Rollback.**
>
> Companions: [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md) (migration mechanics) ·
> [`PROD-CUTOVER-RECORD.md`](PROD-CUTOVER-RECORD.md) (the 2026-06-20 cutover, as-run) ·
> [`../MIGRATIONS.md`](../MIGRATIONS.md) (the migration model) · [`../ENVIRONMENTS.md`](../ENVIRONMENTS.md).
>
> Authored 2026-06-29 from the live infra recon below. Verify any drifted fact against the repo /
> `gcloud` before executing.

---

## ⚠️ Reality check — read this first (corrects stale docs)

**Prod is ALREADY LIVE. This cutover is an UPDATE of running production, not a first-ever deploy.**

Older notes (memory, parts of `GO-LIVE-READINESS.md`/`MIGRATIONS.md`) said *"no prod services → the first
`main` merge is the first prod deploy."* That was wrong — it searched for `-prod`-suffixed service names
and missed the **unsuffixed** prod services. Verified live (gcloud recon, 2026-06-29):

- Cloud Run services **`gifsy-api`** and **`gifsy-frontend`** (region `asia-south1`, project `gifsy-platform`)
  are **serving image tag `b3ab2e0`** = current `main` HEAD (2026-06-21). Prod is up and serving.
- So merging `develop`→`main` **updates the revision** of two existing, running services. It does **not**
  create them. The rollback in Step 5 is "redeploy the prior image", not "tear down a first deploy".
- The DB (`gifsy_prod`) was **already reconciled to the squashed baseline** at the 2026-06-20 cutover
  (`_prisma_migrations` = 1 row: `00000000000000_baseline`). The **P3005 baseline-reconcile is DONE** —
  the older `PROD-DB-MIGRATION.md` Step 1.5 / `MIGRATIONS.md` reconcile sections describe a one-time event
  that **already happened** and is **not** repeated here. This cutover applies **6 ordinary forward
  migrations** on top of that baseline.

### Risk list (what makes this cutover non-routine)
| Risk | Why it matters | Mitigation in this runbook |
|---|---|---|
| **185-commit jump** `main`→`develop` | Large surface; `main` HEAD is `b3ab2e0` (2026-06-21), 185 commits stale. Many UAT fixes land at once. | Full gate green (Step 0); staging is already serving this exact candidate; smoke every role (Step 4); fast rollback to `b3ab2e0` (Step 5). |
| **6 migrations applied at once** | More schema change in one shot than a normal deploy. | All 6 are **additive / lightweight** (see Step 2 table) — no DROP TABLE/COLUMN, no destructive type change, no large backfill. Backup first (Step 1); `--wait` fails the deploy if any migration errors (broken-schema code never serves). |
| **Shared Cloud SQL instance** `gifsy-db` (staging + prod) | A mis-targeted command could hit `gifsy_staging` instead of `gifsy_prod`, or vice-versa. | Every DB op is **double-guarded** by asserting `current_database()='gifsy_prod'` before acting (Steps 1, 2). Prod uses secret `DATABASE_URL`; staging uses `DATABASE_URL_STAGING`. |
| **GitHub "production" approval gate** | The `main` pipeline **pauses** at a required-reviewer gate between tests and deploy. | Expected — Step 3 includes approving the gate. If unapproved, nothing deploys (safe). |

---

## How the prod pipeline actually works (must understand before Step 2/3)

`.github/workflows/deploy.yml` runs on **push to `main`** with these jobs in order:

1. **`test`** — runs api + platform suites (`needs`-gated; a RED suite means the deploy jobs never run → **silent skip**, no deploy. `workflow_dispatch` has a `skip_tests` emergency input — do **not** use it for this cutover).
2. **`approve`** — `environment: production`, a **required-reviewer gate**. The run **pauses** here until a reviewer approves in the GitHub UI.
3. **`deploy-api`** — builds + pushes `api:<sha>` and `api:latest`, then **runs DB migrations** via the in-VPC Cloud Run Job (`gifsy-migrate`, `npx prisma migrate deploy`, prod `DATABASE_URL` secret, `--vpc-connector gifsy-connector`, `--set-cloudsql-instances`, `--execute-now --wait`) — **before** the new revision serves; `--wait` **fails the deploy if a migration fails**. Then `gcloud run deploy gifsy-api --image …:<sha>`.
4. **`deploy-frontend`** — builds + pushes `frontend:<sha>`, deploys `gifsy-frontend`.
5. **`health-check`** — waits 15s, curls `<NEXT_PUBLIC_API_URL>/health` (**advisory only** — it logs a warning but does not fail the deploy).

### 🔑 The pipeline migrates automatically — so Step 2 is OPTIONAL / belt-and-suspenders
Because `deploy-api` **already runs `migrate deploy`** against prod with the merged image before the
service rolls, **merging `develop`→`main` (Step 3) applies the 6 migrations on its own.** `migrate deploy`
is **idempotent** and forward-only: it applies only the migrations not yet in `_prisma_migrations` and
no-ops on the rest.

**Two valid orderings — pick one and follow it exactly:**

- **Ordering A (recommended — let the pipeline do it):** do Step 0 → Step 1 (backup) → **skip Step 2** →
  Step 3 (merge; the pipeline migrates then deploys, gated by `--wait`) → Step 4 → Step 5. Simplest, fewest
  manual DB touches, and the migration + the matching code go live atomically.
- **Ordering B (migrate-first, for extra control):** do Step 0 → Step 1 → **Step 2 (manually run the
  `gifsy-migrate` job)** → verify `_prisma_migrations` → Step 3 (merge; the pipeline's migrate step then
  finds nothing to do and no-ops) → Step 4 → Step 5. Use this only if you want the DB migrated and verified
  **before** committing to the merge/deploy.

Whichever you pick, the migrations land exactly once. **Do not** run Step 2 manually AND expect a different
result from the pipeline's migrate step — they target the same DB with the same idempotent command.

---

## Step 0 — Pre-flight (gate green · staging on the candidate · freeze develop)

**Goal:** prove the candidate is releasable and freeze the source branch so nothing new sneaks in mid-cutover.

**Do:**
1. **Full gate green — all 4 suites** (targeted gate ≠ CI; run the *full* suites, per the staging-deploy-gate rule):
   ```bash
   # API (NestJS + Jest)
   cd api && npm test -- --forceExit --no-coverage
   # Frontend (Vitest)
   cd platform && npm test
   # tsc on both
   cd api && npx tsc -p tsconfig.build.json --noEmit
   cd platform && npx tsc --noEmit
   ```
   (E2E Playwright `platform/e2e` `npm run e2e` if running it locally is part of your gate.)
2. **Confirm staging is serving the cutover candidate SHA** — staging auto-deploys from `develop`, so the
   `develop` HEAD you are about to merge should already be live + UAT'd on staging:
   ```bash
   # develop HEAD = the candidate
   git rev-parse develop
   # staging serving SHA (image tag is staging-<sha>)
   gcloud run services describe gifsy-api-staging --region=asia-south1 \
     --project=gifsy-platform --format='value(spec.template.spec.containers[0].image)'
   ```
   The `staging-<sha>` in the image must match `git rev-parse develop`.
3. **Freeze `develop`** — announce to the team: **no new merges to `develop` until cutover completes.**
   (Optionally protect the branch in GitHub Settings for the window.) A merge mid-cutover changes the SHA the
   pipeline builds and de-syncs staging from what you verified.

**Verify:** 4 suites green · staging image SHA == `develop` HEAD · freeze announced/acknowledged.

**Rollback:** none needed — nothing has changed. If a suite is red, **stop**: fix on `develop`, re-verify on
staging, restart Step 0. A red suite would silently skip the prod deploy anyway.

---

## Step 1 — Backup the PROD database (double-guarded)

**Goal:** a clean, explicit restore point taken immediately before any schema change. Backups + PITR are
**already ON** on `gifsy-db`, so this on-demand backup is belt-and-suspenders + a labelled point to restore to.

> ⚠️ `gifsy-db` is **shared** between staging and prod. Confirm you are pointed at **`gifsy_prod`** before
> anything. The instance is private-IP — the confirm query runs from inside the VPC (Cloud Run Job / the
> Auth-Proxy path the migrate job uses), not from a laptop.

**Do:**
1. **Confirm the prod DB name first** (belt + braces — run this read-only check via the in-VPC path with the
   prod `DATABASE_URL` secret, exactly the connection the `gifsy-migrate` job uses):
   ```sql
   SELECT current_database();   -- MUST return: gifsy_prod   (abort if it says gifsy_staging)
   ```
   The canonical guard shape is the `IF current_database() <> 'gifsy_prod' THEN RAISE EXCEPTION …` block used
   across `api/prisma/migrations-manual/*.sql` and `seed.ts` — mirror it for any ad-hoc SQL.
2. **Take the on-demand backup of the shared instance** and note the timestamp:
   ```bash
   gcloud sql backups create \
     --instance=gifsy-db \
     --project=gifsy-platform \
     --description="pre-cutover $(date -u +%FT%TZ) develop->main"
   # then record the backup id:
   gcloud sql backups list --instance=gifsy-db --project=gifsy-platform --limit=3
   ```
   > Note: a Cloud SQL backup is **instance-level** (covers every DB on `gifsy-db`, incl. `gifsy_staging`).
   > That's fine — restore is selective via PITR/clone. The `current_database()` check above is what proves
   > you'll be *migrating* the right DB; the backup itself is whole-instance.

**Verify:** `current_database()` returned `gifsy_prod`; the new backup id + UTC timestamp recorded in the
cutover log. Confirm automated backups + PITR remain **ENABLED** on `gifsy-db`.

**Rollback:** none (read + backup only). If `current_database()` is **not** `gifsy_prod`, **STOP** — your
connection is mis-targeted; fix the `DATABASE_URL` before going further.

---

## Step 2 — (Ordering B only) Apply the 6 migrations to PROD via the in-VPC job

> **Skip this step entirely under Ordering A** — Step 3's pipeline applies the migrations. Do this step only
> if you chose Ordering B (migrate-first). It is idempotent either way.

**Goal:** bring `gifsy_prod`'s schema from the baseline up to current by applying the 6 forward migrations,
using the same mechanism the pipeline uses (so behaviour is identical).

**The 6 migrations (all additive / lightweight — none destructive, none a heavy backfill):**
| Migration | What it does | Lock/weight note |
|---|---|---|
| `20260621000000_uat_hardening_constraints` | CREATE 3 partial UNIQUE indexes (credit reversal, 2× TDS dedup) | Index builds on near-empty prod tables → trivial. |
| `20260621120000_go_live_fix_constraints` | DROP 2 stale coarse TDS indexes (`IF EXISTS`); CREATE 1 partial unique (one payout per order) | Idempotent drops; light. |
| `20260621130000_credit_entry_reversed_status` | `ALTER TYPE "CreditEntryStatus" ADD VALUE IF NOT EXISTS 'REVERSED'` | **Enum add** — must run **outside a transaction**; it is the **only** statement in its file, so Prisma runs it non-transactionally — safe on PG 12+. No table rewrite. |
| `20260622120000_kpi_one_primary_per_client` | Self-healing `UPDATE kpi_defs` (demote dup primaries) + CREATE partial unique | UPDATE is a no-op on a clean/empty tenant; light. |
| `20260623120000_redemption_order_conversion_rate_centi` | `ALTER TABLE redemption_orders ADD COLUMN conversionRateCenti INTEGER` (nullable) | Additive nullable column — instant, no rewrite, no backfill. |
| `20260627120000_add_push_subscription` | CREATE new `push_subscription` table + indexes + FK to `users` | Brand-new table — fully additive. |

**Do** (mirror the pipeline's prod migrate step exactly; SHA-pin to the image you are about to deploy):
```bash
gcloud run jobs deploy gifsy-migrate \
  --image=asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:<DEVELOP_HEAD_SHA> \
  --region=asia-south1 \
  --command=npx \
  --args=prisma,migrate,deploy \
  --set-secrets=DATABASE_URL=DATABASE_URL:latest \
  --vpc-connector=gifsy-connector \
  --set-cloudsql-instances=gifsy-platform:asia-south1:gifsy-db \
  --service-account=gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com \
  --execute-now --wait
```
> `<DEVELOP_HEAD_SHA>` = the SHA whose image you'll deploy. If that image isn't in Artifact Registry yet
> (it's built by the pipeline on merge), prefer **Ordering A** and let the pipeline migrate — Ordering B only
> makes sense if a SHA-pinned `api:<sha>` image already exists for the candidate.

**Verify:**
- The job's `migrate deploy` output lists the migrations it applied and ends successfully (`--wait` returns 0).
  `migrate deploy` reports *"The following migrations have been applied"* with the 6 names (or *"No pending
  migrations"* if already applied).
- Confirm `_prisma_migrations` now ends with all 6 (read-only, in-VPC, prod `DATABASE_URL`):
  ```sql
  SELECT current_database();  -- gifsy_prod
  SELECT migration_name, finished_at
  FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 8;
  -- expect: baseline + the 6 above, all with a finished_at
  ```

**Rollback:** migrations are **forward-only** — there is no in-place down-migration. If a migration errored,
`--wait` fails and **no code deploys**. Roll back the DB via the Step 1 backup / PITR (see Step 5). All 6 are
additive, so the realistic failure mode is a transient connectivity error, not data loss — re-run the job
(idempotent) after fixing it.

---

## Step 3 — Merge `develop` → `main` (triggers the prod pipeline)

**Goal:** ship the candidate. The push to `main` runs `deploy.yml`: tests → **approval gate** →
build+migrate+deploy `gifsy-api` → build+deploy `gifsy-frontend` → advisory health-check. The two **existing**
prod services get a new revision; their image tag becomes the **new `main` SHA**.

**Do:**
```bash
# from a clean checkout, develop frozen (Step 0)
git fetch origin
git checkout main
git merge --ff-only origin/develop     # prefer fast-forward; the 2026-06-20 cutover merged ff-only
# if ff-only is refused (main has commits develop lacks), use a real merge commit deliberately:
#   git merge --no-ff origin/develop
git push origin main
```
Then in the **GitHub Actions UI**:
1. Watch the `test` job go green (if red → the deploy silently skips; fix on `develop`, re-verify staging, retry).
2. **Approve the `production` environment gate** (required reviewer) when the run pauses at `approve`.
3. Watch `deploy-api` → its **"Run DB migrations (production)"** step (this is the pipeline applying the 6
   migrations; under Ordering A this is where they land; under Ordering B it no-ops) → `gcloud run deploy`.
4. Watch `deploy-frontend` succeed.

**Verify:**
- Both deploy jobs succeeded; the migrate step inside `deploy-api` succeeded (`--wait`).
- New serving image SHA == the merged `main` HEAD:
  ```bash
  git rev-parse main
  gcloud run services describe gifsy-api --region=asia-south1 --project=gifsy-platform \
    --format='value(spec.template.spec.containers[0].image)'
  gcloud run services describe gifsy-frontend --region=asia-south1 --project=gifsy-platform \
    --format='value(spec.template.spec.containers[0].image)'
  # image tags should be api:<main-sha> / frontend:<main-sha>, matching git rev-parse main
  ```

**Rollback:** see Step 5 (redeploy `b3ab2e0`). If the run failed **before** `deploy-api` rolled the new
revision (e.g. at tests or unapproved gate), prod is untouched — no rollback needed; just don't approve / re-run.

---

## Step 4 — Smoke PROD

**Goal:** confirm prod is healthy and real users can actually log in and use it on the prod domain.

**Do / Verify:**
1. **API health = 200:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://api.gifsy.in/health    # expect 200
   ```
2. **Serving SHA matches** the merged `main` (re-confirm the Step 3 `gcloud run services describe` output ==
   `git rev-parse main`).
3. **One real login per role on the PROD domain** — prod uses **real MSG91 OTP** (NO `FIXED_OTP`), so use a
   real phone per role. Deoleo prod domain = **`https://deoleoloyalty.gifsy.in`**; GIFSY operator on
   `https://gifsy.in` (or the configured platform host). Cover the role matrix that exists in prod data:
   - GIFSY operator (cross-tenant)
   - CLIENT_ADMIN (Deoleo admin) — sees the whole tenant
   - a sales role (ISR/SO/XSR per hierarchy)
   - a partner — sees only their own wallet/redemptions

   For each: login → land on the right role home → one real scoped read renders **real** data (no fabricated
   `8,550`/`Rajesh Kumar`-style values) → logout clears the session.
   > ⚠️ If prod has not yet had the **real Deoleo master-data load** (#76 in `GO-LIVE-READINESS.md` /
   > `PROD-CUTOVER-RECORD.md`), real users **cannot** log in (0 users by design). In that case Step 4's login
   > matrix runs **after** the data load — confirm with the owner whether data is loaded before asserting login.
4. **Quick routing sanity:** `https://deoleoloyalty.gifsy.in/auth/login` → 200; an unauthenticated API call
   returns an honest 4xx from the backend (proves FE→backend routing + `NEXT_PUBLIC_API_URL`), as in the
   2026-06-20 record.

**Rollback:** if smoke fails (health non-200, login broken, fabricated data, wrong SHA) → go to Step 5.

---

## Step 5 — Rollback plan

**Goal:** restore prod fast if Step 3/4 went bad. Two independent rollbacks — **code** and **DB** — because
migrations are forward-only.

### 5a. Code rollback — redeploy the prior image `b3ab2e0`
The previous good prod image (current `main` before this cutover) is tag `b3ab2e0`, already in Artifact
Registry. Redeploy both services to it (no rebuild needed):
```bash
gcloud run deploy gifsy-api --region=asia-south1 --project=gifsy-platform \
  --image=asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/api:b3ab2e0
gcloud run deploy gifsy-frontend --region=asia-south1 --project=gifsy-platform \
  --image=asia-south1-docker.pkg.dev/gifsy-platform/gifsy-images/frontend:b3ab2e0
```
> Alternatively roll back to the prior **revision** without touching images:
> `gcloud run services update-traffic gifsy-api --region=asia-south1 --to-revisions=<prev-revision>=100`
> (find it via `gcloud run revisions list --service=gifsy-api --region=asia-south1`).

**Caveat — code/schema skew:** the 6 migrations are **additive**, so `b3ab2e0` (the older code) runs fine
against the **migrated** schema — extra columns/tables/indexes/enum values it doesn't use are harmless. So in
practice **code-only rollback is sufficient** for a bad app deploy, and you do **not** need to also roll back
the DB unless a migration itself corrupted data.

### 5b. DB rollback — restore from backup / PITR (only if a migration went bad)
Migrations are **forward-only — there is no down-migration.** If a migration corrupted data, restore the
`gifsy_prod` data to just before Step 2/3 using the Step 1 backup or PITR:
```bash
# list backups taken in Step 1
gcloud sql backups list --instance=gifsy-db --project=gifsy-platform
# PITR (clone to a point in time just before the cutover), then cut over to the clone, OR
# restore the on-demand backup. Because gifsy-db is SHARED, prefer a PITR CLONE to a new
# instance and validate gifsy_prod there before repointing DATABASE_URL — a full in-place
# restore would also roll back gifsy_staging.
gcloud sql instances clone gifsy-db gifsy-db-cutover-restore \
  --point-in-time=<UTC_TS_BEFORE_STEP_2> --project=gifsy-platform
```
> ⚠️ Because the instance is **shared with staging**, do **not** do a blind in-place restore of `gifsy-db`
> (it would revert staging too). Clone to a point-in-time, validate `gifsy_prod` on the clone, then repoint
> the prod `DATABASE_URL` secret at the restored DB. Owner-driven; coordinate before executing.

**Verify after rollback:** `/health` 200 on the restored stack; serving SHA == `b3ab2e0` (5a); a role login
works; `_prisma_migrations` reflects the intended state.

---

## PWA / Notifications — prod activation (cutover-coupled)

> The full PWA round (sales push notifications, scheduler-driven delivery, adoption tracking, install UX) is
> DONE + device-verified on **staging only**. Prod activation replicates the staging wiring. **If this section
> is skipped, sales/partner notifications sit undelivered in prod** (the worker won't tick on idle Cloud Run).
> Do this at/after cutover. Canonical build detail: [`../PWA-PLAN.md`](../PWA-PLAN.md).

**(a) Mirror the staging PWA wiring onto the prod pipeline** — in `.github/workflows/deploy.yml`, copy
`deploy-staging.yml`'s PWA wiring:
- Frontend build-args: `NEXT_PUBLIC_PWA_SW_ENABLED=true`, `NEXT_PUBLIC_PWA_INSTALL_ENABLED=true`,
  `NEXT_PUBLIC_PWA_PUSH_ENABLED=true`.
- On the api deploy, add env `PUSH_WORKER_ENABLED=true,VAPID_SUBJECT=mailto:ops@gifsy.in` and secrets
  `VAPID_PUBLIC_KEY=VAPID_PUBLIC_KEY_PROD:latest,VAPID_PRIVATE_KEY=VAPID_PRIVATE_KEY_PROD:latest,PUSH_DRAIN_SECRET=PUSH_DRAIN_SECRET_PROD:latest`.

**(b) Create the prod secrets first (one-time):**
- Generate a VAPID prod keypair → store as `VAPID_PUBLIC_KEY_PROD` / `VAPID_PRIVATE_KEY_PROD` (generate
  without printing the private key).
- Drain secret:
  ```bash
  SECRET=$(openssl rand -hex 32); printf '%s' "$SECRET" | gcloud secrets create PUSH_DRAIN_SECRET_PROD \
    --project gifsy-platform --replication-policy=automatic --data-file=-
  ```
- Grant the api SA access to each (repeat for the two VAPID prod secrets):
  ```bash
  gcloud secrets add-iam-policy-binding PUSH_DRAIN_SECRET_PROD --project gifsy-platform \
    --member="serviceAccount:gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
  ```

**(c) After the prod api is serving the new image, create the prod scheduler job:**
```bash
API_PROD=<prod gifsy-api URL>
SECRET=$(gcloud secrets versions access latest --secret=PUSH_DRAIN_SECRET_PROD --project gifsy-platform)
gcloud scheduler jobs create http push-drain-prod \
  --location asia-south1 --project gifsy-platform \
  --schedule "* * * * *" \
  --uri "$API_PROD/v1/push/drain" --http-method POST \
  --headers "x-drain-secret=$SECRET" --message-body '{}' --attempt-deadline 30s
```

**(d) Migration** — the `pwa_install` migration (`20260629120000`) auto-applies via the prod migrate step
(Step 2 / `deploy-api`). No extra action.

**(e) Smoke:** `curl -X POST $API_PROD/v1/push/drain` with **no** header → expect **403** (fail-closed); with
the secret header → **201**.

> 🔑 **TRAP:** Cloud Run `min-instances=1` alone does **NOT** keep background `@Interval` workers ticking — CPU
> is throttled between requests. The **scheduler** (step c) is what drives delivery.

---

## Done-criteria (all must be true)
- [ ] Step 0: 4 suites green · staging SHA == `develop` HEAD · `develop` frozen.
- [ ] Step 1: `current_database()='gifsy_prod'` confirmed · backup id + UTC timestamp logged.
- [ ] Step 2 (or pipeline's migrate step in Step 3): `_prisma_migrations` = baseline + all 6, applied OK.
- [ ] Step 3: `main` updated · approval gate approved · both deploy jobs green · serving SHA == `main` HEAD.
- [ ] Step 4: `/health` 200 · role-matrix login on prod domains · no fabricated data · SHA matches.
- [ ] Rollback path (Step 5) understood and the `b3ab2e0` image confirmed present in Artifact Registry **before** starting.
