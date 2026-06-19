# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️ **STATE (2026-06-19): the ENFORCEMENT is built and the local matrix is GREEN — but green is BOUNDED, not
"the whole app works".** The Playwright E2E harness (`platform/e2e`, `npm run e2e`, **37/37 green**) now covers
real-login-per-role · real scoped data (no fabrication) · role/portal scoping · cross-tenant isolation (BOTH
directions) · write-persistence (tickets · the partner redemption MONEY PATH · the partner VISIBILITY submit).
It is re-runnable (dev throttle
disabled via `skipIf(FIXED_OTP)`). **It does NOT yet cover every page/flow** — most admin sub-pages, partner
targets/leaderboard, sales team/outlets, the gifsy console (mock, #49), and most write flows are unverified. Read
FIRST: [[e2e-harness]] · `e2e/README.md` · `GO-LIVE-READINESS.md` · `DATA-VISIBILITY.md` · `VERIFICATION-PROTOCOL.md`
· gap-register **#33–#50** · [[runtime-audit-p0.5]] · [[verify-flows-at-runtime]].

**THE DEFINITION OF DONE (`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow
end-to-end at RUNTIME against realistic multi-role data — canonical surface · role matrix · cross-tenant · DB
persistence seen by a different session · honest unhappy path. `tsc`/unit tests are necessary, NEVER sufficient.
**A green harness means "the asserted slices work" — NOT "everything works".** NEVER sample / "should be fine".

**RESOLVED this session (harness-verified):** #46 the harness itself · #39 GIFSY login (dev `clientId` override on
the login form + prod subdomain; clientb login too) · #40 fabricated data (partner/sales identity via `/partner/me`;
admin KPIs real) · #41 role/portal guards + Q1 payouts GIFSY-only · #47 admin dashboard KPIs · cross-tenant (2nd
tenant `clientb` seeded) · **#50 the partner REDEMPTION MONEY PATH** (was 100% broken). Q1–Q6 owner decisions encoded
in `DATA-VISIBILITY.md §3`.

**🔑 KEY PATTERN (now CLEARED) — `platform/next.config.ts` proxy-exclusions WERE the map of DEAD WRITES.** Its
`beforeFiles` rewrite excluded some `/api/*` paths from the backend proxy (negative lookahead), routing them to stale
local `src/app/api/*/route.ts` handlers on the **RETIRED platform Prisma** → they threw. **ALL EXCLUSIONS NOW DROPPED
(`/api/:path*` forwards everything):** redemption (P5 backend, fixed 2026-06-19) · **`visibility/submit` PORTED**
(`POST /v1/visibility/submit` — multipart→GCS via `StorageService`, partner-from-JWT, outlet-from-partner,
PHOTO_APPROVAL gate, partner-only `@Roles`; dead local route deleted; harness write-persistence test green) ·
`admin/kyc` was a **no-op** exclusion (KYC writes already at `/v1/kyc/*`; FE calls `/api/kyc/*`, never matched).
**NEXT = P0.6 Phases A–D (re-scoped 2026-06-19 from a code-grounded audit; full plan in `00-MASTER-PLAN §P0.6` +
`reconcile/P0.5-make-it-runnable.md`; owner decisions in `DATA-VISIBILITY §3.1`).** **✅ A1 — Gifsy cross-tenant
access DONE (#38, 2026-06-19):** `kycTenantFilter`/`submissionTenantFilter` make GIFSY_ADMIN exempt from the
caller-tenant filter (KYC + visibility); reviewQueue emits each record's clientId; FE got a brand column/filter;
clientb seeded a PENDING_GIFSY KYC. Runtime-verified (6 checks) + api jest 783/783 + harness 39/39 + independent
audit PASS (notes: slaMetrics/outletStatuses same-class → A3). **NEXT = A2** payouts money path
(`processBatch` txn+guarded-claim + canonical TDS, #42/#43) ∥ **A3** enforcement coverage audit (#2); then **B1**
sales-assisted redemption real (#50-E) ∥ **B2** invoices/Excel (#44) ∥ **B3** gifsy console real data (#49); then
**C** harness+staging, **D** cleanup+platform-retirement. **Decisions:** Gifsy=sees-all console + brand-labeled
queues · RBAC=@Roles-only+coverage-audit for launch · sales-redeem=real · tenant-creation=deferred but
provision-ready. ⚠️ **Seeds note:** `seedDeoleoDemo` now seeds VisibilityProgram `VP001` (seed-vp-1). **Servers were
restarted this session** with the new build (backend `dist` rebuilt; FE restarted for next.config) — owner may re-own.

**Still OPEN (gap-register):** #38 Gifsy cross-tenant access (real bug → A1) · #42 payouts.processBatch ·
#43 TDS · #44 Excel round-trips · #45 cleanup/dead-routes (P0.7) · #48 admin trend-analytics · #49 gifsy console
real-data · #47 configurable RBAC. **Plus: STAGING harness env-support** (the harness only runs local; needs MSG91-OTP
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
mechanism**). **Remaining P0.6 = Phases A–D** (code-grounded re-scope 2026-06-19): **A** Gifsy cross-tenant access
(#38) + payouts money-path (#42/#43) + enforcement audit (#2) → **B** sales-assisted redemption (#50-E) + invoices
(#44) + gifsy real data (#49) → **C** harness+staging → **D** cleanup (#45) + platform-retirement (#31/#32). Full
plan: `00-MASTER-PLAN §P0.6` + `reconcile/P0.5-make-it-runnable.md` + [[runtime-audit-p0.5]]. P7 (Engagement &
support) resumes after D. The P6 decisions below are the historical record; all shipped.

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

**AFTER the remaining P0.6 items (the actual NEXT — see the top of this prompt: `payouts.processBatch` #42, sales
`/catalogue` redemption, KYC cross-tenant verify #38, cleanup), then P7 · Engagement & support
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
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P6 + S DONE**; **P0.5/0.6 ◐ — dead-write ports DONE; remaining = payouts.processBatch #42 / sales-redemption / KYC verify #38 / cleanup; then P7**)
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
