# Production Cutover — Record (A-9)

> Executed 2026-06-20. This is the **as-run record** of the Deoleo production cutover. The cutover was
> performed directly (each step gated by an independent adversarial audit) rather than handed off as a
> runbook; this doc captures exactly what was done so it's reproducible/auditable. Companions:
> [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md) (the migration mechanics) + [`../MIGRATIONS.md`](../MIGRATIONS.md).

## Pre-state (verified read-only, in-VPC)
`gifsy_prod`: stale **June-6 schema** — `public_tables: 75`, `otp_codes: true`, **`kpi_defs`(P4): false**,
**`tds_deposits`(P6): false**, **World-A `tier_configs`: true**, `_prisma_migrations: 6 rows`, **`users: 0`,
`clients: 0`** (greenfield, no real data). Prod ran OLD code; `deoleoloyalty.gifsy.in` served via a temporary
worker host-alias (`deoleoloyalty`→`deoleo.gifsy.in`).

## Steps executed (in order)
1. **Backup** — on-demand backup of the shared Cloud SQL instance `gifsy-db`.
2. **Wire prod auto-migrate** — added a "Run DB migrations (production)" step to `.github/workflows/deploy.yml`
   (mirrors staging: `gcloud run jobs deploy gifsy-migrate … npx prisma migrate deploy … --execute-now --wait`,
   prod `DATABASE_URL`, SHA-pinned image, before the service deploy).
3. **Recreate `gifsy_prod` empty** — in-VPC job, **double-guarded** (`current_database()='gifsy_prod'` AND
   `users=0`): `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;`. This
   reconciles the P3005 (drops the 6 stale migration rows + the World-A tables). Zero real data lost (0 users).
4. **Apply baseline** — ran the `gifsy-migrate` job (`prisma migrate deploy`) → applied
   `00000000000000_baseline`. Verified: **`public_tables: 73`** (72 + ledger), `kpi_defs`(P4)=true,
   `tds_deposits`(P6)=true, **World-A=false**, `_prisma_migrations: 1`, `users: 0`, `clients: 0`.
5. **`CORS_ORIGINS`** — added `https://deoleoloyalty.gifsy.in` (secret v3).
6. **Code deploy** — merged `develop`→`main` (fast-forward, 193 commits) → pushed → prod deploy approved at the
   GitHub "production" required-reviewer gate → `gifsy-api` + `gifsy-frontend` now serve `b3ab2e0`.
7. **Remove the worker host-alias** — deleted `deoleoloyalty.gifsy.in`→`deoleo.gifsy.in` from
   `cloudflare-worker/worker.js` (current code resolves `deoleoloyalty.gifsy.in`→`deoleo` natively) + `wrangler deploy`.
   The UAT alias (`uat.deoleoloyalty.gifsy.in`→`deoleoloyalty.gifsy.in`, for staging) was kept.

## Post-state (verified)
- Prod `gifsy-api` + `gifsy-frontend` serve `b3ab2e0` (current code).
- `https://deoleoloyalty.gifsy.in/auth/login` → **200**; `…/api/auth/send-otp` (no-channel) → **400** from the
  backend (proves FE→backend routing + the `NEXT_PUBLIC_API_URL` GitHub secret = `https://api.gifsy.in`; no SMS sent).
- `https://api.gifsy.in/health` → **200**.
- Independent Opus audit pre-deploy: **SAFE-TO-APPROVE** (all in-repo correct; the two external values — the
  `NEXT_PUBLIC_API_URL` secret + `CORS_ORIGINS` — were then verified/fixed).

## What is intentionally NOT done (prod is greenfield-empty)
Prod has **0 users / 0 clients** — by design. Real users cannot log in until the **real Deoleo master data** is
loaded (client config, admins, sales team, partners/outlets, reward catalog, schemes). That is the go-live
data-load step, tracked in [`GO-LIVE-READINESS.md`](../GO-LIVE-READINESS.md) / `DEOLEO-GO-LIVE-BUNDLE.md`.

