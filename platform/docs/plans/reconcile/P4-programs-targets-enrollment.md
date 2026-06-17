# P4 · Programs, Targets & Enrollment — Reconcile + Build Record

> Status (2026-06-17): **P4 COMPLETE ✅ — backend 4.0–4.5 (gated tsc 0 / jest 182) + FE wiring (platform
> tsc 0 / vitest 133) + `SchemeTarget` dropped. Backend rebuilt + restarted + browser-verified (KPI screen
> fetches live; `[PrismaService] Database connected`). All pushed (origin/develop ≤ `ebf5ae5`).** Gaps closed:
> #6, #10, #29 (+ #18-KPI, #32-`admin/sales`). Owner-confirmed model below. Source of truth = `api/`; FE thin.

## 0. Why a reconcile first

The inherited P4 brief (`00-MASTER-PLAN §P4`, `MODEL-ALIGNMENT.md`) headlined **"program-based scheme
targeting"** as the net-new work. An owner check at P4 kickoff (2026-06-17) **invalidated that framing**.
This is exactly the "validate inherited concepts against the real model before building" discipline —
the same pattern that prevented churn in P2/P3. The corrected model is below; the docs it contradicts
are updated as part of 4.0.

## 1. The owner-confirmed P4 model (do not relitigate)

1. **Program / category are reporting facets, NOT a targeting dimension.** `Outlet.programName` /
   `Outlet.programCategory` are tagged at KYC and used to **categorize outlets for filtering and
   reporting only**. They have **no bearing on target setting** and are **not** a scheme-participation
   rule. (This retires the "program selector + matcher" idea entirely.)

2. **There is no separate eligibility/targeting engine.** A scheme/activation is **metadata**
   (name, dates, `SchemeType`, reward type, **parameters**) plus an **Excel target template**. The admin
   **downloads the template, fills target values, and uploads it.**
   - **Blank cell ⟹ no target configured** for that outlet/parameter.
   - **Filled cell ⟹ target configured** for that outlet/parameter.
   - **Participation *is* the set of non-blank cells.** Nothing else decides who is "in" a scheme.
   - The decorative `ChannelPartnerClass` (GOLD/SILVER) selector in `scheme-builder.tsx` is simply
     **removed** — nothing replaces it. Partner-class was already decorative (`MODEL-ALIGNMENT.md`).

3. **Targets are explicit and verbatim — no compute.** Stored **per outlet per parameter** (mirrors the
   proven `OutletSalesRecord.kpiValues` pattern). **Achievement** upload is the same shape; **pace =
   achieved ÷ target**; the partner sees target + achievement (tracking only). Confirms Gap #10 (PRUNE).

4. **Schemes/activations ⟂ targets — ZERO linkage (owner, 2026-06-17).** Activations run *parallel* to
   targets; there is **no FK and no shared concept** between them. The configurable opt-in enrollment form
   (#6) — self vs sales-assisted, conditional pre-fill — is partner-facing data capture on the *scheme*
   side. `CampaignType` (LOYALTY_ONLY / OPEN_CAMPAIGN / MIXED) is the enrollment **audience** model, confirmed
   in 4.2/4.3. The World-A `SchemeTarget` (which coupled targets to schemes/users) is therefore **dropped**.

5. **KPIs/parameters are per-TENANT, not per-scheme.** The already-built `TenantKpiDef[]` (`kpi_defs`
   config) is the parameter set; it drives every target/achievement template. **Normalized to a per-tenant
   `KpiDef` table** (owner decision — Gap #18 prefers relational; greenfield makes it cheap; KPI codes are
   the keys inside both upload models, so they deserve referential identity).

6. **Targets are tenant-level: per outlet × per KPI × per month** (the existing `target-excel-upload.ts`
   model: `month → outletId → kpiId → number`, no schemeId). Stored in a new **`OutletTarget`** model
   mirroring `OutletSalesRecord`. Pace joins target↔achievement on (outletCode, month, kpiId).

## 2. Audit — what's built vs net-new (backend = source of truth)

| Area | Backend state | Verdict |
|---|---|---|
| Scheme CRUD | ✅ `api/src/schemes/*` list/create/get/update/soft-delete, tenant-scoped; compute engine correctly absent | **Reuse** (4.1 base). |
| KPIs / parameters | 🟡 per-tenant `kpi_defs` JSON config (`TenantKpiDef[]`) in platform; not in backend | **Normalize → `KpiDef` table (4.4)** + CRUD; port the Deoleo defaults. Per-tenant, drives all templates. |
| Scheme eligibility engine | n/a — `SchemeEligibility` has geo + `specificPartnerId`, no program | **Drop the engine idea.** Participation = the upload. `SchemeEligibility` is **not** the P4 mechanism (leave model in place, unused for targeting). |
| `SchemeTarget` (World-A) | ⚠️ one `targetValue`/`achievedValue` **per user per scheme** — couples targets↔schemes | **DROP** (schemes ⟂ targets). Remove its reads from `schemes` module (`getSchemeTarget`/`listTargets`). Replaced by `OutletTarget`. |
| Targets | ❌ no model; the real shape (`month→outlet→kpi→number`, no schemeId) lives only in platform `lib/target-excel-upload.ts` | **New `OutletTarget`** (clientId, outletCode, month, `targetValues` JSON) **mirroring `OutletSalesRecord`** + `TargetUploadBatch`. Template download + verbatim upload parser (4.4 — heart of P4). |
| Achievement upload | ❌ `OutletSalesRecord`/`SalesUploadBatch` models exist, **zero writers in `api/src`**; correct writer lives only in platform `admin/sales/bulk-upload/route.ts` (the WRONG SKU→`SalesInvoice` route correctly not ported) | **Port (4.5):** lift bulk-upload into the backend; already the right no-compute shape. |
| Enrollment form | ❌ no field-def/values model; `SchemeEnrollment` is a bare join | **Net-new schema (4.2).** FE `EnrollmentFormBuilder.tsx` (808L, CALCULATED + `visibleWhen`) + `enrollment-form-renderer.tsx` (666L) are rich + reusable — just need backend persistence. |
| Enrollment submission | ❌ no enroll endpoint | **Net-new (4.3):** self vs sales + pre-fill. |
| De-scaffold debt | ✅ class/tier/SKU dropped (Phase S S2); `channel-partners` already clean; **backend carries no compute** | **No backend debt.** `lib/incentive.ts` retirement is **re-homed to ~P6** — it's imported by ~10 still-live platform World-A pages/routes (`admin/schemes`, `admin/reports`, `api/schemes/calculate`, `api/partner/targets` …) and references `salesInvoice`/`salesUpload` (dropped in the backend, alive in the stale platform schema); deleting it now breaks live platform pages. Folds into the ~P6 platform retirement (MODEL-ALIGNMENT's "quarantine until P5/P6" path). |

