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

## 8. What was built (2026-11-23/24, branch `feat/fund-reconciliation` — LOCAL, not pushed)

Status: built; three independent audits (money rules, money security, UI/UX) done and their fix round + the owner
decisions D1–D6 implemented. **Still to do: full gates, staging runtime check (real login per role), re-audit, owner.**

**Data** (migration `20261123150000_fund_reconciliation`, additive + idempotent, `lock_timeout 5s`, not run anywhere
yet): `fund_receipts` gains `entryType` (RECEIPT / ADJUSTMENT / OPENING_BALANCE) + `reason`, a per-client unique receipt
number and a partial unique index (ONE opening balance per client). New `fund_settings` (threshold, recipients, last
alert date / error / recipient count) and `fund_rates` (effective-dated, never edited: AGENCY_FEE PERCENT bps / FLAT
paise per payout line; VOUCHER_DISCOUNT bps per voucher ITEM = `rewardId`; back-dated rows record `repricedLines`,
`repriceDeltaPaise`, `repricedFrom`). `fund_ledger` is deprecated and unused. The tenant wipe deletes all four.

**Engine** — `api/src/fund/fund-statement.engine.ts` (pure) + `fund-sources.loader.ts` (rules per spend type, with the
source fields, in its header). Bank-statement model: each item is one debit at its commit date; a returned item adds a
credit of the same amount at its return date; balance = opening + receipts + adjustments − committed − paid (=
available). Rates in force on the COMMIT date. Opening cut-off: spend committed before the opening date is ignored; its
return after that date is listed ("pre-opening returns"), never auto-credited. Receipts dated before the opening date
are refused (excluded + listed if any exist).
- **Paid then reversed** (audit A1): a credit entry that was PAID (it keeps `paidAt`) and later REVERSED — incl. a fully
  TDS-withheld entry both reversal engines flip PAID → REVERSED — stays PAID; only PENDING/FAILED → REVERSED is
  "returned". Recoverable cash is a receivable ("to recover"), never a credit.
- **Receivables** (A2): from `PayoutReversalAllocation` (APPLIED_RECEIVABLE); for LEGACY reversals without allocations,
  the PAID entries in `CreditReversal.consumedPayoutEntryIds` at their net amount (amount − TDS withheld); a legacy
  reversal that recorded no entries → one reversal-level receivable of its `shortfallPaise`.
- **Dates** (A6): only event timestamps (status-history rows, `deliveredAt`/`completedAt`/`paidAt`, reversal
  `approvedAt`, `cancelledAt`/`reversedAt`) — never `updatedAt`. No event → flag DATE_ESTIMATED (a return is placed on
  its commit day, where it nets to zero; a paid date is left blank).
- **194C TDS — owner decision 2026-11-24 (SUPERSEDES the D3 pro-rata allocation):** charged as WHAT GIFSY ACTUALLY
  PAYS, WITH ITS BANK RUN. One line per `TdsRecoveryEntry` (194C, Gifsy-borne), in FULL, frozen — it depends only on its
  own row and its own run, so later payouts never change an earlier line (no re-split). Dated with its bank run: the
  client's latest `CreditPayoutDownload` made ≤ 10 min before the row (the row is written in the same transaction as the
  run); its payouts = that run's 194C entries of the same PAN (`payeePan` snapshot) / no-PAN outlet. Status follows those
  payouts: all paid → paid; ALL reversed before payment → returned (the only case a return is shown); otherwise
  committed. If the run or its payouts cannot be identified (e.g. a FAILED payout re-banked in a later run, or one
  reversed by the legacy path, which clears its download link) the line is charged in full on the day recorded, flagged
  "bank run not identified" (status not tracked). When the row's base is larger than this run's payouts (no-PAN:
  cumulative base > this run's base; PAN: tenant base > the run's matched amount) the line carries the note "Includes TDS
  for earlier payouts this year — yearly limit crossed". A negative row (true-up) is a credit line dated when recorded.
  Rows recorded before the opening date are excluded.
- **Back-dated rates** (owner D1): a rate whose effective date is on/before the moment it is saved (today included)
  re-prices lines already committed. The first save returns a preview (lines re-priced, balance change, period) and a
  confirm token; only a second call with that token saves (server-enforced; a stale token → 409 + new preview). Audited
  with old/new values + delta; the statement shows an information line "Rate change on <date>: N lines re-priced from
  <date>, balance changed by ±₹X". Future-dated rates save at once ("Scheduled from <date>").

