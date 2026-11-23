# Fund reconciliation — design (DRAFT for owner review, 2026-11-23)

Status: **design only — nothing built.** Replaces the unused "Fund Management" screen (`/admin/payouts/fund`), which
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

## 2. Inputs

| Input | Who / where | Notes |
|---|---|---|
| **Advance received** | Gifsy records it: amount, date received, UTR / reference, bank, note. | Corrections are new entries (a reversing receipt or an adjustment), never edits — full audit trail. |
| **Opening balance** | Gifsy records it once per client at go-live ("balance as of <date>"). | For money already deposited/spent before tracking starts. |
| **Manual adjustment** | Gifsy, with a mandatory reason (e.g. "recovered ₹X for reversed payout", "Hubble credit note"). | ± amount; audited. |
| **Per-client rates** (effective-dated) | Gifsy console → client → Fund settings: voucher discount %; agency fee type (% / flat ₹) + value; low-balance alert threshold ₹; alert recipients. | Each change has an *effective from* date; spend is always charged at the rate in force on its commit date, so a rate change never rewrites history. |
| **Spend events** | Read from the existing records (no new hooks in the money paths — see §5). | Vouchers, voucher-dispersal campaigns billed to the client, cash redemptions, credit/target payouts, visibility payouts, gross-up TDS. |

## 3. What counts, how much, and when

Amounts in ₹; *face* = the value the outlet receives.

| Spend | Committed when | Paid when | Returned to the advance when | Amount charged to the advance |
|---|---|---|---|---|
| **Voucher (Hubble, partner redemption)** | Order CONFIRMED (points debited) | DELIVERED (code issued) | FAILED / refunded / cancelled / returned | face × (1 − voucher discount %) |
| **Voucher dispersal campaign** billed to the client | Row QUEUED (campaign confirmed) | Row BOUGHT | Row released (rejected / marked not bought / cancelled) | face × (1 − voucher discount %) — *see open question Q1* |
| **Cash redemption (UPI / bank)** | Order CONFIRMED (payout created) | UTR PAID | UTR FAILED (points refunded) | face + agency fee |
| **Target / credit payout (cash)** | Batch CONFIRMED (entry created) | UTR PAID | Entry FAILED-and-not-re-banked, or REVERSED before payment | gross award + agency fee |
| **Visibility payout** | as credit payout | as credit payout | as credit payout | gross award + agency fee (+ held GST released later — *Q2*) |
| **Gross-up TDS** (Gifsy pays TDS on top) | with its payout | with its payout | with its payout | the TDS amount (e.g. ₹1,000 at 10% gross-up → ₹111.11) — *Q3* |

Not counted: **points credits** (credited to wallets — the money leaves only when the outlet redeems, via the voucher /
cash rows above); **physical gifts** (off-portal); **DEDUCT-method TDS** (the outlet bears it — it is part of the gross
award, not an extra cost).

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

## 6. Open questions (need the owner before build)

| # | Question | Recommendation |
|---|---|---|
| **Q1** | Do **voucher dispersal campaigns** with "billed to client = Bajaj" come off Bajaj's advance? | Yes — they are vouchers bought for the client. |
| **Q2** | Visibility payouts to GST-registered outlets: GST is held back and **released later as a separate payment**. Does that release come off the advance? | Yes — it is money paid to the outlet for the client (charged when released). |
| **Q3** | **194R TDS on redemptions** (vouchers / cash) is deposited **by the client itself** today (it is the client's TDS). Should only TDS that **Gifsy** pays (gross-up on credit / visibility payouts, 194C) come off the advance? | Yes — only TDS Gifsy actually pays; the client's own 194R deposits stay off this ledger (shown for information). |
| **Q4** | Does the **agency fee** also apply to cash redemptions (points → bank), or only to target / visibility payouts? | Apply to all three payout types (decision 2 calls them all payouts). |
| **Q5** | Does the **voucher discount** apply to Hubble vouchers only, or also to manually-issued vouchers? | Every voucher, whoever issues it. |
| **Q6** | **Opening balance** for Bajaj: what was deposited and spent before tracking starts (date + amount)? | Gifsy enters one opening entry per client at go-live. |

## 7. Build plan (after the answers)

1. Settings: per-client fund settings + rate history (Gifsy console, audited, effective-dated).
2. Receipts / adjustments / opening balance (fix the existing receipt flow; correct paise handling; balance written inside the transaction).
3. Statement engine (pure, tested against hand-built cases per spend type and status, incl. returns and rate changes).
4. Screen (Gifsy + client admin read-only) and the Excel via Downloads.
5. Low-balance alert (banner + daily email) and the Digest line.
6. Retire the old screen and its wrong numbers; Help guide for the operator (multi-step admin workflow).
7. Dual audit (money) + UI/UX audit; staging with real Bajaj-like data; prod.

Estimated effort: **~3–4 working days** including audits and staging.
