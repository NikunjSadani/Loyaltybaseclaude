# Focus products from the target file — design (FOCUS-FROM-TARGETS)

Owner-approved 2026-11-13 (option A). ⚠️ PLATFORM-WIDE (shared Sales Import + targets code), dormant for every tenant
until a Sales Import KPI is set to `productSource: 'TARGET_NAMES'`. ✅ Shipped to prod in `e242b1a1` (2026-11-13/14)
with LINES (PRODUCT_COUNT, `5ed08fd6`) and the 194R export outlet columns (`1d664ad9`); used for the Bajaj November 2026
apply (2026-11-15).

> ⚠️ **Trap (prod, 2026-11-15):** the per-outlet names are read from the target file's **second column with the same
> heading** as the KPI (first = value, second = names → `__names[kpiCode]`), and the Sales Import KPI scope is
> **intersected** with the target KPI's applies-to scope. Detail: `SALES-IMPORT-PIPELINE-PLAN.md` §18.

## 1. The problem

A Sales Import KPI has ONE product list (`filter`) for every outlet in its scope. Bajaj's focus brands differ per outlet
and per month and are already written in the TARGET FILE, in the KPI's per-outlet name column
(`OutletTarget.targetValues.__names[kpiCode]`). November 2026 on prod:

| Outlets | FOCUS BRAND (label "Focus Brand 1") | FOCUS BRAND 2 |
|---|---|---|
| Retailers SSS (4,079) | `CNO & ADHO500` | — |
| Wholesalers (2,338) | `ADHO50` | `ADHO500` |

Owner principles (verbatim intent): **one place to enter data** (the target file) and **one screen to reconcile**
(the month preview) so the operator knows exactly what will happen; **no silent failures**.

## 2. Operator model

- Once: Sales Import settings → each KPI's meaning. FOCUS BRAND / FOCUS BRAND 2 get **"Products: from the target
  file (per outlet)"** (`productSource: 'TARGET_NAMES'`, `filter: {}`), plus a measure (₹ / cases / products) and the
  usual outlet scope. Never edited month to month.
- Monthly: upload the target file (targets + focus names, the columns they already fill) and the sales file.
- Reconcile + apply on ONE screen: the import's month preview (and the month "Recalculate" preview), which now carries
  `MonthReconciliation` (targets, focus names → products, blockers, gaps, per-KPI results).

## 3. Reading a focus name (pure, `api/src/sales-import/kpi/focus-products.ts`)

- `focusKey(s)` = `normalizeDim(s)` with ALL whitespace removed (so UPPERCASE, trimmed, no spaces).
- `splitFocusName(raw)` = split on `&` or `,`; trim; drop empties; de-duplicate by key (keep first spelling).
- Catalogue = every known product combination of the tenant: the profile's dimension keys IN PROFILE ORDER
  (`[brand, skuGroup]` for Bajaj) over (a) every stored month's product list (`sales_month_history_combos`, all months)
  and (b) for an import preview, the import's own aggregates' distinct `dims`. For each combo with values `v1..vn`, every
  PREFIX is a candidate: key `focusKey(v1)` → `{d1:v1}` (the whole brand), `focusKey(v1)+focusKey(v2)` → `{d1:v1,d2:v2}`,
  … up to all n dims. Blank values end the prefix (a combo with blank skuGroup only yields the brand key).
- A token resolves to the DISTINCT DimMatches under its key: exactly 1 → `MATCHED`; 0 → `UNMATCHED`; >1 → `AMBIGUOUS`
  (e.g. brand `AB`+sku `C` vs brand `A`+sku `BC`).
- Owner confirmations: `CNO` = only the brand code `CNO` (not `CNO Enrich` / `CNO Green` — their keys are `CNOENRICH`
  / `CNOGREEN`, so they never match `CNO`). `ADHO50` = brand `ADHO` + skuGroup `50`.
