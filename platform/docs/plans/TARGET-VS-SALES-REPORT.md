# Target vs Sales Performance report

Admin → Reports → **Target vs Sales Performance** (`/admin/reports/target-vs-sales`) and the Overview
"Monthly billing progress" card's **Download Target vs Sales (Excel)**.

- Endpoint: `GET /v1/admin/reports/target-vs-sales?fromMonth=YYYY-MM&toMonth=YYYY-MM[&format=xlsx][&program=][&outletType=][&managerId=][&bucket=]`
  (CLIENT_ADMIN / GIFSY_ADMIN + `targets:read`; GIFSY_STAFF with `targets:read`). JSON = on-screen preview (≤ 3 months);
  `format=xlsx` = export kind `target-vs-sales` (≤ 3 months streams now, 4–15 months → Downloads page).
- Filter dropdowns: `GET /v1/admin/reports/target-vs-sales/filters` (same lists as the billing card).
- Code: `api/src/exports/kinds/batch2/target-vs-sales.kind.ts` (`runTargetVsSales` = the ONE engine for both the
  preview and the Excel), `api/src/reports/area/outlet-hierarchy.ts`, shared rules in
  `api/src/admin-core/dashboards/billing-progress.ts`. FE: `platform/src/app/admin/reports/target-vs-sales/page.tsx`,
  `platform/src/components/admin/dashboard/BillingProgressCard.tsx`, `platform/src/lib/target-vs-sales.ts`.

## Columns (2026-11-23, owner-approved PLATFORM-WIDE — every tenant incl. Deoleo)

Outlet Code · Outlet Name · Outlet Type · **Programme · Sub-programme · Zone · State · ASM Name · ASM Employee ID · SO
Name · SO Employee ID · ISR Name · ISR Employee ID** · Month · **Billing bucket** · per enabled KPI: Target / Achieved /
Pace %. Row set and order unchanged (one row per outlet with any target/sales row in the range × every month,
outlets in `localeCompare` order). A second sheet **About** gives the period, the filters, the row count and
plain-English definitions.

- **Programme / Sub-programme / Zone / State** — outlet master (`programName` / `programCategory` / `zone` / `state`),
  trimmed; blank or outlet not in the master → "Not set".
- **Hierarchy** — headers use the tenant's own level name (`SalesHierarchyLevel.name`; Bajaj XSR → "ISR"), else the
  Bajaj label, else ASM / SO / ISR. Resolution = the user-area rule (`forEachCoveredOutlet`): every ACTIVE rep assigned
  to the outlet, its owner partner, or its parent group; walk each rep's `reportingTo` chain (the rep counts as their
  own rung) to the first person at that level. Vacant position (inactive / removed / placeholder) → "Vacant (code)"
  + the code in the ID column (never the next manager up). Passing a more senior level, no rep, dangling link →
  "Not set". Several reps → distinct (name, ID) pairs sorted by name, joined ", " — names and IDs in the same order.
- **Deoleo decision**: a tenant whose hierarchy has NO level with that code (the dev seed's Deoleo has SO + ASM only,
  no XSR) keeps the columns (one layout for everyone) and shows **"Not set"** in that pair on every row; the About
  sheet says "This programme's sales hierarchy has no ISR level…". Never blank.
- **Billing bucket** — exactly the Overview card: KPI = `pickReportKpi` (primary, else first enabled);
  `billingKpiValue` → `classifyBillingOutlet` → `BILLING_BUCKETS` labels ("Not started", "Under 20%", "20–39%",
  "40–59%", "60–79%", "80–99%", "Achieved (100%+)"); "No target"; "Not covered by the KPI target"; outlet outside the
  card's live roster (deleted / deactivated / parked / not interested, or not in the master) → "Not on the live outlet
  list"; no enabled KPI → "No KPI set up". Equivalence is proven by
  `target-vs-sales.kind.spec.ts` ("Overview billing card ⇔ Target vs Sales") feeding one fixture to both.
  Note: the card's "No target" count also includes live outlets with no target AND no sales row — those never appear
  in this report (not a disagreement: they have no report row).

## Filters (all optional; absent = the old behaviour)

`program` (trimmed programName), `outletType` (type code), `managerId` (the card's rule: outlets whose CURRENT direct
assignments include anyone in the manager's whole downline — `resolveBillingManagerScope` + `outletPassesBillingFilters`),
`bucket` (one of the 7 band keys; the card's NO_TARGET / NOT_COVERED / BEHIND_PACE lists → 400 with a clear message).
Outlets missing from the master are left out when any outlet filter is set. Params are stored RAW and parsed once on
each side of the export queue (round-trip spec cases added).

## Performance

Hierarchy = one tenant-wide load (levels, sales users, assignments + outlets keyset-paged ≤ 2,000) before the first
chunk; per chunk ≤ 2,000 rows: targets, sales, outlet master, live-roster check. No query per row.
