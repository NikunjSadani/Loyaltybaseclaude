# Scheme Roster-Row Remove (SchemeOutlet soft-delete) — build plan

> **✅ BUILT + TRIPLE-AUDITED + STAGING-VERIFIED — on develop `378f795` (2026-08-01), awaiting owner-gated prod cutover.**
> Gate: api jest 2174/0 · nest build 0 · FE tsc 0 · vitest 2066. Carries additive migration
> `20260801120000_scheme_outlet_soft_delete` (deletedAt nullable + idx) — **APPLIED to gifsy_staging** (guarded,
> `col=1 idx=1`, recorded, not rolled back); **NOT yet on prod** (applies at cutover via deploy.yml). Three
> independent adversarial audits (leak-hunt + correctness + fix-diff): 1 HIGH (side-effect resurrect — fixed to
> "removed stays removed") + 1 MED (deleted-enrollments-panel identity leak — guarded) + 3 LOW, all fixed + confirmed
> clean. **Staging runtime-verify 16/16** (assumed-GIFSY synthetic scheme: upload 3 → remove/vanish/removed-list/
> restore/bulk/idempotent/dedup/all-removed/re-upload-resurrect → scheme deleted, no residue). Additive + DORMANT.

**Owner-approved (2026-08-01): Option A — soft-delete, mirroring the existing `SchemeEnrollment.deletedAt` pattern.**
Zero-defect bar (owner will NOT re-test). Additive + DORMANT. GIFSY-admin only.

