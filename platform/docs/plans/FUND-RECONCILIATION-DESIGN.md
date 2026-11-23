# Fund reconciliation — design (owner-approved 2026-11-23; built — §8)

Status: **built 2026-11-23 on `feat/fund-reconciliation` (not pushed; audits + runtime check pending) — see §8.** Replaces the unused "Fund Management" screen (`/admin/payouts/fund`), which
today shows ₹0, cannot record a receipt (400 on `remarks`; would also store 100× the amount), counts only cash
redemptions and never debits its own ledger. Production has 0 receipts, 0 ledger rows, 0 cash payouts (checked
2026-11-23), so nothing has to be migrated.

## 1. Owner decisions (2026-11-23)

| # | Decision |
|---|---|
| 1 | Clients **prepay** (an advance per client). Vouchers and all payouts are tracked on the portal. **Physical gifts are off-portal** (settled separately — not in this ledger). |
| 2 | Spend that comes off the advance: **vouchers** (Hubble), **cash redemptions** (UPI / bank), **target / credit payouts**, **visibility payouts**. |
| 3 | The amount is a **rate defined by Gifsy per client**: a **voucher discount %**, and an **agency fee on payouts**. |
| 4 | The agency fee is **% of the payout or a flat ₹ per payout — chosen per client**. |
| 5 | **Gross-up TDS** comes off the advance. |
| 6 | Spend counts **when committed** (voucher ordered / payout approved), shown as *committed* until paid, then *paid*. |
| 7 | Low balance → **alerts only**; Gifsy decides case by case; nothing is ever blocked. |
| 8 | **Gifsy manages; the client admin can view** (read-only). |
| 9 | **No GST** on the portal. |
| 10 | **Voucher Dispersal campaigns** (even when "billed to" a client) are **NOT** on this ledger — settled separately. |
| 11 | **GST held back on visibility payouts** and released later is **NOT** on this ledger. |
| 12 | **TDS:** only TDS **Gifsy pays — 194C** (gross-up on visibility / target payouts under 194C) comes off the advance. **194R is paid by the client — no impact** on this ledger. |
| 13 | The **agency fee applies to all three payout types**: cash redemptions, target payouts, visibility payouts. |
| 14 | The **voucher discount is set per client per voucher brand** (e.g. Amazon 3% for Bajaj, 2% for Deoleo) and applies to every voucher of that brand, Hubble or manual. A brand with no rate set is charged at face value and **flagged** on the statement. |
| 15 | Go-live = an **opening balance as of a date** per client; only spend after that date is tracked. |

## 2. Inputs

| Input | Who / where | Notes |
|---|---|---|
| **Advance received** | Gifsy records it: amount, date received, UTR / reference, bank, note. | Corrections are new entries (a reversing receipt or an adjustment), never edits — full audit trail. |
| **Opening balance** | Gifsy records it once per client at go-live ("balance as of <date>"). | For money already deposited/spent before tracking starts. |
| **Manual adjustment** | Gifsy, with a mandatory reason (e.g. "recovered ₹X for reversed payout", "Hubble credit note"). | ± amount; audited. |
| **Per-client rates** (effective-dated) | Gifsy console → client → Fund settings: voucher discount % per brand; agency fee type (% / flat ₹) + value; low-balance alert threshold ₹; alert recipients. | Each change has an *effective from* date; spend is always charged at the rate in force on its commit date, so a rate change never rewrites history. |
| **Spend events** | Read from the existing records (no new hooks in the money paths — see §5). | Vouchers, voucher-dispersal campaigns billed to the client, cash redemptions, credit/target payouts, visibility payouts, gross-up TDS. |

## 3. What counts, how much, and when

Amounts in ₹; *face* = the value the outlet receives.

| Spend | Committed when | Paid when | Returned to the advance when | Amount charged to the advance |
|---|---|---|---|---|
| **Voucher (partner redemption — Hubble or manual)** | Order CONFIRMED (points debited) | DELIVERED (code issued) | FAILED / refunded / cancelled / returned | face × (1 − discount % for that **client × brand**); no rate set → face value, flagged |
| **Cash redemption (UPI / bank)** | Order CONFIRMED (payout created) | UTR PAID | UTR FAILED (points refunded) | face + agency fee |
| **Target / credit payout (cash)** | Batch CONFIRMED (entry created) | UTR PAID | Entry FAILED-and-not-re-banked, or REVERSED before payment | gross award + agency fee |
| **Visibility payout** | as credit payout | as credit payout | as credit payout | gross award + agency fee |
| **194C gross-up TDS** (Gifsy pays the TDS on top) | with its payout | with its payout | with its payout | the TDS amount Gifsy bears (e.g. ₹1,000 at 2% gross-up → ₹20.41) |

