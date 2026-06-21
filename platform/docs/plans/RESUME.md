# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️ **STATE (2026-06-20, end of session): NOW IN THE DEOLEO GO-LIVE BUNDLE — launching Deoleo on the core loop.** The
P0–P6 + P0.6 A–D platform is built (history below). Instead of finishing P7→P8→P9 first, we pulled only the
launch-critical slice of each forward and made the rest post-launch fast-follows. **SOURCE OF TRUTH for the launch =
`DEOLEO-GO-LIVE-BUNDLE.md`** (Rev 3, after 4 adversarial audit rounds; §A = owner decisions, §3 = sequenced lanes + §3.1
parallelization + §3.2 owner-action list, §A.1 = live infra + the temporary host-alias, §A.2 = build progress). **Read it
FIRST**, with `runbooks/PROD-DATA-WIPE.md` + `runbooks/PROD-DB-MIGRATION.md`.

**Owner decisions (do NOT relitigate):** leaderboard = **post-launch fast-follow** (launch with the sales-LB nav hidden);
OTP = **synchronous send** (the queue-worker is deferred); CI gate = **quarantine-to-green** (skip the red-by-design TDD
specs so `npm test` is a real all-pass gate); data lifecycle = **staging-UAT → guarded prod clean-wipe → real Deoleo data**;
**domain-first**.

**DONE this session — each: gate (tsc/jest/vitest) + runtime-verify + an INDEPENDENT ADVERSARIAL AUDIT.** (The audit step
was reinstated mid-session after the owner caught me skipping it on build items; it then found a real issue every time:
A-2a F5, A-10 F1/F3, the dry-run 5s-tx-timeout, and the OTP→staging-infra cascade below.)
- **Domain LIVE** — `https://deoleoloyalty.gifsy.in` serves the Deoleo login (200, branded). ⚠️ **The edge is a Cloudflare
  Worker (`cloudflare-worker/worker.js` + `wrangler.toml`), NOT a GCP load balancer** — the LB was archived 2026-06-13
  (`terraform/load-balancer.tf`). A **temporary host-alias** presents it as `deoleo.gifsy.in` so PROD (old code) serves it;
  the alias retires once prod runs current code (steps in §A.1). I deploy the worker via `wrangler deploy` (machine is
  Cloudflare-authed); secrets/DNS that need the owner's accounts are owner-gated.
- **A-1 CD gate (THE foundational unblock)** — quarantined the ~92 red-by-design vitest specs (`it.skip`/`describe.skip`,
  tracked in `baseline-red-snapshot.txt`) → `npm test` green → **deploys actually work now** (the workflows' `test` job
  was failing on the red suite → every staging/prod deploy was silently blocked). Staging now deploys on each `develop` push.
- **🗄️ MIGRATION MODEL FIXED + STAGING OTP/LOGIN WORKING (2026-06-20) — see `MIGRATIONS.md` + [[migration-model]].** The
  "staging can't generate OTP" issue was `gifsy_staging` having **no tables** (the deploy pipeline never ran migrations;
  every DB had been migrated by hand; staging was skipped) **+** a malformed `DATABASE_URL_STAGING` secret (empty host →
  Prisma migrate `P1013`). Fixed: (1) **squashed** the divergent migration history into one clean baseline
  (`api/prisma/migrations/00000000000000_baseline/` = current schema; old 6 → `migrations-archive/`; an audit caught + I
  recovered two dropped TDS partial-unique indexes); (2) **wired `migrate deploy` as an in-VPC Cloud Run Job** into
  `deploy-staging.yml` (`gifsy-migrate-staging`, SHA-pinned, `--wait`) — the instance is **private-IP** so migrations
  can't run from a laptop or a GH runner; (3) **corrected the staging secret** to `@localhost/` (matching prod, secret
  v2); (4) **compiled the seed into the image** (`prisma/seed.js`; prod omits ts-node) + ran `gifsy-seed-staging`. **Runtime-verified:** send-otp 200, full login `9000000001`/OTP `123456` → tokens, cross-tenant refused. **UAT-ready on
  `uat.deoleoloyalty.gifsy.in`.** Commits `d9c847b` (baseline+CI+seed-guard) + `5623a35` (seed-compile+docs), pushed.
  ⚠️ **PROD is NOT migrated** — still on the stale June-6 schema (has `otp_codes`, missing P4–P6); deferred to the gated
  cutover, which now = run the `gifsy-migrate` job with the **Step-1.5 P3005 reconcile** (`runbooks/PROD-DB-MIGRATION.md`).
  Prod state is **inferred, not confirmed** — verify read-only (in-VPC) before cutover.
