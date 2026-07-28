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
- **D8 — DEDUCT method:** below threshold pay full; at crossing, TDS on the full aggregate becomes due and is
  **deducted from the crossing payout**; if the catch-up exceeds that payout, **deduct what fits and carry the rest
  forward** to the next payout(s) (per-PAN carry-forward ledger). Retailer bears it (claims via 26AS).
- **D9 — GROSS-UP method:** retailer is **never** reduced. At threshold, raise ONE **"TDS invoice"** in the retailer's
  name (same marketing-services narration; **GST applies** as normal — CA-blessed as additional service consideration).
  Its body amount = the TDS; that amount is **NOT paid to the retailer — it is deposited to govt as TDS against the
  retailer's PAN** (the deposit *settles* the invoice). GST on it follows the normal holdback/settlement. Retailer
  benefit = 26AS credit + GST-on-proof, **no extra cash**. **Reconciles exactly:** TDS deposited = 1% of the base the
  retailer was actually paid.
- **D10 — Tenant recovery / attribution.** The grossed-up TDS is **recovered from tenants, pro-rata** by each tenant's
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
