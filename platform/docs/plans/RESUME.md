# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️⚠️ **STATE: P0 · P1 · P2 · Phase S · P3 · P4 ALL ✅ COMPLETE. NEXT = P5 (Wallet, points & rewards).**
Everything pushed to origin/develop (≤ `a5c9beb`). 18 gaps resolved (latest #6/#10/#29 via P4).

**Architecture (Phase S, done):** API-first — a dedicated NestJS backend built IN PLACE in `api/` (reused its shell,
deleted its World-A domain, rebuilt the real domain from the platform's `lib/`+schema), consumed by a thin Next.js FE
over a `next.config.ts` proxy (`/api/*` → backend `/v1/*`, wrapped `{success,data}`). FE calls `/api/*` directly —
**never add local `app/api/*` proxy routes** (the proxy already forwards; such routes are shadowed/dead). The World-A
de-scaffold (tiers/partner-class/compute/SKU) was absorbed into Phase S S2 — the backend is born clean. See
[[architecture-backend-split]] + `docs/spec/04-architecture.md`.

**THE REAL MODEL (owner-confirmed — do not relitigate; [[platform-real-model]]):** sales/achievement = **upload
FINAL amounts per outlet × parameter, NO compute**; segmentation **program = a reporting/filter facet, NOT a
targeting dimension**; no point-tiers, no SKU. Validate any inherited concept against this BEFORE building
([[reconcile-fit-before-build]]) — the codebase still has speculative World-A scaffolding.

**DONE so far (brief — full records in the reconcile docs):**
- **P3 Onboarding & KYC** (`api/src/kyc/*`): two-stage, two-lane field-level KYC (status machine + 7-field
  `KycVerificationItem` grid; one `evaluateSubmission` bridge). Closes #9/#12/#13/#14/#15.
  `reconcile/P3-onboarding-kyc.md` · [[p3-kyc-complete]]. Two invariants if you touch KYC: **enqueue notifications
  only AFTER the tx commits**; **resolve the primary outlet BEFORE any status flip**.
- **P4 Programs/Targets/Enrollment** (no compute): `KpiDef` (per-tenant params) · `OutletTarget` (mirrors
  `OutletSalesRecord`) + verbatim per-outlet×KPI×month upload (blank=omit, 0 stored, non-template→400) ·
  achievement (`/v1/admin/achievements/*`) + pace (÷0→null) · enrollment (`SchemeEnrollmentForm` + validator +
  `POST /v1/schemes/:id/enroll` SELF/SALES + audience-by-KYC + server-side `CALCULATED` recompute). **Schemes ⟂
  targets — zero linkage.** World-A `SchemeTarget` + `lib/incentive` compute DROPPED. FE wired (vitest 133).
  Closes #6/#10/#29. `reconcile/P4-programs-targets-enrollment.md` · [[p4-complete]].

**NEXT = P5 · Wallet, points & rewards (spec §02 WF4).** ⚠️ Magnet gaps: **#16** (POINTS awards never credit the
wallet — credits confirm writes `CreditPayoutEntry` only, no `Wallet`/`PointsLedger` write) + **#28** (`lib/wallet`
credit/debit update aggregate counters + `WalletTransaction` but **never write `PointsLedger`** → expiry/holding
config is dead). Tasks (00-MASTER-PLAN §P5): 5.0 reconcile Wallet+Rewards (validate inherited `lib/wallet.ts`/
`lib/gifts.ts` vs the real model FIRST) · 5.1 wallet read/transactions/admin-adjust · 5.2 **PointsLedger writes on
credit/debit + expiry/holding (#16/#28)** · 5.3 rewards catalog/inventory (Gifsy-managed) · 5.4 redemption order +
OTP + lifecycle/fulfilment · 5.5 partner wallet+rewards UI. **START P5:** confirm on `develop` + dev DB reachable,
read `00-MASTER-PLAN.md §P5` + `MODEL-ALIGNMENT.md`, propose the P5 reconcile before building. Depends on P1.

**Residuals carried forward (NOT done — don't assume):**
- **Platform retirement (~P6, ONE unit):** stale `platform/prisma/schema.prisma` + still-live platform Prisma code
  (auth/session/client-config + the proxy-excluded `rewards/redeem`[P5] / `visibility/submit`+`partner/invoices`[P6]
  / `admin/kyc`) + the ~96 shadowed rollback-net route files + `lib/incentive`/`lib/kyc-approval`. 120 platform files
  still use Prisma; deleting before they port breaks the running platform. Also Gap #32 `auth/logout` revocation.
- `lib/invoice` reads persisted `entityType`/`gstRegistrationType` = **P6**. WhatsApp delivery + notification worker
  (#21) = **P7/MSG91**. Seed `kyc:*` perms + enable RBAC (OFF by default — `RBAC-ENABLEMENT.md`). target-config/
  banner/gift JSON-blob normalization (#18 residual).

ROLE & OPERATING MODEL (owner-agreed): you ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute
(Sonnet executor, run in background; they have NO shell — you run the gate) → ONE independent adversarial audit
(Sonnet, Read/Grep — also no shell) → Opus gates → commit.** AUDIT EVERYTHING — don't risk-tier (audits have caught
a cross-tenant key, a tx-escaping notification, a half-commit, an inverted mask, a dead-proxy-route mistake that
tsc+tests missed). Parallelize streams that touch disjoint files; Opus owns `schema.prisma` + migrations so executors
never collide. The gate (run it YOURSELF): `cd api && npx tsc -p tsconfig.build.json --noEmit` (0) + `npx jest <area>`
+ a boot smoke for new endpoints; for FE, `cd platform && npx tsc --noEmit -p tsconfig.json` + `npx vitest run <area>`
(platform = **vitest**, not jest) + `node scripts/check-doc-consistency.mjs` GREEN. Sweep docs (reconcile/gap-register/
RESUME/00-MASTER-PLAN/memory) after every task. Protocol: `docs/plans/DOC-MAINTENANCE.md`.

CONSTRAINTS (must hold):
- WORK ON **develop**. **main = prod releases only — never push main.** **Commit/push ONLY when the owner asks.**
  Never expose secrets (grep/cut DB creds without echoing).
- DEV DB = Cloud SQL `gifsy-db-dev` via Auth Proxy on **127.0.0.1:5433** / `gifsy_dev` (drops after reboot — restart
  per `DEV-DB.md`). **`SELECT 1` + confirm `current_database='gifsy_dev'` before migrating.** NEVER point dev at prod.
  **NEVER `prisma migrate dev`** (RESETS gifsy_dev) — use guarded SQL via `prisma db execute` (txn guarded by
  `current_database='gifsy_dev'`, in `api/prisma/migrations-manual/`). **SHOW migration SQL (independently audited) +
  WAIT for the owner's go before applying.** Never `DEMO_MODE` in staging/prod.
- ⚠️ **SCHEMA SOURCE OF TRUTH = `api/prisma/schema.prisma`** (+`KpiDef`/`OutletTarget`/`TargetUploadBatch`/
  `SchemeEnrollmentForm` from P4). `platform/prisma/schema.prisma` is stale — retires ~P6.
- CI is red-by-design (~105 TDD-baseline fails until P8) — the gate is DIFFERENTIAL ("no NEW reds").
- ⚠️ **Backend dev gotchas (recur on restart):** (1) `api/.env` was found pointing at **PROD (`gifsy_prod`)** —
  it's now on the dev proxy; re-verify before any DB op. (2) The dev backend runs a compiled `dist/`; new code needs
  a rebuild, and repeated `tsc --noEmit` gate runs **poison the incremental `tsconfig.tsbuildinfo`** so `nest build`
  emits nothing (exit 0, empty `dist/`) → rebuild with `tsc -p tsconfig.build.json --incremental false` (or delete
  `*.tsbuildinfo`), then `node dist/main.js`.

Reload (read before building):
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P4 + S DONE**; **§P5 = NEXT**)
- docs/plans/MODEL-ALIGNMENT.md           (the REAL parameter model — spine of P5 wallet/points reconcile)
- docs/plans/reconcile/{P4-programs-targets-enrollment,P3-onboarding-kyc}.md  (build records — pattern/reference)
- docs/plans/08-agent-execution-guide.md · GIT-WORKFLOW.md · DEV-DB.md · DOC-MAINTENANCE.md · RBAC-ENABLEMENT.md
- docs/spec/gap-register.md               (open gaps; 18 resolved; P5 magnets = #16/#28)
- memory: [[p4-complete]] · [[p3-kyc-complete]] · [[architecture-backend-split]] · [[platform-real-model]] · [[reconcile-fit-before-build]] · [[own-consistency-no-micromanage]]

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (restart per DEV-DB.md); the owner runs platform on :3000 + backend on
:4000 (drive the live app via the Chrome extension, not preview_start). Confirm on `develop` + dev DB reachable.
Before any migration/irreversible step, show the SQL/plan (independently audited) + wait for the owner's go.
```