- **🔑 STAGING LOGIN FIXED + REAL-OTP UAT LIVE (2026-06-20) — owner logged in end-to-end with a real SMS OTP.** Two more
  issues surfaced when the owner tried the browser login: (1) the **"Send OTP" button hung** — the Cloudflare worker
  rewrites `x-forwarded-host` for tenant resolution, so Next 16's Server-Action CSRF guard saw origin≠x-forwarded-host and
  **ABORTED the action** (`auth/login/actions.ts` is the ONLY `'use server'` file → login was the only flow with this).
  Fix: `experimental.serverActions.allowedOrigins` (next.config) with our tenant hosts incl. the **4-part** `uat.deoleoloyalty`/
  `clientb.app` hosts (`*` doesn't cross dots); independent audit APPROVE-WITH-CHANGES. (2) **real MSG91 send 500'd** —
  `MSG91_AUTH_KEY` (and `MSG91_SENDER_ID`) secrets had a leading **UTF-8 BOM** (U+FEFF) → `fetch` ByteString error; stripped
  the auth-key BOM (secret **v5**) + added defensive `.trim()` in `msg91.service`. Removed the **SMS/WhatsApp selector**
  (SMS-only). **Real-OTP UAT:** flipped `FIXED_OTP` **OFF** on staging (also removed from `deploy-staging.yml` → persistent;
  restores ENVIRONMENTS.md's "staging = real MSG91" intent) + set deoleo admin (`seed-deoleo-admin`) phone → real
  `9830011252`. ⚠️ **With real OTP on, only REAL numbers receive OTPs** — the seeded partner(`9000000002`)/sales/outlet are
  FAKE, so partner-login + redemption-OTP UAT need real numbers set first. Commit `ea22776` (login fix) + a persistence
  commit. **Local E2E harness unaffected** (local FIXED_OTP); the **staging** harness now needs the deferred real-OTP
  read-back endpoint (→ P8).
- **🚀 PROD CUTOVER DONE (2026-06-20) — prod is LIVE on current code, empty schema. Record: `runbooks/PROD-CUTOVER-RECORD.md`.**
  Executed as one coordinated gated op (each step audited): backup → wire prod auto-migrate into `deploy.yml` → **recreate
  `gifsy_prod` empty** (double-guarded DROP SCHEMA; reconciles P3005; 0 users so 0 data lost) → apply baseline (verified 72
  tables, World-A gone) → add `deoleoloyalty.gifsy.in` to `CORS_ORIGINS` → merge `develop`→`main` (FF, 193 commits) → prod
  deploy approved at the GitHub gate (`gifsy-api`+`gifsy-frontend` on `b3ab2e0`) → **remove the worker host-alias** (current
  code resolves `deoleoloyalty.gifsy.in`→deoleo natively; `wrangler deploy`). Verified: login page 200, FE→backend routing
  400 (proves `NEXT_PUBLIC_API_URL`=api.gifsy.in), `api.gifsy.in/health` 200. Pre-deploy Opus audit = SAFE-TO-APPROVE.
  ⚠️ **Prod is intentionally EMPTY (0 users/clients)** — real users can't log in until the **real Deoleo master data** is
  loaded (THE next go-live blocker). A-5/A-8/A-9 (cutover) + D1/D2 are DONE & live.
- **A-2a synchronous OTP** — shared `api/src/notifications/msg91.service.ts`; partner (`rewards:720`) + sales-assisted
  (`:437`) OTP send directly with send-failure cleanup (cancel order + clear OTP + 503); auth delegates to it; **+ a 10s
  MSG91 fetch timeout**. Audit SHIP; F5 (cleanup masking the 503) fixed. Confirmation SMS deferred.
- **A-3** login reads `x-forwarded-host` (tenant behind the worker). **A-4/A-6 reconciled** — observability + hardening
  **code already present** (helmet/CORS/strict-validation/`ThrottlerGuard`/`AllExceptionsFilter`); residuals = owner
  (Cloud Monitoring alert email; cred rotation). **Footer** "Powered by Gifsy" on tenant-facing pages (login/admin/partner/
  sales, NOT the gifsy operator portal).
- **A-10 prod-wipe** — `api/prisma/wipe-tenant-data.ts` + `runbooks/PROD-DATA-WIPE.md`: 69-step FK-ordered scoped delete,
  dry-run-default, DB-name + confirm-token guards. Hard-audited (F1 missed `OutletTypeClientConfig`, F3 fail-closed scope —
  both fixed). **Dry-run-VALIDATED on `gifsy_dev`** (424 rows, sane; a 5s-tx-timeout bug it surfaced was fixed). Real wipe
  is cutover-only (backups-first).
- **A-5 prod-migration runbook** — `runbooks/PROD-DB-MIGRATION.md`: `prisma migrate diff` (Prisma-7 syntax verified —
  `--from-config-datasource --to-schema … --script`) → review → staging dry-run → guarded prod apply. Validated vs dev
  (only 4 cosmetic index renames; dev IS current).
- **MSG91 OTP template set** — `MSG91_OTP_TEMPLATE_ID` = `699d295ba29962881e09d062` (added to Secret Manager; auth-key +
  sender already there, 4 versions each). MSG91 confirmed responding <1s; **IP-whitelisting is OFF** (not a factor).
- **UAT URL** `https://uat.deoleoloyalty.gifsy.in` → the **staging** build (owner UAT / view current builds pre-prod).
- **3 STAGING-INFRA BUGS found+fixed** (all surfaced by attempting the real-OTP test — staging was fundamentally broken
  and had never been exercised): (1) staging FE missing `JWT_SECRET` → 500 every page; (2) `api.staging.gifsy.in` (the FE's
  baked `NEXT_PUBLIC_API_URL_STAGING`) was **unrouted** → the login server-action self-proxy hung → routed it in the worker
  + added a 12s timeout to the login fetches (hardens prod too); (3) staging API **missing the `--vpc-connector`** prod has
  → couldn't reach the private-IP Cloud SQL (`gifsy-db`) → all DB ops 500'd → added `gifsy-connector` to `deploy-staging.yml`.

**NEXT = the PROD CUTOVER (owner-gated, sequenced in the bundle):** owner enables **backups/PITR (O-4)** → I run **A-5**
prod migration (diff → review → staging dry-run → apply) → **prod code deploy** (merge `develop`→`main`, approval-gated) →
remove the worker host-alias → **real-OTP smoke** on the live domain → write **A-9** cutover runbook (mine, prep) → data
lifecycle (staging UAT → A-10 wipe → real data). **Resume the real-OTP test** once the latest staging redeploy lands (flip
`FIXED_OTP` off on staging → owner retries login with a real phone). Leaderboard + the rest of P7/P8 = post-launch.

**PUSH STATE: ALL of the above is committed AND pushed to `develop` (last tip `60c700a`).** D2 + the domain-map (previous
session) were pushed at session start — the Docker image build was verified green via a clean `npm ci`/`next build` in a
throwaway copy (no Docker needed). The staging-infra fixes auto-deploy on push. **Reload: `POST-GO-LIVE-BACKLOG.md`,
`reconcile/D2-platform-retirement.md`.**

**`gcloud` is authed (run-services/logging/secrets-VIEWER — NOT secret-accessor); `wrangler` is Cloudflare-authed; the
Cloud SQL Auth Proxy runs via `& "$env:TEMP\cloud-sql-proxy.exe" … --token (gcloud auth print-access-token)` (ADC is NOT
set up — use the `--token` trick, do NOT ask the owner for `application-default login`).**
The Playwright E2E harness (`platform/e2e`, `npm run e2e`, **59 green**) covers real-login-per-role · real scoped data · role/portal scoping ·
cross-tenant (both dirs) · write-persistence (tickets · partner redemption MONEY PATH · visibility submit) · A1 Gifsy
cross-tenant KYC · A2 operator-switcher. **✅ C1 DONE (`547fa03`, 2026-06-20): the harness now covers the wave (B2 invoice render+list-shape guard · B3 gifsy overview/detail+no-secret · A1 rendered cross-tenant · Q1 payouts redirect · sales catalogue/KYC-review) — `npm run e2e` = 59 passed.** C1 also caught + fixed a flaky OTP-fill in `login.ts` and re-aligned the visibility-write test to A4's partner-denylist (read-back as GIFSY). Re-runnable
(`skipIf(FIXED_OTP)`). **It does NOT cover every page/flow** — most admin sub-pages, partner targets/leaderboard, sales
team/outlets, and most write flows are unverified by the harness (B2 invoices + B3 gifsy overview/detail were
runtime-verified by hand this wave but have no harness spec yet → C1). Read FIRST: [[e2e-harness]] · `e2e/README.md` ·
`GO-LIVE-READINESS.md` (launch blockers) · `POST-GO-LIVE-BACKLOG.md` (deferred/fast-follow work, incl. multi-tenant SSR branding → before client #2) · `DATA-VISIBILITY.md` · `VERIFICATION-PROTOCOL.md` · gap-register **#33–#53** · [[runtime-audit-p0.5]] · [[verify-flows-at-runtime]].

**THE DEFINITION OF DONE (`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow
end-to-end at RUNTIME against realistic multi-role data — canonical surface · role matrix · cross-tenant · DB
persistence seen by a different session · honest unhappy path. `tsc`/unit tests are necessary, NEVER sufficient.
**A green harness means "the asserted slices work" — NOT "everything works".** NEVER sample / "should be fine".

**RESOLVED (cumulative):** harness-verified — #46 the harness · #39 GIFSY login · #40 fabricated data · #41 role/portal
guards + Q1 payouts GIFSY-only · #47 admin dashboard KPIs · cross-tenant (`clientb` seeded) · **#50 partner REDEMPTION
MONEY PATH** · **#36 visibility/submit PORTED** · **#38 A1 Gifsy cross-tenant oversight** · **#51 A2 operator-context
switcher**. A-wave + B1 (audited + runtime-verified, pushed) — **#42/#43 A3 payouts** · **#2 A4 enforcement + #52 +
`kyc.ledger` PII leak** · **sales-KYC-review grant** · **#50-E B1 sales-assisted redemption (UI browser-verified)** ·
**#49 B3 ◐ gifsy clients-list real**. Owner decisions in `DATA-VISIBILITY.md §3 + §3.1`.

**🔑 KEY PATTERN (now CLEARED) — `platform/next.config.ts` proxy-exclusions WERE the map of DEAD WRITES.** Its
`beforeFiles` rewrite excluded some `/api/*` paths from the backend proxy (negative lookahead), routing them to stale
local `src/app/api/*/route.ts` handlers on the **RETIRED platform Prisma** → they threw. **ALL EXCLUSIONS NOW DROPPED
(`/api/:path*` forwards everything):** redemption (P5 backend, fixed 2026-06-19) · **`visibility/submit` PORTED**
(`POST /v1/visibility/submit` — multipart→GCS via `StorageService`, partner-from-JWT, outlet-from-partner,
PHOTO_APPROVAL gate, partner-only `@Roles`; dead local route deleted; harness write-persistence test green) ·
`admin/kyc` was a **no-op** exclusion (KYC writes already at `/v1/kyc/*`; FE calls `/api/kyc/*`, never matched).
**P0.6 Phases A–D (re-scoped 2026-06-19 from a code-grounded audit; full plan in `00-MASTER-PLAN §P0.6` +
`reconcile/P0.5-make-it-runnable.md`; owner decisions in `DATA-VISIBILITY §3.1`).** Gifsy operates in **TWO modes**:
cross-tenant OVERSIGHT (see-all; A1) + per-brand OPERATION (the A2 switcher).
- **✅ A1 — Gifsy cross-tenant OVERSIGHT DONE (#38):** `kycTenantFilter`/`submissionTenantFilter` exempt GIFSY_ADMIN
  from the caller-tenant filter (KYC + visibility); reviewQueue emits each record's clientId; FE brand column/filter.
  Runtime-verified (6 checks) + independent audit PASS (residual slaMetrics → ✅ cross-tenant in A4; outletStatuses already had a partner denylist).
- **✅ A2 — Operator-context SWITCHER DONE (#51), backend+FE:** `POST /v1/auth/assume-tenant` mints a tenant-scoped
  `{sub:operator, role:GIFSY_ADMIN, clientId:tenant, assumed:true}` token (GIFSY-only, target-ACTIVE-only,
  sub-preserved, audited, 8h, refresh preserves scope, strategy matches session by userId+clientId). FE: a "Work in
  brand ▾" switcher (real `GET /api/gifsy/clients`) + a global "Working in &lt;Brand&gt;" banner in both shells +
  `PORTAL_ROLES.admin` admits GIFSY_ADMIN. Operator-switch round-trip runtime-verified through the real UI (harness)
  **AND manually browser-verified** (login→switcher→assume Deoleo→banner+admin shell real KPIs→exit restores gifsy);
  independent audit PASS after 2 fixes. **A2 unblocks payouts (A3).**
- **◐ B3 — gifsy console real data (#49) PARTIAL:** the Clients LIST (browser-verified: "Modules X/5", retired
  partner-class column gone) + the switcher's brand list read the real `clients` table now; the gifsy **Overview
  dashboard** + **per-client detail** still read `CLIENT_REGISTRY` (remaining). ⚠️ **Live admin-dashboard demo chrome
  confirmed → D1/#45:** hardcoded "NEEDS ATTENTION" numbers, the "Client/Gifsy" demo role-switcher, partner-class
  filter chips, Growth-Trends MoM% (the KPI *cards* ARE real per #47).

**✅ A3 — Payouts COMPLETION DONE (#42/#43, money path, 2026-06-19):** ran INSIDE the A2 assumed session (no cross-tenant
rewrite). (a) **batch-from-pending** sweep `POST /v1/payouts/batches/:id/assign-pending` — the missing consumer: a
guarded `updateMany` assigns unbatched (`batchId:null`, PENDING, `redemptionOrderId` set) redemption `PayoutTransaction`s
into a DRAFT batch, scoped by `partner: { clientId }` (cross-tenant-safe) + matching `payoutMode`; plus a `?unbatched=true`
list filter. (b) `processBatch` → **guarded atomic claim** (`payoutBatch.updateMany status in [DRAFT,SUBMITTED,FAILED]`,
0-count=BadRequest) + disbursement/finalise in `$transaction` + **reset-to-FAILED on any post-claim throw** (never stranded
in PROCESSING). (c) **OWNER DECISION: payouts disburse the FULL amount — inline flat-194R TDS + the `TdsRecord` write were
REMOVED** (TDS owned by the P6.5 engine, which reads `RedemptionOrder.valuePaise` directly; `/admin/tds/liability?section=`
ALREADY existed). jest **795/795** + independent adversarial audit (**SHIP**, no money/cross-tenant defect; 2 findings
fixed = stuck-batch + dead reconciliation tdsRecord read) + **runtime-verified end-to-end** (gifsy→assume deoleo→unbatched
list shows ONLY deoleo not clientb→create batch→assign-pending=1→process SUBMITTED, required=full 500000, flagged 1; DB:
deoleo INITIATED+batched, clientb still PENDING+unbatched, **0 TdsRecords**). ⚠️ **Found pre-existing bug #52:**
`payouts/fund/receive` 400s — `ReceiveFundDto.paymentDate` lacks an `@IsX` decorator so `forbidNonWhitelisted` rejects it
(**✅ fixed in A4**; was not A3).

**✅ A4 — Enforcement coverage audit DONE (#2, 2026-06-19):** audited ALL 35 controllers. KEY FINDING (validated): tenant
isolation is solid (service-layer `clientId` + TenantGuard) and MOST "ungated" endpoints already self-scope (tickets→own,
wallet→own, rewards-orders→own, banners/banner-config/admin-visibility→service denylist, targets fully gated) — so it was
NOT "40 open holes". Added `@Roles` to the partner/sales self-service surface (partner.* class-gated PARTNER; sales.* class
SALES; wallet read; rewards redeem/confirm/catalog; schemes enroll/my-enrollment; kyc first-approve/reject) for
defense-in-depth + honest 403. **Fixed a REAL intra-tenant PII read-leak:** `kyc.ledger` had no owner guard → a partner
could read ANY tenant submission's wallet ledger; now partner-callers are own-only (`kyc.getOne` was already leak-safe via
its post-fetch owner guard — left unchanged). **Fixed `visibility.listSubmissions`** (added the partner denylist its sibling
`outletStatuses` already had). **Fixed #52** (`ReceiveFundDto.paymentDate` `@IsDate()`) + **slaMetrics cross-tenant** (A1
residual). jest **803/803** + independent audit (**SHIP**; caught + fixed 1 self-inflicted regression — over-gating
`/rewards/orders` broke the CLIENT_ADMIN Fulfilment tab → reverted those 2 to ungated self-scoping) + **runtime role-matrix
12/12** (partner own-ledger 200 / other-ledger 404 / sales-team 403 / partner-me 200 / client-admin wallet 403 /
rewards-orders 200 / fund-receive 201 / slaMetrics cross-tenant). **DEFERRED (documented):** JWT↔x-tenant-slug → Gap
#23/P8.6 (RLS). **✅ sales-KYC-review GRANTED (owner decision 2026-06-19):** `kyc.getOne` now blocks only PARTNER roles
from non-owned (admins+MIS+SALES tenant-wide, consistent with list()'s stage-queue + ledger; partners own-only; PII masked
for non-admin non-owner). Runtime-verified (sales reviews non-owned detail+ledger 200, cross-tenant 404; partner blocked
from other partner 403). ⚠️ Stale `'RETAILER'` test-fixture role (not in the enum) → D1.

**✅ B1 — sales-assisted redemption DONE (#50-E, 2026-06-19):** `POST /v1/rewards/redeem-for-outlet` + `/confirm`
(`@Roles(SALES)`) reuse the audited partner redeem/confirm core but target an ASSIGNED outlet — assignment-scoped (active
`salesUserAssignment` by **partnerId OR the partner's outletIds**; the outletId path covers the production master-upload
shape where partnerId is null), the OUTLET's wallet is debited, **OTP to+from the OUTLET** (owner consent decision),
order against the outlet, sales user audit-logged. `/sales/outlets` now returns `partnerId`+`balance`. FE `sales/catalogue`
wired (real calls + real balances; `otp==='999999'` fake removed; tsc 0). jest 813/813 + independent money-path audit
(**SHIP** after fixing the assignment-keying MEDIUM the audit caught) + **runtime-verified API** (sales→assigned outlet
wallet 46000→45500; non-assigned→403; outletId-only auth) **AND full UI click-through browser-verified 2026-06-20**
(sales login→real catalog→select outlet real balance→confirm→OTP to outlet→confirm→DB wallet 45500→45000, order
CONFIRMED, SALES_ASSISTED_REDEEM audit). **The UI pass caught + fixed 2 bugs unit/API missed:** A4 over-gated
`/rewards/catalog` to partner-only (sales 403/empty → added SALES to the read `@Roles`) + the FE mapped non-existent
`available`/`brand`/`category` fields (false "Out of stock" → derive from status+stock). GIFT_CATALOGUE cosmetic
reliance → D1; **#53** logged: `schemes.submitEnrollment` has the SAME assignment-keying gap.

**✅ WAVE-NOW DONE 2026-06-20 (4 parallel agents; each independent adversarial audit → Opus gate → runtime-verify →
local commit; full plan = `00-MASTER-PLAN §P0.6 Parallel-agent waves`):**
1. **B2** invoices + Excel (#44 invoice slice) — `e07c06a`. Export (`/v1/{admin,partner}/invoices/export`)+template+real upload page (drives no-compute period-gen). FULL money audit = SHIP-WITH-FIXES → fixed HIGH list-shape (FE read `res.data.invoices`; tests now assert the REAL `{invoices,pagination}` shape, not a fabricated bare array) · MED P2002 mis-attribution (disambiguate `meta.target`) · LOW Excel formula-injection (sanitize `=+-@`). **Remaining → D1:** enrollments-export + final-targets header.
2. **B3-finish** gifsy console real (#49) — `745d573`. `GET /v1/gifsy/overview` + `/clients/:slug` real; both pages off `CLIENT_REGISTRY`; fake "N classes" → real modules-on count. Audit SHIP (no secret leak; GIFSY-only). `CLIENT_REGISTRY` retires in D2; admin-dashboard demo-chrome → D1.
3. **#53** schemes assignment-keying — `72a77f1`. Mirrors B1 exactly (partnerId OR outletIds + empty-list guard); +positive +negative over-auth tests; audit SHIP; runtime-proven (outletId-only authorizes, unassigned 403).
4. **C2** staging harness env-support — `4e08477`. `E2E_ENV=local|staging` switch (base URL · tenant strategy · OTP source); local default byte-identical; **no prod code touched**; audit SHIP.

**▶ NEXT:** (a) **PUSH the wave** — `72a77f1`,`4e08477`,`745d573`,`e07c06a` are committed to local `develop` but **NOT pushed** (awaiting owner go; push auto-deploys to staging). (b) **C2 staging-OTP — DECIDED 2026-06-20:** use `FIXED_OTP` on the staging backend now (`E2E_OTP_STRATEGY=fixed`); the real-OTP read-back endpoint is **deferred → P8-ops/staging-hardening** (not yet built). (c) **C1** harness specs for the A/B/#53 fixes (file-disjoint, logically behind B2/B3/#53). (d) **THEN serial, Opus-coordinated (broad FE, do NOT parallelize): D1** P0.7 cleanup (#45) **→ D2** platform-Prisma retirement (#31/#32, deletes shared infra → LAST). **Opus owns `api/prisma/schema.prisma` + migrations** (none were needed for B2/B3/#53/C2). **Decisions:** RBAC=@Roles-only+coverage-audit for launch · sales-redeem=real · tenant-creation=deferred but provision-ready. **Payouts audit: P6 was sound** — the payout gaps are a documented P6 hold (6.5 ON HOLD) + a Q1 consequence, not P6 errors. ⚠️ **Seeds note:** `seedDeoleoDemo` seeds VisibilityProgram `VP001` (seed-vp-1); `seedClientBDemo` seeds a PENDING_GIFSY KYC (seed-kyc-b1); deoleo has NO seeded schemes / invoice source data (so B2's populated invoice path + #53 enrollment are unit-proven + the bounded live divergence proof, not a full live happy-path). **A1–A4 + sales-review + B1 pushed to `develop` (auto-deploys staging) on 2026-06-20** (`2021601..39cf299`); **the WAVE-NOW commits are local-only until the push** — ⚠️ staging NOT harness-verified (C2 env-support is in but the staging OTP source is undecided); exercise login + operator switcher + partner & sales-assisted redemption there manually. Servers
restarted this wave (backend `dist` rebuilt + restarted on :4000 for B2/B3/#53 runtime verify; owner may re-own); DB proxy on :5433
(`DEV-DB.md`). ⚠️ **B1 runtime tests left the deoleo seed-cp-1 wallet at 45000** (3 test redemptions) — realistic, consistent.

**Still OPEN (gap-register):** ✅ #44 (B2) · ✅ #49 (B3) · ✅ #53 · ✅ #46 harness coverage (C1, 59 passed) — all DONE
this wave. **✅ SEED ENRICHMENT DONE (`52f6698`, 2026-06-20):** deoleo seed now has CP003 (APPROVED KYC) + Visibility-Spend
CreditField + CB-2026-05 payout + DEMO-VIS ACTIVE scheme → the **populated live paths are runtime-verified** (B2
generate→IGST invoice ₹5,900 + idempotency + export-with-row; #53 full enrollment 201 ACTIVE). Ripple handled: deoleo
now 3 active partners (count-isolation spec updated). The dev-generated invoice was deleted to keep the harness
re-runnable (the seed SOURCE stays → generation is demonstrable on-demand). **✅ D1 DONE (`d947d55`):** admin
demo-chrome removed + Sidebar hydration fixed (see #45). **✅ D2 DONE (`60b5a76`, 2026-06-20, COMMITTED LOCAL — NOT
PUSHED):** platform-Prisma retirement — deleted 113 dead `app/api` routes + dead-transitive `lib` + `lib/prisma.ts` +
`platform/prisma/` + deps; rewired `layout.tsx` tenant-config → in-code `CLIENT_REGISTRY` (behavior-identical; real
multi-tenant SSR branding → `POST-GO-LIVE-BACKLOG §A`); auth/logout = stateless (B1); fixed the `Dockerfile`/`ci.yml`
`prisma generate` deploy breakers. **5 independent audits**; tsc 0 · next build green · harness 59 · vitest 0-new-reds
(−26k lines). ⚠️ **Docker image build NOT run locally (no Docker) → watch the staging deploy (first real image build).**
**▶ NEXT = P7 (Engagement & support)** — the P0.6 A–D wave is COMPLETE. **REMAINING (non-blocking, in `POST-GO-LIVE-BACKLOG.md`):**
D1-residuals (admin header notifications dropdown, partner DemoSwitcher/`lib/partner-session` demo personas, A1 KYC
brand column) · #48 admin trend-analytics (→ P8) · C2 staging real-OTP endpoint (→ P8.7; FIXED_OTP interim) · #47
configurable RBAC. The Q1 payouts BACKEND `@Roles` change is code-correct but NOT runtime-verified (RBAC off in dev;
the FE scope-out IS verified + harness-pinned via the redirect spec).

**Architecture/env:** 3 environments — **local dev** (`gifsy_dev`, isolated instance, `FIXED_OTP=123456`) · **staging**
(`gifsy_staging`, auto-deploys on **push to `develop`**) · **prod** (`gifsy_prod`, `main`, approval-gated). Full ref:
`ENVIRONMENTS.md` / [[environments-topology]]. All session changes are **dev-gated and staging-safe** (`FIXED_OTP`
skipIf, `NODE_ENV!=='production'` clientId override, DB-guarded seed). **Pushed to `develop` on 2026-06-19**
(auto-deploys to staging) — ⚠️ **staging is NOT harness-verified** (env-support TODO); exercise login + redemption +
scoping there manually. Seeded phones (gifsy_dev): gifsy `9830011252`/clientId `gifsy`, deoleo admin `9000000001`,
partner `9000000002` (wallet now <50k after redemption test runs), sales `9000000003`, clientb admin `9000000020`
(clientId `clientb`). Servers: backend `:4000` (rebuilt+restarted for `/partner/me`+throttle+redeem) · FE `:3000`
(restarted for the next.config change) · DB proxy `:5433`.

**Architecture (Phase S, done):** API-first — a dedicated NestJS backend built IN PLACE in `api/` (reused its shell,
deleted its World-A domain, rebuilt the real domain from the platform's `lib/`+schema), consumed by a thin Next.js FE
over a `next.config.ts` proxy (`/api/*` → backend `/v1/*`, wrapped `{success,data}`). FE calls `/api/*` directly —
**never add local `app/api/*` proxy routes** (the proxy already forwards; such routes are shadowed/dead). See
[[architecture-backend-split]] + `docs/spec/04-architecture.md`.

**THE REAL MODEL (owner-confirmed — do not relitigate; [[platform-real-model]]):** sales/achievement = **upload
FINAL amounts per outlet × parameter, NO compute**; segmentation **program = a reporting/filter facet, NOT a
targeting dimension**; no point-tiers, no SKU. Validate any inherited concept against this BEFORE building
([[reconcile-fit-before-build]]) — the codebase still has speculative World-A scaffolding.

**DONE so far (brief — full records in the reconcile docs + memories):**
- **P3 Onboarding & KYC** (`api/src/kyc/*`): two-stage two-lane field-level KYC. Closes #9/#12/#13/#14/#15.
  `reconcile/P3-onboarding-kyc.md` · [[p3-kyc-complete]]. (Touching KYC: enqueue notifications only AFTER the tx
  commits; resolve the primary outlet BEFORE any status flip.)
- **P4 Programs/Targets/Enrollment** (no compute): `KpiDef` · `OutletTarget` + verbatim per-outlet×KPI×month upload ·
  achievement (`/v1/admin/achievements/*`) + pace · enrollment. Schemes ⟂ targets. Closes #6/#10/#29.
  `reconcile/P4-programs-targets-enrollment.md` · [[p4-complete]]. P5 also closed the **P4 test-debt** (stale
  geo-hierarchy wizard tests retired/updated) + added **Download Final Targets export** + **past-month upload lock**.
- **P5 Wallet, points & rewards** (`api/src/{wallet,rewards}/*`): ledger-aware wallet primitives
  (`creditEarn`/`debitRedeem`/`reverse`/`adjust`/`expireDuePoints`) writing `WalletTransaction` **+** `PointsLedger`
  atomically + expiry sweep (**closes #28**); real `RewardCategory`/`RewardCatalog` admin CRUD (retired the
  gift-config JSON blob, #18-gift); redeem → OTP(`REDEMPTION_CONFIRM`) → debit → guarded status lifecycle +
  refund-on-cancel + voucher/tracking fulfilment (inline + bulk Excel); partner wallet/rewards FE + admin
  catalogue/fulfilment FE. Money-path audit caught + fixed real double-spend/oversell bugs (guarded
  PENDING→CONFIRMED claim, one-pending-order OTP binding, guarded stock claim, FIXED_OTP prod-gate, in-tx OTP
  consume, atomic refund claim). `reconcile/P5-wallet-points-rewards.md` · [[p5-complete]].

**P6 · Finance — ✅ DONE (2026-06-18, backend).** Full record: `reconcile/P6-finance.md` + `reconcile/P6.5-TDS-SPEC.md`.
**P0.5/P0.6 "Make It Runnable" — MOSTLY DONE (2026-06-19), enforced by the E2E harness (top of this doc).** Auth +
fabricated-data + scoping + dashboards + cross-tenant + the redemption money path + the **visibility/submit port**
are resolved & harness-green (**the next.config proxy-exclusion list is now EMPTY — no remaining dead writes via that
mechanism**). **P0.6 = Phases A–D** (code-grounded re-scope 2026-06-19): **A1** Gifsy oversight (#38) **✅** · **A2**
operator-context switcher (#51) **✅** · **A3** payouts money-path (#42/#43) **✅** · **A4** enforcement audit (#2) **✅**
→ **B1** sales-assisted redemption (#50-E) **✅** · **B2** invoices (#44) **← NEXT** · **B3** gifsy real data (#49, list ◐ done) →
**C** harness+staging → **D** cleanup (#45) + platform-retirement (#31/#32). Full plan: `00-MASTER-PLAN §P0.6` +
`reconcile/P0.5-make-it-runnable.md` + [[runtime-audit-p0.5]]. P7 (Engagement & support) resumes after D. The P6
decisions below are the historical record; all shipped.

**P6 key facts (DO NOT relitigate; full record: `reconcile/P6-finance.md` + `P6.5-TDS-SPEC.md` + [[p6-finance-decisions]]):**
- **Money = integer `BigInt` paise EVERYWHERE** (#19). Shared `money.ts` (api `src/common` + platform `src/lib`);
  global `BigInt.prototype.toJSON`→Number in `main.ts`; FE converts ↔₹ ONLY at the upload-ingest + display edges.
- **Two distinct money rails (#5)** — Awards/Credits `api/src/credits` (admin *push*) vs Redemption Payouts
  `api/src/payouts` (partner *pull*). Separate, never consolidated.
- **#16** — awarded POINTS credit the **partner** wallet on confirm (`walletService.creditEarn`, race-safe claim);
  reversal → `clawbackAward` (reduces redeemablePoints ONLY; lifetime counters monotonic). Already-redeemed
  **shortfall = report-only** (`CreditReversal.shortfallPaise`; supposed/reversed/pending; client settles off-platform).
- **#8/#15 invoicing** (`api/src/invoices`) — auto idempotent per-outlet/month self-bill; re-run never mutates a PAID
  invoice; GST from the **retailer GSTIN state vs 19** (Tech Gifsy/WB, `19AAACT9811F1Z9`); number editable-while-GENERATED,
  locked-once-PAID; KYC-complete guard. Deferred: invoice PDF/email.
- **#17** — per-tenant `features.visibilityCaptureMode` (`PHOTO_APPROVAL`/`AMOUNT_UPLOAD`) + Gifsy `PUT` toggle.
- **#25 TDS** (`api/src/tds`) — **194R** (client; per-tenant/FY; 10/20% no-PAN; ₹20k threshold, retroactive) +
  **194C** (Gifsy; platform per-PAN; 1/2/20%; >₹30k single|>₹1L agg; **two columns** w/ & w/o threshold);
  **grossed-up (payer-borne)**; **PAN-keyed** (null/off-platform PAN → `__NO_PAN__` 20%); **compute+track+export ONLY**
  (Form-16A/26Q filing OFF-platform — TRACES / future 3rd-party TDS API; §206AB removed). Redemption 194R value =
  **points ÷ conversionRate**, frozen at confirm on `RedemptionOrder.valuePaise`. Off-platform + deposit Excel uploads
  (PAN-required, `uploadBatchId` dedup); liability − deposited = outstanding. **Cash redemptions (UPI/BANK_TRANSFER)
  now create a `PayoutTransaction`** (the settlement bridge) → existing payouts engine. **Audit money paths hard.**

**AFTER the remaining P0.6 items (the actual NEXT — see the top of this prompt: the B-wave — sales
`/catalogue` redemption B1, invoices B2, finish B3 — then C harness+staging, D cleanup), then P7 · Engagement & support
(spec §02 WF6; 00-MASTER-PLAN §P7).** Banners, notifications, leaderboard,
tickets. Much read-side already exists (Phase S re-homed `api/src/{leaderboard,tickets,notifications}`). Tasks:
**7.0** reconcile Engagement + Support · **7.1** banner config (admin) + partner-app banners · **7.2 notification
engine** — templates/queue/delivery on the canonical **MSG91** path (**closes #21**; MSG91 = sole SMS/OTP/WhatsApp/email
provider; retire `lib/notifications.ts` axios senders + `nodemailer`; the S3 `NotificationsService.enqueue` seam +
DB template/queue exist — build the delivery worker) · **7.3** leaderboard config + snapshot + entries (ranking) ·
**7.4** ticket lifecycle + threaded messages + escalation/SLA/routing. **START P7:** confirm on `develop` + dev DB
reachable, read `00-MASTER-PLAN §P7` + the existing `api/src/{notifications,leaderboard,tickets}`, propose the P7
reconcile before building. (No P6 finance gaps remain open.)

**Residuals carried forward (NOT done — don't assume):**
- **Platform retirement (~P6, ONE unit):** stale `platform/prisma/schema.prisma` + still-live platform Prisma code
  (auth/session/client-config + `partner/invoices`[P6]; the proxy-exclusion list is now EMPTY — `visibility/submit`
  ported + dead route deleted, `admin/kyc` was a no-op) + the
  ~96 shadowed rollback-net route files + `lib/incentive`/`lib/kyc-approval`. **P5 note: the platform `lib/targets.ts`
  geo-hierarchy + `lib/gifts.ts`/`redemption-store.ts` demos are now dead/legacy but still imported by ~9 FE pages —
  they retire as part of this unit, NOT piecemeal.** ~120 platform files still use Prisma. Also Gap #32 `auth/logout`.
- P5 deferred: **holding/lock period** (schema fields kept — `lockedUntil`/`lockedPoints`/`LOCK_HOLDING`; ~½-day, no
  migration). `lib/invoice` reg-type read = **P6**. WhatsApp + notification worker (#21) = **P7/MSG91**. Seed `kyc:*`
  perms + enable RBAC (OFF by default — `RBAC-ENABLEMENT.md`). target-config/banner JSON-blob normalization (#18 resid).

ROLE & OPERATING MODEL (owner-agreed): you ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute
(Sonnet executor, run in background; they have NO shell — you run the gate) → ONE independent adversarial audit
(Sonnet, Read/Grep — also no shell) → Opus gates → commit.** AUDIT EVERYTHING — don't risk-tier (audits this session
caught real DOUBLE-SPEND/oversell bugs in the redemption money-path that tsc+tests missed; also cross-tenant keys,
tx-escaping notifications, half-commits). Parallelize streams that touch disjoint files; Opus owns `schema.prisma` +
migrations so executors never collide. The gate (run it YOURSELF): `cd api && npx tsc -p tsconfig.build.json --noEmit`
(0) + `npx jest <area>` + a boot smoke for new endpoints; for FE, `cd platform && npx tsc --noEmit -p tsconfig.json` +
`npx vitest run <area>` (platform = **vitest**, not jest) + `node scripts/check-doc-consistency.mjs` GREEN. After a
task, re-run the full FE suite and diff failing FILES vs `reconcile/baseline-red-snapshot.txt` — **no NEW reds**.
Sweep docs (reconcile/gap-register/RESUME/00-MASTER-PLAN/memory) after every task. Protocol: `DOC-MAINTENANCE.md`.

CONSTRAINTS (must hold):
- WORK ON **develop**. **main = prod releases only — never push main.** **Commit/push ONLY when the owner asks.**
  Never expose secrets (grep/cut DB creds without echoing). ⚠️ Don't `git add -A` while a background FE executor is
  mid-write — it sweeps half-written files into the wrong commit (happened in P5; recoverable, local-only, but messy).
- DEV DB = Cloud SQL `gifsy-db-dev` via Auth Proxy on **127.0.0.1:5433** / `gifsy_dev` (drops after reboot — restart
  per `DEV-DB.md`). **`SELECT 1` + confirm `current_database='gifsy_dev'` before migrating.** NEVER point dev at prod.
  **NEVER `prisma migrate dev`** (RESETS gifsy_dev) — use guarded SQL via `prisma db execute --file` (no `--schema`
  flag in Prisma 7; URL comes from `prisma.config.ts`) in `api/prisma/migrations-manual/`, txn-guarded by
  `current_database='gifsy_dev'`. **`ALTER TYPE … ADD VALUE` must run OUTSIDE a transaction** (see
  `P3_doctype_split.sql` / `P5_wallet_rewards_additive.sql` for the proven shape). **SHOW migration SQL
  (independently audited) + WAIT for owner go before applying.** Never `DEMO_MODE` in staging/prod.
- ⚠️ **SCHEMA SOURCE OF TRUTH = `api/prisma/schema.prisma`** (P5 added `OtpPurpose.REDEMPTION_CONFIRM`,
  `RewardCatalog.stockQuantity`, `RedemptionOrder.voucherCode/voucherProvider`). `platform/prisma/schema.prisma` is
  stale — retires ~P6.
- CI is red-by-design (TDD-baseline fails) — gate is DIFFERENTIAL ("no NEW reds vs the snapshot").
- ⚠️ **Backend dev gotchas (recur on restart):** (1) `api/.env` was once found pointing at **PROD (`gifsy_prod`)** —
  re-verify it reads `127.0.0.1:5433/gifsy_dev` before any DB op. (2) The dev backend runs a compiled `dist/`; new
  code needs a rebuild, and repeated `tsc --noEmit` gate runs **poison `tsconfig.tsbuildinfo`** so `nest build` emits
  nothing → rebuild with `tsc -p tsconfig.build.json --incremental false`, then `node dist/main.js`. (3) The owner
  already runs servers; a stale backend may hold :4000 (`EADDRINUSE`) — find the PID
  (`Get-NetTCPConnection -LocalPort 4000`) + `Stop-Process` before starting the fresh build. Platform :3000 is Next
  dev (serves FE live from disk — no restart needed for FE changes).

Reload (read before building):
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P6 + S DONE**; **P0.5/0.6 ◐ — A1–A4 + B1 DONE+pushed; WAVE-NOW (B2 · B3-finish · #53 · C2) DONE+audited+runtime-verified, COMMITTED local NOT pushed; NEXT = push the wave → C1 → D1→D2 serial → P7**)
- docs/plans/MODEL-ALIGNMENT.md           (the REAL parameter model)
- docs/plans/P6-TDS-EXPLAINER.md          (TDS structure for owner review — 6.5 is HELD on its 4 questions)
- docs/plans/reconcile/{P6-finance,P6.5-TDS-SPEC,P5-wallet-points-rewards,P4-programs-targets-enrollment}.md  (build records)
- docs/plans/08-agent-execution-guide.md · GIT-WORKFLOW.md · DEV-DB.md · DOC-MAINTENANCE.md · RBAC-ENABLEMENT.md
- docs/spec/gap-register.md               (open gaps; 19 resolved; P6 magnets = #16 + #7/#8/#19/#25)
- memory: [[p6-finance-decisions]] · [[p5-complete]] · [[p4-complete]] · [[p3-kyc-complete]] · [[architecture-backend-split]] · [[platform-real-model]] · [[reconcile-fit-before-build]] · [[own-consistency-no-micromanage]]

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (restart per DEV-DB.md); platform on :3000 (Next dev) + backend on :4000
(rebuild `dist` + `node dist/main.js`). Drive the live app via the Chrome extension (not preview_start). Confirm on
`develop` + dev DB reachable. Before any migration/irreversible step, show the SQL/plan (independently audited) + wait.
```