## Rollback
The pre-cutover backup (step 1) is the restore point. Prod had no real data, so rollback ≈ restore the empty
instance; in practice forward-fix (another `main` deploy) is the path.

---

# Production Cutover — Record (2026-06-30 `develop` → `main` go-live)

> **Executed 2026-06-30. As-run record of the SECOND cutover** — the `develop`→`main` go-live that promoted the
> full UAT'd candidate (213-commit + 8-migration jump) onto the already-live-but-empty prod. Owner-driven **HYBRID**
> model: the owner approved the GitHub `production` gate personally; the orchestrator ran the reversible prep + the
> in-VPC jobs on the owner's explicit per-step go. The 2026-06-20 record above is the earlier baseline-reconcile
> cutover; this section is the actual go-live. Runbook followed: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

## Pre-state (verified)
`gifsy_prod`: reconciled-to-baseline at the 2026-06-20 cutover (`_prisma_migrations` = baseline only), **0 users /
0 clients** (greenfield). Both prod Cloud Run services (`gifsy-api`, `gifsy-frontend`) already live, serving
`main` HEAD **`b3ab2e0`** (the 2026-06-20 code). `main` was **213 commits + 8 additive migrations** behind `develop`.
Gate green at cutover: **api jest 1271 · nest 0 · FE vitest 1692 · tsc 0**.

## Steps executed (in order)
1. **Step 1 — Prod PWA secrets + wiring.** Created the **3 prod PWA secrets** + granted the api SA accessor on each:
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `PUSH_DRAIN_SECRET`. The prod VAPID **public** key (safe to record):
   `BDa-41v-qzwle4dHG0PEF046WVanmr-Wr5-Ff-ChDBJZLHD2OSipmyGt-1cmhSSA5v3sNNiaWj3TadmIkNuaWzY`.
   **Deviation — cherry-pick, not the stale-branch merge:** the prod-PWA `deploy.yml` wiring landed on `develop` via a
   **cherry-pick of commit `762251e` (new SHA `dd04570`)**, NOT by merging `prep/prod-pwa-activation`. The branch was
   **213 commits behind `develop`**, so merging it would have *appeared to delete* recent work (`msg91.service.ts`,
   `whatsapp-kyc.config.ts`, `admin/users/page.tsx`, etc.). The cherry-pick was provably safe because `develop`'s
   `deploy.yml` was **byte-identical** to the branch point. Also baked **`MSG91_WHATSAPP_NUMBER=917003202293`** into the
   prod api env (in the cutover commit) so it's explicit rather than a manual post-step. The stale branch
   `prep/prod-pwa-activation` was then **DELETED** (validated safe: its only unique change is now on `develop`, no
   workflow references it, it is not an ancestor of `develop`/`main`).
2. **Step 2 — Pre-cutover backup (double-guarded).** On-demand backup of the shared `gifsy-db` instance:
   **id `1782824807740`**, **2026-06-30T13:06:47Z**, `ON_DEMAND`, **SUCCESSFUL**, description
   `"pre-cutover … develop->main (2fa020c)"`. **PITR remained ON.**
3. **Step 3 — Merge `develop`→`main` (owner-triggered).** Prod `main` HEAD moved **`b3ab2e0` → `2fa020c`** (the
   213-commit + 8-migration jump). The owner approved the GitHub `production` environment gate; the pipeline ran the
   **8 additive migrations automatically** via the in-VPC `gifsy-migrate` job (`migrate deploy --wait`) **before** the
   new revision served, then deployed. **Both `gifsy-api` and `gifsy-frontend` now serve `2fa020c`; prod `/health` =
   200.** The 8 migrations were proven applied by the healthy roll + by the Step-4 bootstrap job successfully writing to
   the new tables.
4. **Step 4 — Bootstrap (first GIFSY_ADMIN + OutletType master rows).** The `gifsy-bootstrap` Cloud Run job ran against
   **`gifsy_prod`** (double-guard `BOOTSTRAP_CONFIRM=gifsy_prod` matched `current_database()`). It created the **4
   OutletType master rows** (`SSS`, `WHOLESALER`, `SUB_STOCKIST`, `SSS_TOT`) and the **first GIFSY_ADMIN** (name
   **Nikunj**, phone **9830011252**, clientId `gifsy`, OTP login). Idempotent + additive.
