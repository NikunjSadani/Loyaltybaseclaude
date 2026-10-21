# Payout Compute + Report (decoupled from crediting)

**Owner directive (2026-10-21):** "the payout flow will be where the engine computes the
payout based on the logic and the report is downloaded, shared with client, client shares
approval and then the final status of payment is uploaded. i do not think the calculation
engine needs to be linked with payouts being done. However, the calculation engine should
exist and a report should be created." + **"amount unit can be rounded off to INR and not paise."**

## Model

A **PAYOUT-award** rule is authored exactly like a POINTS rule, but its output is **money
(whole INR)**, and it is **compute-to-REPORT only** — the engine NEVER credits/pays it.

Flow: author PAYOUT rule → Compute → Preview (payout amounts per outlet) → **Download payout
report** → share with client → client approves offline → the **final payment status is
uploaded through the existing payout flow**, outside the engine. The engine does the
*calculation + report*, nothing more.

## The one safety invariant

`PointsComputeService.mapPreviewToUploadRows` feeds the **credit-upload export** and the
**direct-credit commit** (the money path). It MUST emit **POINTS rows only**. Before this
change PAYOUT rows never reached it (they were demoted to ERROR); now that PAYOUT rows
compute to OK, they are explicitly filtered out of that mapping (`awardType === 'POINTS'`),
and a PAYOUT OK row carries its amount in a **separate** field (`payoutRupees`), with
`points` left `undefined`. So a payout amount can never enter crediting, the points total,
the credit-upload file, or a wallet.

## Changes

### Backend
- **`points-compute.types.ts`**: `ComputePreviewRow.payoutRupees?: number` (OK PAYOUT rows,
  whole INR); `ComputePreview.totalPayoutRupees: number`.
- **`points-compute.service.ts`** §3b: PAYOUT OK rows are no longer demoted to ERROR. They
  are validated (field exists + active + classified PAYOUT for the outlet type — else honest
  ERROR), then the computed amount is moved `points → payoutRupees = Math.round(points)`
  (whole INR) and `points` cleared. §4 sums `totalPayoutRupees` separately from `totalPoints`.
  `mapPreviewToUploadRows` gains the explicit `awardType === 'POINTS'` guard. `demoteToError`
  also clears `payoutRupees`.
- **`points-engine.helper.ts` `validateRule`**: a PAYOUT rule must use `rounding.scale 0`
  (whole INR) — mirrors the POINTS scale-0 rule. (Compute also rounds defensively.)
- **`points-compute-export.helper.ts`**: `buildPayoutReportXlsx(preview)` — "Payout Rows"
  sheet (one row per PAYOUT row, amount in ₹ on OK) + "Summary" (payout-specific counts +
  Total Payout ₹).
- **`points-compute.controller.ts`**: `GET /v1/admin/points-compute/payout-report` → the
  payout report xlsx. Read-only report (like `preview-report`): role floor + `points_rules:read`,
  no engine fail-closed gate (it credits nothing).

### Frontend
- `types.ts` mirror; `api.ts` `downloadPayoutReport`.
- compute `page.tsx`: split OK rows into points vs payout; add a "Total payout (₹)" card and a
  "rows to pay out" group; add a "Download payout report" button (report-only copy); base
  "Credit in portal" / credit-upload on **points** OK rows only.

## Platform-wide note
Shared points-engine code, but **additive** and gated behind authoring a PAYOUT rule. The
engine is dormant for live Deoleo (POINTS-only), so this cannot change Deoleo behavior. No
schema/migration change. Verified Deoleo byte-identical by the gates + audit.
