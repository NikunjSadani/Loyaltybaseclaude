# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude  (git root; branch **develop**). Frontend: `platform/` (thin Next.js).
Backend: `api/` (NestJS + Prisma 7, the source of truth — owns the DB + ALL business logic).

⚠️⚠️ **STATE: P0 + P1 + P2 + Phase S + P3 ✅ COMPLETE. P4 (Programs, targets & enrollment) ◐ IN PROGRESS —
4.0 reconcile DONE + additive schema applied to gifsy_dev (audited); building streams T (targets) + E
(enrollment).** Everything through `02ab110` pushed to origin/develop.

**Architecture (Phase S, done):** API-first — a dedicated NestJS backend built IN PLACE in `api/` (reused its
shell, deleted its World-A domain, rebuilt the real domain from the platform's `lib/`+schema) consumed over
HTTP/JSON by a thin Next.js FE via a `next.config.ts` proxy (`/api/*` → backend `/v1/*`). The World-A de-scaffold
(tiers/partner-class/compute/SKU — formerly "P4.0") was absorbed into Phase S step S2, so the backend is born clean.
See [[architecture-backend-split]] + `docs/spec/04-architecture.md` + `docs/plans/BACKEND-SPLIT-PLAN.md`.

**P3 (Onboarding & KYC, done 2026-06-17):** full enroll→route→verify→approve→activate→re-KYC in `api/src/kyc/*`
(**129 unit tests**) + thin FE, built plan→execute→audit (one independent audit per task; 4 caught real bugs all
fixed). Two-stage, two-lane field-level KYC: Stage 1 = `KycSubmission.status` sales-chain machine; Stage 2 = the
7-field `KycVerificationItem` grid (begins at PENDING_GIFSY; status stays PENDING_GIFSY through it; progress derived).
One pure `evaluateSubmission` bridge + `applyBridgeOutcome` shared by Lane A (bulk Excel `bulk-verify` preview→commit,
auto-approve) and Lane B (portal `:id/verify`). Tree-based routing (retired `ROLE_PHONES`, #9); GCS doc upload;
consent persistence; manual re-KYC; GST reg-type capture + DPDP masking; `KycDocumentType.OTHER` split. Closes
#9/#12/#13/#14/#15. Full record: `docs/plans/reconcile/P3-onboarding-kyc.md`. See [[p3-kyc-complete]].
Two invariants enforced across the KYC code (preserve if you touch it): **enqueue notifications only AFTER the tx
commits**; **resolve the primary outlet BEFORE any status flip** (no half-commit).

**P3 residual carried to later phases (NOT done — don't assume):**
- The **stale platform `schema.prisma` + still-live platform Prisma code** (auth/session/client-config + the
  proxy-excluded `rewards/redeem`[P5] / `visibility/submit`+`partner/invoices`[P6] / `admin/kyc`) + the ~96
  shadowed rollback-net route files + `lib/kyc-approval` retire as **ONE unit ~P6** (RE-HOMED from P4 — 120
  platform files still use Prisma; deleting the schema before they port breaks the running platform). Also Gap
  #32 (16 unported routes; `admin/sales/*` ports in P4.5; `auth/logout` server revocation ~P6).
- `lib/invoice` reading the persisted `entityType`/`gstRegistrationType` = **P6** (invoicing).
- Assigned-sales-owner re-KYC notification (only the partner is notified today); WhatsApp delivery = P7/MSG91.
- Seed `kyc:*` perms for SALES roles + enable RBAC (it's OFF by default — see `RBAC-ENABLEMENT.md`).

**P4 · Programs, targets & enrollment (gaps #6, #10) — ◐ IN PROGRESS. Full record:
`docs/plans/reconcile/P4-programs-targets-enrollment.md`.** ⚠️ **4.0 reconcile DONE (2026-06-17, owner-confirmed):**
program (`programName/programCategory`) is a **reporting/filter facet, NOT a targeting dimension**; there is **no
eligibility engine** — scheme participation = the **non-blank cells of the per-outlet × KPI × month target Excel
upload** (blank = not configured). **Schemes ⟂ targets — zero linkage** (two parallel streams). KPIs normalized →
`KpiDef` table. #10 resolved (`SchemeType` canonical; FE `IncentiveType` retired; `CampaignType`=enrollment
audience). Additive schema **applied to gifsy_dev** (`KpiDef`, `OutletTarget` mirrors `OutletSalesRecord`,
`TargetUploadBatch`, `SchemeEnrollmentForm` + `scheme_enrollments.{enrollmentMode,formValues}`; audited PASS).
**BUILDING (each task plan→execute→audit→gate):** **Stream T (targets, heart):** 4.4 `KpiDef` CRUD + `OutletTarget`
template/upload → 4.5 achievement (port `admin/sales/bulk-upload`→`OutletSalesRecord`) + pace + partner view.
**Stream E (enrollment):** 4.1 scheme CRUD cleanup + **drop World-A `SchemeTarget`** (model+reads; destructive
migration, gated) + remove decorative class UI → 4.2 enrollment-form persistence → 4.3 submission (self/sales +
prefill). ⚠️ **`api/.env` was found pointing at PROD (`gifsy_prod`) and repointed to the dev proxy** — verify
`current_database=gifsy_dev` before any migration.

ROLE & OPERATING MODEL (owner-agreed): you ORCHESTRATE, plan, GATE, and own docs. **Per task: plan (Opus) → execute
(a Sonnet executor) → ONE independent adversarial audit (Sonnet) → Opus gates → commit.** AUDIT EVERYTHING — do not
risk-tier (the P3 audits caught a cross-tenant key, a tx-escaping notification, a half-commit, an inverted mask that
tsc + unit tests all missed). For high-risk/destructive work Opus also personally audits. The gate (run it YOURSELF,
every change): `cd api && npx tsc -p tsconfig.build.json --noEmit` (0) + `npx jest <area>` (or differential for the
red-by-design suite) + a boot smoke for new endpoints + **`cd platform && node scripts/check-doc-consistency.mjs`
GREEN**. Opus sweeps the docs (reconcile / gap-register / RESUME / 00-MASTER-PLAN / memory) after every task so
nothing drifts. Protocol: `docs/plans/DOC-MAINTENANCE.md`.

CONSTRAINTS (must hold):
- WORK ON **develop** (auto CI + staging). **main = prod releases only — never push main** except a deliberate release.
- **Commit/push ONLY when the owner asks.** Never expose secrets (extract DB password from `platform/.env` via
  grep/cut without echoing).
- DEV DB = Cloud SQL `gifsy-db-dev` via Auth Proxy on **127.0.0.1:5433** / `gifsy_dev` (DROPS after reboot — restart
  per `DEV-DB.md`; `SELECT 1` before migrating). NEVER point dev at prod (`gifsy-db`). **NEVER `prisma migrate dev`**
  (it RESETS gifsy_dev) — use `prisma db push` / guarded SQL applied via `prisma db execute` (txn guarded by
  `current_database='gifsy_dev'`, in `api/prisma/migrations-manual/`). **SHOW migration SQL + WAIT for the owner's go
  before applying.** Never `DEMO_MODE=true` in staging/prod.
- ⚠️ **SCHEMA SOURCE OF TRUTH = `api/prisma/schema.prisma`** (canonical, de-scaffolded; +`KycVerificationItem` etc.
  from P3; +`KpiDef`/`OutletTarget`/`TargetUploadBatch`/`SchemeEnrollmentForm` from P4). `platform/prisma/schema.prisma`
  is **stale/transitional** — retires **~P6** (re-homed from P4; gated by still-live platform Prisma usage).
- CI is red-by-design (~105 TDD-baseline fails until P8) — the gate is DIFFERENTIAL ("no NEW reds vs the snapshot").

Reload (read before building):
- docs/plans/00-MASTER-PLAN.md            (phases; **P0–P3 + S DONE**; **§P4 ◐ IN PROGRESS**)
- docs/plans/reconcile/P4-programs-targets-enrollment.md (**P4 reconcile + build record — READ FIRST for P4**)
- docs/plans/MODEL-ALIGNMENT.md           (the REAL parameter model; ⚠️ its program-targeting framing is SUPERSEDED — see the P4 reconcile)
- docs/plans/reconcile/P3-onboarding-kyc.md (P3 build record + every audit outcome — reference/pattern)
- docs/plans/08-agent-execution-guide.md  (role, loop, review gate, context bundles)
- docs/plans/GIT-WORKFLOW.md              (branches/deploy — WORK ON develop, main=releases)
- docs/plans/DEV-DB.md                    (dev DB + Auth Proxy restart; migrate gotcha)
- docs/plans/DOC-MAINTENANCE.md           (doc-consistency is a GATE STEP; ownership map)
- docs/plans/RBAC-ENABLEMENT.md           (how to turn RBAC on — it's OFF)
- docs/spec/gap-register.md               (open gaps; 13 resolved incl. #9/#12/#13/#14/#15 via P3)
- your memory: [[p3-kyc-complete]] · [[architecture-backend-split]] · [[platform-real-model]] · [[reconcile-fit-before-build]] · [[own-consistency-no-micromanage]]

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (restart per DEV-DB.md); the owner runs platform on :3000 + backend on
:4000 (drive the live app via the Chrome extension, not preview_start). Confirm on `develop` + dev DB reachable.
Before any migration/irreversible step show the SQL/plan + wait for the owner's go.
```
