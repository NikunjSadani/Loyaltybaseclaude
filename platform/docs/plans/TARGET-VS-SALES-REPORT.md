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
Pace % (**since 2026-11-23 floored** to 1 dp, see below). Row set and order unchanged (one row per outlet with any target/sales row in the range × every month,
outlets in `localeCompare` order). A second sheet **About** gives the period, the filters, the row count and
plain-English definitions.

- **Programme / Sub-programme / Zone / State** — outlet master (`programName` / `programCategory` / `zone` / `state`),
  trimmed; blank or outlet not in the master → "Not set".
- **Hierarchy** — headers use the tenant's own level name (`SalesHierarchyLevel.name`; Bajaj XSR → "ISR"), else the
  Bajaj label, else ASM / SO / ISR. Resolution = the user-area rule (`forEachCoveredOutlet`): every ACTIVE rep assigned
  to the outlet, its owner partner, or its parent group; walk each rep's `reportingTo` chain (the rep counts as their
  own rung) to the first person at that level. Vacant position (inactive / removed / placeholder) → "Vacant (code)"
  + the code in the ID column (never the next manager up). Passing a more senior level, no rep, dangling link →
  "Not set". Several reps → distinct (name, ID) pairs sorted by name, joined **" | "** (names can contain commas) —
  names and IDs in the same order.
- **Unique headers**: a level name that would repeat a fixed column or another level's header gets its internal code
  appended (a level named "Outlet" → "Outlet Name (ASM)"; two levels both "Sales Officer" → "Sales Officer Name" and
  "Sales Officer Name (XSR)") — the JSON preview keys rows by header, so a clash would overwrite a column.
- **Deoleo decision**: a tenant whose hierarchy has NO level with that code keeps the columns (one layout for
  everyone) and shows **"Not set"** in that pair on every row; the About sheet says "This client's sales hierarchy has
  no ISR level…". Never blank. Prod (read-only check 2026-11-23): Deoleo HAS all six levels (XSR / SO / ASM / RSM /
  ZNM / NSM, XSR named "XSR" → headers "XSR Name" / "XSR Employee ID"); Bajaj's XSR is named "ISR". So the "Not set"
  rule only applies to the dev seed's Deoleo (SO + ASM only) or a future client.
- **Billing bucket** — exactly the Overview card: KPI = `pickReportKpi` (primary, else first enabled);
  `billingKpiValue` → `classifyBillingOutlet` → `BILLING_BUCKETS` labels ("Not started", "Under 20%", "20–39%",
  "40–59%", "60–79%", "80–99%", "Achieved (100%+)"); "No target"; "Not covered by the KPI target"; outlet outside the
  card's live roster (deleted / deactivated / parked / not interested, or not in the master) → "Not on the live outlet
  list"; no enabled KPI → "No KPI set up". Equivalence is proven by
  `target-vs-sales.kind.spec.ts` ("Overview billing card ⇔ Target vs Sales") feeding one fixture to both.
  Note: the card's "No target" count also includes live outlets with no target AND no sales row — those never appear
  in this report (not a disagreement: they have no report row). The card says so under its "Download Target vs Sales
  (Excel)" button.
- **Pace %** (every KPI) = achieved ÷ target × 100 **floored** to 1 dp (`floorPct1`: float noise removed first, so
  29/100 reads 29.0, 19.96 reads 19.9, 99.96 reads 99.9 — never rounded up). Before 2026-11-23 it was rounded. On the
  Billing-bucket KPI of a bucketed row it is the card's `displayPct` (clamped into the band), so it can never contradict
  the bucket (a target met within 0.005 reads 100.0). The card's own `displayPct` uses `floorPct1` too (an exact 29/100
  used to show 28.9 on the card).

## Filters (all optional; absent = the old behaviour)

`program` (trimmed programName), `outletType` (type code), `managerId` (the card's rule: outlets whose CURRENT direct
assignments include anyone in the manager's whole downline — `resolveBillingManagerScope` + `outletPassesBillingFilters`),
`bucket` (one of the 7 band keys; the card's NO_TARGET / NOT_COVERED / BEHIND_PACE lists → 400 with a clear message).
Outlets missing from the master are left out when any outlet filter is set.

**Manager filter vs hierarchy columns (kept as-is, documented):** the manager filter (like the card) uses the outlet's
own current assignments; the ASM / SO / ISR columns follow assignments to the outlet, its owner or its parent group.
They can differ when reps are assigned by owner / group. Prod check 2026-11-23: every assignment is a direct outlet
assignment (Bajaj 7,075, Deoleo 3,179; 0 by owner or group), so today they never differ. The About sheet says this.

**Screens:** the Overview card's "Download Target vs Sales (Excel)" (card filters, current month; disabled while the
card refetches) and, in a progress-band list, "Download Target vs Sales for this bucket (Excel)". The Behind pace /
Missed target, No target and Not covered lists say a Target vs Sales file isn't available for them and point to
"Download outlet list (Excel)" (renamed from "Download Excel"). The Reports page clears the preview on any filter or
period change, shows "For: …" (the card's words) next to Download Excel, and always offers the 7 bucket options. Params are stored RAW and parsed once on
each side of the export queue (round-trip spec cases added).

## Performance

Hierarchy = one tenant-wide load (levels, sales users, assignments + outlets keyset-paged ≤ 2,000) before the first
chunk; per chunk ≤ 2,000 rows: targets, sales, outlet master, live-roster check. No query per row.
