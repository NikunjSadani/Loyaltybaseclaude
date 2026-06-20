# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️ **STATE (2026-06-19): the ENFORCEMENT is built and the local matrix is GREEN — but green is BOUNDED, not
"the whole app works".** The Playwright E2E harness (`platform/e2e`, `npm run e2e`, **40/40 green**) now covers
real-login-per-role · real scoped data (no fabrication) · role/portal scoping · cross-tenant isolation (BOTH
directions) · write-persistence (tickets · the partner redemption MONEY PATH · the partner VISIBILITY submit) ·
**Gifsy cross-tenant KYC (A1)** · **the Gifsy operator-context SWITCHER round-trip (A2-FE)**. Re-runnable (dev
throttle disabled via `skipIf(FIXED_OTP)`). **It does NOT yet cover every page/flow** — most admin sub-pages, partner
targets/leaderboard, sales team/outlets, the gifsy dashboard/detail (still registry-mock — B3 list IS real now), and
most write flows are unverified. Read FIRST: [[e2e-harness]] · `e2e/README.md` · `GO-LIVE-READINESS.md` ·
`DATA-VISIBILITY.md` · `VERIFICATION-PROTOCOL.md` · gap-register **#33–#51** · [[runtime-audit-p0.5]] · [[verify-flows-at-runtime]].

**THE DEFINITION OF DONE (`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow
end-to-end at RUNTIME against realistic multi-role data — canonical surface · role matrix · cross-tenant · DB
persistence seen by a different session · honest unhappy path. `tsc`/unit tests are necessary, NEVER sufficient.
**A green harness means "the asserted slices work" — NOT "everything works".** NEVER sample / "should be fine".

**RESOLVED (cumulative, harness-verified):** #46 the harness · #39 GIFSY login · #40 fabricated data · #41 role/portal
guards + Q1 payouts GIFSY-only · #47 admin dashboard KPIs · cross-tenant (`clientb` seeded) · **#50 partner REDEMPTION
MONEY PATH** · **#36 visibility/submit PORTED** · **#38 A1 Gifsy cross-tenant oversight** · **#51 A2 operator-context
switcher (backend+FE)** · **#49 B3 ◐ gifsy clients-list real**. Owner decisions in `DATA-VISIBILITY.md §3 + §3.1`.

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

**NEXT = the B-wave (parallel, disjoint modules):** ∥ **B1** sales-assisted redemption real (#50-E,
`api/src/rewards` sales-context + `sales/catalogue`; money path) ∥ **B2** invoices/Excel (#44, `api/src/invoices`) ∥ finish
**B3** (gifsy Overview dashboard + per-client detail still `CLIENT_REGISTRY`); then **C** harness+staging, **D**
cleanup+platform-retirement. **Decisions:** RBAC=@Roles-only+coverage-audit for launch ·
sales-redeem=real · tenant-creation=deferred but provision-ready. **Payouts audit: P6 was sound** — the payout gaps
are a documented P6 hold (6.5 ON HOLD) + a Q1 consequence, not P6 errors. ⚠️ **Seeds note:** `seedDeoleoDemo` seeds
VisibilityProgram `VP001` (seed-vp-1); `seedClientBDemo` seeds a PENDING_GIFSY KYC (seed-kyc-b1). **All session work
pushed to `develop` (auto-deploys staging) on 2026-06-19** — ⚠️ staging NOT harness-verified (C2 env-support TODO);
exercise login + the operator switcher + redemption there manually. Servers restarted this session (backend `dist` +
FE) — owner may re-own; DB proxy on :5433 restarted (`DEV-DB.md`).

**Still OPEN (gap-register):** #50-E sales-assisted redemption (→ B1) · #44 Excel round-trips (→ B2) · #49 gifsy dashboard/detail (→ finish
B3) · #45 cleanup/dead-routes (P0.7 → D1) · #31/#32 platform-retirement (→ D2) · #48 admin trend-analytics (→ P8) ·
#47 configurable RBAC (deferred). **Plus: STAGING harness env-support** (the harness only runs local; needs MSG91-OTP
injection + staging tenant slugs before staging is a real gate). The Q1 payouts BACKEND `@Roles` change is
code-correct but NOT runtime-verified (RBAC off in dev; the FE scope-out IS verified).

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
→ **B1** sales-assisted redemption (#50-E) **← NEXT** · **B2** invoices (#44) · **B3** gifsy real data (#49, list ◐ done) →
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
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P6 + S DONE**; **P0.5/0.6 ◐ — A1+A2+A3+A4 DONE; NEXT = B-wave (B1/B2/B3); then C/D; then P7**)
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