- A name's filter = `{ anyOf: [product of every MATCHED token] }`. Accepted UNMATCHED tokens contribute nothing. A name
  whose tokens are all accepted-unmatched → filter that matches nothing (value 0).

## 4. Per outlet, per TARGET_NAMES definition, for month M

Targets = `OutletTarget` rows of (tenant, M); outlet codes mapped onto the CURRENT roster with the same normalized
index as the aggregates (`rosterIndexOf`). For a roster outlet in the definition's scope (`outletInScope`):

| Name for the KPI | Numeric target for the KPI | Result |
|---|---|---|
| present, all tokens MATCHED / accepted | any | value = the KPI's measure over the name's products (0 if none sold) |
| present, any token UNMATCHED (not accepted) or AMBIGUOUS | any | **blocker** (FOCUS_UNMATCHED / FOCUS_AMBIGUOUS); value computed from the matched tokens only, shown in the preview, month NOT applicable |
| absent | present | **blocker** FOCUS_MISSING_NAME; key omitted |
| absent | absent | key omitted (the KPI does not apply to that outlet this month) |

Measures: AMOUNT, QUANTITY and PRODUCT_COUNT all work with TARGET_NAMES (same netting rules as FILTER).

## 5. Blocking rules (no silent failures)

- Any blocker → `canApply: false`, `blockedReason` summarises (e.g. "2 focus product names in the November target file
  could not be matched — see Focus brands."). Apply re-checks under the month lock and refuses.
- `FOCUS_UNMATCHED` can be cleared by **"Accept — not sold yet"** (per month + KPI + token key): stored in
  `SalesFocusAcceptance` with who/when, AuditLog entry; removable. `FOCUS_AMBIGUOUS` and `FOCUS_MISSING_NAME` can only
  be cleared by fixing and re-uploading the target file.
- `focusFingerprint` (sha256 of stable JSON: sorted per-outlet `[outletCode, kpiCode, nameKey]` for in-scope outlets,
  each name key's resolution (status + product per token), accepted keys, missing-name outlets) is returned per month;
  apply / recalculate must send it back (`ApplyRequest.expectedFocusFingerprints[month]`,
  `SalesMonthRecalcRequest.expectedFocusFingerprint`); mismatch → 409 "The targets or focus products changed since the
  preview. Refresh the preview and try again." `''` when the tenant has no enabled TARGET_NAMES definition (then no
  fingerprint is required — every existing tenant/flow is byte-identical).
- `definitionsHash` includes `productSource` ONLY when it is `TARGET_NAMES` (existing hashes unchanged).

## 6. Reconciliation (`MonthReconciliation`, in `MonthPreview` and `SalesMonthRecalcPreview`)

- `targets`: per owned KPI (with its measure), outlets with a numeric target + Σ target; when the month's target rows were
  last written (`MAX(outlet_targets.updatedAt)`). `newerThanLastApply` / `SalesMonthRow.targetsChangedSinceApply` compare
  that time with the month's last apply and are true ONLY for a tenant with an enabled TARGET_NAMES definition (targets
  change no figure otherwise). Residual (audit 2026-11-13): a target upload commits in chunks, so an apply that reads targets
  while one chunk is in flight can miss that chunk's rows without the flag rising; the window is one chunk, needs two
  operators acting on the same month in the same second, and self-heals on the month's next apply / recalculate (every
  apply recomputes from the targets present). Closing it fully = target upload takes the sales-month lock (not done).
