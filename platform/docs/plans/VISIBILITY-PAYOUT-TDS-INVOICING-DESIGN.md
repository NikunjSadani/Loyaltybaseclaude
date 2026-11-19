# Visibility-Led Payouts — 194C Auto-Invoicing + Configurable TDS — DESIGN (for sign-off)

**Status:** SPEC — awaiting owner sign-off. NO code yet. Author reconciled against current code via a 3-stream
audit (TDS engine, invoicing engine, payout origination). Money path → dual adversarial audit is mandatory before done.

## 1. Scope
Pay a retailer for **visibility / marketing-and-support services** and, when covered under **194C**, auto-generate a
self-billed GST invoice, deduct/deposit TDS across the platform, and recover grossed-up TDS from tenants. **194R is a
separate workstream (later)** — but the per-tenant *section* config + routing is built now so a 194R tenant simply
routes to the existing 194R engine. Operator/deductor = **Tech Gifsy Solutions Limited** (GSTIN `19AAACT9811F1Z9`,
PAN `AAACT9811F`, West Bengal / code 19, SAC 998361).

## 2. What ALREADY exists (audit, `develop`) — reuse, don't rebuild
- **194C TDS engine** (`api/src/tds/*`): platform-wide, **PAN-keyed, aggregated across ALL tenants**; thresholds
  **>₹30k single OR >₹1L/FY** (`tds.service.ts:116-117,419-421`); rates **1% indiv/HUF · 2% others · 20% no-PAN**
  (`tds.helpers.ts:389-393`); retroactive threshold jump (two-column with/without). **Gap: gross-up only; section
  hardcoded by rail (`isSeparatePayout`), no per-tenant config, no DEDUCT method.**
- **Invoicing** (`api/src/invoices/*`, model `AutoInvoice`): self-billed, GST **CGST/SGST vs IGST from retailer GSTIN
  first-2 vs `19`** (`invoice.helpers.ts:103-144`), GST-exclusive, Tech-Gifsy recipient baked in, snapshot, idempotent
  (`@@unique[clientId,outletCode,period]`), **invoice number editable by partner while GENERATED, locked at PAID**,
  partner FE view/edit, client-side PDF. **Gap: admin-per-period trigger (not at confirm); lock at PAID (not UTR);
  legend/narration wording; no GST-holdback.**
- **Payout origination** (`api/src/credits/*`): visibility payout = a `CreditField` flagged `isSeparatePayout=true`
  → credit batch confirm → `CreditPayoutEntry.amountPaise`. The **new POSM `api/src/visibility/*` module is
  reward-FREE** — it never pays; visibility *payouts* stay on the credits rail. **Decoupled from POSM by decision.**

## 3. Locked decisions (owner-confirmed)
- **D1 — Section per tenant, VISIBILITY-STREAM ONLY.** Config sets the section for that tenant's *visibility* payouts
  (194R|194C); incentive/other payouts keep their own 194R treatment. The visibility stream is an **explicit
  designation** on the credit field (`payoutStream = VISIBILITY | INCENTIVE`), replacing the overloaded
  `isSeparatePayout` as the classifier.