## 3. Schema design locked in 4.0 (ONE additive migration, independently audited, then owner-gated)

> ✅ **APPLIED to `gifsy_dev` 2026-06-17** — `api/prisma/migrations-manual/P4_targets_enrollment_additive.sql`
> (independently audited PASS; nits reconciled). `current_database=gifsy_dev` confirmed pre-apply; client
> regenerated; backend `tsc` green; all 4 tables + 2 columns verified present. (Pre-apply: a prod-pointing
> `api/.env` misconfig was caught + audited + repointed to the dev proxy — see the gap-register note.)

> Opus owns `schema.prisma` edits + migrations so parallel executors never collide on the schema file.
> The migration SQL is **independently audited (owner instruction), reconciled, then shown + owner-gated**
> before `prisma db execute` on `gifsy_dev`.

**One additive P4 migration (audited as a unit, owner-gated before apply):**
- **`KpiDef`** (per-tenant parameters): `(id, clientId, code, label, unit, isPrimary, hasNameOverride,
  nameOverrideLabel?, order, enabled, createdAt, updatedAt)`, `@@unique([clientId, code])`.
- **`OutletTarget`** (targets, mirrors `OutletSalesRecord`): `(id, clientId, outletCode, outletName,
  outletType, month, targetValues Json, batchId, createdAt, updatedAt)`, `@@unique([clientId, outletCode, month])`.
- **`TargetUploadBatch`** (mirrors `SalesUploadBatch`): `(id, clientId, uploadedById, month, totalRows,
  acceptedCount, rejectedCount, status, …)`.
- **`SchemeEnrollmentForm`** (4.2): `(id, schemeId @unique, campaignType, formSchema Json, …)` +
  **ALTER `scheme_enrollments`** add `formValues Json?` + `enrollmentMode` default `'SELF'`.

**Separate destructive step — ✅ DONE 2026-06-17 (after 4.5):**
- **DROP `SchemeTarget`** ✅ — both readers removed (`schemes` service `getSchemeTarget`/`listTargets` in
  **4.1**; `partner.service.ts` rewired to `OutletTarget`/`OutletSalesRecord` in **4.5**). grep-confirmed
  zero readers; verified **0 rows** on `gifsy_dev`; guarded `P4_drop_scheme_target.sql` applied (table gone).

