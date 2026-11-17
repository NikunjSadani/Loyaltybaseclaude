# APPLIES-TO TARGETING — KPI + Visibility scope by Outlet Type(s), Program, Sub-Program

**Status:** ✅ SHIPPED — merged and on prod since `247fae4b` (2026-11-13); current prod `2eb8271d`. The Sales Import KPI scope is intersected with this KpiDef scope (`SALES-IMPORT-PIPELINE-PLAN.md` §18). _(Original:)_ APPROVED by owner 2026-11-12 with ALL ★ decisions (fast follow-ups #1 KPI↔Program, #2 KPI outlet-type multi-select, #3 Visibility by Program/Sub-Program). ⚠️ PLATFORM-WIDE, owner-approved in-session. Branch `feat/applies-to` (worktree `.claude/worktrees/applies-to`, off develop `dd27888b`). Must leave every tenant with no scope configured (incl. live Deoleo) byte-identical.

## 0. Model
`AppliesTo = { outletTypes: string[]; programs: string[]; subPrograms: string[] }` — AND across facets, OR within; **empty facet = all**; matching trimmed + case-insensitive; `programs` ↔ `Outlet.programName`, `subPrograms` ↔ `Outlet.programCategory`, `outletTypes` ↔ `Outlet.outletType.code`. Sub-programs are an independent flat list (no nesting).
- **KpiDef**: add `outletTypes String[] @default([])`, `programs String[] @default([])`, `subPrograms String[] @default([])`; backfill `outletTypes = ARRAY[outletType]` where `outletType` non-blank; keep `outletType` as DEPRECATED for one release, dual-written (`= outletTypes[0]` only when exactly one type and no programs/subPrograms, else null). Drop later (separate owner-approved migration).
- **visibilityConfig** (JSON in program_settings): add `programs: string[]`, `subPrograms: string[]` (empty = all). `outletScope` keeps its meaning (types; **empty = NONE**) and remains required (≥1 type).
- One pure helper `api/src/common/applies-to/` replaces 4 near-duplicate matchers for KPI/visibility use (sales-kpi.helper `scopeHas/outletInScope`, offers `outletMatches` stay as-is unless trivially reusable; audience + points-engine exact matching NOT changed).

## 1. Prior art / current consumers (file:line at dd27888b)
- KpiDef schema `api/prisma/schema.prisma:2954-2986` (`outletType` @2978); Outlet `programName` 1233, `programCategory` 1234, `outletTypeId` 1226. Program values are free text in BE (admin-outlets.service.ts:198-199, 1459-1460); FE validates vs tenant lists.
- Tenant lists `outletPrograms`/`outletCategories` flat: tenant-settings.service.ts:202-207 (defaults 363-364); edited platform/src/app/admin/settings/page.tsx:756-823.
- visibilityConfig type tenant-settings.service.ts:135-144, default 373, copy 570, overlay 688-704. Writers (replace-whole!): visibility-admin.service.ts:72-110 (DTO dto/visibility-admin.dto.ts:41-62) and generic `PUT /admin/settings visibilityConfig` (platform/src/lib/gifsy-settings.ts:198).
- Matchers: SalesKpiDefinition (schema 3056-3057) + `sales-kpi.helper.ts:73-90` (ci, empty=all); OfferTile + `offers/offers.helpers.ts:71-80`; `common/audience/audience.helpers.ts:66-84` (exact); points-engine `getActiveForAttachment` points-engine.service.ts:293-334 (exact).

### KPI consumers to make scope-aware
- Write/CRUD: targets.service.ts:130-200 `upsertKpi` (no-op guard 137-145), :213-241 `resolveKpiOutletType`, dto/targets.dto.ts:43-49 (forbidNonWhitelisted → add fields), :111-122 listKpis, :299-315 seedDeoleoKpis (no change).
- Templates/uploads: targets.service.ts:323-376 getTemplateBuffer, :703-773 buildAchievementTemplate, :528-694 uploadTargets (persist 609-639), :781-945 uploadAchievements; targets.helpers.ts KpiDefLike 36-44, OutletLike 64-68, RowStatus 72, FIXED_COLS 168, generateTargetTemplateBuffer 185-275, parseTargetUploadBuffer 494-735 (integrity 611-628, cell loop 680-711). Exports 383-455/458-525 unchanged (dump stored).
- Sales-import: sales-kpi.helper.ts KpiDefLite.kpiOutletType 36-44, outletInScope 80-90, definitionsHash 341-356; sales-kpi-def.service.ts kpiOutletTypesOf 67-75, toLite 49-60, list 94-102, enabled 129-138, tester 302/334, segmentOptions 109-125 (+subPrograms); sales-import-data.ts 26-30/64-74 (+programCategory); apply/month-compute.ts:97-100; sales-import.contract.ts; FE kpi-editor.tsx 20-40/239-253.
- Sales: sales-kpi-type.helper.ts:22-59 (kpisForOutletType/primaryKpiForOutletType → generalise); sales.service.ts getTradeComparison 880-960 (909/916; progF 905), getTargets 1390-1480 (1424-1432), getTargetTrend 1662-1730 (1678-1679), getTeamView 431-780 (KPI list 460-464 currently unfiltered; visibility pseudo-KPI 548-600, scope 590), getTeam/buildTeamRollups 181-420 (primary 368-373), getLeaderboard 1735-2000 (primary 1876-1881), readOutletTargets 1548-1610, buildOutletScope 789-850 (+programCategory), subtreeOutletCodes 1350-1388.
- Partner: partner.service.ts:405-500 (kpiDef 417), 520-560 (primary 530-540); group.service.ts:262-340; FE partner/targets/page.tsx, partner/dashboard/page.tsx:978-1042.
- Points engine: points-engine.service.ts:375-391 assertKpiCodesExist (publish gate → disjoint-scope 400); points-compute.service.ts:73-340 previewCompute (outlet load 128-147, loop 187-280 → SKIP out-of-scope); FE RuleBuilder.tsx:201-220, compute/page.tsx:271-277.
- Offers: offers-admin.service.ts:141-163 assertRefs (scope-overlap warning); offers-partner.service.ts:70-140 (no change; test).
- Admin dashboards/reports: program-health-dashboard.service.ts:270-300; admin-programs/reports.service.ts:810-830; targets.service.ts getPace 1070-1180.

### Visibility consumers
visibility-capture.service.ts getSalesEligible 208-345 (where 293-301), status 375-420 (395), loadInScopeOutlet 526-553 (403 at 549); visibility-admin.service.ts outlets-in-scope 178-215, setConfig 72-110; visibility-report.service.ts addressableInScopeWhere 48-125 (numerator==denominator invariant), captures export 145-270 (no scope filter — keep); visibility-notify.service.ts 93-130; sales.service.ts 548-600 visAggregate; FE VisibilityConfigEditor.tsx 30/71/93-131/165, VisibilityReportView.tsx:135, lib/visibility.ts 63/152, lib/visibility-types.ts 186/680, types/index.ts 528-540, lib/gifsy-settings.ts 49-50. Visibility PAYOUTS/INVOICES/TDS do not read outletScope (credits/invoices) — unchanged.

## 2. Helper API (`api/src/common/applies-to/applies-to.ts`, pure)
`normalizeAppliesTo`, `isUnscoped`, `appliesToOutlet(scope, {outletType, program, subProgram})`, `appliesToFilter(scope, {outletType?, program?, subProgram?})` (facet passes if empty OR filter absent/'ALL' OR contains), `intersectAppliesTo`, `fromLegacyOutletType`, `canonicalScopeKey` (hash), and sibling `applies-to.prisma.ts` `appliesToOutletWhere(scope)` (OR of `{equals: v, mode:'insensitive'}` per value). FE mirror `platform/src/lib/applies-to.ts`.

## 3. Owner-approved decisions (★)
- **D1** Upload value for an out-of-scope (outlet, KPI): IGNORE that cell, keep the row; remarks list ignored KPIs; summary `ignoredOutOfScope`. (Targets + achievements.)
- **D2** Template: for tenants with any scoped KPI add `Program`, `Sub-Program` info columns after `Outlet Type` and pre-fill out-of-scope cells with `N/A` (parser ignores non-numeric). Unscoped tenant template byte-identical.
- **D3** Enforce at write + KPI-list building; never hide stored values at read time; exports dump stored values.
- **D4** Non-empty facet + blank outlet value → OUT of scope.
- **D5** Points compute: out-of-scope pair → SKIP with reason "KPI not applicable to this outlet (KPI scope)". Rule publish with program/programCategory disjoint from the KPI scope → 400.
- **D6** Out-of-scope KPI hidden in filtered single-outlet/type views; "—" in multi-outlet tables; primary KPI falls back to the outlet's first in-scope KPI (`primaryKpiFor(scopeFilter)`).
- **D7** Sales views with a program filter narrow the KPI list too (appliesToFilter) — also fixes team-view KPI list ignoring the type filter (460-464). Leaderboard keeps tenant primary but skips outlets where it is out of scope.
- **D8** KPI/visibility matching trimmed + case-insensitive; stored values canonicalised to the settings-list spelling (fallback: most common live outlet spelling). Points-engine rule matching NOT changed.
- **D9/D10** Live evaluation: program change takes effect immediately (visibility list/capture 403, coverage numerator+denominator move together); stored target values remain until next upload; compute uses current attributes.
- **D11** Sub-programs independent of programs (AND).
- **D12** Visibility still requires ≥1 outlet type; programs/subPrograms narrow further.

### Audit round 2 (2026-11-12) — owner rules applied
- **Every reader honours scope:** points compute masks each referenced input KPI (bonus `kpiCode`/`achievement:`/`target:`/`pct:`) by THAT KPI's scope per outlet (out-of-scope → absent → `nullAs`); offer-tile progress sums only segment outlets where the tile KPI applies (none → progress null).
- **D1 refined (OWNER DECISION):** a re-upload NEVER deletes stored out-of-scope values — targets/achievements carry over the stored keys (and target `__names`) of every KPI out of scope for that outlet, in-statement (same mechanism as importer-owned keys). Mixed and all-out-of-scope rows both leave stored out-of-scope values untouched. UI copy says so. **Batch delete** (achievements — the only batch-delete endpoint; targets have none) follows the same rule for scope-enforced tenants: a row keeps only its out-of-scope keys, re-pointed to the latest other batch of the same month (else of the tenant); importer-owned keys keep the existing owned rule; if the tenant has no other batch to hold them → 409, nothing deleted (FE shows the reason). Unscoped tenants: unchanged plain cascade.
- **D5 case-only check** compares rule segment values to the LIVE outlet spellings (what the engine matches exactly) and names them; an exact live match is never rejected. FE RuleBuilder drops its case hint (no live spellings there) and now mirrors the backend `ruleAppliesTo` incl. hard segmentFilter nodes (`ruleScopeOf`).
- **ILIKE escaping** guarded offline by `applies-to.prisma.compiled.spec.ts` (real query compiler, stub adapter).
- **Visibility program lists:** every submitted value is stored in its canonical spelling (settings list → most common live); a stale value with no canonical keeps the submitted spelling — a case-only edit is never a silent no-op.

## 4. Write API
`UpsertKpiDefDto` + optional `outletTypes?`, `programs?`, `subPrograms?` (`@IsOptional @IsArray @IsString({each})`). Legacy `outletType` accepted (→ `[outletType]`; arrays win). Omitted = unchanged; unchanged resend not re-validated. Validation: types ⊆ enabled tenant types (canonical codes); programs/subPrograms ⊆ (settings list ∪ distinct live outlet values), ci → 400 listing allowed values. AuditLog row only when scope changes. Visibility `setConfig` (and generic settings PUT): absent `programs`/`subPrograms` keys → carry over stored values (stale-tab safety).

## 5. Sales-import hash stability
`definitionsHash` must not change for existing data: unscoped KPI → emit nothing; exactly one type & no programs → emit legacy `kpiOutletType: TYPE`; else `kpiScope:{sorted}`. Pin with existing fixture hashes. SalesKpiDefinition scope intersects KPI scope.

## 6. UI
KPI form (admin/targets/page.tsx 276-301): three ScopeMultiSelects (shared component lifted from sales-import kpi-editor.tsx:83 → `platform/src/components/admin/scope-multi-select.tsx`); options from new `GET /v1/admin/kpis/scope-options` (types w/ labels, programs = settings ∪ live, subPrograms = settings ∪ live, badge "(not in settings list)"); "Leave all empty = applies to every outlet"; live matching-outlet count; send arrays only when changed; list row scope chip. Upload result screens show `ignoredOutOfScope`. VisibilityConfigEditor: "Programs (optional)", "Sub-Programs (optional)" + in-scope count. RuleBuilder + offer-form warnings; kpi-editor generalised warning.

## 7. Tests + verification
Exhaustive helper matrix; byte-identical unscoped template golden test; parser N/A round-trip; definitionsHash fixtures unchanged; sales/partner/points/visibility specs per §1; setConfig carry-over; overlay defaults. Gates `bash scripts/gates.sh` un-piped. Deoleo proof: SQL count of scoped KPI rows = 0 before/after migration; response-diff harness on staging (admin/kpis, sales targets/trend/team-view/leaderboard, partner targets/group, program-health, compute preview) + sha256 of target/achievement templates identical. Bajaj staging role matrix (GIFSY_ADMIN, CLIENT_ADMIN, SO/ASM, XSR, partner) per design; revert temp UAT scope after.

## 8. Work packages
- **WP-0 contract** (first): schema + migration + helper (+spec) + FE mirror + generalised sales-kpi-type.helper (old names as wrappers) + VisibilityConfigSettings type/overlay.
- **WP-A** (after WP-0): `api/src/targets/**`, `api/src/sales-import/kpi/**`, `sales-import/apply/{month-compute,sales-preview}`, `sales-import.contract.ts`. Not sales.service/visibility/platform.
- **WP-B** (after WP-0): `api/src/sales/sales.service.ts`, `partner/{partner,group}.service.ts`, `points-engine/{points-compute,points-engine}.service.ts`, `offers/offers-admin.service.ts`, admin dashboards/reports, `api/src/visibility/**`. Not targets/sales-import.
- **WP-C** (after WP-0): platform UI per §6 + platform tests.
- Orchestrator: merge, independent adversarial audit, full gates, Deoleo diff, Bajaj staging matrix, docs/memory sweep.
