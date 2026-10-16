# Bajaj hierarchy nomenclature rename — build contract

**Owner-approved 2026-10-15.** Bajaj-only rename of the sales employee-hierarchy nomenclature
"everywhere it is shown". **Internal role codes stay the same** (XSR/SO/ASM/RSM/ZNM/NSM remain the
machine identifiers) — we add a **Bajaj-only display + column-header layer** plus input/parse aliases.
**Deoleo and every other tenant must be byte-identical.** Platform-wide code, Bajaj-gated by tenant slug.

## Canonical mapping (the ONLY source of truth — every stream uses exactly this)

| Internal code (unchanged) | Bajaj display label | Bajaj ID-column header | Bajaj Name col | Bajaj Phone col (FE "Phone" / BE "Phone Number") |
|---|---|---|---|---|
| XSR | ISR | ISR Code | ISR Name | ISR Phone / ISR Phone Number |
| SO  | SO  | SO HQ   | SO Name  | SO Phone / SO Phone Number |
| ASM | ASM | ASM HQ  | ASM Name | ASM Phone / ASM Phone Number |
| RSM | SM  | SM HQ   | SM Name  | SM Phone / SM Phone Number |
| ZNM | ZH  | ZH HQ   | ZH Name  | ZH Phone / ZH Phone Number |
| NSM | NSM | NSM HQ  | NSM Name | NSM Phone / NSM Phone Number |

Outlet-master single leaf column: **"XSR ID" → "ISR Code"** (Bajaj).

Deoleo (and all non-Bajaj) keep the existing headers verbatim: `XSR ID`/`XSR Name`/`XSR Phone[ Number]`,
… , `NSM …`, and the outlet "XSR ID".

## Architecture: keep codes, add a Bajaj label layer + resolver

`TenantHierarchyLevel` gains two OPTIONAL fields (absent ⇒ current Deoleo behavior, byte-identical):
- `displayLabel?: string` — the label shown in UI and used as the Name/Phone column prefix. Defaults to `roleLabel`.
- `idHeader?: string` — the ID-column header. Defaults to `` `${roleCode} ID` ``.

A per-tenant resolver `hierarchyConfigForTenant(slug)` returns `BAJAJ_HIERARCHY` for `bajaj`, else `DEOLEO_HIERARCHY`.
(`admin/hierarchy/page.tsx` must call this instead of hardcoding `DEOLEO_HIERARCHY`.)

Header generators derive columns from the level:
- ID header   = `level.idHeader ?? \`${level.roleCode} ID\``
- Name header = `` `${level.displayLabel ?? level.roleCode} Name` ``
- Phone header = `` `${level.displayLabel ?? level.roleCode} Phone` `` (FE) / `… Phone Number` (BE)

## Backward-compat (MANDATORY — existing uploads must keep working)

Every parser that READS a renamed header must accept BOTH new and legacy:
1. `parseHierarchyChainRows` (employee-hierarchy.ts) — read `newHeader ?? legacy \`${roleCode} …\``.
2. `validateHierarchyChainHeaders` — accept a file whose columns are EITHER the new OR legacy set.
3. outlet-upload.ts `parseOutletUploadRows` — leaf id = `raw['ISR Code'] ?? raw['XSR ID']` (Bajaj); keep `raw['XSR ID']` working for Deoleo. Header validation accepts either.
4. `resolveRole` (Hierarchy column VALUE) — accept the Bajaj display labels (ISR/SM/ZH) as aliases for XSR/RSM/ZNM, in addition to the codes.

## Streams (disjoint file ownership)

### Stream FE-CORE — `platform/src/lib/employee-hierarchy.ts`, `platform/src/app/admin/hierarchy/page.tsx`
- Extend `TenantHierarchyLevel` (displayLabel?, idHeader?). Add `BAJAJ_HIERARCHY` per the mapping. Add `hierarchyConfigForTenant(slug)`.
- Update `getHierarchyChainHeaders`, `getHierarchyChainTemplateData`, `getTemplateData`, `generateGuideHtml`, `buildHierarchyChainExportRows`, `buildHierarchyErrorSheet`, `validateHierarchyChainHeaders`, `parseHierarchyChainRows` (+legacy alias), `resolveRole` (+label aliases) to use the per-level headers/labels.
- `admin/hierarchy/page.tsx` — resolve config per tenant (the page already knows the tenant slug via tenant context / useTenantFeatures endpoint; use the tenant slug).
- Update hierarchy tests; add Bajaj-config tests (headers, parse-with-new, parse-with-legacy, round-trip).
- EXPORT a small helper the other FE streams import: `leafIdHeaderForTenant(slug)` ("ISR Code"/"XSR ID") and `displayLabelForTenant(slug, code)`.

