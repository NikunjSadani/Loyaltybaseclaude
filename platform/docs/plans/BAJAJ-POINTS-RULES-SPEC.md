# Bajaj points / payout rules — spec (DRAFT for owner sign-off)

Source: Bajaj scheme slides "Retail Loyalty Program – Unnati (Excluding South)", "– SAMT – (Excluding South)",
"Urban BSC" (re-shared 2026-11-25). Owner answers recorded 2026-11-25.

Status legend: ✅ owner-confirmed · ❓ open question (see §6) · 📝 my reading of the slide.

## 0. Rules that apply to every programme (owner-confirmed)

| # | Rule |
|---|---|
| G1 ✅ | A **gate** is a gate on EVERY payout / points item of that outlet unless the slide ties it to one parameter. |
| G2 ✅ | **Per-parameter 100% gate:** a parameter pays only if *that parameter's* achieved ≥ its own target. |
| G3 ✅ | **% is paid on the achieved value** of that parameter. |
| G4 ✅ | **120% cap per parameter:** achieved counts only up to 120% of that parameter's own target. `pay = rate × min(achieved, 1.2 × target)` |
| G5 ✅ | **Lines is binary:** fixed amount if Lines achieved ≥ Lines target, else 0. No over-achievement, no cap. |
| G6 ✅ | **No target uploaded ⇒ no payout** for that parameter (this is how South / Telangana are excluded — no state filter). |
| G6b ✅ | **Target of 0 = no target:** that parameter pays 0; the row is flagged "target is 0". |
| G6c ✅ | Each rule amount is rounded half-up to whole ₹ (consistent with whole-unit credits); total = sum of rule amounts. |
| G7 | Unnati + SAMT outlets are SSS → **₹ PAYOUT report only** (engine never pays). BSC wholesalers → **POINTS** (1 point = ₹1). |

## 1. Unnati (sub-programme **Unnati**, target value ≥ ₹4,000)

Outlet-level gate: **NON ADHO achieved ≥ ₹400** — if missed, the outlet gets nothing (G1).

| Parameter | Own gate | Pays | Cap |
|---|---|---|---|
| ADHO | ADHO ach ≥ ADHO target | 2.5% × ADHO ach | 120% of ADHO target |
| NON ADHO | NON ADHO ach ≥ NON ADHO target | 5% × NON ADHO ach | 120% of NON ADHO target |
| Focus Brand | FB ach ≥ FB target | 2.5% × FB ach | 120% of FB target |
| Lines | Lines ach ≥ Lines target | ₹100 flat | — |
| Visibility | ✅Q1: TOTAL achieved ≥ ₹4,000 + NON ADHO ≥ ₹400 + visibility **approved this month** (1 window). **No 100% target needed.** | ₹500 Metro / ₹250 Non-Metro (metro value outside `Metro`/`Non Metro` ⇒ skipped + flagged, never paid ₹250 by default) | — |

## 2. Unnati Lite (sub-programme **Lite**, target value ₹2,000–4,000)

Outlet-level gate: **NON ADHO achieved ≥ ₹200**.

Same as Unnati for ADHO 2.5% · NON ADHO 5% · Focus Brand 2.5% · Lines ₹100 · 120% cap per parameter.
**No visibility payout** (slide: "NA — removed from earlier construct").

## 3. SAMT (Focus Brand removed from SAMT)

| | SAMT Elite (value ₹2k–4k) | SAMT Privilege (value ₹4k+) |
|---|---|---|
| Outlet-level gates (all payouts incl. Lines) | NON ADHO ach ≥ ₹200 · visibility approved this month ✅Q2 | NON ADHO ach ≥ ₹400 · visibility approved this month ✅Q2 |
| Total (target-linked) | TOTAL ach ≥ TOTAL target → **5% × TOTAL ach** ✅, cap 120% of TOTAL target | same → **7% × TOTAL ach** ✅, cap 120% |
| Lines | ₹100 if Lines ach ≥ target | ₹150 if Lines ach ≥ target |
| Visibility window requirement | 1 shelf talker | 2 shelf talkers |

📝 "Margin — as per brand retailer margin" and "Scheme — as per scheme sheet" are Bajaj's own trade terms, **not**
computed by us. ✅Q3: rate comes from the outlet's sub-programme (Elite → 5%, Privilege → 7%), never re-derived from the target value.

## 4. Urban BSC (wholesalers, POINTS)

