# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build (multi-tenant trade-loyalty platform,
C:\Users\nikun\Loyaltybaseclaude\platform).
⚠️⚠️ **PHASE S — BACKEND SPLIT (API-first) — ✅ COMPLETE (S0–S8). Architecture realigned; FE prod-deployable against the backend. NEXT = P3.** (Physical *retirement* of the shadowed platform routes + schema deferred to P3/P4 — see below.) DECIDED by owner
2026-06-16 (Gap #31): split the full-stack Next.js code into a **dedicated NestJS backend API** (single source of
truth — owns DB + ALL business logic) + a **thin Next.js web frontend** (future mobile/PWA/partner reuse one backend).
Built **IN PLACE in `api/`** (reuses api/'s proven framework shell — Dockerfile/Prisma-7/guards/bootstrap; the deploy
build is hard-wired to `./api`); api/'s World-A domain was deleted and the real domain rebuilt from the platform's
`lib/`. The **`api/` dir IS the backend now** (NOT deleted; only its World-A domain was). **Why:** `terraform/` was
always built for the split (stateless FE + `gifsy-api` DB owner; FE has no prod `DATABASE_URL`) — realign code→infra
while greenfield = cheapest. **Backend dev:** `cd api && npm run build` / `npm test`; boot needs `DATABASE_URL` (from
`platform/.env` → gifsy_dev) + `JWT_SECRET`.
**Absorbs P4.0:** the World-A de-scaffold (tiers/partner-class/compute/SKU) happens in step S2 so the backend is
born clean. **Owner constraints:** no speed-vs-quality tradeoff (full split); NestJS confirmed; multi-tenancy =
config/data not code-branches (no `if clientId===`); DEFER per-client customization machinery (YAGNI — clean module
boundaries only); current client = parameter-upload, **no compute engine**. **The full plan = read
`docs/plans/BACKEND-SPLIT-PLAN.md` (steps S0–S8). **S0–S7 ✅ DONE on `develop` (S0–S5 pushed; S6–S7 commit-pending; run `git log --oneline -30`):**
- **S1** scaffold in place in `api/` (World-A domain deleted, shell + `auth`/`tenant` kept).
- **S2** canonical schema = **`api/prisma/schema.prisma` (66 models)**; guarded de-scaffold migration (`api/prisma/migrations-manual/S2_descaffold_worldA.sql`, 14 tables + cols + 2 enums) **applied to `gifsy_dev`** (80→66).
- **S3 foundation:** response-envelope interceptor · RBAC permission guard · **StorageService** (GCS) · **NotificationsService** (enqueue seam → NotificationQueue; delivery is P7) · shared `src/common/xlsx.ts` (StreamableFile downloads).
- **S4 ✅ ALL 124 `/v1` endpoints re-homed, 17 modules:** auth, tickets, wallet, gifsy, visibility, rewards, partner, kyc, sales, payouts, reports, schemes, leaderboard, credits, admin-outlets, admin-core, admin-programs (`@Controller('admin/<x>')` mirrors source paths). Every wave gated (tsc+tests+boot) + independently audited (credits money-flow audited by Opus = SOLID).
- **S5 ✅ `TenantGuard`** (`api/src/common/guards/tenant.guard.ts`, 5th APP_GUARD after Jwt/Roles, before Permission): for non-`@Public()` routes asserts `req.user.clientId` is a non-empty string → loud **403** instead of a silent unscoped query; stamps `req.tenantId` (the seam RLS will hook). GIFSY_ADMIN unaffected (carries a clientId; cross-tenant routes scope by path `:slug`). Gated: tsc 0 · 273 tests (10 new) · boot smoke (DB connected, `/health` 200 public-bypass, `/v1/wallet` 401). **DB-level isolation (RLS / Prisma auto-scoper) measured-and-deferred to P8.6** (Gap #23): ~28 relation-scoped + 41 id-only of 236 query sites carry no direct `clientId`, so a strict assert false-positives on ~¼ of sites → must land *with* RLS + one cross-tenant escape-hatch taxonomy.
- **S6 ✅ thin frontend via Next proxy** (`platform/next.config.ts`): `beforeFiles` rewrite `/api/:path*` → `${NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/:path*`. **Zero page changes** — the web client keeps calling same-origin `/api/*`; existing `Authorization: Bearer` (localStorage) auth preserved; login stays same-origin. `beforeFiles` makes the backend win over the still-present local `src/app/api/*` handlers (deleted at S8). **Deferred routes EXCLUDED** via negative-lookahead (`rewards/redeem|visibility/submit|partner/invoices|admin/kyc`) → stay on local handlers. **Verified e2e:** seeded throwaway user+session, minted JWT, `GET /api/auth/me` *through the proxy* (:3000) = **200** {id,role,clientId} / no-token = 401 / `/api/__nope__` = backend 404 (proxy engaged) / `/api/partner/invoices` = local (excluded). *Premise correction: api-client.ts + `NEXT_PUBLIC_API_URL` were NOT pre-plumbed (api-client used by 5 files; `NEXT_PUBLIC_API_URL` unused; 53 raw `fetch('/api')`). Chose proxy over a 53-file direct-cross-origin sweep — lower auth-risk, no churn, the sweep is partly throwaway (pages rework in P3).*
- **S7 ✅ infra/CI (near-no-op):** removed the dead cross-app `prisma generate --schema=../api/prisma/...` fallback from `deploy.yml` + `deploy-staging.yml` (both apps have a local schema → the `else` never fired; kept the `-f` guard so the step no-ops cleanly once S8 deletes platform's schema). **`NEXT_PUBLIC_API_URL` was already fully plumbed** — `platform/Dockerfile` does `ARG NEXT_PUBLIC_API_URL` → `ENV` (so `next build` bakes the proxy destination *and* it's present at runtime); both deploy workflows pass `--build-arg NEXT_PUBLIC_API_URL=${{ secrets.* }}`; `terraform/README` documents the values (`https://api.gifsy.in`, `…staging…`). **Only operational step left: ensure the GitHub secrets `NEXT_PUBLIC_API_URL`/`_STAGING` hold the real backend origins** (repo-settings value, not code). `ci.yml` was already fallback-free.
- **S8 ✅ cutover (human-gated) — DONE; retirement DEFERRED to P3/P4:** e2e cutover proven (S6's authed `/api/auth/me`→proxy→backend→DB→200). `api/` confirmed **clean** of World-A leftovers (only explanatory comments; `prisma/seed.ts` is the real-model seed). Closed **#31 (✅ RESOLVED)** + reduced **#30** (platform schema lingers). **A route-coverage cross-check (independently reviewed) found 16 platform routes with no backend equivalent** → the proxy 404s them (new **Gap #32**): 14 wrong-model/retired (skus/tiers/schemes-calculate/billing-trends/sales-invoices/upload/returns/last-upload/leaderboard — await P4.x; never prod-functional on the FE anyway), `admin/sales/*` (models survive → clean port candidate), `auth/logout(-all)` (no backend route **and** no UI caller → server-side revocation never invoked, latent auth gap). **Decision: leave as honest 404s + track (Gap #32), do NOT band-aid via proxy-exclusion.** **Retirement deferred:** the ~112 shadowed-but-inert local `src/app/api/*` handlers + platform schema stay as an in-cutover rollback safety-net; they retire as ONE unit in P3/P4 once the 16 unported + 4 deferred groups are ported/reworked.
**NEXT = P3 (Phase S gated it; now unblocked):** see `00-MASTER-PLAN.md`. **Phase-S follow-ups carried into P3/P4:** Gap #32 (16 unported routes — rework wrong-model, decide `admin/sales/*` port, add real server-side logout revocation); when porting completes → delete the shadowed platform routes + platform schema (full retirement).
**DEFERRED routes (need infra / P3 — re-home when ready):** rewards `redeem`(+confirm) = action-OTP (no `REDEMPTION_CONFIRM` OtpPurpose) + delivery · visibility `submit` = multipart on StorageService · partner `invoices` = mock · admin/kyc approvals = mock (P3). **Follow-ups (audit-found, all faithful source carry-overs or pre-existing):** payouts `processBatch` atomicity (P6); seed `kyc:*` for SALES_SO/ASM/STATE_HEAD before enabling RBAC (RBAC-ENABLEMENT); `admin/banners` list omits `deletedAt:null` (soft-deleted banners show — 1-line fix); **(S6) centralize the 53 raw `fetch('/api/...')` callers through `api-client.ts`** — do incrementally when each page is touched in P3, not a big-bang. Reload:
- docs/plans/KYC-APPROVAL-REVAMP.md       ⭐ **P3 design — START HERE** (KYC approval revamp: bulk-validate→upload→commit, field-level verification, schema + 3.4a–e)
- docs/plans/00-onboarding.md             (P3 onboarding/KYC spec §02 WF1)
- docs/plans/00-MASTER-PLAN.md            (phases; P2 + **Phase S DONE**; **P3 = Onboarding & KYC §P3 tasks 3.0–3.6**; P4 = program targeting)
- docs/plans/BACKEND-SPLIT-PLAN.md        (Phase S plan + status — ✅ DONE; reference for what the backend looks like + Gap #32)
- docs/spec/04-architecture.md            (architecture §1/§2/§6/§8 — API-first, built)
- docs/plans/MODEL-ALIGNMENT.md           (REAL model + the World-A de-scaffold list executed in S2)
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
⚠️ **SCHEMA SOURCE OF TRUTH = `api/prisma/schema.prisma`** (canonical, **66 models**) — **moved to the backend in
S2 (DONE 2026-06-16)**; the de-scaffold migration was applied to `gifsy_dev` (80→66 tables; guarded SQL in
`api/prisma/migrations-manual/`). `platform/prisma/schema.prisma` is now **transitional/stale** (still 80 models;
its World-A routes are removed in S4 as the platform thins to the frontend). See DEV-DB.md.

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
- **Two-schema / shared-prod-DB question (Gaps #30/#31) — ✅ RESOLVED BY PHASE S.** The backend (the `api/` dir,
  World-A domain deleted) owns one canonical schema = the de-scaffolded platform schema at `api/prisma/`. No
  migration-ownership conflict remains; greenfield = no prod data to reconcile. (Historical: a 2026-06-16 CI bug that
  generated the platform client from api's schema was fixed.)
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
NOT piecemeal** — **executed in Phase S step S2** (the backend is built clean; "P4.0" = S2). **Program-based scheme
targeting is net-new P4 work** (a program selector + a matcher vs `Outlet.programName/Category`), built in the
backend after Phase S. 2.2 + 2.5 are CLEAN (no legacy deps; 2.5 already uses program).

**✅ P2 FUNCTIONALLY COMPLETE:** 2.0, 2.1, 2.2, 2.4, 2.5 + RF1–RF7 done & gated. 2.2/2.5 verify+harden fixed 4
more tenant-isolation defects (bulk-edit cross-tenant XSR reassign; deactivate/reactivate/bulk-delete used the
partner-join so ownerless outlets couldn't be lifecycle-managed → now scoped by `Outlet.clientId`). **2.3 (tiers)
folded into the P4.0 de-scaffold** (above). Adjacent P3 note: outlet list GET hardcodes `kycStatus:'NOT_STARTED'`
(KYC filter cosmetic until a real KYC-status join). Deferred: replace mock `sales-role.ts`/`partner-session.ts`
with DB; per-field re-KYC consumption (P3).

**NEXT = P3 · ONBOARDING & KYC (3–5 wk) — Phase S is COMPLETE and unblocked it.** Objective: the full
enroll→KYC→approve→credential journey (spec §02 WF1) works e2e, **built in the NestJS backend** (`api/src/kyc/*`
already exists from S4 as a skeleton — controller/service/dto + `kyc-approval.helper.ts`; the `/admin/kyc/*` approval
routes are still **mock**) with thin web KYC pages. Tasks (see `00-MASTER-PLAN.md` §P3 + design `docs/plans/KYC-APPROVAL-REVAMP.md`):
**3.0** reconcile KYC vs spec §02 WF1 · **3.1** submission form + GCS doc upload · **3.2** tree-based approval routing,
retire `ROLE_PHONES` (#9) · **3.3** first-approve/approve/reject + activate-user-&-create-wallet on approve · **3.4**
field-level rejection (#14) + Gifsy GST/bank validation + reg-type (#12/#15) — bulk export→offline-validate→upload-
preview→commit (additive dev-DB migration; human-gate the SQL) · **3.5** consent + DPDP `DataRequest` · **3.6** re-KYC
trigger (#13) + SLA metrics.
⚠️ **COORDINATE BEFORE TOUCHING KYC UI:** the user is **redesigning the Gifsy KYC-approval page** — Task 3.0 must build
against whatever revamped approval UX is in the code when P3 starts, NOT the current `sales/kyc/[id]` page. Confirm with
the user before editing approval routes/pages.
**Carried from Phase S (don't lose):** Gap #32 (16 unported routes the proxy 404s — incl. `admin/sales/*` clean port
candidate + `auth/logout` server-revocation gap); the ~112 shadowed platform routes + platform schema await full
retirement once unported routes port; seed `kyc:*` for SALES_SO/ASM/STATE_HEAD before enabling RBAC (`RBAC-ENABLEMENT.md`);
`admin/banners` list `deletedAt:null` 1-line fix; centralize the 53 raw `fetch('/api')` callers incrementally.

Local: dev-DB Auth Proxy on 127.0.0.1:5433 (drops intermittently — restart per DEV-DB.md); `.env.development.local`
DEMO_MODE=true; preview on :3000 (restart to pick up schema/client changes). Confirm dev DB reachable + on `develop`.
Before any migration/irreversible step show the SQL/plan + wait for the user's go.
```