5. **Step 7 — Prod PWA scheduler + drain smoke.** Created the `push-drain-prod` Cloud Scheduler job (state **ENABLED**,
   schedule `"* * * * *"`, POST prod `/v1/push/drain` with the `x-drain-secret` header). **Drain smoke verified:**
   no-secret → **403** (fail-closed); with-secret → **201**.

## Owner-prerequisite resolution
- **GCP alert-email verification (was a prereq) — RESOLVED / struck.** GCP **plain-email** notification channels have
  **no click-to-verify gate** (only SMS/voice do). Both channels (`nikunj.sadani@gifsy.in`, `nikita@gifsy.in`) are
  **enabled** and wired to **both** alert policies, and delivery was already **confirmed end-to-end on 2026-06-29**. No
  owner action needed — this item is struck from the prereqs.

## Post-state (verified)
- Both prod services (`gifsy-api`, `gifsy-frontend`) serve **`2fa020c`**; prod **`/health` = 200**.
- 8 additive migrations applied (proven by the healthy roll + bootstrap writes to the new tables).
- Pre-cutover backup **`1782824807740`** taken; PITR ON.
- Bootstrap done: **first GIFSY_ADMIN (Nikunj/9830011252)** + **4 OutletTypes** present.
- `push-drain-prod` scheduler ENABLED + drain 403/201 behaviour correct.

## What remains (owner-gated — NOT done)
- **Step 5 — Load real Deoleo master data via the app UIs.** Waits for the client's files. Prod is bootstrapped +
  ready; the GIFSY_ADMIN can log in and provision the `deoleo` tenant (slug **MUST** be `deoleo`) → upload
  outlet/hierarchy/catalog/schemes → set conversion-rate / programs / visibility-OFF.
- **Step 6 — Real-OTP login smoke per role.** The admin exists, so it can be done anytime; prod uses **real MSG91** (no
  `FIXED_OTP`).
