# P6 — Finance: credits, payouts, visibility, invoicing — Reconcile + Build Record

> **Status: 6.0 ✅ (committed `13c5d4e`) · Stream 1 (Credits #16) ✅ · Stream 2 (Visibility #17) ✅ (2026-06-18).**
> Decisions below are owner-locked. Build records: §4 (6.0 money unit), §5 (Streams 1+2). **Remaining: Invoicing
> (6.7) last; ⚠️ Payouts/TDS (6.5 + #25) ON HOLD** — owner reviews the TDS structure before any TDS work.
> Reversal "shortfall" is **owner-decided** (report-only — see §5). Remaining visible piece: FE reversal report columns.
> Read [[platform-real-model]] + [[reconcile-fit-before-build]] + [[architecture-backend-split]] + [[p5-complete]].

P6 = spec §02 Workflow 2/3 (Credits & Payouts) + the money spine. **This is mostly
reconcile + wire-up, not build-from-zero** — most P6 models + read-side routes already
exist (ported in Phase S). The audit (2026-06-18) found four finance contexts already
coded; P6 closes the gaps between them.

---

## §1 · The model (audit-confirmed; owner-locked)

### Two distinct money rails — NOT consolidated (#5)
The word "payout" is overloaded across **two legitimate, separate** flows. Keep them
distinct; rename for clarity (Awards & Credits vs Redemption Payouts). **Not a merge.**

| Rail | Direction | Models | Built today | Gap |
|---|---|---|---|---|
| **Awards & Credits** | admin **pushes** awards to outlets | `CreditBatch/Field/PayoutEntry/PayoutDownload/Reversal` (`credits/`) | batch→confirm→bank-download (SEPARATE/STANDARD grouping)→UTR upload+dup→reversal maker-checker — full CRUD | ⚠️ **#16** POINTS rows inert (no wallet write); reversal doesn't debit wallet |
| **Redemption Payouts** | partner **pulls** cash out | `PayoutBatch/Transaction/FundLedger/FundReceipt/TdsRecord` (`payouts/`) | batch→process (validate→TDS→fund-check→flag)→reconciliation xlsx; fund receipts/ledger | **#25** TDS section not differentiated; **no code creates a `PayoutTransaction` from a P5 INR `RedemptionOrder`** (the P5→P6 settlement bridge is unbuilt) |
| **Visibility** | outlet renders display service | `VisibilitySubmission/Approval/FraudLog/ImageHash`, `OutletVisibilityRecord/UploadBatch` (`visibility/` + `admin-programs/visibility*`) | approve/reject/fraud-log/outlet-statuses | **#17** no per-tenant capture-mode flag; `POST /submit` (photo upload) not ported (GCS infra) |
| **Self-bill invoicing** | Gifsy invoices on the outlet's behalf | `AutoInvoice` | — (logic is pure functions in platform `lib/invoice.ts`) | **Greenfield in backend** — no `api/src/invoices` module; `AutoInvoice` too thin for #8 |

### LOCKED DECISION — money unit (#19): **integer paise, everywhere**
**Standardise the entire system on integer paise (and whole-integer points).** Drop the
Awards rail's `Decimal(15,2)` rupees; everything money becomes `Int` paise, matching
Payouts/Fund/TDS/Invoice/Wallet (which are already paise).

- **Why paise, not whole rupees:** whole-rupees breaks on **tax** — 1% TDS of ₹2,550 =
  ₹25.50, 18% GST of ₹1,055 = ₹189.90. In paise these are **exact integers** (2,550 paise;
  18,990 paise) — no rounding fudge, no float. This is the industry-standard "integer
  minor units" model.
- **Why now:** the finance tables are **empty in `gifsy_dev`** → the unit conversion is a
  ~1-hour schema migration (`×100` on conversion, nothing to backfill). Doing the same
  change later, with live award/payout money in the tables, would be a risky data
  migration. **This is the cheapest this change will ever be.**
- **Also fixes a real bug:** the Awards service currently sums money via JS `Number()`
  (`cur.amount += Number(e.amountInr)`, [credits.service.ts](../../../../api/src/credits/credits.service.ts)) —
  IEEE-754 float math on money. Integer-paise arithmetic removes it.
- **Scope** (4 Credit models, ~7 columns): `CreditBatch.totalPayoutInr/totalPoints`,
  `CreditPayoutEntry.amountInr`, `CreditPayoutDownload.totalAmountInr`,
  `CreditReversal.originalAmount/requestedAmount/approvedAmount` → `Int`. Money columns =
  paise; `totalPoints` = whole points. Backend ~4 files / ~53 touchpoints + the
  `credits-payouts-*` Excel lib (~6 files) + tests + screens. ⚠️ Every `×100`/`÷100`
  (upload ingest / display / Excel) must be audited — a missed conversion is a 100× error.

### LOCKED DECISION — wallet grain (#16): **aggregate to the partner wallet**
`Wallet.partnerId @unique` — the wallet belongs to the **ChannelPartner**, not the outlet.
Awards are per-outlet×field; on confirm, POINTS rows for all outlets under a partner
credit **that partner's single wallet** (resolve `outletCode → partnerId`, call
`walletService.creditEarn(partnerId, …)`). The outlet is the unit of measurement; the
partner is the points-holder (matches the P5 model). Per-outlet balances were considered
and rejected (would re-grain Wallet/Ledger — significant P5 rework, no business need).

### LOCKED DECISION — invoicing (#8): **included in P6, built LAST**
The self-bill invoicing module is the only fully-greenfield-in-backend piece, **but** the
hard logic already exists as clean pure functions in `lib/invoice.ts`
(`computeGST` CGST/SGST/IGST-from-reg-type, `computeTDS`, `generateInvoiceNumber`). So 6.7
is a **port + persist**, not a build-from-scratch. It is the literal P6 exit criterion
("Visibility on its own UTR + invoice") and it **depends on visibility settle (6.6)** —
so it runs **last**. Needs an `AutoInvoice` schema delta (status, finalize-lock,
`invoiceNumberEdited`, KYC/bank snapshot) to satisfy #8 (partner-editable number +
uniqueness/lock-after-finalize).

