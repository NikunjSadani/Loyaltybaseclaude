# Reporting Revamp — user-driven track

> Adopted 2026-06-15. **Isolated track on `develop`.** User-driven reporting UI/UX + new reports,
> built **ahead of P8** so the client can approve the **look and feel** early. DEMO_MODE carries the
> full look-and-feel now; production DB-wiring of any field that depends on master data not yet built
> (sales org tree, distributor, program) is **deferred to the phase that builds that data** (P2/P4) and
> tracked here. This is an early build of [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md) **§P8.2**, not a new phase.

## Process
- Built → gated → **independently audited** per [`08-agent-execution-guide.md`](08-agent-execution-guide.md)
  (audit everything; docs by Opus). **UI = human (owner/client) sign-off** — executors build + unit-test,
  they cannot judge UX.
- Verification gate: in DEMO_MODE we verify look-and-feel + export shape now. **Real-DB end-to-end
  verification of the P2/P4-dependent columns happens when that data exists** (recorded per report below).

---

## R1 · Outlet Points Ledger report

**Category:** Business · **Filter:** period picker, month **From–To**, **max 24 months**.
**Goal of this build:** client look-and-feel sign-off + the points-aggregation engine (the part that is
fully backed today).

### Columns (exact order)
`Outlet ID` · `Outlet Name` · `Zone` · `ZNM id` · `RSM id` · `ASM id` · `SO id` · `XSR id` ·
`Distributor code` · `Distributor Name` · `Program name` · `Program category` · `Outlet type` ·
`Opening balance` · **{ for each month in range: `<Mon YYYY> Earn`, `<Mon YYYY> Burn` }** ·
`Total earn` · `Total burn` · `Total expired` · `Closing balance`.

### Column → data mapping
| Column(s) | Source | Status |
|---|---|---|
| Outlet ID / Name / type | `Outlet`, `OutletType` | ✅ exists |
| Opening / monthly Earn / monthly Burn / Total earn / Total burn / Total expired / Closing | `PointsLedger` (via `Outlet → partner(1:1) → Wallet → PointsLedger`), bucketed by `createdAt` month. **Earn = `EARN`** (+credit `ADJUST`/`REVERSE`), **Burn = `REDEEM`**, **Expired = `EXPIRE`**. `Opening = net points before period start`; `Closing = Opening + Earn − Burn − Expired`. | ✅ engine buildable now |
| Zone, ZNM id, RSM id, ASM id, SO id, XSR id | `SalesHierarchyLevel` + `SalesUser.reportingTo` chain + `SalesUserAssignment` (outlet→salesUser→walk up) | ⏳ **P2** — schema exists, org tree **not seeded**; blank in prod until P2.1/2.2, demo-filled now |
| Distributor code / Name | **No `Distributor` entity and no outlet→distributor relation exist** | ⏳ **P2.4** — must define entity + link first; demo-filled now |
| Program name / category | Closest is `Scheme` (no "category" field); no "Program" entity; `PointsLedger.schemeId` exists but points span **many schemes** over 24 months | ⏳ **P4** — define Program(=Scheme?)+category and decide per-outlet vs per-outlet×program granularity; demo-filled now |

### Decisions (locked)
- **Points attribution: 1 partner = 1 outlet.** `Wallet` is keyed by `partnerId`; we attribute a partner's
  wallet to its single outlet. **Rides on P2.4 finalizing the 1:1 partner↔outlet binding (gap #4).** If P2
  lands multi-outlet partners, this report needs an allocation rule — revisit.
- **Expired is a separate column** (not netted into Burn).
- **Build now, stub P2/P4 columns** (owner directive): ship the engine + UX for sign-off; wire the rest later.

### Build-now scope (this track)
- `lib/points-ledger-export.ts`: pure `monthsInRange` (≤24 enforced), pure aggregation, dynamic-column
  `generatePointsLedgerExcel`, `DEMO_*` rows (reuse outlet-master demo distributor/program/hierarchy values
  for consistency).
- `api/admin/reports/points-ledger` route: admin-only + `requirePermission('reports:export')`;
  `?from&to&format=json|xlsx`; validate `from≤to` and `≤24 months` (400 otherwise); DEMO_MODE fully
  populated; production fills outlet + points columns, leaves P2/P4 columns blank with a TODO.
- `admin/reports/points-ledger` page: period picker + **on-screen preview table** (sticky outlet cols,
  horizontal month scroll) + **Export Excel**. Linked from the Reports list (business).
- Unit tests for the pure functions (month range, aggregation math, column count/labels).

### Deferred / repercussions (do NOT lose — wired in later phases)
- **P2.1/2.2:** wire Zone/ZNM/RSM/ASM/SO/XSR from the real org tree + assignments.
- **P2.4:** define **Distributor** entity + **outlet→distributor** relation, then wire those two columns;
  **confirm 1:1 partner↔outlet** (our attribution depends on it, gap #4).
- **P4:** define **Program / Program category** mapping; decide per-outlet vs per-outlet×program rows.
- **P8.2:** fold this report into the reporting reconcile; add it to scheduled-reports/exports if needed.
- **Real-DB evidence** for every now-stubbed column once the data exists (our gate requires it).

### Open questions for client sign-off
- Hierarchy label set (client uses **XSR** lowest, not ISR; **Zone** as a separate column) — confirm names/order.
- Month label format (`Apr 2026`?) and whether a partner with no activity should still appear (zero row).
