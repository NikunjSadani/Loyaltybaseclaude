# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/` (thin Next.js 16).
Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic). Last verified state: 2026-06-21.

═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
⚠️ STATE (2026-06-21): platform serving in prod (empty DB) — but a COMPREHENSIVE GO-LIVE AUDIT found **6 BLOCKERS → NOT go-live ready.**
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
The P0–P6 + P0.6 platform is built and serving in prod (`gifsy-api`+`gifsy-frontend`, `https://deoleoloyalty.gifsy.in`; prod DB
intentionally EMPTY). The **S0–S6 UAT-hardening wave is DONE + pushed** (S0 migration; S5 Excel round-trips `c9bf80e`; S1
redemption UTR-ingest + BUG-1 close `0aa6490`; S2 auth + S3 KYC + S4 TDS + S6 FE-mock `ad4fbe2`; small FIXED_OTP/DEMO_MODE
prod-gates uncommitted-as-of-this-write) — each executor→independent-audit→gate→runtime-verify; money (S1/S5) + auth (S2)
runtime-PROVEN. **THEN a 4-angle comprehensive adversarial audit (money · auth/isolation · core-loop · data/config) found the
platform is NOT go-live ready — 6 BLOCKERS + 4 majors** (full detail + file:line in `gap-register.md` "GO-LIVE AUDIT" block +
`GO-LIVE-READINESS.md` status):
  • **GLB-1** eligibility (KYC-APPROVED + isActive) gate MISSING on BOTH money rails (credit bank-file hardcodes kycStatus:APPROVED; redemption has no KYC check) → revoked/inactive partners get paid.
  • **GLB-2** zero-value redemption (`conversionRate=0`) debits points for ₹0.
  • **GLB-3** stale coarse TDS unique indexes in the baseline drop all-but-first row of every multi-row TDS upload (regression from S4 + my skipped S4 real-DB runtime check).
  • **GLB-4** CLIENT_ADMIN can create/promote a user to GIFSY_ADMIN → full cross-tenant breach (`admin-core` createUser/updateUser, no role allow-list).
  • **GLB-5** scheme enrollment writes localStorage-only, never `POST /v1/schemes/:id/enroll` (the real route exists).
  • **GLB-6** payout settlement has NO working operator UI (`admin/payouts` Process = setTimeout+alert; S1 settle endpoints have no FE driver).
  Majors: credit PAYOUT-reversal clawback, FAILED-credit retry, beneficiary-field validation, PayoutTransaction.redemptionOrderId unique, /admin/kyc fake bulk-approve.
  **What the audit CONFIRMED SOUND (don't re-audit):** money atomic-claims + reversal idempotency, tenant data-isolation (no unscoped query / 33 services), schema↔migration parity, BigInt/secrets, the S0–S6 hardening.
**Next phases:** (1) THE FIX WAVE below (close GLB-1..6 + majors) → (2) re-audit money/auth/data → (3) load real Deoleo data into
empty prod (#76) → (4) owner UAT on staging → (5) owner ops (#74).
**UAT creds (staging, real SMS OTP):** GIFSY `uat.app.gifsy.in`/**9830011252** · deoleo admin `uat.deoleoloyalty.gifsy.in`/**6289864191** · partner `7795096288` · sales `9875436349`.
**Read FIRST:** `gap-register.md` (GO-LIVE AUDIT block) · `GO-LIVE-READINESS.md` (status) · `DEOLEO-GO-LIVE-BUNDLE.md` · `MIGRATIONS.md` · `ENVIRONMENTS.md` · [[staging-deploy-gate]] · [[audit-every-build-item]] · [[verify-flows-at-runtime]].

## ✅ What is LIVE / DONE
- **The platform** — P0–P6 (onboarding/KYC, programs/targets/enrollment, wallet/points/rewards, finance/credits/
  invoicing/TDS) + **P0.6 A–D** (Gifsy cross-tenant oversight + operator switcher, payouts money-path, enforcement
  coverage audit, sales-assisted redemption, invoices+Excel, gifsy console real data, P0.7 cleanup, platform-Prisma
  retirement). All built + independently audited + runtime-verified; **all LIVE in prod now**. Records: `reconcile/*`
  + the memories ([[p3-kyc-complete]] [[p4-complete]] [[p5-complete]] [[p6-finance-decisions]]).
- **🚀 PROD CUTOVER DONE (2026-06-20)** — recreate `gifsy_prod` empty (double-guarded) → apply the squashed baseline
  (72 tables, World-A gone) → `develop`→`main` deploy (GitHub prod gate) → removed the temporary worker host-alias
  (native resolution). Verified: login 200, FE→backend routing 400 (`NEXT_PUBLIC_API_URL`=api.gifsy.in), health 200.
  Full as-run log: `runbooks/PROD-CUTOVER-RECORD.md`.
- **🗄️ MIGRATION MODEL FIXED** — ONE squashed baseline (`api/prisma/migrations/00000000000000_baseline/`; old 6 →
  `migrations-archive/`; `migrations-manual/` is now LEGACY) applied via `prisma migrate deploy` run as an **in-VPC
  Cloud Run Job** (the staging/prod instance is private-IP). Staging auto-migrates on `develop` push, prod on `main`.
  Full model: `MIGRATIONS.md` / [[migration-model]].
- **STAGING login WORKS with REAL MSG91 OTP** (owner logged in end-to-end). The earlier login bugs (empty staging DB,
  empty-host secret, Next-16 Server-Action CSRF abort behind the worker, BOM'd MSG91 key) are all fixed. Redemption-UAT
  phones set on staging: deoleo admin `9830011252`, partner+outlet `7795096288`, sales `9875436349`.

## ✅ E2E ROLE×PAGE MATRIX — DONE (Waves 0–4, 291 passed / 0 failed / 11 skipped; committed `961d5fa`/`7b3828a`/`5119c1d`, PUSHED)
The full matrix (admin writes+reads, partner, sales + salesManager team roll-up, MIS read-only incl. write-denied, gifsy)
is machine-enforced. It caught + we FIXED real prod bugs: the **money-path #42** (`payouts.processBatch` had no test → added
a GIFSY assume-tenant spec + payout-pipeline seed), **`/api/auth/me` thin → profile pages showed MOCK data** (enriched `me`
with nested channelPartner+wallet+salesUser; backend rebuilt), **`OutletTypeClientConfig` unseeded → outlet-upsert broken**
(seeded), seed-hygiene (canonical names), the `login.ts` OTP-fill race, and admin demo-identity (#55). **To run E2E:** DB
proxy `:5433`→gifsy_dev + backend `:4000` (`node dist/main.js`; ⚠️ **rebuild `dist` after the /api/auth/me change**) + FE
`:3000`; re-seed `gifsy_dev` to re-arm money/KYC write specs; `cd platform && npm run e2e`. Staging-run still needs the OTP
read-back endpoint OR temp `FIXED_OTP`.

## 🔴 The GO-LIVE critical path — what's LEFT

**⭐ THE POST-COMPACT WORK (do FIRST, 2026-06-21): EXECUTE THE GO-LIVE-AUDIT FIX WAVE — close the 6 blockers + 4 majors the
comprehensive audit found.** The S0–S6 hardening wave is DONE; THIS wave fixes what the 4-angle go-live audit surfaced (full
detail + file:line in `gap-register.md` "GO-LIVE AUDIT" block). Run it as parallel disjoint-file streams, same discipline as
S0–S6: executor → INDEPENDENT adversarial audit (hand the problem, not the fix) → Opus gate → **RUNTIME-VERIFY AGAINST THE REAL
DEV DB** (not just jest — GLB-3 slipped precisely because S4 was jest-only) → FULL suites → commit. Opus owns `schema.prisma` +
migrations so executors never collide. Streams (disjoint files):
  - **GLM (migration, Opus-owned):** DROP the two stale coarse TDS indexes `tds_off_platform_entries_client_batch_key` +
    `tds_deposits_client_section_batch_key` (GLB-3); ADD partial unique on `PayoutTransaction.redemptionOrderId WHERE NOT NULL` (GLM-4).
    Show SQL → apply to dev → **runtime-verify a multi-row TDS upload persists ALL rows** (the proof S4 lacked).
  - **GL-Money (`rewards`/`payouts`/`credits`):** GLB-1 eligibility gate — exclude non-APPROVED-KYC + inactive/deleted at the
    credit bank-file build (`createPayoutDownload`, write the REAL kycStatus not hardcoded), mirror the check at redeem-confirm
    (`confirmRedeem`/`confirmRedeemForOutlet`, UPI/BANK only) + `payouts.processBatch`; GLB-2 hard-fail zero-value cash redemption
    inside the confirm tx (rollback the debit) + validate conversionRate>0 at boot; GLM-1 PAYOUT-reversal clawback/receivable;
    GLM-2 FAILED-credit retry (FAILED→PENDING or include in re-download); GLM-3 beneficiary-field validation in processBatch.
    **MONEY MODEL (owner, do not relitigate):** no in-portal fund; offline transfer + UTR upload; INR uncancellable once
    OTP-confirmed; reversal ONLY on UTR=FAILED. **Runtime-verify against a partner moved APPROVED→RE_KYC_REQUIRED mid-flow.**
  - **GL-RBAC (`admin-core`):** GLB-4 — per-caller assignable-role allow-list in createUser/updateUser (non-GIFSY callers can't
    assign GIFSY_ADMIN/CLIENT_ADMIN); stop spreading `...dto` into role; + validate tickets.escalate assignee is in-tenant.
    Runtime-verify a CLIENT_ADMIN cannot create/promote a GIFSY_ADMIN.
  - **GL-FE-enroll (`platform`):** GLB-5 — wire partner self-enroll + sales-assisted enroll to `POST /v1/schemes/:id/enroll`
    (replace the localStorage writes in `lib/schemes.ts:253/283`). Runtime-verify the enrollment persists + shows in the admin export.
  - **GL-FE-settle (`platform`, the biggest):** GLB-6 — build the GIFSY payout-settlement UI driving the EXISTING S1/payouts
    endpoints (create batch → assign-pending → process → UTR-template download → UTR upload), replacing the `setTimeout+alert`
    stub in `admin/payouts/page.tsx`; + remove/wire the fake `/admin/kyc` bulk-approve (GLM-5). Runtime-verify a redemption
    settles end-to-end through the UI.
Already done (small, gated, uncommitted-as-of-write): FIXED_OTP send-side (`msg91`) + rate-limit `skipIf` (`app.module`) +
DEMO_MODE (`admin-core.bulkEditUsers`) now NODE_ENV-gated. After the wave: re-run the 4 go-live audits on the changed paths,
THEN proceed to #76 prod data load. Present the stream plan for owner go-ahead, then execute (owner already wants these closed).

1. **✅ DONE (2026-06-21, task #77) — gap-#57 (b/c/e) wired; (a) sub-dashboards DEFERRED.** (b) orphan `/admin/outlets` mock
   removed → redirect to the already-real `/admin/users/outlets`, + real per-outlet KYC-status join (derived from the owning
   **partner's** `KycSubmission` — KYC is partner-keyed, not outlet-keyed); (c) hierarchy read stays snapshot-fed **by P2.1
   design** — the empty page was a SEED-FIXTURE gap, fixed by seeding the `employee_hierarchy` snapshot (NOT a new relational
   read); (e) notification bells hidden in both shells until P7. **⚠️ (a) `/admin/dashboards/{payments,engagement,redemptions,kyc}`
   STILL render mock ("4,821"/"Kumar General Store")** — owner deferred wiring 2026-06-21; **open pre-UAT call: hide that nav
   sub-group OR wire the aggregations** before UAT (else a tester sees fake data there). (d) tenant-settings write + (f) MIS
   KPI-read RBAC = lower, still open. 2 independent audits + E2E 290/0/9. Detail: `gap-register.md` #57.
2. **✅ DONE (2026-06-21, task #78) — `OutletTypeClientConfig` auto-provisioned on tenant creation.** `GifsyService.createClient`
   + a `provisionOutletTypeConfigs(tx, clientId)` chokepoint create one enabled config per active `OutletType` inside the
   client-create `$transaction`; `POST /v1/gifsy/clients` (GIFSY_ADMIN) + the `/gifsy/clients/new` wizard wired; `seed.ts`
   routed through the same helper (§3.2b band-aid retired). Race-safe (P2002→409). Runtime-verified: fresh tenant → 5 enabled
   configs; dup → 409. **#76 is no longer gated on this.** Detail: `gap-register.md` #58.
3. **LOAD REAL DEOLEO MASTER DATA into the empty prod** — prod is migrated but has 0 users/0 clients; no real user can
   log in until the real client + admins + sales team + partners/outlets + reward catalog + schemes are loaded (owner
   provides the file; I author+audit the load). ✅ **#78 done — no longer gated** (a fresh tenant self-provisions outlet-type
   configs; load the real Client via `POST /v1/gifsy/clients` or seed-style script so provisioning runs). THE data blocker. Task #76.
4. **Owner UAT** of the core loop on staging with real OTP (login done; KYC/earn/redeem pending) — first resolve the #57(a)
   sub-dashboards (hide-or-wire) so UAT doesn't surface mock data there.
5. **Owner ops** (owner-only; I prepare exact steps): Cloud Monitoring alert email · automated backups + PITR on
   `gifsy-db` (a one-off backup was taken at cutover; ongoing is OFF) · rotate prod-only secrets. Task #74.
- **Deferred fast-follows (NOT blockers):** sales-team leaderboard (nav hidden), rest of P7 (notification worker,
  banners, ticket lifecycle), P8 (RLS, DPDP, trend analytics, the staging real-OTP endpoint), multi-tenant SSR
  branding (before client #2). Full list: `POST-GO-LIVE-BACKLOG.md`.

## Known gaps to watch (staging + prod)
- **Staging E2E can't run there right now** (FIXED_OTP removed → needs the OTP read-back endpoint or temp FIXED_OTP).
- **Staging shares the prod `gifsy-db` Cloud SQL instance** (different DB names) — any DB op must double-guard the DB name.
- **Prod is empty** (the data-load blocker) · **no backups/PITR, no monitoring alerts, creds not rotated** (owner ops).
- **Prod deploy health-check is advisory** (doesn't fail the deploy) — the migrate `--wait` step is the real gate.
- **Redis:** `REDIS_URL` is bound but OTP is stored in the DB; the throttler is in-memory (per-instance, not global) —
  verify whether Redis is actually used / needed; minor hardening, not a blocker.

## Infra realities (these bite — all confirmed)
- **Edge = Cloudflare Worker** (`cloudflare-worker/worker.js` + `wrangler.toml`), **NOT a GCP load balancer** (archived
  2026-06-13). Add a domain / change routing = edit the worker + `wrangler deploy` (machine is Cloudflare-authed).
- **Staging + prod SHARE the private-IP `gifsy-db` instance**; dev is a separate PUBLIC instance `gifsy-db-dev`. You
  CANNOT reach staging/prod DB from a laptop or a GH runner — run migrations/seeds/one-off SQL as **in-VPC Cloud Run
  Jobs** (for one-off SQL: a `node -e eval(Buffer.from('<base64>','base64'))` job with the prod/staging `DATABASE_URL`
  secret + `--vpc-connector=gifsy-connector` + `--set-cloudsql-instances=gifsy-platform:asia-south1:gifsy-db` +
  `--service-account=gifsy-api-sa@…`; the `^@^` gcloud arg-delimiter avoids comma-splitting). [[migration-model]]
- **`gcloud` is authed and CAN read+write secrets here** (used it to fix `DATABASE_URL_STAGING`, the BOM'd
  `MSG91_AUTH_KEY` v5, `CORS_ORIGINS` v3). **`wrangler` is Cloudflare-authed.** The dev Cloud SQL proxy uses the
  `--token` trick (`& "$env:TEMP\cloud-sql-proxy.exe" <conn> --port 5433 --token (gcloud auth print-access-token)`;
  ADC is NOT set up — don't ask the owner for `application-default login`).
- **Real MSG91 OTP everywhere** (no `FIXED_OTP` on staging/prod). **MSG91 secrets must be saved WITHOUT a UTF-8 BOM**
  (a BOM on `MSG91_AUTH_KEY` 500'd OTP via a fetch ByteString error; `.trim()` in `msg91.service` now defends).
- **The Chrome extension blocks NEW domains** until the owner adds them to the extension's own allowed-sites list
  (separate from Chrome's site-access). It refused `uat.deoleoloyalty.gifsy.in` ("Navigation to this domain is not
  allowed") even with Chrome site-access on — so own-domain UI driving may need the owner to allow the domain first.

## Operating model (unchanged — owner-agreed)
You ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute (Sonnet executor, background, NO shell — you
run the gate) → ONE independent adversarial audit (fresh agent, Read/Grep) → Opus gate → RUNTIME-VERIFY → commit → doc
sweep.** **AUDIT EVERYTHING — do not risk-tier** (the owner caught me skipping audits TWICE this session; the audit
then found a real defect every time, incl. a money-path TDS-index drop on the prod cutover). **DIAGNOSE BEFORE BUILD
(owner caught me 2026-06-21 about to rebuild a hierarchy read that P2.1 deliberately designed as snapshot-fed):** before
proposing ANY fix, answer two questions and cite evidence — (1) **Design intent:** what do the plan/reconcile docs say
this was MEANT to do? Is the current behaviour deliberate? (`00-MASTER-PLAN` 2.1 = "save persists the relational tree IN
ADDITION TO the JSON snapshot" → the snapshot is the intended read model; the empty page was a *seed-fixture* artifact,
not a code gap.) (2) **Real data path:** how does data ACTUALLY arrive for go-live — the upload/PUT or the #76 load
script, NOT the seed fixture? Does that path already satisfy the requirement? Never inherit a gap-register entry's framing
without re-deriving it; never mistake the seed (a test fixture) for the canonical data path. **Auditors must be handed the
PROBLEM to re-derive, NOT my proposed FIX to rubber-stamp** — a leading, solution-shaped claim makes the audit validate
the wrong thing (that's how the hierarchy misframe slipped 2 auditors). Parallelize disjoint-file
streams; **Opus owns `schema.prisma` + migrations** so executors never collide. **Definition of done
(`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow end-to-end at RUNTIME against
realistic data — `tsc`/unit-tests/audits are necessary, NEVER sufficient. ⚠️ **The hard lesson this session: staging
had NEVER been exercised end-to-end, so 4 stacked login bugs sat latent until the owner logged in. Run real flows
EARLY — don't trust "it's deployed" = "it works".** The gate (run it YOURSELF): `cd api && npx tsc -p
tsconfig.build.json --noEmit` (0) + `npx jest <area>`; FE: `cd platform && npx tsc --noEmit` + `npx vitest run <area>`
(platform = **vitest**) + `node scripts/check-doc-consistency.mjs` GREEN. **🚦 BEFORE EVERY PUSH run the FULL suites — `cd
api && npx jest --no-coverage` (N/N, 0 failed) + `cd platform && npx vitest run` — exactly what CI's `test` job gates the
DEPLOYS on. A red full suite SILENTLY SKIPS all staging deploys (`needs: test`); it froze staging a whole day 2026-06-21 on
2 stale specs while my targeted gate stayed green. And "pushed" ≠ "deployed" — verify the serving Cloud Run image SHA
ends in `staging-<short-sha>` (`gcloud run services describe gifsy-frontend-staging|gifsy-api-staging`) + curl the surface
before claiming UAT-ready. See [[staging-deploy-gate]].** Sweep docs (RESUME/bundle/gap-register/
reconcile/memory) after every task (`DOC-MAINTENANCE.md`).

## Constraints (must hold)
- **Work on `develop`.** `main` = prod releases — they go out via the cutover/CI path WITH the owner approving the
  GitHub "production" gate (that's how the cutover shipped). **Commit/push ONLY when the owner asks.** Never expose
  secrets. ⚠️ Don't `git add -A` while a background executor is mid-write.
- **DB migrations:** baseline + `migrate deploy` via the in-VPC job (above). **NEVER `prisma migrate dev`** (resets
  `gifsy_dev`). `migrations-manual/` is LEGACY (don't add to it). For any **prod/staging DB op**: double-guard
  (`current_database()` assert) + take a backup + show the SQL + WAIT for owner go (the instance hosts prod).
- **DEV DB** = `gifsy-db-dev` via Auth Proxy on `127.0.0.1:5433` / `gifsy_dev` (drops after reboot — `DEV-DB.md`).
  `SELECT 1` + confirm `current_database='gifsy_dev'` before touching it. NEVER point dev at prod. ⚠️ `api/.env` was
  once found pointing at PROD — re-verify it reads `127.0.0.1:5433/gifsy_dev`. **Schema source of truth =
  `api/prisma/schema.prisma`.**
- **Backend dev gotchas:** runs a compiled `dist/`; repeated `tsc --noEmit` poisons `tsconfig.tsbuildinfo` → rebuild
  with `tsc -p tsconfig.build.json --incremental false` then `node dist/main.js`; a stale backend may hold :4000
  (`Get-NetTCPConnection -LocalPort 4000` → `Stop-Process`). FE :3000 is `next dev` (live from disk).

## Architecture + the REAL model (do not relitigate)
- **API-first:** `api/` (NestJS) owns the DB + all logic; thin Next.js FE over a `next.config.ts` proxy (`/api/*` →
  backend `/v1/*`, wrapped `{success,data}`). **Never add local `app/api/*` routes** (the proxy forwards; such routes
  are dead). [[architecture-backend-split]] · `docs/spec/04-architecture.md`.
- **The real model** ([[platform-real-model]]): sales/achievement = **upload FINAL amounts per outlet × parameter, NO
  compute**; program = a reporting/filter facet, NOT a targeting dimension; no point-tiers, no SKU. Validate inherited
  concepts against this before building ([[reconcile-fit-before-build]]).

## Reference (read before building)
- Launch: `DEOLEO-GO-LIVE-BUNDLE.md` · `GO-LIVE-READINESS.md` · `POST-GO-LIVE-BACKLOG.md` · `runbooks/PROD-CUTOVER-RECORD.md`
  · `E2E-COVERAGE-PLAN.md` · `MIGRATIONS.md` · `runbooks/{PROD-DB-MIGRATION,PROD-DATA-WIPE}.md` · `ENVIRONMENTS.md`
- Build/process: `00-MASTER-PLAN.md` · `08-agent-execution-guide.md` · `VERIFICATION-PROTOCOL.md` · `DATA-VISIBILITY.md`
  · `DOC-MAINTENANCE.md` · `RBAC-ENABLEMENT.md` · `DEV-DB.md` · `GIT-WORKFLOW.md` · `docs/spec/gap-register.md` (latest #54)
- memory: [[deoleo-go-live-bundle]] · [[migration-model]] · [[audit-every-build-item]] · [[verify-flows-at-runtime]] ·
  [[e2e-harness]] · [[environments-topology]] · [[architecture-backend-split]] · [[platform-real-model]] · the P3–P6 completes.
- **Seeded phones — LOCAL `gifsy_dev`** (FIXED_OTP=123456): gifsy `9830011252`/clientId `gifsy`, deoleo admin
  `9000000001`, partner `9000000002`, sales `9000000003`, clientb admin `9000000020`. **STAGING `gifsy_staging`**
  (REAL OTP): deoleo admin `9830011252`, partner+outlet `7795096288`, sales `9875436349`. **PROD `gifsy_prod`: EMPTY.**
- Local: dev proxy `127.0.0.1:5433` (DEV-DB.md); FE `:3000` (`next dev`); backend `:4000` (rebuild `dist` + `node
  dist/main.js`). Confirm on `develop` + dev DB reachable. Before any irreversible/prod step, show the plan (audited) + wait.
```