- **WhatsApp `deoleo_kyc_approval` template runtime-verify (#143).** The MSG91 template is not yet owner-verified.

## Rollback (unchanged path)
Code rollback = redeploy both services to the prior Cloud Run revision (the additive migrations are harmless to older
code); DB restore (rarely) via the Step-2 backup / PITR-clone (never a blind in-place restore — `gifsy-db` is shared
with staging). See the Rollback note in [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

---

# Production Cutover — Record (2026-07-04 `develop` → `main` — CODE-ONLY, re-KYC batch)

> **Executed 2026-07-04. As-run record of the THIRD cutover** — the `develop`→`main` promotion of the re-KYC batch onto
> the already-live prod. Owner-driven: the owner approved the GitHub `production` gate personally. **This was a CODE-ONLY
> cutover — 0 migrations**, so the in-VPC `gifsy-migrate` step was a **no-op / not required**. The 2026-06-30 record is the
> go-live cutover; the 2026-07-01 record (cutover #2) added the onboard-slug fix + points-expiry + admin-users work and
> created + activated the Deoleo tenant; this section is the re-KYC batch promotion. Runbook: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

## Pre-state (verified)
`gifsy_prod`: live, serving `main` HEAD **`a2f5929`** (the cutover-#2 code), Deoleo tenant CREATED + ACTIVE (platform
defaults: conversion `1`, expiry null, visibility OFF). `main` was **60 commits behind `develop` with 0 pending migrations**.
Gate green at cutover: **api jest 1419 · nest 0 · FE vitest 1769 · tsc 0**.

## Steps executed (in order)
1. **Step 1 — Pre-cutover backup (double-guarded).** On-demand backup of the shared `gifsy-db` instance:
   **id `1783158625082`**, `ON_DEMAND`, **SUCCESSFUL**, description `"pre-cutover3-develop-9d366f9"`. **PITR remained ON.**
   Rollback point = redeploy `a2f5929`.
2. **Step 2 — Merge `develop`→`main` (owner-triggered).** Prod `main` HEAD moved **`a2f5929` → `9d366f9`** (the 60-commit,
   **CODE-ONLY** jump). The owner approved the GitHub `production` environment gate. **0 migrations** in this batch → the
   in-VPC `gifsy-migrate` step was a **no-op (not required)**; the pipeline deployed the new revision directly. **Both
   `gifsy-api` and `gifsy-frontend` now serve `9d366f9`; prod `/health` = 200.**
3. **Step 3 — Live verification on the real domain.** `https://deoleoloyalty.gifsy.in/auth/login` → **200**; tenant branding
   resolving; `https://api.gifsy.in/health` → **200**; both prod Cloud Run services confirmed on the `9d366f9` image.
   *(The raw `*.run.app` frontend URL 404s on routes — that is host-based tenant routing via Cloudflare, NOT a fault; the
   real domain is authoritative.)*
4. **Step 4 — Login-logo follow-up (ARMED, NOT yet deployed).** After the cutover fired, the Deoleo login-logo commit
   **`0780d1f`** was **fast-forwarded onto `main` + pushed**, so `main` == `develop` == `0780d1f`. Its prod deploy is a
   **separate pending run awaiting the owner's `production` gate approval** — **prod serves `9d366f9` until approved.**

## What was in this cutover (payload)
- **Field-level re-KYC** (`267da65`, `e1e4ba5`) — non-flagged fields LOCKED + backend-enforced; flagged fields pre-filled +
  editable; approver highlight + admin remark on the sales-senior detail AND Gifsy reviewer; F1–F4 audit fixes.
- **Re-KYC in-flight DISPLAY fix** (`2b7f44b`) — a resubmitted re-KYC shows "Under Review" not "Re-KYC Required", via the new
  `isReKycActionable(flags, latestStatus)` helper (flags AND latest-not-in-flight).
- **Program Name/Category upload case-insensitive + canonicalised** (`1be7119`).
- **Hierarchy phone-correction orphan FIX** (`e83e63d`) — User keyed by `(clientId,phone)` but SalesUser by
  `(clientId,employeeCode)` → a phone correction stranded the old User + locked the old number; fix resolves the existing User
  via `SalesUser.userId` + updates in place (8 staging orphans cleaned, freed numbers incl. 9113145451).
- **Redeem-button KYC gate** — the sales "Redeem for Outlet" button shows only when the outlet's KYC `isApproved`.
- **Deoleo login logo** (`0780d1f`) — ARMED, awaiting the owner's gate (see Step 4).

## Post-state (verified)
- Both prod services (`gifsy-api`, `gifsy-frontend`) serve **`9d366f9`**; prod **`/health` = 200**.
- **0 migrations applied** (code-only cutover; the in-VPC migrate step was a no-op).
- Pre-cutover backup **`1783158625082`** taken; PITR ON.
- Live-verified on `deoleoloyalty.gifsy.in` (login 200, branding resolving, API health 200).
- `main` == `develop` == `0780d1f`; the login-logo deploy (`0780d1f`) is ARMED, prod serves `9d366f9` until the owner approves.

## What remains (owner-gated — NOT done)
- **Approve the `production` gate for the login-logo run (`0780d1f`)** → prod shows the Deoleo wordmark.
- **Load real Deoleo master data via the app UIs (#76)** — THE last hard go-live blocker; waits on the client's files.
- **WhatsApp `deoleo_kyc_approval` template runtime-verify (#143)** — template APPROVED 2026-07-02; needs a real approval + phone.

## Rollback (unchanged path)
Code rollback = **redeploy both services to `a2f5929`** (the prior prod revision); this cutover added no migrations so there is
nothing to reverse in the DB. DB restore (only if ever needed) via the Step-1 backup `1783158625082` / PITR-clone (never a blind
in-place restore — `gifsy-db` is shared with staging).
