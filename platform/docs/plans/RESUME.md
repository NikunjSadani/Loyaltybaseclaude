# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build (multi-tenant trade-loyalty platform,
C:\Users\nikun\Loyaltybaseclaude\platform). Reload context by reading:
- docs/plans/00-MASTER-PLAN.md            (phases P0→P9; P1 status block; P9 = infra/deploy/go-live)
- docs/plans/08-agent-execution-guide.md  (role, loop, review gate, context bundles)
- docs/plans/01-how-we-test.md            (test conventions; deterministic; two styles)
- docs/plans/GIT-WORKFLOW.md              (branches/deploy — WORK ON develop, main=releases)
- docs/plans/DEV-DB.md                    (dev DB + Auth Proxy restart; migrate gotcha)
- docs/plans/reconcile/baseline-red-snapshot.txt   (the gate: NO NEW reds vs this snapshot)
- docs/plans/reconcile/P1-identity-tenancy.md + docs/plans/P1-sessions-design.md   (P1 detail, audits, deferred)
- docs/plans/RBAC-ENABLEMENT.md           (how to turn RBAC enforcement on — it's OFF by default)
- docs/plans/REPORTING-REVAMP.md          (user-driven reporting track, built ahead of P8 for client sign-off)
- docs/plans/KYC-APPROVAL-REVAMP.md        (P3 design: Gifsy bulk KYC verify/approve — DEMO workflow BUILT on develop; schema/persistence = P3)
- docs/spec/gap-register.md               (open gaps + what P0/P1 resolved)
- your memory note: loyaltybase-spec-effort.md

ROLE & OPERATING MODEL (user-agreed for speed): you orchestrate, plan, GATE, and personally audit
high-risk work; you do NOT just trust an executor's word — a task is done only when YOUR gate passes
(re-run npx tsc --noEmit + npm test [differential] + lint yourself; check DRY/YAGNI/clientId/secrets;
real-DB evidence for DB work). Run tasks as PARALLEL WAVES of disjoint Sonnet executors; PIPELINE the
auditors (audit task A while building task B); BATCH the gate once per wave. **AUDIT EVERYTHING — do NOT
risk-tier:** every task (incl. pure-function/doc) gets an independent audit (owner directive). **Docs are
maintained by the best agent (Opus)** — sweep spec/gap-register/reconcile/RESUME/memory after every wave so
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

STATE: **P0 + P1 COMPLETE**, all built→gated→independently-audited, **pushed to GitHub** (origin/main,
88 commits) + the latest on **origin/develop** (the working branch). Gate is DIFFERENTIAL ("no NEW reds
vs the snapshot"; the suite is red throughout a TDD build). P1 delivered: OTP→msg91 auth; persisted
sessions (365d sliding idle, logout/logout-all/Gifsy-force-logout-all, admin edit-phone→revoke);
getAuthUser validates the session + enforces subdomain==session-tenant for non-Gifsy (closed #20 + the
#23 header-swap); DB-backed Client tenant config (migration applied to dev); RBAC engine (72 perms/17
groups) + can() + Gifsy/Client operating split + requirePermission wired into all 44 admin routes,
FLAG-GATED OFF (env RBAC_ENFORCEMENT + per-tenant features.rbacEnforcement). Reversal = maker-checker
(client requests, Gifsy approves). Gaps: #1/#3/#20/#22 closed, #2 engine done, #23 reduced.

DEFERRED / OPEN (none block P2):
- RBAC enforcement is OFF and safe to enable later via RBAC-ENABLEMENT.md (mappings already finalized).
- Phone-change→logout hooks: wire into P2 sales bulk-upload + P3 re-KYC (revoke mechanism is ready).
- Small follow-ups: OTP validity window (6h→10min), send-otp orphaned-rows on failure, isolation-audit
  AST hardening, force-logout-all audit-durability ordering, vitest.integration server-only alias,
  requirePermission per-tenant-config caching, RBAC per-tenant override storage/UI.
- INFRA P9.1 (fix CI differential gate) is the gating item before the deploy pipeline can deploy.
- **Reporting track** (user-driven, isolated on `develop`, built AHEAD of P8 for client look-and-feel
  sign-off) — see REPORTING-REVAMP.md. **R1 Outlet Points Ledger DONE** (engine + period picker + on-screen
  preview + xlsx; gated + independently audited; DEMO_MODE fully populated). Prod-wiring of its
  sales-hierarchy / distributor / program columns is **deferred to P2/P4** (those entities aren't built yet);
  points attribution decision = 1 partner = 1 outlet (rides on P2.4 #4).
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

NEXT = **P2 (Organization & master data)** — sales org tree, partners/outlets, catalog (per 00-MASTER-PLAN.md
§P2; note: an outlet/phone can belong to MULTIPLE tenants → separate per-tenant records; P2.1/2.2 also unblock
the Outlet Points Ledger hierarchy columns, P2.4 the distributor columns + 1:1 binding). The user chose P2 as
the post-compaction starting point. **All session demo work (reporting R1/R2, KYC design+demo+rebuild, scheme
form-builder extend+prune) is committed AND pushed to `origin/develop`** (CI red-by-design → no deploy
proceeds). Local: dev-DB Auth Proxy on 127.0.0.1:5433 (UP) + `.env.development.local` DEMO_MODE=true; a
preview dev server runs on :3000. Confirm dev DB reachable + you're on `develop`, then propose the P2 task
list (start with 2.0 Reconcile). Before
assigning each task show the task + context bundle + what you'll verify; wait for the user's go on
anything irreversible (esp. prod/main, deploys, prod DB).
```