## Goal
Let a Gifsy admin **remove a roster row** from a scheme's audience (a wrongly-added outlet), and
**restore** it — non-destructively. A removed row disappears from EVERY read (roster list/export,
enrollment reach/visibility, reports, notify recipients, admin enrollments view, sales eligibility,
prefill/facet pickers). Removing an outlet that already has a filled enrollment hides that enrollment
too (it's reached only through the roster row) and is fully recoverable by restoring the row.

## The two structural facts that shape it
1. `SchemeOutlet` has **no** soft-delete column today → additive `deletedAt`.
2. `SchemeEnrollment.schemeOutlet` + `SchemeSubmission.schemeOutlet` are `onDelete: Cascade` → a HARD
   delete would destroy captured data. Soft-delete avoids that entirely.

## Design contract (SINGLE SOURCE OF TRUTH = `SchemeOutlet.deletedAt`)
- **Remove/restore toggles ONLY `SchemeOutlet.deletedAt`.** We do NOT touch the enrollment's own
  `deletedAt` — every enrollment read is reached THROUGH its 1:1 `schemeOutlet`, so filtering
  `schemeOutlet.deletedAt: null` hides the enrollment automatically. (This avoids a restore-symmetry
  bug where restoring an outlet would wrongly un-delete an enrollment the admin separately deleted.)
- **Every `SchemeOutlet` read gains `deletedAt: null`.** (Direct call-sites enumerated below; the map
  agent confirms relation-based reads.)
- **The one enrollment-anchored read that bypasses `schemeOutlet`** — `scheme-report.service`
  `viewMediaByToken` (`schemeEnrollment.findFirst` by id, ~L428) — gains a
  `schemeOutlet: { deletedAt: null }` relation guard so a removed outlet's media link fails closed.
- **Resurrect-on-re-add** (mirrors enrollment reset-on-re-enroll):
  - `uploadRoster` upsert (Mode B): the `update` branch sets `deletedAt: null` → re-uploading a
    previously-removed `outletRef` brings it back.
  - `setAudience` filter-materialize: `createMany(skipDuplicates)` SKIPS an existing soft-deleted row,
    so after the createMany loop, run one `updateMany({ where:{ schemeId, outletRef:{in:currentSet},
    deletedAt:{not:null} }, data:{ deletedAt:null } })` to resurrect rows that are back in the filter.

## API (GIFSY-admin only; all under the scheme-admin controller, `@Roles('GIFSY_ADMIN')` like the
## other roster routes)
- `POST /v1/schemes/:id/roster/remove`  `{ schemeOutletIds: string[] }` (max 500) →
  soft-delete matching rows scoped `{ schemeId, clientId, id:{in}, deletedAt:null }`. Idempotent.
  Returns `{ removed, notFound }`.
- `POST /v1/schemes/:id/roster/restore` `{ schemeOutletIds: string[] }` (max 500) →
  clear `deletedAt` scoped `{ schemeId, clientId, id:{in}, deletedAt:{not:null} }`.
  Returns `{ restored, notFound }`.
- `GET /v1/schemes/:id/roster/removed` → paginated list of `deletedAt != null` rows (identity +
  removedAt) for the restore panel. Same shape as `getRoster`.

## Direct `schemeOutlet.*` call-sites (from grep; map agent confirms + adds relation reads)
READ (add `deletedAt: null`):
- scheme-admin.service.ts:405 getRoster findMany · :415 count (same where)
- scheme-admin.service.ts:445 getRosterExport findMany
- scheme-admin.service.ts:533 getPrefillSources findMany · (facet-values — confirm)
- scheme-report.service.ts:487 · :637 findMany
- scheme-notify.service.ts:198 · :262 findMany (broadcast recipients)
- scheme-enrollment.service.ts:365 findFirst (enroll resolve) · :1258 · :1331 findFirst
- scheme-enrollment.service.ts:1441 findMany (reach) · :1517 findMany (getSalesTargets)
- scheme-enrollment.service.ts:1684 findMany (admin list) · :1701 count
WRITE:
- scheme-admin.service.ts:281 createMany (setAudience) → + resurrect updateMany
- scheme-admin.service.ts:351 upsert (uploadRoster) → update branch `deletedAt:null`
- scheme-enrollment.service.ts:399 upsert (enroll standalone-row create) → update branch resurrect
  (enrolling a removed row implies re-activation) — CONFIRM context
NEW-LIST (uses `deletedAt:{not:null}`):
- getRemovedRoster (new)

## Pattern to mirror (enrollment soft-delete — copy this shape exactly)
- delete/restore/list: scheme-enrollment.service.ts `deleteEnrollment` :1123 · `restoreEnrollment`
  :1144 · `listDeletedEnrollments` ~:1163 (`where:{schemeId, deletedAt:{not:null}}`).
- controller routes: scheme-enrollment.controller.ts `GET :id/enrollments/deleted` :185 · delete :256
  · restore :268.
- read filter idiom: `deletedAt: null` in the where, or `x.deletedAt == null ? x : null` on a
  projected relation.

## FE
- `platform/src/components/admin/SchemeAudienceEditor.tsx` → `CurrentRosterPanel`: per-row **Remove**
  (trash) + confirm; optional multi-select bulk remove; a **"Show removed / Restore"** sub-panel
  (mirrors the enrollment "Show deleted" restore). GIFSY-only (already the panel's context).

## Migration
`ALTER TABLE "scheme_outlets" ADD COLUMN "deletedAt" TIMESTAMP(3);` + `CREATE INDEX ... ("deletedAt")`
(or composite `("schemeId","deletedAt")`). Additive, nullable. Apply to staging (oneoff) + prod (at
cutover, via deploy.yml migrate step).

## Verification (owner won't test → I do ALL of it)
- Full gate (api jest + nest build + FE vitest + tsc).
- ≥2 independent adversarial audits (leak-hunt: does a removed row surface in ANY read? resurrect
  correctness? cross-tenant scoping? enrollment-anchored media guard? re-upload/filter resurrect?).
- Staging runtime-verify: seed a scheme+roster, enroll one row, remove it → confirm it vanishes from
  roster/reports/export/sales-eligibility/reach; restore → returns; re-upload resurrect; bulk; then
  clean up synthetic data.