**API** — client view `/v1/fund/*`: `summary`, `statement` (filters + paging; period figures always cover all types for
the date range), `entries`, `settings` (READ-ONLY), `export` (Excel via the Downloads kind `fund-reconciliation`:
Summary · Statement · Receipts · Rates · About) — GIFSY_ADMIN / GIFSY_STAFF with `payouts:read` + CLIENT_ADMIN (own
tenant). Writes on `/v1/fund`: `receipts`, `adjustments`, `opening-balance` — Gifsy with `payouts:manage_fund`
(`canManage` checks the real permission). Gifsy console `/v1/gifsy/clients/:slug/fund` (owner D6): `GET`, `PUT alerts`,
`POST rates/fee`, `POST rates/discount` — GIFSY_ADMIN, or GIFSY_STAFF with the permission AND a tenant grant. Duplicate
UTR check is trimmed + case-insensitive; a receipt-number clash is a clear 409.

**Screens** — `/admin/fund` (Overview · Statement · Receipts & adjustments · Rates & alerts read-only, "Managed by
Gifsy in the console"); `/admin/fund/settings` (Gifsy operators working in the client — owner or staff); the Gifsy console
client page has a **Fund** section (agency fee + history, voucher-item
discounts + history, threshold + recipients, back-dated preview/confirm). Opening balance has a confirmation step
(owner D2: it can never be changed — corrections are adjustments). The payouts-page Fund card and the Finance dashboard
fund block read the same engine (the dashboard block is hidden for MIS_USER / staff without `payouts:read`).
Client-admin copy never shows raw mail errors or the supplier name. Help & Guides: "Fund reconciliation".

**Alerts** — computed and sent INSIDE the Daily Ops Digest run (its lease + time budget, one statement compute per
client), Monday to Saturday: one e-mail per client per IST day while the balance is below the threshold; skipped (and
said why) without an opening balance, for a non-ACTIVE client, or without recipients. A send failure or relay rejection
releases the day's claim so a forced re-run retries. **Environment guard (new, fail-safe):**
`FUND_ALERTS_LIVE=true` → the client's recipients (set on PRODUCTION only); else `FUND_ALERTS_TEST_RECIPIENT=<address>`
→ only that address, subject "[TEST — would go to …]" (staging); else nothing is sent ("switched off on this server",
shown in the digest). ⚠️ Production deploy must set `FUND_ALERTS_LIVE=true` or clients get no alerts.

**Owner decisions (2026-11-23):** D1 back-dated rates allowed with preview + confirm (above). D2 no opening-balance
correction path; confirmation before recording. ~~D3 194C TDS dated with its payout (pro-rata allocation)~~ — superseded
2026-11-24 by "charged in full with its bank run" (above). D4 voucher discount per
voucher ITEM (catalogue reward id; the order's `rewardId` is stable, so past orders keep their item); no rate → face
value + flag. D5 confirmed: flat fee per payout line; digital-voucher gifts not counted; imported vendor history
excluded. D6 settings live in the Gifsy console client page; `/admin/fund` shows them read-only.

**Re-audit round (2026-11-24):** the back-dated confirm is atomic (per-client advisory lock; the preview is recomputed
and the token verified inside the same transaction — a double-click or two concurrent confirms can never double-save);
rate-change lines respect the opening cut-off, keep date order and are not shown for 0 lines re-priced (and can be
filtered); the breakdown by type counts like the cards (returned items reported separately); a genuine ₹0 receivable
stays ₹0; client low-balance e-mails run as their OWN step of the daily run (independent of the internal digest's
early exits), every check's outcome is stored (`lowAlertLastStatus` / `lowAlertLastCheckedAt`) and shown in the
console, the client view and the digest; `FUND_ALERTS_TEST_RECIPIENT` must be internal (else refused loudly); the client
view says plainly when alert e-mails are switched off; every rate audit row names the previous rate; Gifsy staff (who
never see the console client pages) edit a client's fund settings at `/admin/fund/settings` while working in the client
(same API: permission + tenant grant). Env vars are listed in RESUME §6 (not in the workflows).

**Other build choices:** only `redemptionMode = GIFT_CARD` counts as a voucher; TDS lines carry their payout's status;
low-balance recipients may be any domain (Gifsy-configured, client addresses).