### Stream FE-SALES — `platform/src/lib/sales-role.ts`, `platform/src/app/sales/**`, `platform/src/lib/so-declaration.ts`
- `sales-role.ts`: add a Bajaj-aware `roleLabelFor(slug, code)` returning the Bajaj display label for bajaj, else existing `ROLE_LABELS[code]`. Do NOT change `ROLE_LABELS` values (Deoleo byte-identical).
- Update `sales/team`, `sales/team/[memberId]`, `sales/profile`, `sales/support`, `sales/kyc` (child-role filter), and `sales/kyc/[id]` approver/designation maps to use `roleLabelFor(slug, …)`; the slug comes from the tenant context already available in the app.
- `so-declaration.ts`: designations are DB-driven (hierarchyLevel.name) with hardcoded fallbacks — make the fallbacks Bajaj-aware (SM/ZH), keep Deoleo fallbacks unchanged.
- ⚠️ Reconcile-fit: VERIFY Deoleo's displayed labels are unchanged (ROLE_LABELS path untouched for non-bajaj). Add tests.

### Stream FE-OUTLET — `platform/src/lib/outlet-upload.ts`, `platform/src/lib/outlet-master-export.ts`, `platform/src/app/admin/users/outlets/page.tsx`
- outlet-upload.ts: template header `'XSR ID'` → leaf id header per tenant (`leafIdHeaderForTenant(slug)`); parse alias `raw['ISR Code'] ?? raw['XSR ID']`; header validation accepts either; update XSR/ISR guide + message text for Bajaj.
- outlet-master-export.ts: the D-section labels already use ISR for L1 — align the manager labels to the Bajaj mapping for bajaj (SM/ZH), keep Deoleo labels.
- admin/users/outlets/page.tsx: `LEAF_ROLE_CODE` stays 'XSR' (internal), but the "Assigned ISR" column header + search placeholder become Bajaj-aware display label.
- Update outlet-upload/outlet-master tests; add Bajaj header + legacy-alias tests.
- ⚠️ This file set was just changed by the outlet-master feature (committed @938fd49) — build on that.

### Stream BE — `api/src/admin-programs/reports.service.ts`, `api/src/reports/reports.service.ts`, `api/src/admin-core/hierarchy-persistence.ts`, `api/src/admin-outlets/admin-outlets.service.ts`, `api/prisma/seed.ts`
- reports.service.ts (outlet-master 57-col): the `RUNGS`-based header build + row keys must emit Bajaj headers (ISR Code/SO HQ/…; ISR Name/…; ISR Phone Number/…) when the tenant is bajaj; keep `resolveRungs` bucketing by internal `hierarchyLevel.code` (codes unchanged). Deoleo byte-identical.
- reports/reports.service.ts (session report `roleLabel` map): Bajaj-aware display labels; Deoleo unchanged.
- hierarchy-persistence.ts: `DEOLEO_HIERARCHY` copy + `buildLevelRows` persist `roleCode→code`, `displayLabel→name` for Bajaj (so the DB `name` carries the Bajaj label when a Bajaj hierarchy snapshot is persisted). `mapRoleCodeToUserRole` switch stays keyed on the UNCHANGED internal codes — no change needed (codes unchanged). Add a Bajaj config.
- admin-outlets.service.ts: XSR/ISR user-facing message vocabulary → Bajaj-aware; `LEAF_ROLE_CODE` stays internal.
- seed.ts: Bajaj `SalesHierarchyLevel` rows — `code` = XSR/SO/ASM/RSM/ZNM/NSM, `name` = ISR/SO/ASM/SM/ZH/NSM.
- Update BE tests (reports-outlet-master spec expectations become tenant-aware; add a Bajaj case).

## DB data (owner-gated staging/prod op — NOT part of the code streams)
Set the live **bajaj** tenant's `SalesHierarchyLevel.name` to the Bajaj display labels (ISR/SO/ASM/SM/ZH/NSM),
`code` unchanged. Show SQL, confirm, apply on staging first. (Deoleo rows untouched.)

## Open assumption (flagged to owner)
The `/sales` app currently shows LONG role names (ROLE_LABELS, e.g. "Area Sales Manager"). The owner's
mapping is short-form (ISR/SM/ZH). We apply the SHORT Bajaj labels in the `/sales` app for bajaj. If the
owner wants descriptive long Bajaj names instead, that is a copy change on top of this.

## Done = gates (api jest + nest build; platform tsc + vitest) + adversarial audit (Deoleo byte-identical,
backward-compat parse, no code-change) + staging runtime-verify + owner-gated DB data write.
