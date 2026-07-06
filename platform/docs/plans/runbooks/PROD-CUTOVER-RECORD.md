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

# Production Cutover — Record (2026-07-04 `develop` → `main` — CODE-ONLY, re-KYC batch + login-logo/`/brand/*` fix)

> **Executed 2026-07-04. As-run record of the THIRD cutover** — the `develop`→`main` promotion of the re-KYC batch onto
> the already-live prod (`a2f5929` → `9d366f9`), **followed the same day by the login-logo + `/brand/*` middleware fix deploy
> (`9d366f9` → `eb841e9`, Step 4). Current prod == develop == main == `eb841e9`.** Owner-driven: the owner approved the GitHub
> `production` gate personally (for both the cutover and the login-logo run). **Both were CODE-ONLY — 0 migrations**, so the
> in-VPC `gifsy-migrate` step was a **no-op / not required**. The 2026-06-30 record is the go-live cutover; the 2026-07-01 record
> (cutover #2) added the onboard-slug fix + points-expiry + admin-users work and created + activated the Deoleo tenant; this
> section is the re-KYC batch promotion + the login-logo/`/brand/*` deploy. Runbook: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

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
4. **Step 4 — Login-logo follow-up + `/brand/*` fix (✅ DEPLOYED, later 2026-07-04).** After the cutover fired, the Deoleo
   login-logo commit **`0780d1f`** was **fast-forwarded onto `main` + pushed**. The login wordmark then first rendered as a
   **BROKEN IMAGE** because `/brand/*.png` was **307-redirected to `/auth/login`** — the `platform/src/proxy.ts` auth-middleware
   `config.matcher` excluded `logos/`/`favicons/`/`icons/`/`images/`/`sw.js`/`offline.html` but **not `brand/`** (the login page
   has no token → the asset request got the auth redirect). Fix **`eb841e9`** added `brand/` to the matcher exclusion. **The owner
   approved the `production` gate → prod moved `9d366f9` → `eb841e9`** (= 9d366f9 + login logo `0780d1f` + the `/brand/*` matcher
   fix `eb841e9`); both prod services now serve **`eb841e9`**; `main` == `develop` == `eb841e9`. **Verified LIVE:**
   `/brand/deoleo-wordmark-white.png` → **200 image/png** and the Deoleo wordmark renders on the login page (placeholder gone).
   Gate for the `/brand/*` fix: **FE vitest 1769 · tsc 0.**
   **⚠️ Brand-asset trap:** a static asset under a NEW `public/` subdir needs the `proxy.ts` `config.matcher` exclusion, else it
   307s to `/auth/login` on a no-token page; **local `npm run dev` does NOT reproduce the edge 307 — curl the asset on the REAL
   staging edge** (same class as the earlier `sw.js` 307).

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
- **Deoleo login logo** (`0780d1f`) — ✅ LIVE in `eb841e9` (see Step 4), + the **`/brand/*` middleware fix** (`eb841e9`) that made
  the wordmark render (was a 307 to `/auth/login`; `brand/` added to the `proxy.ts` matcher exclusion).

## Post-state (verified)
- **Cutover #3 rolled to `9d366f9`; then the login-logo + `/brand/*` fix deploy (later 2026-07-04) moved prod `9d366f9` → `eb841e9`.**
  Both prod services (`gifsy-api`, `gifsy-frontend`) now serve **`eb841e9`**; prod **`/health` = 200**.
- **0 migrations applied** (code-only cutover; the in-VPC migrate step was a no-op; the login-logo/`/brand/*` deploy also added none).
- Pre-cutover backup **`1783158625082`** taken; PITR ON.
- Live-verified on `deoleoloyalty.gifsy.in` (login 200, branding resolving, API health 200; `/brand/deoleo-wordmark-white.png` 200
  image/png + the Deoleo wordmark renders on the login page).
- prod == develop == main == **`eb841e9`**; the login logo (`0780d1f`) is **LIVE** and the `/brand/*` matcher fix (`eb841e9`) is **LIVE**.

## What remains (owner-gated — NOT done)
- **Load real Deoleo master data via the app UIs (#76)** — THE last hard go-live blocker; waits on the client's files.
- **WhatsApp `deoleo_kyc_approval` template runtime-verify (#143)** — template APPROVED 2026-07-02; needs a real approval + phone.

## Rollback (unchanged path)
Code rollback = **redeploy both services to the prior prod revision** (`9d366f9` to drop just the login-logo/`/brand/*` deploy, or
`a2f5929` to unwind the whole cutover); neither this cutover nor the login-logo/`/brand/*` deploy added migrations, so there is
nothing to reverse in the DB. DB restore (only if ever needed) via the Step-1 backup `1783158625082` / PITR-clone (never a blind
in-place restore — `gifsy-db` is shared with staging).

---

# Production Cutover — Record (2026-07-04/05 `develop` → `main` — CODE-ONLY — CUTOVER #4: rewards FREE_AMOUNT fix + Credits/Payouts config card)

> **Executed 2026-07-04→05. As-run record of the FOURTH cutover** — the `develop`→`main` promotion of the rewards FREE_AMOUNT
> blank-Max fix + the Credits & Payouts Config settings card onto the already-live prod (`eb841e9` → `824eac0`, **3 commits**).
> Owner-driven: the owner approved the GitHub `production` gate personally. **CODE-ONLY — 0 migrations**, so the in-VPC
> `gifsy-migrate` step was a **no-op / not required**. The 2026-07-04 record above (cutover #3) is the re-KYC batch + the
> login-logo/`/brand/*` fix; this section is the rewards-fix + credits/payouts-config promotion. Runbook: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

## Pre-state (verified)
`gifsy_prod`: live, serving `main` HEAD **`eb841e9`** (the cutover-#3 code + login-logo/`/brand/*` fix), Deoleo tenant CREATED +
ACTIVE + LIVE on the real domain (platform defaults: conversion `1`, expiry null, visibility OFF). `main` was **3 commits behind
`develop` with 0 pending migrations**. Gate green at cutover: **api jest 1427 · nest 0 · FE vitest 1776 · tsc 0**.

## Steps executed (in order)
1. **Step 1 — Pre-cutover backup (double-guarded).** On-demand backup of the shared `gifsy-db` instance:
   description `"pre-cutover4-develop-824eac0"`, `ON_DEMAND`, **SUCCESSFUL**. **PITR remained ON.** Rollback point = redeploy `eb841e9`.
2. **Step 2 — Merge `develop`→`main` (owner-triggered).** Prod `main` HEAD moved **`eb841e9` → `824eac0`** (the 3-commit,
   **CODE-ONLY** jump). The owner approved the GitHub `production` environment gate. **0 migrations** in this batch → the
   in-VPC `gifsy-migrate` step was a **no-op (not required)**; the pipeline deployed the new revision directly. **Both
   `gifsy-api` (rev `gifsy-api-00017-sd5`) and `gifsy-frontend` (rev `gifsy-frontend-00013-kr2`) are Ready=True @ 100% traffic on
   `824eac0`.**
3. **Step 3 — Live verification on the real domain.** `https://deoleoloyalty.gifsy.in/auth/login` → **200**;
   `/brand/deoleo-wordmark-white.png` → **200 image/png** (no regression — the wordmark still renders on the login page);
   both prod Cloud Run services confirmed Ready=True @ 100% traffic on the `824eac0` image.

## What was in this cutover (payload — 2 items)
- **Rewards FREE_AMOUNT blank-Max fix** (`5dbf641`) — a free-amount voucher (`pointsCost 0`) saved with the "Max points" field
  **blank** persisted `maxRedemptionPoints = null` → the reward was treated as a **FIXED cost-0** reward → every redeem threw
  **"must cost a positive number of points"** (the voucher was un-redeemable). Fix: backend `assertFreeAmountComplete` guard on
  create + update + a DTO `@Min(1)` on `minRedemptionPoints`, and a FREE→FIXED switch clears the stale bounds; the FE makes "Max
  points" required for a free-amount reward. Independently audited (no live money defect — the guard fails closed).
- **Credits & Payouts Config settings card** (`824eac0`) — a **GIFSY_ADMIN-only** card on `/admin/settings` (month cutoff /
  per-row safety caps / notify emails). It seeds from `GET /api/admin/settings` (the `/me` endpoint **strips `creditsPayouts`**),
  saves the **whole object**, and the backend **floors the caps at ≥1** so a stored `0` can't freeze credit uploads.
  Independently audited (ship it).

## Post-state (verified)
- **Cutover #4 rolled prod `eb841e9` → `824eac0`.** Both prod services — `gifsy-api` (rev `gifsy-api-00017-sd5`) and
  `gifsy-frontend` (rev `gifsy-frontend-00013-kr2`) — are **Ready=True @ 100% traffic** on **`824eac0`**.
- **0 migrations applied** (code-only cutover; the in-VPC migrate step was a no-op).
- Pre-cutover backup **`pre-cutover4-develop-824eac0`** taken (ON_DEMAND, gifsy-db); PITR ON.
- Live-verified on `deoleoloyalty.gifsy.in` (`/auth/login` 200; `/brand/deoleo-wordmark-white.png` 200 image/png — no regression).
- At cutover, **prod == develop == main == `824eac0`**. *(After the cutover, `develop` advances with a follow-up KYC change — the
  per-document "Pending" status tag removed from the sales KYC store-information view — which is NOT yet in prod, so `develop` may
  be ahead of prod by post-cutover follow-ups.)*

## What remains (owner-gated — NOT done)
- **Load real Deoleo master data via the app UIs (#76)** — THE last hard go-live blocker; waits on the client's files.
- **WhatsApp `deoleo_kyc_approval` template runtime-verify (#143)** — template APPROVED 2026-07-02; needs a real approval + phone.

## Rollback (unchanged path)
Code rollback = **redeploy both services to the prior prod revision `eb841e9`** (unwinds the whole cutover #4); this cutover added
no migrations, so there is nothing to reverse in the DB. DB restore (only if ever needed) via the Step-1 backup
`pre-cutover4-develop-824eac0` / PITR-clone (never a blind in-place restore — `gifsy-db` is shared with staging).

---

# Production Cutover — Record (2026-07-05 `develop` → `main` — CODE-ONLY — CUTOVER #5: sales-KYC UAT fixes — status-tag, re-KYC amber badges, approval-stepper)

> **Executed 2026-07-05. As-run record of the FIFTH cutover** — the `develop`→`main` promotion of the sales-KYC UAT fixes (per-document
> "Pending" tag removal + re-KYC amber doc/photo badges + the Approval-Status stepper current-submission fixes) onto the already-live prod
> (`824eac0` → `5c2bb65`, **5 commits**). Owner-driven: the owner approved the GitHub `production` gate personally. **CODE-ONLY — 0
> migrations**, so the in-VPC `gifsy-migrate` step was a **no-op / not required**. The 2026-07-04/05 record above (cutover #4) is the rewards
> FREE_AMOUNT fix + the Credits/Payouts Config card; this section is the sales-KYC UAT batch promotion. Runbook: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

## Pre-state (verified)
`gifsy_prod`: live, serving `main` HEAD **`824eac0`** (the cutover-#4 code), Deoleo tenant CREATED + ACTIVE + LIVE on the real domain
(platform defaults: conversion `1`, expiry null, visibility OFF). `main` was **5 commits behind `develop` with 0 pending migrations**.
Gate green at cutover: **api jest 1427 · nest 0 · FE vitest 1784 · tsc 0**.

## Steps executed (in order)
1. **Step 1 — Pre-cutover backup (double-guarded).** On-demand backup of the shared `gifsy-db` instance:
   description `"pre-cutover5-develop-5c2bb65"`, `ON_DEMAND`, **SUCCESSFUL**. **PITR remained ON.** Rollback point = redeploy `824eac0`.
2. **Step 2 — Merge `develop`→`main` (owner-triggered).** Prod `main` HEAD moved **`824eac0` → `5c2bb65`** (the 5-commit,
   **CODE-ONLY** jump). The owner approved the GitHub `production` environment gate. **0 migrations** in this batch → the
   in-VPC `gifsy-migrate` step was a **no-op (not required)**; the pipeline deployed the new revision directly.
3. **Step 3 — Live verification on the real domain.** Both prod Cloud Run services confirmed serving the `5c2bb65` image.

## What was in this cutover (payload — 5 items)
1. **Per-document "Pending" status-tag removed** (`6ad4d62`) — the misleading per-document "Pending" status tag was removed from the sales
   KYC store-info view: the `KycDocument.status` field is **never advanced off PENDING**, so it read as a false hold on already-approved outlets.
2. **Cutover #4 doc updates** (`0028a07`) — already recorded (the cutover #4 as-run doc updates); part of this batch reaching prod.
3. **Re-KYC flagged doc/photo amber badges** (`6e96d5b`) — re-KYC flagged documents + photos now show an **amber badge ("Needs re-capture")**
   on the sales-senior KYC detail, at **parity with the Gifsy reviewer** (driven by `flaggedDocTypes`).
4. **Approval-Status stepper reflects the CURRENT submission** (`12d781f`) — a re-KYC **rejected by the ASM** now shows first-approver =
   **Rejected** + Gifsy = **pending** (was showing a stale "Approved" + "Queued for Gifsy"). Uses **latest-event-per-stage** and keys the
   Gifsy step off `kyc.status`.
5. **First-approver step LABEL reflects the real reviewer level** (`5c2bb65`) — the first-approver label was hardcoded from a bad
   `submittedByRole==='XSR'` cast → **always "ASM Review"**. Now derived from the **PENDING_*_APPROVAL** status (awaiting) or the
   **approver's role** (acted), so it is correct under vacant-level skipping.

## Post-state (verified)
- **Cutover #5 rolled prod `824eac0` → `5c2bb65`.** Both prod services (`gifsy-api`, `gifsy-frontend`) serve **`5c2bb65`**.
- **0 migrations applied** (code-only cutover; the in-VPC migrate step was a no-op).
- Pre-cutover backup **`pre-cutover5-develop-5c2bb65`** taken (ON_DEMAND, gifsy-db); PITR ON.
- **prod == develop == main == `5c2bb65`**.

## What remains (owner-gated — NOT done)
- **Load real Deoleo master data via the app UIs (#76)** — THE last hard go-live blocker; waits on the client's files.
- **WhatsApp `deoleo_kyc_approval` template runtime-verify (#143)** — template APPROVED 2026-07-02; needs a real approval + phone.
- **⚠️ Two broken reward catalog items in prod** — **Amazon Voucher** + **To Bank** are free-amount vouchers persisted with a **missing
  min/max** → currently **un-redeemable**. The owner must fix them in the prod **Gift Catalogue** — re-saving each through the now-live
  FREE_AMOUNT guard (shipped in cutover #4) enforces the required bounds.
- **`creditsPayouts.notifyEmails` empty in prod** — credit-batch emails fall back to Gifsy ops; the owner can set the Deoleo recipients via
  the new **Credits & Payouts** config card (live in prod since cutover #4).

## Rollback (unchanged path)
Code rollback = **redeploy both services to the prior prod revision `824eac0`** (unwinds the whole cutover #5); this cutover added
no migrations, so there is nothing to reverse in the DB. DB restore (only if ever needed) via the Step-1 backup
`pre-cutover5-develop-5c2bb65` / PITR-clone (never a blind in-place restore — `gifsy-db` is shared with staging).

---

# Production Cutover — Record (2026-07-06 `develop` → `main` — CODE-ONLY — CUTOVER #6: per-tenant per-purpose OTP templates + re-KYC deep-link auto-skip + assumed-session 24h TTL)

> **Executed 2026-07-06. As-run record of the SIXTH cutover** — the `develop`→`main` promotion of the per-tenant/per-purpose OTP
> template selection (headline) + the sales re-KYC wizard deep-link auto-skip + the assumed-tenant session TTL raise onto the
> already-live prod (`5c2bb65` → `c36f6c8`, **7 commits**). Owner-driven: the owner approved the GitHub `production` gate personally.
> **CODE-ONLY — 0 migrations**, so the in-VPC `gifsy-migrate` step was a **no-op / not required**. The 2026-07-05 record above
> (cutover #5) is the sales-KYC UAT fixes; this section is the OTP-templates + re-KYC deep-link + assumed-session-TTL promotion.
> Runbook: [`CUTOVER-RUNBOOK.md`](CUTOVER-RUNBOOK.md).

## Pre-state (verified)
`gifsy_prod`: live, serving `main` HEAD **`5c2bb65`** (the cutover-#5 code), Deoleo tenant CREATED + ACTIVE + LIVE on the real domain
(platform defaults: conversion `1`, expiry null, visibility OFF). `main` was **7 commits behind `develop` with 0 pending migrations**.
Gate green at cutover: **api jest 1446 · nest 0 · FE vitest 1786 · tsc 0**.

## Steps executed (in order)
1. **Step 1 — Pre-cutover backup (double-guarded).** On-demand backup of the shared `gifsy-db` instance:
   description `"pre-cutover6-develop-c36f6c8"`, `ON_DEMAND`, **SUCCESSFUL**. **PITR remained ON.** Rollback point = redeploy `5c2bb65`.
2. **Step 2 — Merge `develop`→`main` (owner-triggered).** Prod `main` HEAD moved **`5c2bb65` → `c36f6c8`** (the 7-commit,
   **CODE-ONLY** jump). The owner approved the GitHub `production` environment gate. **0 migrations** in this batch → the
   in-VPC `gifsy-migrate` step was a **no-op (not required)**; the pipeline deployed the new revision directly. **Both
   `gifsy-api` (rev `gifsy-api-00019-ms7`) and `gifsy-frontend` (rev `gifsy-frontend-00015-sr8`) are Ready=True @ 100% traffic on
   `c36f6c8`.**
3. **Step 3 — Live verification on the real domain.** `https://deoleoloyalty.gifsy.in/auth/login` → **200**;
   the brand wordmark `/brand/deoleo-wordmark-white.png` → **200 image/png** (no regression); both prod Cloud Run services confirmed
   Ready=True @ 100% traffic on the `c36f6c8` image. *(`/api/health` returns **401** = the edge proxy auth gate on `/api/*` for an
   unauthenticated request, NOT a fault.)*
4. **Step 4 — Post-cutover config-write (Deoleo OTP templates).** The Deoleo `program_settings.otpTemplates` row was written via the
   guarded `gifsy-oneoff-prodcheck` Cloud Run Job (`current_database()='gifsy_prod'` guard). **BEFORE: no row → AFTER: the 4-template
   map; exactly 1 row; job reset to no-op after.** Values: `login` + `redemptionSelf` = `6a391d466b4d90893904e1d2`, `kycConsent` +
   `redemptionSales` = `6a391cf2d011d41f630a1364`. Effective within **≤5 min** (TenantSettingsService 5-min cache TTL).

## What was in this cutover (payload — 7 commits)
- **Per-tenant, per-purpose OTP template selection** (the headline) — `TenantSettingsService.otpTemplates`
  `{login / redemptionSelf / kycConsent / redemptionSales}` + a `getOtpTemplateId` resolver, threaded to
  `Msg91Service.sendOtp(…, templateId?)` at **all 4 send sites**. **Unset → the global env template, byte-identical to before.**
  Independent adversarial audit **CLEAN**; **no migration**.
- **Sales re-KYC wizard: auto-skip Step 1 (Select Outlet) on a deep-link** (`fa8e534`) — a deep-link into the re-KYC wizard for a
  `RE_KYC_REQUIRED` outlet now auto-skips the Select-Outlet step.
- **Assumed-tenant session TTL raised 8h → 24h** (`66ac21e`) — `ASSUMED_SESSION_TTL_HOURS=24`; a single source now drives the
  access + refresh TTL **and** the admin Security-config display. **Normal 7d/30d sessions unchanged.**
- **Doc reframes** — the credit-batch email is folded into Notifications-Core; the WhatsApp KYC templates are noted
  verified-working-on-staging.

## Post-state (verified)
- **Cutover #6 rolled prod `5c2bb65` → `c36f6c8`.** Both prod services — `gifsy-api` (rev `gifsy-api-00019-ms7`) and
  `gifsy-frontend` (rev `gifsy-frontend-00015-sr8`) — are **Ready=True @ 100% traffic** on **`c36f6c8`**.
- **0 migrations applied** (code-only cutover; the in-VPC migrate step was a no-op).
- Pre-cutover backup **`pre-cutover6-develop-c36f6c8`** taken (ON_DEMAND, gifsy-db); PITR ON.
- Live-verified on `deoleoloyalty.gifsy.in` (`/auth/login` 200; `/brand/deoleo-wordmark-white.png` 200 image/png — no regression;
  `/api/health` 401 = the edge proxy auth gate, not a fault).
- **Deoleo `otpTemplates` config-row applied** (post-cutover, guarded job): exactly 1 row with the 4-template map; effective ≤5 min.
- **prod == develop == main == `c36f6c8`**.

## What remains (owner-gated — NOT done)
- **Real-phone prod login-OTP verify** — confirm a real-phone prod login OTP arrives on the **new** Deoleo OTP template (this cutover's config-write).
- **Live end-to-end smoke** — a real KYC→wallet, a credit upload moving a wallet, a redemption per channel, prod OTP.
- **#74 — owner ops before go-live** — monitoring + backups/PITR + credential rotation.
- **NOTE — the prior owner-gated items are now CLEARED (2026-07-05/06):** #76 master data (outlets + hierarchy loaded; no rewards data pending) · #143 WhatsApp `deoleo_kyc_approval` (owner confirms it worked on staging) · the two reward catalog items (owner set min 250 · max 50,000 on both → ACTIVE + redeemable, prod-verified) · `creditsPayouts.notifyEmails` reframed into the Notifications-Core build (enqueued EMAIL never delivers — the queue drainer is PUSH-only — so it's not a config toggle).

## Rollback (unchanged path)
Code rollback = **redeploy both services to the prior prod revision `5c2bb65`** (unwinds the whole cutover #6); this cutover added
no migrations, so there is nothing to reverse in the DB. DB restore (only if ever needed) via the Step-1 backup
`pre-cutover6-develop-c36f6c8` / PITR-clone (never a blind in-place restore — `gifsy-db` is shared with staging).