| Item | Rule |
|---|---|
| Eligibility | ✅Q4: **no engine check.** Bajaj sets every BSC target ≥ ₹10,000 when creating targets (their prerogative). Our reconciliation report lists any BSC target < ₹10,000 for information only. |
| Gate | TOTAL ach ≥ 100% of TOTAL target |
| Base | **35 pts / case**, any SKU (ADHO + NON ADHO) |
| Focus Brand 1 (ADHO) | **+25 pts / case** — ✅Q5 needs TOTAL ≥ 100% AND FB1 ach ≥ FB1 target |
| Focus Brand 2 (Non ADHO / ADHO SKU) | **+25 pts / case** — ✅Q5 needs TOTAL ≥ 100% AND FB2 ach ≥ FB2 target |
| Cap | ✅Q6: when ₹ achievement > 120% of ₹ target, scale points down: `pts × (1.2 × target ÷ achieved)` — base on TOTAL, each FB on its own target (same method as Bajaj's old "Capped @125% Achv" column) |
| Consistency bonus | 5 pts / case on quarter's total cases if ≥ 100% of quarter target — **NOT BUILT. ⚠️ OWNER 2026-11-25: MUST also be closed (delivered) for BSC — open item, not optional.** ✅ Approach: **quarterly run in the engine** (being built). ✅ Definition: FY quarters; pays **5 pts × the quarter's total BSC cases** only if **TOTAL ₹ achieved ≥ TOTAL ₹ target in EACH of the 3 months** (target present and > 0 every month); wholesalers only; cases ≤ 0 → 0 with reason; half-up whole points. ✅ Cap: **120% at MONTHLY level** — bonus = 5 × Σ months (cases_m × min(1, 1.2 × target_m ÷ achieved_m)). |
| Telangana | no target ⇒ no points (G6) |

Data: cases come from the sales file column **QTY (CASES)** (already imported). Needs case-based measures in
Sales Import settings: BSC cases (any SKU), FB1 cases, FB2 cases.

## 5. Engine mapping (build notes)

- Rules attach to (programme, sub-programme, KPI). Every input from a target uses `nullAs = skipRule` (G6).
- Outlet-level gates (NON ADHO minimum, visibility approved) are added as a gate node on EVERY rule of that
  sub-programme (G1).
- "Visibility approved this month" = new engine input (being built; ships next release). Until then visibility
  payouts / SAMT visibility gate cannot be finished.
- Compute only as PREVIEW on staging, on a month that is NOT an imported month. Never export / direct-credit.

## 6. Open questions (asked one at a time)

- **Q1** Unnati visibility payout: gate = TOTAL billing ≥ ₹4,000 + NON ADHO ≥ ₹400 + visibility approved —
  and NOT the 100% target? (recommend: yes, no 100% target needed for visibility)
- **Q2** SAMT: "Approved Visibility" is a gate on ALL SAMT payouts incl. Lines? (recommend: yes, per G1)
- **Q3** SAMT slab from sub-programme (Elite 5% / Privilege 7%), not recomputed from the target value? (recommend: sub-programme)
- **Q4** BSC "≥ ₹10K / month" = actual monthly billing ≥ ₹10,000? (recommend: billing achieved)
- **Q5** BSC FB1 / FB2 extra points also need their own FB target met (as ADHO did for Unnati)? (recommend: yes, per G2)
- **Q6** BSC 120% cap = points scaled down in proportion when achievement > 120% (`pts × min(1, 1.2 × target ÷ achieved)`),
  per parameter — matching Bajaj's historical "Capped @125% Achv" column? (recommend: yes)

## 7. Worked examples — filled in after Q1–Q6, checked by the independent calculator.

## 8. Sign-off (owner 2026-11-25: NO Bajaj sign-off on staging results — Gifsy/Claude signs off)

Before the rules go to production, ALL of these must hold, with evidence recorded here:
1. Engine preview vs the independent calculator: **100% of outlets match to the paisa** on a real non-imported month
   (every mismatch explained and fixed — no tolerance band).
2. Edge-case set passes in both: exactly 100%, exactly 120%, >120%, gate missed by ₹1, missing target, missing
   achievement, zero target, Lines over target, metro blank/odd spelling, visibility pending/rejected.
3. Dual independent audit of the rules vs the slides (no open findings).
4. Every skipped / flagged outlet is listed with its reason (no silent zero).
5. Prod: same script, preview first; prod preview totals re-checked against the calculator before anything is
   exported or paid.