Pace (4.5) joins `OutletTarget` ↔ `OutletSalesRecord` on `(clientId, outletCode, month)` per `kpiId` key —
no cross-scheme keying needed (targets aren't scheme-scoped).

## 4. #10 Incentive-Type vs Campaign-Type — resolved

Two distinct dimensions, not duplicates:
- **`SchemeType`** (backend enum: PURCHASE_INCENTIVE / VISIBILITY / GROWTH_INCENTIVE / REFERRAL /
  WELCOME_BONUS / MILESTONE / SLAB_BASED / TARGET_BASED) = the **scheme category** → **canonical, keep.**
- **`CampaignType`** (`lib/campaign.ts`: LOYALTY_ONLY / OPEN_CAMPAIGN / MIXED) = the **enrollment audience**
  (loyalty-KYC vs non-KYC scheme-only vs both) → a **real enrollment concept** (Gap #6 `nonKycOutletCampaigns`)
  → carried on the enrollment side (4.2/4.3), confirm scope with owner.
- **Legacy FE `IncentiveType`** (`types/index.ts`) = decorative World-B duplicate of `SchemeType` →
  **retire** (map to `SchemeType`).

## 5. Platform-schema retirement — re-homed out of P4 (was deferred "to P4 as one unit")

**Finding (2026-06-17):** the stale `platform/prisma/schema.prisma` **cannot** be retired in P4. The
`next.config.ts` proxy sends `/api/*` → backend **except** `rewards/redeem`, `visibility/submit`,
`partner/invoices`, `admin/kyc`, which **still run on the platform** against that schema — plus
`auth.ts` / `session.ts` / `client-config-db.ts` (tenant resolution) run in the platform process
regardless of the proxy. **120 platform files still use Prisma.** Retirement is gated by porting that
still-live code, which lands in **P5** (`rewards/redeem`) / **P6** (`visibility/submit`,
`partner/invoices`) + a cross-cutting auth/session/client-config port → the retirement naturally
**completes ~P6**, not P4. **Decision: decouple from P4.** P4 holds one invariant instead —
**P4 is backend-only; no new platform-side Prisma reads of P4 columns** (prevents another
`clients.partnerClasses`-style drift bug). **Route-file accounting (corrected 2026-06-17):** of the 116
platform `/api` route files, **4 are proxy-excluded and still LIVE** (`partner/invoices/[id]`,
`rewards/redeem` ×2, `visibility/submit`); the other 112 are shadowed — **~96 are the deliberate inert
rollback net** (Gap #31: keep until the unported routes are ported, then retire the platform backend **as
one unit**) and **16 are the tracked-unported #32 routes**. These are **NOT swept piecemeal as "hygiene"** —
deleting the ~96 early would dismantle the rollback net the architecture decision deliberately preserves.
They retire **together** with the platform schema + still-live lib at ~P6. Re-homed in gap-register #30/#31/#32.

## 6. Build streams (each task: plan → execute → independent audit → Opus gate → commit)

Schemes ⟂ targets share **no models**, so the two streams run **fully in parallel** (only shared file =
`schema.prisma`, which Opus owns; one additive migration unblocks both).

- **4.0** ✅ Reconcile (this doc) + lock schema design. (`lib/incentive.ts` retirement re-homed to ~P6 — §2.)
- **Stream T — Targets (heart of P4):**
  - **4.4 ✅** `KpiDef` table + CRUD · `OutletTarget` + `TargetUploadBatch` · template download · verbatim
    upload (blank = omitted, 0 verbatim; non-template files rejected 400). Backend done; **admin FE repoint pending**.
  - **4.5 ✅** Achievement upload (`admin/sales/bulk-upload` → `OutletSalesRecord`) · pace
    (`OutletTarget`↔`OutletSalesRecord`, ÷0→null) · `partner.service` rewired off `SchemeTarget`. Backend done; **FE pending**.
- **Stream E — Enrollment/Schemes:**
  - **4.1 ✅** Scheme CRUD lifecycle + dropped `SchemeTarget` reads + removed decorative class UI.
  - **4.2 ✅** Enrollment-form persistence (`SchemeEnrollmentForm` upsert/get + pure schema validator).
    `CampaignType` audience confirmed at form level; **submission FE/wiring = 4.3**.
  - **4.3 ✅** Enrollment submission — `POST /v1/schemes/:id/enroll` (SELF vs SALES-on-behalf w/ assignment
    check) + `GET :id/my-enrollment`; audience enforced on the enrolled partner's KYC; `CALCULATED` recomputed
    server-side (client value discarded); upsert on `@@unique([schemeId,userId])`.

- **FE wiring ✅ (2026-06-17):** admin/targets → KPI management (`/api/admin/kpis`) · admin/targets/upload →
  backend template + server-side upload · admin/sales → `/api/admin/achievements/*` + pace · admin/schemes +
  scheme-builder → `/api/schemes` (+ enrollment-form PUT/GET) · enrollments export · partner enrollment submit ·
  partner/targets → new per-outlet×KPI shape. (Orchestrator reconcile: removed FE-B's dead local proxy routes
  — `next.config` already forwards `/api/*` → backend; mapped backend `KpiDef.code`→FE `id`.) Gated platform
  tsc 0 / vitest 133; KPI screen browser-verified against the live backend.

**P4 done.** Optional polish (non-blocking): dedupe the second `scheme-builder-campaign` test FE-C added; have
the achievement-upload screen download the backend template (it still builds one client-side).

**Exit:** tenant KPIs defined; admin uploads per-outlet-per-month targets (blank = not configured) +
achievement; target + achievement + pace display; **separately**, admin publishes activations and outlets
enroll via a configurable form. No compute anywhere.