Not counted: **points credits** (credited to wallets — the money leaves only when the outlet redeems, via the voucher /
cash rows above); **physical gifts** (off-portal); **Voucher Dispersal campaigns**; **GST held back on visibility
payouts and released later**; **194R TDS** (paid by the client itself); **DEDUCT-method TDS** (the outlet bears it — it
is part of the gross award, not an extra cost).

Already-paid payouts that are later **reversed** become a *receivable* (recovered off-platform). The ledger shows them
as "to recover"; when Gifsy recovers the money it records a manual adjustment, which credits the advance.

## 4. Outputs

### Screen (Gifsy console + read-only for the client admin)
- **Cards:** Advance received · Committed (not yet paid) · Paid out · Returned · **Balance** (received − committed − paid + returned ± adjustments) · **Available** (= balance; committed is already deducted).
- **Low-balance banner** when Balance < the client's threshold (and an email to the configured recipients once per day while low). Never blocks spend (decision 7).
- **Breakdown by spend type** (vouchers, dispersal, cash redemptions, target payouts, visibility payouts, TDS, agency fees, discounts) for any date range.
- **Statement:** every entry with date, type, reference (order / batch / UTR), face amount, discount, fee, TDS, amount charged, status (committed / paid / returned), running balance. Filters: date range, type, status. Clicking a row opens its source record.
- **Record advance received** (Gifsy only) with the fields in §2; **Adjustment** (Gifsy only, reason required).

### Excel "Fund reconciliation" (both roles)
1. *Summary* — opening balance, receipts, committed, paid, returned, adjustments, closing balance for the chosen period; totals by spend type.
2. *Statement* — the full line list (as the screen).
3. *Receipts* — every advance received with UTR.
4. *Rates* — the discount % / agency fee in force per period.
5. *About* — plain-English definitions of every figure.

### Daily Ops Digest
One line per client: balance, committed, and "LOW" when under threshold.

## 5. How it is calculated (approach)

**Recommended: compute the statement from the existing records + store only what Gifsy enters.**
- Stored (new): receipts, adjustments, opening balance, rate history (with effective-from dates) and alert settings. The existing `fund_receipts` / `fund_ledger` tables are reused/extended (they are empty on prod).
- Computed on read: every spend line is derived from its source record (redemption orders + status history, voucher-dispersal rows, payout transactions, credit payout entries, TDS recovery entries), charged at the rate in force on its commit date.
- Why: **no new code inside the money paths** (redeem / confirm / UTR / reversal) — nothing that can break a payout or double-count, and the ledger is always consistent with the source records. Volumes (tens of thousands of rows per client) are fine to compute per view; the Excel uses the existing Downloads background job.
- Alternative (not recommended): write a ledger row at every spend event — needs hooks in ~10 money paths, back-filling, and a reconciliation job to catch drift.

## 6. Open questions — ALL RESOLVED 2026-11-23 (decisions 10–15 above)

Q1 dispersal → not on the ledger · Q2 GST release → not on the ledger · Q3 TDS → only Gifsy-paid 194C; 194R no impact ·
Q4 agency fee → all three payout types · Q5 voucher discount → per client per brand · Q6 → opening balance as of a date.

**Data to collect from the owner before go-live (not blocking the build):** per client — opening balance + its date;
agency fee type and value; the voucher brand discount table; low-balance threshold + alert recipients.

## 7. Build plan (after the answers)

1. Settings: per-client fund settings + rate history (Gifsy console, audited, effective-dated).
2. Receipts / adjustments / opening balance (fix the existing receipt flow; correct paise handling; balance written inside the transaction).
3. Statement engine (pure, tested against hand-built cases per spend type and status, incl. returns and rate changes).
4. Screen (Gifsy + client admin read-only) and the Excel via Downloads.
5. Low-balance alert (banner + daily email) and the Digest line.
6. Retire the old screen and its wrong numbers; Help guide for the operator (multi-step admin workflow).
7. Dual audit (money) + UI/UX audit; staging with real Bajaj-like data; prod.

