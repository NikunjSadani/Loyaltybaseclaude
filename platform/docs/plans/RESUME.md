# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️⚠️ **STATE: P0 · P1 · P2 · Phase S · P3 · P4 · P5 ALL ✅ COMPLETE. NEXT = P6 (Finance: credits, payouts,
visibility, invoicing).** Everything pushed to origin/develop (≤ `51231fc`). 19 gaps resolved (latest #28 via P5).

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

**NEXT = P6 · Finance: credits, payouts, visibility, invoicing (spec §02 WF2/WF3; 00-MASTER-PLAN §P6).** The money
spine — most High-severity gaps live here. **◐ RECONCILE DRAFTED (2026-06-18) — decisions locked, build NOT started.**
Full record: `reconcile/P6-finance.md`. Audit found most P6 models + read-side routes already exist (Phase S);
P6 = reconcile + wire-up, not build-from-zero.

**Owner-locked decisions (do not relitigate):**
- **Two distinct money rails (#5)** — **Awards & Credits** (admin *pushes* awards, `credits/*`, was Decimal-INR) vs
  **Redemption Payouts** (partner *pulls* cash, `payouts/*`, paise + Fund + TDS). Keep separate; rename for clarity;
  NOT a consolidation.
- **#19 money unit — ✅ DONE (6.0, 2026-06-18): integer `BigInt` paise EVERYWHERE.** Awards rail `Decimal`-INR →
  `BigInt` paise (renamed `*Inr`→`*Paise`; `totalPoints`→whole `Int`); existing paise rail widened `Int`→`BigInt`
  (int4 overflow fix, done while tables empty — audit finding); shared `money.ts` (`rupeesToPaise`/`paiseToRupees`/
  `toPaiseBigInt`) in api+platform; global `BigInt.prototype.toJSON`→Number in `main.ts`; killed JS float-sum.
  Migration `P6_credits_paise_standardisation.sql` applied to gifsy_dev (guarded/idempotent, tables were empty).
  Conversion happens ONCE (FE ingest edge), ÷100 for display only. Gate green; dead platform credit routes +
  `credits-payouts-notify` lib left on old `*Inr` contract (retire later). **Not committed** (owner commits on ask).
- **#16 (HIGH) — ✅ DONE (Stream 1, 2026-06-18):** `confirmBatch` credits POINTS → the **partner** wallet
  (`creditEarn`, race-safe guarded claim, no-wallet outlets skipped+reported); reversal approval → new
  `walletService.clawbackAward` (`DEBIT_ADJUSTMENT`, reduces **only `redeemablePoints`** — `earnedPoints`/lifetime*
  stay monotonic per the locked invariant). Money-path audited (no double-credit/-debit). The
  already-redeemed **shortfall** is **owner-decided = report-only**: persisted on `CreditReversal.shortfallPaise`
  (migration `P6_reversal_shortfall.sql`); report = supposed(`approvedPaise`)/reversed(`approved−shortfall`)/
  pending(`shortfall`); client settles `pending` **off-platform** (no platform write-off/recovery). Remaining: FE
  reversal report columns.
- **#8 invoicing — included, built LAST.** Logic already pure in `lib/invoice.ts` (GST-from-reg-type, number-gen);
  port + persist; needs `AutoInvoice` delta (status/finalize-lock/`invoiceNumberEdited`/snapshot). #15 GST reads reg-type.
- **#17 (Visibility capture-mode) — ✅ DONE (Stream 2 + toggle, 2026-06-18):** per-tenant `features.visibilityCaptureMode`
  (`PHOTO_APPROVAL` default | `AMOUNT_UPLOAD`) in `Client.features` JSON (no migration); mutating entry points gated
  by mode; **Gifsy-admin toggle** (`PUT /v1/admin/settings/visibility-capture-mode`, `tenancy:manage_flags`, features-merge
  no-clobber) + segmented control on the admin settings screen. Residual: photo `submit` still unported (GCS).
- ◐ **#25 TDS — SPEC DRAFTED (`reconcile/P6.5-TDS-SPEC.md`), awaiting owner sign-off; NO code yet.** Owner-confirmed:
  **194R** (incentive; deductor=client; per-tenant/FY; 10%/20%-no-PAN; ₹20k) vs **194C** (visibility; deductor=Gifsy;
  platform-level per-PAN; 1%/2%/20%; >₹30k single|>₹1L agg; **GST-exclusive base**; two columns w/ & w/o threshold).
  **Grossed-up (payer-borne)** only (no config flag — current tenant); **PAN-keyed** incl. off-platform unknown PANs;
  FY-scoped; **compute+track+export only** (filing/Form-16A off-platform via TRACES / future third-party TDS API;
  §206AB removed). 194R taxable event = cash payout at PAID + redemption at fulfilment + off-platform upload.
  **Recommend 6.7 (invoicing) BEFORE 6.5** (194C base = invoice pre-GST base). Build only after sign-off.

**Sequencing:** **6.0 ✅ · Stream 1 (Credits #16) ✅ · Stream 2 (Visibility #17) ✅** (all on `develop`; 6.0
committed `13c5d4e`; Streams 1+2 commit pending). **Remaining: Invoicing (6.7) LAST; Payouts/TDS (6.5: P5
`RedemptionOrder`→`PayoutTransaction` settlement bridge + #25) HELD** until the TDS review. **NEXT ACTION:** write
the TDS explainer for owner review and/or start Invoicing (6.7). Also pending: owner decision on the reversal
shortfall settlement policy; a `PUT` admin setter for `visibilityCaptureMode`. Depends on P5 + P3 + P2.

**Residuals carried forward (NOT done — don't assume):**
- **Platform retirement (~P6, ONE unit):** stale `platform/prisma/schema.prisma` + still-live platform Prisma code
  (auth/session/client-config + the proxy-excluded `visibility/submit`+`partner/invoices`[P6] / `admin/kyc`) + the
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
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P5 + S DONE**; **§P6 = NEXT**)
- docs/plans/MODEL-ALIGNMENT.md           (the REAL parameter model)
- docs/plans/P6-TDS-EXPLAINER.md          (TDS structure for owner review — 6.5 is HELD on its 4 questions)
- docs/plans/reconcile/{P5-wallet-points-rewards,P4-programs-targets-enrollment,P3-onboarding-kyc}.md  (build records)
- docs/plans/08-agent-execution-guide.md · GIT-WORKFLOW.md · DEV-DB.md · DOC-MAINTENANCE.md · RBAC-ENABLEMENT.md
- docs/spec/gap-register.md               (open gaps; 19 resolved; P6 magnets = #16 + #7/#8/#19/#25)
- memory: [[p5-complete]] · [[p4-complete]] · [[p3-kyc-complete]] · [[architecture-backend-split]] · [[platform-real-model]] · [[reconcile-fit-before-build]] · [[own-consistency-no-micromanage]]

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (restart per DEV-DB.md); platform on :3000 (Next dev) + backend on :4000
(rebuild `dist` + `node dist/main.js`). Drive the live app via the Chrome extension (not preview_start). Confirm on
`develop` + dev DB reachable. Before any migration/irreversible step, show the SQL/plan (independently audited) + wait.
```