- `focus`: per TARGET_NAMES KPI, every distinct name (by key) with outlets (+ by outlet type), each token's resolution,
  and `achieved` (Σ of the KPI's per-outlet values over those outlets, outlets at 0); plus the missing-name count.
- `blockers`: as §5, ≤ 20 sample outlet codes each.
- `gaps`: `targetNoSales` (roster outlets with a numeric owned-KPI target but no line this month) and `salesNoTarget`
  (roster outlets with lines but no target row this month), each with ≤ 20 samples. Informational, never blocking.
- Computed for EVERY tenant (targets + gaps are useful everywhere); `focus` is `[]` and `focusFingerprint` `''` without
  a TARGET_NAMES definition.

## 7. Early warning at target upload (non-blocking)

The target upload response gets `focusCheck: TargetUploadFocusCheck` — the same token resolution (§3, catalogue (a)
only, the month's acceptances applied) + FOCUS_MISSING_NAME per month the upload actually wrote, for KPIs that have an enabled TARGET_NAMES definition. Never blocks
the upload. `checked: false` + `reason` + `reasonCode` (NO_TARGET_NAMES_KPI = silent; NO_PRODUCT_LIST / CHECK_FAILED = a
grey note on the target upload page, so a skipped check is never silent).

## 8. Data model (one additive migration)

- `SalesKpiDefinition.productSource String @default("FILTER")` (`'FILTER' | 'TARGET_NAMES'`).
- `SalesFocusAcceptance { id cuid, clientId, month, kpiCode, key, acceptedById, acceptedAt @default(now()),
  @@unique([clientId, month, kpiCode, key]), @@index([clientId, month]), @@map("sales_focus_acceptances") }`.

## 9. Save-time validation (KPI definitions)

`productSource: 'TARGET_NAMES'` requires `filter` = `{}` (reject otherwise) and the target KpiDef to have a per-outlet
name column (`hasNameOverride` + `nameOverrideLabel`) — else "Turn on the per-outlet name column for this KPI in KPI
settings first, so the target file can carry the product names." Unknown `productSource` → 400.

## 10. Build split (this release)

| Lane | Owns |
|---|---|
| B1 core | `focus-products.ts` (pure: key/split/catalogue/resolve, `resolveMonthFocus`, fingerprint, reconciliation builder); per-outlet filters in `OutletKpiAccumulator` / `computeMonthRows`; unit tests |
| B2 services | migration + schema; loaders (month targets, catalogue, acceptances); preview / apply / recalculate wiring + 409s; acceptance endpoints; KPI save validation + hash; target-upload `focusCheck`; service/controller tests |
| B3 screens | KPI editor "Products: from the target file"; reconciliation panel on the import month preview + recalculate panel; Accept / Undo; apply sends fingerprints; target upload page shows `focusCheck` |

## 11. Order of events — either order works (owner question 2026-11-13)

Targets for a month often arrive on the 6th–7th while sales run from the 1st, and sales files may later be uploaded
automatically. Nothing here requires targets first:

- A sales file can be uploaded and processed at any time; its lines are stored. Applying computes every KPI from those
  lines and the targets that exist AT APPLY TIME.
- Applied BEFORE the month's targets exist: TOTAL / ADHO / NON ADHO / LINES (FILTER KPIs) are written normally. A
  TARGET_NAMES KPI has no names and no targets yet → its key is omitted for every outlet (rule §4, row 4) — NOT a
  blocker, and NOT silent: the reconciliation shows "No targets uploaded for this month yet — focus KPIs are not
  calculated" (`targets.targetUploadedAt === null`).
- Targets uploaded LATER (or re-uploaded): the month row shows `targetsChangedSinceApply` ("Targets changed —
  recalculate"), and the month's reconciliation `targets.newerThanLastApply`. One click — Months → Recalculate from
  stored history (no file re-upload) — recomputes every KPI from the stored lines with the targets now present, through
  the same reconciliation + blockers. The next sales file of the month does the same automatically when applied.
- An automated sales upload (future) only ingests + processes; applying stays a deliberate step on the reconciliation
  screen, so blockers are always seen before achievements change.

## 12. Audit follow-ups (2026-11-13, dual audit + UI/UX lane — no CRITICAL/HIGH)

- Product columns are frozen (400) while an enabled PRODUCT_COUNT or TARGET_NAMES KPI exists (they define "one product");
  TARGET_NAMES needs ≥ 1 product column.
- Apply loads the focus catalogue ONCE per request (stored lists at request start ∪ the import's products) and reuses it
  under the lock, so applying an earlier month can't unmatch a later month's names mid-request.
- A non-blank name with no product in it (e.g. "&") is a FOCUS_MISSING_NAME blocker (no Accept offered).
- "Accept — not sold yet" only for a key that is a token of that month's target names for that KPI (400 otherwise).
- No empty OutletSalesRecord is inserted for an outlet with no KPI values (existing rows still lose owned keys).
- Migration: `20261115130000_focus_from_targets` (unique timestamp), no redundant index.
- Known limitations (no Bajaj instance today): a brand whose name contains `&` or `,` can't be written as a focus name; a
  token that genuinely matches two different products (AMBIGUOUS) can only be fixed in the target file.

## 13. Focus names from another KPI (owner-approved 2026-11-25, platform-wide but opt-in)

A TARGET_NAMES definition may set `focusNamesFromKpi = <KPI code>` (nullable column, migration
`20261125100000_sales_kpi_focus_names_from_kpi`): it reads the per-outlet names written for THAT code instead of its own,
in the same `resolveMonthFocus` pass, so e.g. `FB1 CASES` (QUANTITY) gets exactly `FOCUS BRAND`'s product set per outlet
(`CNO & ADHO500` → all CNO + ADHO 500 cases).
- Save-time: TARGET_NAMES only; not itself; the source must be an ENABLED TARGET_NAMES definition of the same tenant that
  reads its OWN names (one level → no chains / cycles). The borrower needs no name column of its own. A source with
  enabled borrowers cannot be disabled, renamed, switched to FILTER or made to borrow (409 naming the borrowers).
- Month: values need NO target of the borrower's own (Bajaj: cases achieved only) — every outlet with a source name gets
  one. `FOCUS_MISSING_NAME` when the borrower's own OR the source's target exists but the source name is blank (outlet
  omitted); an outlet the source already flags is not flagged twice;
  UNMATCHED / AMBIGUOUS tokens already reported on the source are not repeated (one fix / acceptance on the source clears
  both; an acceptance on the borrower also counts); source not available at run time → `FOCUS_SOURCE_MISSING` (no outlet
  gets a value, month blocked).
- NULL (every existing row) = unchanged: same DTO, lite, `definitionsHash` and focus fingerprint (pinned in
  `api/src/sales-import/kpi/focus-names-from-kpi.spec.ts`).
- Audit round 2 (2026-11-25): a borrower must have the SAME EFFECTIVE outlet scope as its source (definition types /
  programmes ∩ KPI applies-to) — refused at save, and `FOCUS_SCOPE_MISMATCH` (no values) at run time if the KPI
  applies-to changes later; a source with borrowers can't change its own types / programmes. A month where the source has no
  focus name at all is NOT blocked (owner 2026-11-25): see the last bullet. Separator-only
  names de-dupe against the source internally (payload unchanged, still no `key`). A DISABLED borrower is editable
  whatever its source; the source check + borrower check run INSIDE the write transaction under a row lock
  (`SELECT … FOR UPDATE` on the source definition), so a concurrent source disable / borrower save serialise.
- No focus names in the month (owner decision 2026-11-25): the month applies; each borrowing KPI is left EMPTY (no value,
  not 0) and listed in `MonthReconciliation.notCalculated` (absent when none) with a red warning "No focus names in this
  month's target file — <KPI> not calculated". Apply needs `acknowledgeNotCalculatedMonths` (400 before any write;
  re-checked under the month lock), recalculate needs `confirmNotCalculated: true`; both are recorded on the month's
  audit row (`notCalculated: { kpiCodes, acceptedById, messages }`). Uploading the targets and recalculating fills them.
  When the month already holds values for such a KPI, the warning (and the tick) says "Existing <KPI> values for N outlets
  will be REMOVED" (`existingOutlets`); its per-KPI preview row says "not calculated" (`MonthPreviewKpi.notCalculated`).
  The tick is cleared whenever the preview reloads.