Estimated effort: **~3–4 working days** including audits and staging.

## 8. What was built (2026-11-23, branch `feat/fund-reconciliation` — LOCAL, not pushed)

Status: steps 1–6 built; **step 7 (dual money audit + UI/UX audit, runtime check on staging) NOT done.**

**Data** (migration `20261123150000_fund_reconciliation`, additive + idempotent, `lock_timeout 5s`): `fund_receipts`
gains `entryType` (RECEIPT / ADJUSTMENT / OPENING_BALANCE, default RECEIPT) + `reason`, a per-client unique receipt
number and a partial unique index (ONE opening balance per client). New `fund_settings` (threshold, recipients, last
alert date/error) and `fund_rates` (effective-dated, never edited: AGENCY_FEE PERCENT bps / FLAT paise per payout line;
VOUCHER_DISCOUNT bps per brand key). `fund_ledger` is deprecated and unused.

**Engine** — `api/src/fund/fund-statement.engine.ts` (pure) + `fund-sources.loader.ts` (rules per spend type, with the
source fields, in its header). Bank-statement model: each item is one debit at its commit date; a returned item adds a
credit of the same amount at its return date; balance = opening + receipts + adjustments − committed − paid (=
available). Rates are those in force on the COMMIT date. Opening cut-off: spend committed before the opening date is
ignored; its return after that date is listed ("pre-opening returns"), never auto-credited. Receipts dated before the
opening date are refused (and excluded + listed if any exist).

**API** `/v1/fund/*`: `summary`, `statement` (filters + paging; running balance over the full history), `entries`,
`settings`, `export` (Excel via the Downloads kind `fund-reconciliation`: Summary · Statement · Receipts · Rates ·
About) — GIFSY_ADMIN + CLIENT_ADMIN (own tenant), `payouts:read`. Writes (`receipts`, `adjustments`,
`opening-balance`, `settings/alerts`, `rates/fee`, `rates/discount`) — Gifsy only (`payouts:manage_fund` + a service
check), audited, serialised per client by an advisory lock. An un-assumed Gifsy owner gets 400 "open a client first".

**Screen** `/admin/fund` (Overview · Statement · Receipts & adjustments · Rates & alerts; write controls for Gifsy
only). The payouts-page Fund card and the Finance dashboard fund block read the same engine. The settings-page "Low
balance alert threshold" (never read by anything) was replaced by a pointer. Help & Guides: "Fund reconciliation".

**Alerts**: the daily scheduled-reports run (Mon–Sat) first sends each low client ONE e-mail per IST day to its
recipients (claimed by compare-and-set; failure stored + shown), then the Daily Ops Digest shows one Fund line per
client with a fund set-up (balance · committed · LOW) plus the e-mail outcome; LOW, a failed e-mail and lines charged
without a rate are "needs attention". Nothing is ever blocked.

**Decisions taken in the build that the owner should confirm:**
1. **Voucher brand** — the catalogue has no brand column. Brand key = `metadata.brand/brandName` → else the Hubble
   product id (all amounts of one Hubble brand share it) → else the catalogue item itself. Manual vouchers without a
   brand therefore get a rate per item. Ideal alternative: a "brand" field on the catalogue item.
2. **Flat fee** is charged per payout LINE (one credit entry / one cash redemption), not per combined bank transfer.
3. **TDS 194C lines** (TdsRecoveryEntry 194C, incl. no-PAN 194C paid in full) are charged when the bank file is made
   and shown as "paid" (there is no separate paid step); a negative true-up is a credit.
4. **Imported vendor history** (`CreditBatch.sourceKind = VENDOR_IMPORT`) is not spend from the advance.
5. Only `redemptionMode = GIFT_CARD` counts as a voucher; a PHYSICAL_GIFT fulfilled as a DIGITAL_VOUCHER stays off.
6. The low-balance e-mail goes to the recipients Gifsy configured (any domain — client addresses), Mon–Sat with the
   digest trigger.