- **D2 — Methodology per tenant** = `DEDUCT | GROSS_UP`. Commercially the tenant's choice; the **toggle lives in the
  Gifsy admin portal** (Gifsy configures it — it governs TGSL's deduct/deposit/recovery).
- **D3 — Both section × both methodology configurable** (matrix), **Gifsy-set** per tenant. 194C built now; 194R later.
- **D4 — Invoice base = the payout amount, GST-EXCLUSIVE.** Retailer receives the base; GST added on top (18%).
- **D5 — GST HOLDBACK.** Retailer is paid the **base now**; the **GST is held back** and released **only on the
  retailer's proof of GST deposit** (ticket + proof), via a **Gifsy-admin-only GST-reimbursement screen** storing the
  release payout details. Applies to GST-registered retailers only.
- **D6 — Unregistered retailers:** no GST on invoice (it is effectively the RCM self-invoice). TGSL owes RCM
  off-portal → a **report of unregistered-retailer payouts with invoice numbers** (RCM computed outside the portal).
- **D7 — TDS is threshold-gated, retroactive, combined across all 194C tenants by PAN** (TGSL = single deductor).
  **D7 applies to 194C ONLY. 194R is PER CLIENT (owner, 2026-11-18):** a retailer PAN's 194R visibility payouts under
  tenant A and tenant B are never aggregated — threshold (₹20k/FY), prior base and DEDUCT carry-forward ledger are all
  evaluated per (client, PAN, FY). This matches the 194R report's client scope (`api/src/tds/tds.service.ts`) — its
  inputs and method are now ONE shared definition too (§9 — `api/src/tds/tds-194r.shared.ts`).
  **TDS INVOICING IS 194C-ONLY (owner, 2026-11-18):** Gifsy deposits 194C TDS and recovers it from the client, so only
  194C GROSS_UP raises a TDS invoice + `TdsRecoveryEntry` rows. A **194R** GROSS_UP payout raises **no** TDS invoice and
  **no** recovery row (no-PAN 194R included) — the retailer is paid in full and the client's liability is shown by the
  194R report. 194R DEDUCT withholding (the carry-forward ledger) is unchanged. TDS invoice NUMBERS stay globally
  sequenced per (PAN, FY) (`TGSL-TDS-<PAN>-<FY>-<seq>`); **the next seq = the highest seq existing for that PAN/FY + 1**
  (owner D8, 2026-11-18), parsed from the numbers — never a count, so deleting a middle invoice can't cause a collision.
  Only seq 001 is the anchor (a deleted 001 is not re-anchored). Limit: the numbers are derived from existing rows, so
  if the HIGHEST invoice is deleted its number is issued again (no persisted counter; TDS invoices are born locked and
  the app has no delete path — deletion is a manual DB operation).
  **194R whole-year true-up (owner D2–D6/D9/D10 + Q1–Q6, 2026-11-18) — BUILT;** the full rules are in §9 below.
  **Legacy rows:** ledger rows written before this change carry their tenant's `clientId`, so they are re-scoped
  automatically on the next read (another tenant's 194R withholding simply stops counting). Any legacy 194R TDS invoice /
  194R recovery row is ignored by the engine (it never blocks or reduces a 194C top-up) and still lists on the recovery
  report. Prod had **0** TDS ledger rows at the change, so no data migration is needed. A same-period TDS invoice with
  **no recovery rows** (section unknown) still blocks a 194C re-raise for the PAN (as before). Pinned by specs in
  `credits.service.spec.ts` ("194R per-client scoping").
- **D8 — DEDUCT method:** below threshold pay full; at crossing, TDS on the full aggregate becomes due and is
  **deducted from the crossing payout**; if the catch-up exceeds that payout, **deduct what fits and carry the rest
  forward** to the next payout(s) (per-PAN carry-forward ledger). Retailer bears it (claims via 26AS).
- **D9 — GROSS-UP method:** retailer is **never** reduced. At threshold, raise ONE **"TDS invoice"** in the retailer's
  name (same marketing-services narration; **GST applies** as normal — CA-blessed as additional service consideration).
  Its body amount = the TDS; that amount is **NOT paid to the retailer — it is deposited to govt as TDS against the
  retailer's PAN** (the deposit *settles* the invoice). GST on it follows the normal holdback/settlement. Retailer
  benefit = 26AS credit + GST-on-proof, **no extra cash**. **Reconciles exactly:** TDS deposited = 1% of the base the
  retailer was actually paid.
- **D10 — Tenant recovery / attribution** (194C only; 194R has no TDS invoice and no recovery row, see D7). The grossed-up TDS is **recovered from tenants, pro-rata** by each tenant's
  share of the retailer's aggregate (e.g. X ₹70k + Y ₹40k → ₹1,100 TDS split ₹700 / ₹400). A **per-tenant recovery
  ledger** tracks it; reports tag it **"in lieu of TDS deduction."**
- **D11 — The "in lieu of TDS" tag appears ONLY in the dashboard/report, NEVER on the invoice face.** The invoice
  reads as a normal invoice.
- **D12 — Invoice trigger = at payout-Excel CONFIRM (before payout).** UTR + payment date entered later; **once the
  UTR/date is recorded the invoice locks** (no more edits). (Replaces the current PAID-lock.)
- **D13 — Legend:** exactly *"This is an automated invoice. No Signature is required."*
- **D14 — Narration:** exactly *"Payment for Marketing and support services for the month of &lt;Month, Year&gt;"*
  (month/year = the payout period).

## 4. Money flow — worked examples (retailer A, individual/1%, 194C, above threshold)
| | DEDUCT-then-pay | GROSS-UP |
|---|---|---|
| Invoice service value | ₹500 | ₹500 (unchanged; retailer paid full) |
| GST @18% (held back) | ₹90 | ₹90 |
| Retailer receives now | 500 − TDS | **₹500** (full) |
| TDS at threshold | 1% × aggregate, deducted (carry-forward overflow) | 1% × aggregate → **separate TDS invoice**, deposited (not paid) |
| Who bears TDS | retailer (26AS credit) | tenant (recovered pro-rata) |
| GST released | on retailer's GST-deposit proof | on retailer's GST-deposit proof |

Cross-tenant: retailer A gets ₹70k (tenant X) + ₹40k (tenant Y) → aggregate ₹1.1L crosses ₹1L → TDS ≈ ₹1,100 →
recovery X ₹700 / Y ₹400. Engine already aggregates cross-tenant by PAN.

## 5. Portal placement
- **Gifsy admin (tenant-agnostic):** 194C TDS engine + liability/deposits/26Q export; per-tenant **section +
  methodology config**; **tenant recovery/attribution ledger** ("in lieu of TDS"); **GST-reimbursement screen**;
  **unregistered/RCM report**; invoice generation trigger + master register.
- **Tenant admin (scoped):** upload visibility payout Excel; read-only own invoices + payout reports (with GST reg
  type); read-only **own recovery liability** (so the bill isn't a surprise — in scope).
- **Retailer (partner):** view own invoices + edit invoice number (built).

## 6. Reports
Payout report incl. **GST registration type**; **unregistered-retailer/RCM report** (invoice numbers); **TDS
liability + tenant-wise recovery/attribution report** ("in lieu of TDS deduction"); existing 194C/26Q export.

## 7. Deferred / out of scope (now)
194R engine wiring (separate workstream — config + routing built now); POSM-photo → payout gating (decoupled by
decision — natural future link); invoice PDF server-side (client-side PDF already exists); TRACES/FVU filing (off-platform).

## 8. Phase-wise build plan (orchestrated; parallel where safe)
**Wave 0 — Foundation & frozen contracts (SERIAL, gating):** schema — per-tenant TDS config (section+methodology),
`payoutStream` on CreditField, recovery-attribution ledger, carry-forward ledger, GST-holdback/reimbursement fields;
migration; shared money/TDS contracts (DEDUCT helper, gross-up-TDS-invoice model, config service). **~0.5 day.**

**Wave 1 — Backend (3 parallel streams):**
- A — TDS engine: section routing per config; DEDUCT + carry-forward; GROSS-UP TDS-invoice + pro-rata recovery; wire
  methodology into the existing threshold/aggregation.
- B — Invoice engine: trigger at confirm; lock at UTR; legend + narration; GST-holdback fields + two-stage settlement.
- C — GST-reimbursement + recovery + reports: Gifsy GST-release flow; tenant recovery ledger + report; unregistered/RCM
  report; payout report w/ GST reg type. **~1.5 days (parallel).**

**Wave 2 — Frontend (3 parallel streams; starts once W1 API contracts freeze, overlaps W1 tail):**
- D — Gifsy config UI (section + methodology per tenant) + explicit visibility-stream designation.
- E — Gifsy dashboards: TDS liability/recovery/attribution, GST-reimbursement screen, RCM report.
- F — Tenant read-only views (invoices, payout reports, own recovery liability); retailer invoice copy tweaks.
  **~1.5 days (parallel).**

**Wave 3 — Integrate + DUAL money-path audit + full gate + staging runtime-verify + docs. ~1 day.**

**Wave 4 — Cutover (owner-gated):** prod pre-check + migration + merge→main + owner-approved gate + verify +
post-cutover. **~0.5 day (mostly owner-gated).**

**Total ≈ 4.5–5.5 days** focused build. Biggest variables: money-path audit findings (always real → fix cycles) and
owner sign-off/UAT cadence. Wall-clock within a session is shorter (agents run in parallel); the estimate bakes in the
non-negotiable gate + dual-audit + staging-verify rigor for a money path.


## 9. How TDS is calculated (owner decisions 2026-11-18 — the reference)

### 9.1 194R — per client, per retailer, per FY
**One shared definition** (`api/src/tds/tds-194r.shared.ts`: `collect194RBases` + `liability194R`) is used by BOTH the
payout engine (`credits.service.ts` `plan194RDeductions`) and the 194R report (`tds.service.ts` `compute194R`). A parity
spec (`api/src/tds/tds-194r.spec.ts`) runs one dataset through both and asserts the same TDS.

**What counts** (never across clients):

| Benefit | Dated by (owner FY rule) | Bucket |
|---|---|---|
| Incentive payouts (always 194R) | the BANK FILE date `download.downloadedAt` — PAID or PROCESSING (the UTR/payment date never moves it); a PAID payout with no bank file by `paidAt` | cash, client-borne |
| Visibility payouts whose section was **frozen 194R at confirm** (Q6 — no re-classification) | same | cash ("vis") |
| Imported vendor incentive payouts (`VENDOR_IMPORT`, `historical-incentive-payout`), only paid on/after the client's `tdsImportedPayouts.countFrom` (D9; fail-closed on a malformed value) | `paidAt` | cash, client-borne |
| Delivered redemptions — UPI / BANK_TRANSFER | `deliveredAt` | cash, client-borne |
| Delivered redemptions — GIFT_CARD / PHYSICAL_GIFT | `deliveredAt` | non-cash |
| `TdsOffPlatformEntry` (194R) | `entryDate` | non-cash |

FAILED / REVERSED / PENDING payouts never count. **Owner FY rule (2026-11-18):** a payout and its TDS belong to the FY the
bank file was made — the engine counts the run it is building at the run date (`runAt` = that file's date), its ledger
rows carry that FY, and the report windows PAID + PROCESSING payouts by `download.downloadedAt`. A 30-Mar file paid on
2-Apr is in the March FY only (no double counting / withholding). 194C keeps its period FY — unchanged. Bajaj's imported payout history and the §10
"Outlet Points" off-platform rows are different benefits and both count (Q5).

**Who — everything is by PAN; a PAN change SPLITS the year at the change (owner rule 2026-11-18).** Each payout records
WHO it was paid to when it went into a bank file (`CreditPayoutEntry.payeePan` / `payeePartnerId`, written in the
download tx — also for fully-withheld settles), and each redemption when it was delivered (`RedemptionOrder.payeePan`,
written by `transitionOrderStatus` on DELIVERED). Base, threshold, liability, deducted so far and carry-forward are all
per that key (within the client and FY): everything paid BEFORE a PAN change stays with the OLD PAN; everything after
goes to the NEW PAN. No PAN → PAN added: the earlier payouts stay on the no-PAN owner key at 20%, the later ones go to
the PAN. Ledger rows net by their own stored `panNumber` (the PAN at withholding). A row without a snapshot (not yet in
a bank file, or pre-snapshot data the backfill could not resolve) falls back to the current owner. Off-platform rows and
194R deposits store `resolvedKey` = the retailer key AS OF their upload (A-H1: a PAN row → its normalised PAN; a no-PAN
row → its outlet's owner key at upload), so a later PAN change never moves them; a legacy row without it resolves now.
Imported vendor payouts were snapshotted at import = the owner at the backfill (history was not recorded before
2026-11-18). Without a PAN, all outlets of one ChannelPartner = one retailer (`__NO_PAN__:<partnerId>`);
an outlet with no partner counts alone (`__NO_PAN__:outlet:<clientId>:<outletCode>`). Migration
`20261118180000_tds_payee_snapshot` (additive, idempotent, `lock_timeout 5s`; backfill: (1) an entry with a positive
194R ledger row takes THAT row's key (A-M1), (2) other PROCESSING/PAID entries + DELIVERED orders the CURRENT owner,
(3) `resolvedKey` for 194R off-platform rows + deposits; prod had 0 194R TDS rows) — not applied anywhere yet. See the
runbook pre-check below.

**How much** (D5/D6/Q1/Q3): total base > ₹20,000 (FY statutory config) → TDS on the **whole year**. Rate 10% PAN /
20% no-PAN from the statutory config (never a fixed fraction). The whole year uses the client's **current** method:
- **Deduct part** = visibility base when the current method is **DEDUCT** → `base × rate%` — 10% with a PAN, **20% without**
  (owner 2026-11-18: a no-PAN retailer's 194R visibility IS withheld, netted per owner key).
- **Client-borne part** = everything else (incentives, cash redemptions, gifts, vouchers, off-platform, imported payouts,
  and all visibility on GROSS_UP) → `base × rate/(100−rate)`.
- Each part is rounded to the rupee separately; liability = the sum.
- **Report outstanding = liability − deposits uploaded in the portal** (`TdsDeposit`, client/PAN/FY by "TDS for month").
  TDS deducted from payouts is shown ("deducted so far", net of reversals) but **not** subtracted (Q3). Imported vendor
  TDS (the Bajaj partial import = 212 `TdsDeposit` rows) is a deposit, subtracted once; rows whose `uploadBatchId` is not
  a portal file hash (`DEP-`/`OP-` + sha256) are also shown "of which imported vendor TDS" (Q4, informational only).
- **Engine withholding** (only 194R visibility on a client whose current method is DEDUCT — PAN at 10%, no-PAN at 20%
  keyed per owner `__NO_PAN__:<partnerId>`, which is also the ledger `panNumber`; Q1):
  `withhold = deduct part (whole year, incl. this run) − already deducted for (client, PAN, FY)`, capped at this run's
  payout, the rest carried forward (`computeDeduction`). Ledger rows carry `clientId`, `fyLabel` = run FY; a FAILED /
  reversal offset is written in the FY of the original withholding. Incentive payouts and cash redemptions are always
  paid in full (no change to `payouts.service` / `rewards.service`). A download with no 194R entries issues none of the
  194R reads (Deoleo's 194C downloads are unchanged).
- **No TDS invoice and no `TdsRecoveryEntry` for 194R** (D7).
- **Fully withheld payout (audit A-H2):** an outlet whose whole payout is withheld as TDS in a run is NOT a bank line
  (no ₹0 line). Its entries are settled PAID inside the download tx (utr `TDS-WITHHELD-<downloadCode>`, paidAt = the
  download time, guarded on this download's PROCESSING claim); the download result + `X-Fully-Withheld-Count/-Note`
  headers name them and the payout screen shows an amber note; no "credited" message is sent (that only happens on a
  UTR apply). FAILED / re-bank never touch them (re-bank reads PENDING/FAILED; a UTR row for an all-PAID outlet is a
  notice, never a write).
- **Reversing a withheld PAID payout:** a FULLY withheld (TDS-WITHHELD) entry reached the retailer as ₹0, so a reversal
  records NO receivable — it reverses the withholding (negative ledger row in the original FY, under the 194R lock) and
  marks the entry REVERSED. A PARTLY withheld PAID entry becomes a receivable of only the NET amount actually released
  (amount − TDS withheld), 194R and 194C alike.
- **Wallet Reversal Engine (V2 tenants only, 2026-11-19 merge — WALLET-REVERSAL-ENGINE-DESIGN.md §8.3):** a PAID payout
  reversed by the engine is marked `tdsBaseReversedAt` and `collect194RBases` leaves it out of the base (engine + report
  alike); the withheld TDS it carried becomes a capped, client-scoped `TdsCredit` in the ledger row's FY; the report's
  excess subtracts OPEN credits. No marker / no credit (every LEGACY tenant, Deoleo) → everything above is unchanged.
- **KYC-held payouts** left out of a download are listed in the result (`heldNote`), the `X-Held-Count/-Note` headers
  and an amber note on the payout screen (owner rule: no silent pass-through).

**Worked examples (PAN = 10%, no PAN = 20%):**
1. Client on DEDUCT, PAN: visibility ₹15,000 + gift ₹8,000 = ₹23,000 > ₹20,000 → deduct part 10% × 15,000 = **₹1,500**
   (withheld) + client-borne 8,000 × 10/90 = **₹889** → liability **₹2,389**; outstanding = 2,389 − deposits.
2. No-PAN owner with two outlets, visibility ₹15,000 + ₹15,000 → one retailer, ₹30,000 > ₹20,000. On DEDUCT: 20% ×
   30,000 = **₹6,000 withheld**, ₹24,000 released (netted per owner key). On GROSS_UP: 30,000 × 20/80 = **₹7,500**
   client-borne. Incentives / gifts for a no-PAN owner are always client-borne at 20/80.
3. Method switch: ₹1,00,000 visibility paid on GROSS_UP, client then moves to DEDUCT, next visibility payout ₹5,000 → the
   whole year on DEDUCT: 10% × 1,05,000 = **₹10,500** due; ₹5,000 withheld now, **₹5,500** carried forward. (Had the
   client stayed on GROSS_UP: 1,05,000 × 10/90 = ₹11,667, all client-borne.)
4. Threshold from mixed benefits: incentive ₹18,000 + UPI redemption ₹1,000 + off-platform ₹500 + visibility ₹5,000 on
   DEDUCT → ₹24,500 → only 10% × 5,000 = ₹500 withheld; 19,500 × 10/90 = ₹2,167 client-borne.
5. DEDUCT → GROSS_UP switch (audit A-M5): ₹30,000 visibility on DEDUCT → ₹3,000 withheld and deposited; client moves to
   GROSS_UP and pays ₹10,000 more in full → whole year ₹40,000 × 10/90 = **₹4,444** liability − ₹3,000 deposited =
   **₹1,444** outstanding (client-borne). Handled by "liability − deposits uploaded" — no special case. The retailer's
   share on GROSS_UP is ₹0, so the ₹3,000 taken is **flagged as excess** (owner's choice; no refund).

**Audit follow-ups (2026-11-18):**
- *A-M4 — REVERSED by the owner rule (2026-11-18):* ledger rows are NOT moved to the outlet's current owner; each nets
  under its own stored PAN (a PAN change splits the year).
- *Withholding with no base / deposit this FY (B-M2):* still gets its own report row (base 0, "deducted so far") with a
  `note`, in the totals and the export ("Note" column).
- *Legacy 194R DEDUCT ledger rows booked by payout-period FY (B-M3):* none exist on prod. Such a row counts only in the FY
  its `fyLabel` names (pinned by a spec) — no migration.
- *Locks (A-M3/A-L):* ONE advisory key per (client, FY) — `R194|<client>|<FY>` — for 194R entries (replacing the per-PAN
  key; all 194R state is per client, so it is equally correct), all keys in one statement; the UTR FAILED path and
  reversal approvals take the same key before writing an offset. A Bajaj-scale 194R run takes 1 lock (+1 per-download
  key) — far under the ~6,400 lock slots (db-g1-small, max_connections 100 × max_locks_per_transaction 64). 194C keeps
  its per-PAN keys.
- *Scope (B-L8 / A-M2):* engine, report, snapshots and the backfill use ONE PAN normaliser — `normalisePan` / its SQL twin
  `PAN_NORMALISE_SQL` in `tds-194r.shared.ts` (every space / tab / CR / LF / FF / VT / NBSP / zero-width space / BOM
  removed anywhere, then upper-cased); a group parent sharing the PAN counts (its redemptions).
- *Recovery report (B-L6):* legacy 194R recovery rows are listed separately ("Earlier 194R recoveries (no longer raised)")
  and excluded from the 194C rows/totals.
- *Imported vendor deposit label (B-L7):* portal ids are `DEP-`/`OP-` + sha256 or + uuid; any other `uploadBatchId` is
  shown "of which imported".

**Report row fields (D10):** base, cash / non-cash base, deduct base / client-borne base, method, rate %, deduct part /
client-borne part, liability, deducted so far, deposited (of which imported vendor TDS), outstanding — on screen
(`/admin/tds`), API (`GET /v1/admin/tds/194r`) and the Excel export.

**Self-billed SERVICE invoices + GST holdback are 194C-only (owner 2026-11-18).** Only visibility payouts whose frozen
section is 194C (null = legacy 194C) are invoiced — at confirm (`generateForBatch`) and by the per-month Path-2
generation (`generateForPeriod`), both filtered on `tdsSection`. A 194R visibility payout gets no service invoice and
no GST holdback; invoices raised earlier are left untouched.

**Over-withholding — ONLY FLAGGED (owner 2026-11-18, explicit choice).** `excessDeductedPaise = deducted from the
retailer so far − the RETAILER'S share` = the whole-year deduct part on the client's CURRENT method, when positive. So a
DEDUCT → GROSS_UP switch after TDS was taken IS flagged (on GROSS_UP the retailer's share is ₹0 — worked example 5), as is
a year that later drops to ₹20,000 or less, or ₹4,000 taken against a ₹3,000 share (₹1,000). Adding a PAN never is (the
no-PAN and PAN rows are separate keys). (A briefly-shipped "− whole-year liability" variant, B-M1, was reverted.) The
194R report row shows `excessDeductedPaise` ("TDS taken in excess: ₹X — flagged, no automatic refund"), and a
carry-forward recorded on the ledger that is no longer due shows as `carryForwardDroppedPaise`. The summary carries the
total + count; the liability tracker, the Excel ("TDS Taken in Excess") and the admin screen show it; the Daily Ops
Digest has a "TDS (194R)" section (count, total, largest 10) and a Needs-attention line. Nothing is refunded.

**Final-audit follow-ups (2026-11-18, second round):**
- *A-M1:* the download row is written with `downloadedAt = runAt` (the instant the 194R ledger FY comes from).
- *A-M2:* the `R194|client|FY` lock is taken by every path that changes a 194R base: any download moving 194R entries to
  PROCESSING (STANDARD incentive files included), any UTR upload touching a 194R entry (its bank-file FY), and reversal
  approvals of withheld entries. Redemption delivery does NOT take it: redemptions are client-borne (never withheld),
  so a concurrent delivery can only shift WHEN a threshold crossing is seen — the next run's whole-year true-up catches it.
- *A-L4:* a reversal of a withheld 194C entry takes that entry's 194C PAN lock.
- *A-M3/B-M1:* the retailer statement shows the NET received (gross − TDS withheld); a fully withheld payout reads
  "Withheld as TDS ₹X — ₹0 paid to you" with no UTR; lifetime/last-month totals are net; the retailer gets an in-app/push
  note when a payout is fully withheld; the digest's "credit paid" excludes those and is net of TDS, with a separate
  "settled by TDS withholding" figure.
- *A-M4/B-M2:* a fully withheld payout's SERVICE invoice is locked at settle time (as at UTR PAID).
- *A-L3:* when every payout in a run is fully withheld, no bank file is produced — the API answers JSON with the reason.
- *B-H1/B-L1/B-L2:* response notice headers are bounded (count + first 20 + "+K more"; full lists in JSON); the file is
  saved before headers are read; a cut connection says the outcome is unknown (check Download History).
- *A-L1:* the engine's 194R partner scope is one exact match on the normalised PAN (`PAN_NORMALISE_SQL`) for the client (raw SQL).
- *L3:* a stored `__NO_PAN__` sentinel on a partner is treated as no PAN by the engine (same as the report).
- *A-L2:* an off-platform row that names a PAN stays under that PAN (consistent with "everything is by PAN"); only
  no-PAN rows resolve through their outlet to the owner's current key.
- *A-H2 — RESOLVED by the payee snapshot:* a past payout / withholding stays with the PAN it was paid / withheld under,
  even if the outlet later changes owner.

**Final-audit follow-ups (2026-11-18, third round):**
- *A-H1:* `TdsDeposit.resolvedKey` / `TdsOffPlatformEntry.resolvedKey` — the 194R key AS OF the upload (written by both
  uploads via `payeeKeyFor`); the report and engine prefer it.
- *A-M1:* backfill takes a ledger-booked entry's key from its positive 194R ledger row (PAN keys normalised), else the
  current owner.
- *A-M2:* one PAN normaliser (above).
- *A-L1 — imports:* any script that writes 194R payouts / redemptions / uploads (e.g. a vendor-history import) must set
  `payeePan` / `payeePartnerId` (or `resolvedKey`) with `payeeKeyFor()` — never its own PAN rule.
- *A-L2:* the DELIVERED snapshot uses `left(pan, 10) <> '__NO_PAN__'` (no LIKE escaping).
- *A-L3:* the carry-forward note reads the latest ledger group's LAST row in a deterministic `(createdAt, id)` order.
- *Digest cost:* the 194R excess section runs the full 194R report only for tenants with at least one 194R
  `TdsDeductionEntry` in the FY (an excess needs a deduction); others get an empty section. `tds` is in `SECTION_KEYS`,
  so a failed TDS section marks the run degraded.
- *Redemption snapshot is write-once:* `snapshotPayee` sets `payeePan` / `payeePartnerId` only while `payeePan IS NULL`
  (a DELIVERED → DELIVERED re-transition never re-keys an order).
- *A-L5/B-L4:* ONE fully-withheld notice per owner per download (outlets added together). 194R: "The client deposits it
  with the Income Tax Department"; "against your PAN" only when a PAN is on file (else: no PAN → higher rate, add PAN).
- *A-L6:* the dead `summary194R` was removed — `report194R().summary` is the one summary.
- *Excess definition (owner's explicit choice; B-M1 reverted):* deducted − the retailer's whole-year deduct part on the
  current method (above); guide example 4 (Deduct → Gross-up: the ₹3,000 taken is flagged) and example 5 match it.
- *B-M3:* regenerating a month (`generateForPeriod` refresh) reconciles the invoice's GST reimbursement — HELD → amount
  updated (guarded on HELD; GST gone → the row is KEPT at ₹0, still HELD, with a note — never deleted — and reused if GST
  comes back), none → created, RELEASED at a different amount → never changed, returned in `warnings[]` and shown in red
  on both generate screens.
- *B-L1:* the downloaded wallet statement carries the same TDS note as the screen row (`payoutTdsNote`, shared); a fully
  withheld payout has no UTR.
- *B-L2/B-L3:* the digest's credit-paid filter OR-wraps `utr IS NULL`; "awaiting UTR" is net of TDS withheld.
- *B-L5:* invoicing follows each payout's section stamped at confirm (payouts guide).
- *B-L6:* the Payments report (screen + export) shows "Settled by TDS withholding (no bank payment)" instead of the
  internal `TDS-WITHHELD-…` reference; the wallet "Last Month Payout" card keeps its original rule (the single latest
  PAID payout) at its NET amount, and reads "₹0 — withheld as TDS" when that payout was fully withheld.

**Known limits:**
- *A-L4:* Delivering a redemption doesn't take the `R194|client|FY` lock; a concurrent delivery can only delay when the
  ₹20k threshold is noticed — the next run's whole-year recalculation catches it.

**Runbook pre-check before applying `20261118180000_tds_payee_snapshot` (read-only; run on the target DB first, behind
the usual `current_database()` guard):** how many ledger-booked entries will be backfilled with a key DIFFERENT from the
current owner's (their outlet changed owner / PAN after the withholding). Expected 0 on prod (no 194R TDS rows); a
non-zero count is not an error — those entries keep the PAN they were withheld under — but report it before applying.
**Data check (2026-11-18, coordinator):** prod and staging both have **0** `credit_payout_entries` with
`tdsDeductedPaise > 0` or a `TDS-WITHHELD-…` utr — so no withheld / fully-withheld history exists for the backfill to
re-key.

```sql
SELECT count(*) AS entries_keyed_to_an_earlier_payee
FROM (
  SELECT DISTINCT ON (l."creditPayoutEntryId")
         l."creditPayoutEntryId",
         CASE WHEN left(btrim(l."panNumber"), 10) = '__NO_PAN__' THEN btrim(l."panNumber")
              ELSE upper(regexp_replace(l."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) END AS ledger_key,
         e."clientId", e."outletId"
  FROM "tds_deduction_entries" l
  JOIN "credit_payout_entries" e ON e."id" = l."creditPayoutEntryId"
  WHERE l."section" = 'SEC_194R' AND l."tdsDeductedThisPaise" > 0
    AND l."panNumber" IS NOT NULL AND btrim(l."panNumber") <> ''
  ORDER BY l."creditPayoutEntryId", l."createdAt" DESC, l."id" DESC
) x
JOIN "outlets" o ON o."clientId" = x."clientId" AND o."outletCode" = x."outletId"
LEFT JOIN "channel_partners" p ON p."id" = o."partnerId"
WHERE x.ledger_key IS DISTINCT FROM CASE
  WHEN p."panNumber" IS NOT NULL
   AND upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
   AND left(upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__'
    THEN upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
  WHEN o."partnerId" IS NOT NULL THEN '__NO_PAN__:' || o."partnerId"
  ELSE '__NO_PAN__:outlet:' || x."clientId" || ':' || x."outletId"
END;
```
(The character class is byte-identical to the migration's; copy it from the migration file if a viewer mangles the
invisible characters.)

### 9.2 194C — unchanged (D1/D7/D8)
Combined **across all tenants by PAN** (TGSL = single deductor): thresholds > ₹30,000 single or > ₹1,00,000 FY; rates 1%
individual/HUF, 2% others, 20% no-PAN; FY by payout **period**; methodology = the one **frozen** on each entry. DEDUCT →
withheld from the visibility payout with carry-forward (cross-tenant ledger). GROSS_UP → paid full; a monthly TDS top-up
**invoice** (`TGSL-TDS-<PAN>-<FY>-<seq>`, seq = highest existing + 1) and pro-rata `TdsRecoveryEntry` rows across the
contributing tenants (D10). No-PAN → paid full + per-(tenant, outlet) recovery (FIX-9). **Only 194C is invoiced.**
Worked example: tenant X ₹70,000 + tenant Y ₹40,000 (individual) → ₹1,10,000 > ₹1L → gross-up 1,10,000 × 1/99 = ₹1,111,
recovered pro-rata X ₹707 / Y ₹404.