### ⚠️ ON HOLD — TDS (#25): owner reviews structure first
**No TDS code until the owner has reviewed the TDS design.** The audit found TDS logic
already exists on both sides but **not** differentiated by section:
- **Redemption-payout side:** `payouts.processBatch` applies a flat **194R 10%** over a
  ₹20,000 threshold → `TdsRecord`.
- **Invoice / visibility-service side:** `lib/invoice.ts` `computeTDS` applies **194C/194J**
  rates (1% individual/HUF, 2% others, 20% no-PAN) — this is already the
  "differentiate from 194R" logic #25 asks for, just living in the invoice lib.

The reconcile is to **encode the section by relationship type** (incentive 194R vs service
194C/194J) and align with §00 direct-vs-indirect. **This is held pending an owner design
review** — a plain-English TDS explainer (the two sections, thresholds, who bears the
deduction, where each is computed) will be written and confirmed before build.

---

## §2 · Build streams & sequencing

**6.0 must land first** (it changes the money unit everything else builds on). Then two
streams that touch **disjoint files** run in parallel; invoicing is last; Payouts is held.

| Wave | Task | Files / area | Schema delta | Status |
|---|---|---|---|---|
| **6.0 — Reconcile + money unit** (FIRST) | **convert Awards → integer paise** (#19) + kill JS float-sum + lock #5 naming | `credits/*`, `credits-payouts-*` lib, schema | **DONE** — see §4 | **✅ DONE** |
| **Stream 1 — Credits** (∥) | **6.2 #16 POINTS→wallet on confirm + reversal clawback** (HIGH) · 6.1 · 6.3 verify #7 | `credits/*`, `wallet/` | none | **✅ DONE — §5** |
| **Stream 2 — Visibility** (∥, disjoint files) | 6.6 per-tenant **capture-mode flag** (#17) | `visibility/*`, `tenant/*` (`Client.features` JSON) | none (JSON config) | **✅ DONE — §5** |
| **Wave D — Invoicing** (LAST, after 6.6) | 6.7 self-bill invoicing port (#8 number-lock + #15 GST-from-reg-type) | new `api/src/invoices`, `AutoInvoice` | **YES** — `AutoInvoice` +status/+lock/+edited/+snapshot | planned |
| **HELD — Payouts / TDS** | 6.5 redemption→`PayoutTransaction` settlement bridge + **#25 TDS sections** | `payouts/*`, `TdsRecord` | maybe (`TdsRecord.section`/`formType`) | ⚠️ **ON HOLD — owner TDS review first** |

**#7 (separate-UTR / never-clubbed):** likely **already satisfied** — `createPayoutDownload`
excludes `isSeparatePayout` fields from STANDARD and pays them on their own download.
Treat 6.3 as **verify + lock with a test**, not a build, unless the test finds a hole.

**Operating model:** plan (Opus) → execute (bg Sonnet, no shell) → ONE independent
adversarial audit (Sonnet, Read/Grep) → Opus gates → commit. **Audit the money path
hard** (P5's audits caught real double-spend/oversell). Opus owns `schema.prisma` +
migrations; show migration SQL (independently audited) + WAIT for owner go before applying;
confirm `current_database='gifsy_dev'`; `ALTER TYPE ADD VALUE` outside a txn.

---

## §3 · Dependencies & gaps touched

- **Depends on:** P5 (wallet primitives `creditEarn`/`reverse`/`debitRedeem`), P3 (GST
  reg-type `entityType`/`gstRegistrationType` on `ChannelPartner`), P2 (outlets/partners + bank fields).
- **Gaps:** **#16** (HIGH) → 6.2 · **#19** → 6.0 · #5/#7/#8/#15/#17 → as above · **#25 HELD**.
  Also folds the residual **`auth/logout` server-side revocation** (#32) + platform
  retirement (the now-dead `lib/credits-payouts-*`/`lib/invoice.ts`/`lib/gifts.ts`/
  `lib/targets.ts` + still-live platform Prisma) — retired as **one unit** at ~P6 close.

---

## §4 · Build record — 6.0 money-unit standardisation ✅ (2026-06-18)

**Decision evolved during the owner review + an independent audit:** whole-rupees was rejected
(tax produces sub-rupee amounts); **integer paise** chosen; the audit then upgraded `Int`→**`BigInt`**
(int4 max = ₹21.47M would overflow on large batch totals/fund balances). Result: **all money is
`BigInt` paise, system-wide.** Points stay `Int` (whole).

**Migration** (`api/prisma/migrations-manual/P6_credits_paise_standardisation.sql`, applied to `gifsy_dev`,
guarded + idempotent; all 10 finance tables verified empty first → zero data risk):
- Awards rail: 6 `Decimal`-INR money cols → `BIGINT` paise (×100) + renamed `*Inr`/`*Amount`→`*Paise`;
  `CreditBatch.totalPoints` `Decimal`→`INTEGER` (whole points, no ×100).
- Existing rail widened `Int`→`BigInt` (overflow fix, while empty): `PayoutBatch`, `PayoutTransaction`
  (amount/net/tds), `FundLedger` (amount/balance), `FundReceipt`, `TdsRecord`, `AutoInvoice` (subtotal/gst/total).

**Code:** new shared `money.ts` (`rupeesToPaise`/`paiseToRupees`/`toPaiseBigInt`/`formatINR`) in **both**
`api/src/common/` and `platform/src/lib/`; global `BigInt.prototype.toJSON`→Number in `api/src/main.ts`
(safe: paise « `MAX_SAFE_INTEGER`); credits/payouts services + DTOs on paise; killed the JS-`Number()`
float-sum; bigint→`Number()` fixes in the consumer reads (`reports`/`partner`/`admin-core`).
**Conversion happens exactly once** — rupees→paise at the FE upload-parser ingest edge; `÷100` only for
human display/email. The dead/shadowed platform `app/api/admin/credits/*` routes + the server-only
`credits-payouts-notify` lib were **left on the old `*Inr`/Decimal contract** (they read the unmigrated
platform schema; retire with the platform backend — NOT touched here).

**Gate (all green):** backend `tsc` 0 · jest **596 passed** · platform `tsc` 0 · vitest **no new reds**
(22 failing files = the exact baseline set) · credit/payout vitest **133 passed** · doc-consistency green.
**#19 RESOLVED.** Committed `13c5d4e`.

---

## §5 · Build record — Stream 1 (Credits #16) + Stream 2 (Visibility #17) ✅ (2026-06-18)

Built in parallel (disjoint files); each independently audited; backend gate green (**tsc 0 · jest 618**).

**Stream 1 — Credits (#16 HIGH, #7, #6.1):**
- **`confirmBatch` now credits POINTS** rows → the **partner** wallet (`walletService.creditEarn`, inside the
  confirm tx): resolve `outletCode→partnerId`, outlets roll up to the partner; **race-safe guarded
  `updateMany` claim** on PENDING_CONFIRM→CONFIRMED prevents concurrent double-credit; outlets with no wallet
  are **skipped + reported** (`skippedNoWallet`), never abort the batch; 0/negative POINTS rows filtered out
  pre-tx. PAYOUT rows still → `CreditPayoutEntry` (no row double-counted).
- **Reversal clawback:** approving a POINTS reversal → new `walletService.clawbackAward` — a `DEBIT_ADJUSTMENT`
  reducing **only `redeemablePoints`** (floored at 0). ⚠️ **`earnedPoints` + all `lifetime*` stay MONOTONIC**
  (the locked invariant — the audit caught an earlier version wrongly decrementing `earnedPoints`; fixed).
  Guarded `updateMany` claim prevents double-debit.
- #7 verified (separate-UTR exclusion) + locked with tests.
- **Shortfall — OWNER-DECIDED (report only; 2026-06-18):** when a POINTS reversal is approved for more than the
  partner still holds (already redeemed some), the gap can't be reclaimed. The platform does **nothing** with it
  beyond **reporting** — persisted on `CreditReversal.shortfallPaise` (additive migration
  `P6_reversal_shortfall.sql`, applied; table was empty). The reversal report reads three figures per reversal:
  **supposed = `approvedPaise` · reversed = `approvedPaise − shortfallPaise` · pending = `shortfallPaise`**. The
  client settles `pending` **off-platform** — no write-off / recovery / carry-forward logic on the platform.
  (Remaining: the FE reversal screen surfacing the three columns = a small visible-report follow-up.)

**Stream 2 — Visibility (#17):** per-tenant `features.visibilityCaptureMode` (`PHOTO_APPROVAL` default |
`AMOUNT_UPLOAD`) in `Client.features` JSON (no migration); `TenantService.resolveVisibilityCaptureMode`; mutating
entry points gated (photo approve/reject vs amount bulk-upload); read-only paths ungated. **Gifsy-admin toggle
DONE** (2026-06-18): `PUT /v1/admin/settings/visibility-capture-mode` (GIFSY_ADMIN + `tenancy:manage_flags`,
merges `features` without clobbering other keys, audit-logged) + a segmented control on the admin settings page
(GIFSY_ADMIN-gated, optimistic with revert). Residual: the photo `submit` endpoint stays unported (GCS multipart infra).

**TDS (6.5 / #25) — still ON HOLD.** Plain-English structure explainer written for owner review:
[`../P6-TDS-EXPLAINER.md`](../P6-TDS-EXPLAINER.md) (the two sections 194R vs 194C/194J, thresholds, who bears the
deduction, the 4 owner questions). No TDS code until the owner confirms.

**Audit (money-path, independent):** no double-credit/double-debit escape; guarded claims + tx boundaries correct;
DI correct. Must-fixes applied (earnedPoints invariant; 0-amount row skip; shortfall surfaced). Lower-sev pre-existing
notes logged (visibility approve/reject TOCTOU; admin-programs upload-loop not in a tx) — not regressions, future polish.
