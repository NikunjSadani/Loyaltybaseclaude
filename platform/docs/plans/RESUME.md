# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build (multi-tenant trade-loyalty platform,
C:\Users\nikun\Loyaltybaseclaude\platform).
⚠️⚠️ **NEXT (BEFORE P4) = WHOLE-SYSTEM TOPOLOGY RECONCILE + ARCHITECTURE DECISION — do this FIRST.** A late
discovery (2026-06-16): the git ROOT has TWO services — `platform/` (Next.js, full-stack: 119 prisma-using API
routes, owns its schema) + `api/` (NestJS, 74-model schema, **the platform never calls it**) — and `terraform/`
provisions the platform as a **stateless frontend** + the api as the **DB owner** (the platform has NO prod
`DATABASE_URL`). So the deployed infra contradicts the built code. **OWNER DIRECTION:** the frontend/api were
split deliberately for **future mobile-app / PWA scalability** (consultant-advised); owner leans toward the
**SEPARATED architecture** (dedicated API backend + thin frontend) as the target — Opus over-weighted "avoid
rework" first and walked it back. **TASK 0 (gates everything, incl. whether P3+ is built full-stack or separated
— don't build P3+ until settled, or it's built twice):** (1) a whole-repo topology reconcile — inventory git
root (both apps, terraform, CI/CD, all DBs, Redis?, what's LIVE vs LEGACY, real prod data-flow); (2) **assess the
`api/` service's actual maturity** (viable backend foundation vs abandoned scaffolding — decides the effort); (3)
produce a concrete **separate-now migration plan + real effort estimate** (NOW ≈ ~119 routes/80 models migrate
once; LATER ≈ ~2× as P3–P8 add surface; lib/ is portable; terraform ALREADY fits separation so no infra rework).
Then owner decides with numbers. See Gap #30/#31 + `04-architecture.md`. **P4.0 de-scaffold is AFTER this.** Reload by reading:
- docs/plans/MODEL-ALIGNMENT.md           (the platform's REAL model + the P4.0 de-scaffold scope — after Task 0)
- docs/plans/00-MASTER-PLAN.md            (phases P0→P9; P2 = DONE; P4 section has the de-scaffold callout)
- docs/plans/08-agent-execution-guide.md  (role, loop, review gate, context bundles)
- docs/plans/01-how-we-test.md            (test conventions; deterministic; two styles)
- docs/plans/GIT-WORKFLOW.md              (branches/deploy — WORK ON develop, main=releases)
- docs/plans/DEV-DB.md                    (dev DB + Auth Proxy restart; migrate gotcha; drop-migration via guarded SQL)
- docs/plans/reconcile/baseline-red-snapshot.txt   (the gate: NO NEW reds vs this snapshot = 28 files/105 tests)
- docs/plans/DOC-MAINTENANCE.md            (⚠️ doc-consistency is a GATE STEP: run `node scripts/check-doc-consistency.mjs` — must be green — before any wave/model change is "done"; CI enforces it; ownership map = which doc owns which fact)
- docs/plans/reconcile/P2-org-master-data.md  (P2 reconcile + RF1–RF7 + the catalog/sales-upload addendum)
- docs/plans/RBAC-ENABLEMENT.md           (how to turn RBAC enforcement on — it's OFF by default)
- docs/plans/REPORTING-REVAMP.md          (user-driven reporting track, built ahead of P8 for client sign-off)
- docs/plans/KYC-APPROVAL-REVAMP.md        (P3 design: Gifsy bulk KYC verify/approve — DEMO workflow BUILT on develop; schema/persistence = P3)
- docs/spec/gap-register.md               (open gaps + what P0/P1 resolved)
- your memory notes: loyaltybase-spec-effort.md + platform-real-model.md + reconcile-fit-before-build.md

ROLE & OPERATING MODEL (user-agreed for speed): you orchestrate, plan, GATE, and personally audit
high-risk work; you do NOT just trust an executor's word — a task is done only when YOUR gate passes
(re-run npx tsc --noEmit + npm test [differential] + lint + **`node scripts/check-doc-consistency.mjs`
[doc-consistency gate — must be green]** yourself; check DRY/YAGNI/clientId/secrets;
real-DB evidence for DB work). Run tasks as PARALLEL WAVES of disjoint Sonnet executors; PIPELINE the
auditors (audit task A while building task B); BATCH the gate once per wave. **When documenting, fan out
independent build/recon agents in parallel — don't serialize** (owner directive). **AUDIT EVERYTHING — do NOT
risk-tier:** every task (incl. pure-function/doc) gets an independent audit (owner directive). **Docs are
maintained by the best agent (Opus)** — sweep spec/gap-register/reconcile/RESUME/memory after every wave +
run the doc-consistency scan (CI enforces it via `.github/workflows/doc-consistency.yml`; the local Stop hook
only fires if Claude is launched from `platform/`). Protocol + ownership map: `docs/plans/DOC-MAINTENANCE.md`. So
nothing drifts. Model assignment: Opus = orchestrate/plan/gate/high-risk-audit/**docs**; Sonnet = execute +
audit; Haiku = only trivial mechanical sweeps. See docs/plans/08-agent-execution-guide.md. Escalate human
gates (decisions, migrations, prod/main, deploys, UI sign-off); don't guess.

BRANCHES/DEPLOY (see GIT-WORKFLOW.md): WORK ON **develop** (auto CI + staging). **main = releases only;
a push to main is a PRODUCTION deploy attempt** (gated by tests + a manual approval). Never push main
except a deliberate release. ⚠️ CI BLOCKER (P9.1): CI requires all tests pass but the suite is
red-by-design (~105 TDD-baseline fails until P8) → no deploy proceeds until CI adopts the differential
gate or quarantines the baseline reds. Never set DEMO_MODE=true in staging/prod.

DEV DB (before any DB task): Cloud SQL gifsy-db-dev via Auth Proxy on 127.0.0.1:5433 (DOWN after reboot —
check port 5433, restart per DEV-DB.md). .env DATABASE_URL → 127.0.0.1:5433/gifsy_dev, DEMO_MODE=false,
SELECT 1 before migrating. NEVER point dev at prod (gifsy-db). This dev DB has NO prisma migration history
— use db push / surgical `migrate diff` → apply SQL in a txn guarded by current_database='gifsy_dev';
NEVER `prisma migrate dev` (it would RESET it). Backfill scripts reuse the lib/prisma singleton.
⚠️ **SCHEMA SOURCE OF TRUTH = `platform/prisma/schema.prisma`** (80 models; used by local dev via
`prisma.config.ts`, the platform Dockerfile, CI, + `gifsy_dev`). The repo ALSO has a separate NestJS `api/`
service with its OWN `api/prisma/schema.prisma` (74 models) — do NOT edit/generate the platform from api's
schema (Gap #30; CI bug fixed 2026-06-16). The P4.0 drop-migration edits the PLATFORM schema.

STATE: **P0 + P1 + P2 COMPLETE** (as of 2026-06-16), all built→gated→independently-audited and **pushed to
origin/develop** (run `git log --oneline origin/develop -5` for the latest). Gate is DIFFERENTIAL ("no NEW reds
vs the snapshot" = 28 files/105 tests; the suite
is red throughout a TDD build). **P2 summary (full block below + `MODEL-ALIGNMENT.md`):** sales hierarchy →
relational tree; outlet master upload + re-KYC flags persist for real (parameter+program model, World C); RF1–RF7
tenant-isolation defects fixed; 5 dev-DB migrations applied; OutletTypes seeded. Catalog/SKU built-then-reverted
(YAGNI); tiers/partner-class/compute-engine → P4.0 de-scaffold. P1 delivered: OTP→msg91 auth; persisted
sessions (365d sliding idle, logout/logout-all/Gifsy-force-logout-all, admin edit-phone→revoke);
getAuthUser validates the session + enforces subdomain==session-tenant for non-Gifsy (closed #20 + the
#23 header-swap); DB-backed Client tenant config (migration applied to dev); RBAC engine (72 perms/17
groups) + can() + Gifsy/Client operating split + requirePermission wired into all 44 admin routes,
FLAG-GATED OFF (env RBAC_ENFORCEMENT + per-tenant features.rbacEnforcement). Reversal = maker-checker
(client requests, Gifsy approves). Gaps: #1/#3/#20/#22 closed, #2 engine done, #23 reduced.

DEFERRED / OPEN (none block P4):
- RBAC enforcement is OFF and safe to enable later via RBAC-ENABLEMENT.md (mappings already finalized).
- Phone-change→logout hooks: wire into the sales/outlet bulk-uploads (built in P2, hook NOT yet added) + P3 re-KYC (revoke mechanism is ready).
- **CI prisma-schema discrepancy — ✅ FIXED (2026-06-16).** `ci.yml` was generating the platform's Prisma client from `../api/prisma/schema.prisma` (a SEPARATE, staler api-service schema missing the `Client` model, the Credits module, and the P2 columns) → platform `tsc` failed in CI. The platform's REAL source of truth is **`platform/prisma/schema.prisma`** (used by local dev via `prisma.config.ts` AND by `platform/Dockerfile`). Fixed ci.yml to `npx prisma generate` (own schema); deploy.yml + deploy-staging.yml were already conditional-correct (stale comments fixed). Audited: regenerate→tsc 0; dev DB = no-diff. The NestJS `api/` is a separate deployed service with its own schema — left as-is. **Open for P9:** confirm whether `api` + `platform` share a PROD DB (`gifsy-db`); if they do, the two diverged schemas (80 vs 74 models) need a migration-ownership decision (who owns which tables). Dev is clean: `gifsy_dev` is the platform's DB, built from the platform schema.
- Small follow-ups: OTP validity window (6h→10min), send-otp orphaned-rows on failure, isolation-audit
  AST hardening, force-logout-all audit-durability ordering, vitest.integration server-only alias,
  requirePermission per-tenant-config caching, RBAC per-tenant override storage/UI.
- INFRA P9.1 (fix CI differential gate) is the gating item before the deploy pipeline can deploy.
- **Reporting track** (user-driven, isolated on `develop`, built AHEAD of P8 for client look-and-feel
  sign-off) — see REPORTING-REVAMP.md. **R1 Outlet Points Ledger DONE** (engine + period picker + on-screen
  preview + xlsx; gated + independently audited; DEMO_MODE fully populated). Its sales-hierarchy / distributor /
  program columns are now **BUILDABLE** (P2.1 relational `SalesUser` tree + P2.4 `Outlet.distributorCode/Name` +
  `programName/programCategory` columns) — wire the real-data path when convenient (REPORTING-REVAMP.md updated);
  points attribution decision = 1 partner = 1 outlet.
  **R2 Ticket Aging DONE** (operational; status/category/priority filters, aging buckets, SLA flag, summary
  chips + preview + xlsx; gated + independently audited). Fully backed by `Ticket` model — **prod path
  complete, no deferral.** User has MORE reports/workflow changes queued on this track.
- **KYC approval revamp (P3 design + DEMO built on `develop`)** — see KYC-APPROVAL-REVAMP.md. Two-lane
  (bulk export→offline-validate→upload-with-preview→commit + single-page exceptions), **7 field-level
  approvals** (Payment, GST validation, GST document, Address, Address document, Store board photo, Owner
  photo), structured evidence, hybrid Excel+portal merge, completion (all approved→credentials+WhatsApp /
  any reject→re-share via existing Re-KYC `reKycFlags`). DEMO at `admin/kyc/approvals` (GIFSY-only; nav link
  repointed there; commit is a no-op). **P3 remainder:** 3.4a schema + **human-gated dev-DB migration**
  (entityType/gstRegistrationType + per-field verification), 3.4e real persistence + invoicing wiring +
  field-level rejection on the detail page; N1 nav `gifsyOnly` when real roles wired.
- **Scheme form-builder EXTENDED** (the rich `EnrollmentFormBuilder` already existed; wired admin SchemeBuilder
  → partner EnrollmentFormRenderer). Added **CALCULATED** field (safe shunting-yard `computeFormula`, no eval)
  + **single-condition `visibleWhen`** ("if X→show Y") to `lib/campaign.ts` + builder + renderer. Gated +
  audited (PASS, concat fix folded in). Real persistence of form-schema/submissions + Excel-dataset binding =
  **P4**; circular-visibleWhen validation = P4 polish.
- **Scheme builder PRUNED** (owner demo cleanup, audited PASS): removed the stale **Incentive Calculation** +
  **Target Configuration** sections from `scheme-builder.tsx` (the platform does NOT compute incentives →
  tenants upload final amounts). Kept Incentive Type. Deeper rule-engine/schema + **Incentive-Type vs
  Campaign-Type** reconcile (gap #10) = **P4.0**; `[id]/page.tsx` `CalculationMethod` static-fixture leftover
  = P4 cleanup. (`admin/schemes/new` = Open Campaign → the form builder w/ the new fields.)

**P2 IN PROGRESS** (full live status in 00-MASTER-PLAN.md §P2). DONE + committed to `develop` (NOT pushed yet):
- **2.0 Reconcile** (`reconcile/P2-org-master-data.md`) — tagged BUILD/COMPLETE/VERIFY; found defects RF1–RF7.
- **Security RF1–RF3 fixed** (`2734aeb`): RF1 cross-tenant IDOR on `sales/team/[memberId]` (clientId scope +
  `lib/sales-hierarchy-access.ts isSelfOrDescendant` ownership gate, fails closed→403); RF2 unscoped invoice
  dup-check; RF3 `partnerId:userId` wrong-FK in `sales/upload`.
- **2.1 Sales hierarchy → relational** (`b1e0baf`): hierarchy save now persists `SalesHierarchyLevel` (incl. ZNM)
  + `User`+`SalesUser` tree (two-pass reportingTo) — `lib/hierarchy-persistence.ts`; the XSR→NSM 18-col chain
  template flows in correctly.
- **2.4 Outlet master upload** (`5ee7fbe`,`b1e0baf` schema + outlet commits): outlets persist tenant-tagged,
  validate XSR vs the SalesUser tree, tag via SalesUserAssignment; `lib/outlet-persist.ts`. Re-KYC flag upload
  persists (`Outlet.reKycFlags Json?`). All three outlet master files persist FOR REAL **in demo too**.
- **Owner model decisions:** partner≠outlet (kept 1:many + `isPrimary`; 1:1 is convention; future 1:many free);
  outlet created pre-owner (nullable `partnerId`, owner at KYC); distributor + beat/metro/zone/program = report-only
  reference columns on Outlet (NO master table); RF4/RF5/RF7 = per-tenant unique constraints.
- **5 dev-DB migrations applied** (all human-gated, `current_database='gifsy_dev'` guarded, in `prisma/migrations/`).
- **Seeded** 4 OutletTypes for both tenants (`scripts/seed-outlet-types.ts`) so the outlet upload validates.

**⚠️ MODEL ALIGNMENT — READ `docs/plans/MODEL-ALIGNMENT.md` (owner-confirmed, 2026-06-16).** A read-only sweep
found the model mismatch is **systemic**: the codebase is **3 disconnected layers** — World A (inherited DB
loyalty/compute engine, mostly unwired, contradicts the model), World B (decorative mock UI), World C (the REAL
parameter+program model we've been building in P2). Confirmed model: **sales = TARGET-PARAMETER upload (no
compute)**; **segmentation = PROGRAM (`Outlet.programName/Category`, per-outlet at upload), REPLACING partner
class**. Key facts: partner class is **already decorative** (scheme eligibility actually keys off outlet TYPE;
KYC's `partnerClass` holds outlet-type values) → low-risk to retire. **Point-tiers = pure deletion** (multiplier
never applied). **`lib/incentive.ts` + `api/schemes/calculate` compute = contradicts the model**, retire.
Consequences: **2.6 Catalog REVERTED** (`git revert 798aafe`, YAGNI; recoverable). **Tiers + partner-class +
World-A-compute are ENTANGLED → one coherent "loyalty-engine de-scaffold" (with a human-gated drop migration),
NOT piecemeal** — recommended before P4 (or P4.0). **Program-based scheme targeting is net-new P4 work** (a
program selector + a matcher vs `Outlet.programName/Category`), not a rename. 2.2 + 2.5 are CLEAN (no legacy deps;
2.5 already uses program) — safe to finish anytime.

**✅ P2 FUNCTIONALLY COMPLETE:** 2.0, 2.1, 2.2, 2.4, 2.5 + RF1–RF7 done & gated. 2.2/2.5 verify+harden fixed 4
more tenant-isolation defects (bulk-edit cross-tenant XSR reassign; deactivate/reactivate/bulk-delete used the
partner-join so ownerless outlets couldn't be lifecycle-managed → now scoped by `Outlet.clientId`). **2.3 (tiers)
folded into the P4.0 de-scaffold** (above). Adjacent P3 note: outlet list GET hardcodes `kycStatus:'NOT_STARTED'`
(KYC filter cosmetic until a real KYC-status join). Deferred: replace mock `sales-role.ts`/`partner-session.ts`
with DB; per-field re-KYC consumption (P3).

**NEXT = either (a) P4.0 loyalty-engine de-scaffold** (tiers + partner-class→program + retire `lib/incentive.ts`
compute; one human-gated drop migration; then build program-based scheme targeting) **or (b) P3 (Onboarding &
KYC)** — note P3's 3.0 Reconcile must build against the revamped KYC-approval UX + the program model. Owner picks.

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (drops intermittently — restart per DEV-DB.md); `.env.development.local`
DEMO_MODE=true; preview on :3000 (restart to pick up schema/client changes). Confirm dev DB reachable + on `develop`.
Before any migration/irreversible step show the SQL/plan + wait for the user's go.
```
