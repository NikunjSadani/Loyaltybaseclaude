# Focus products from the target file — design (FOCUS-FROM-TARGETS)

Owner-approved 2026-11-13 (option A). ⚠️ PLATFORM-WIDE (shared Sales Import + targets code), dormant for every tenant
until a Sales Import KPI is set to `productSource: 'TARGET_NAMES'`. Ships in the next release with LINES
(PRODUCT_COUNT, `5ed08fd6`) and the 194R export outlet columns (`1d664ad9`).

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

- `targets`: per owned KPI, outlets with a numeric target + Σ target; latest target batch time for the month.
- `focus`: per TARGET_NAMES KPI, every distinct name (by key) with outlets (+ by outlet type), each token's resolution,
  and `achieved` (Σ of the KPI's per-outlet values over those outlets, outlets at 0); plus the missing-name count.
- `blockers`: as §5, ≤ 20 sample outlet codes each.
- `gaps`: `targetNoSales` (roster outlets with a numeric owned-KPI target but no line this month) and `salesNoTarget`
  (roster outlets with lines but no target row this month), each with ≤ 20 samples. Informational, never blocking.
- Computed for EVERY tenant (targets + gaps are useful everywhere); `focus` is `[]` and `focusFingerprint` `''` without
  a TARGET_NAMES definition.

## 7. Early warning at target upload (non-blocking)

The target upload response gets `focusCheck: TargetUploadFocusCheck` — the same token resolution (§3, catalogue (a)
only) + FOCUS_MISSING_NAME per month in the file, for KPIs that have an enabled TARGET_NAMES definition. Never blocks
the upload. `checked: false` (+ `reason`) when there is no TARGET_NAMES definition or no stored product list yet. The
target upload page shows it.

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
