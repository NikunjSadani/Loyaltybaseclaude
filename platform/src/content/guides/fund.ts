import type { Guide } from './index';

/**
 * "Fund reconciliation" guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/fund).
 * Audience: the Gifsy ops team. Keep it plain and concise. Design: platform/docs/plans/FUND-RECONCILIATION-DESIGN.md.
 * The labels quoted here are the ones on the /admin/fund screen and the Gifsy console client page (Fund section) —
 * if the screens' wording changes, update this guide too. The flag table mirrors FLAG_TEXT in src/lib/fund.ts.
 */
export const fundGuide: Guide = {
  slug: 'fund',
  title: 'Fund Reconciliation — Step by Step',
  summary:
    "Track a client's prepaid advance: set the rates and alert in the Gifsy console, record the opening balance, advances and adjustments, read the statement and Excel, and handle low-balance alerts.",
  updated: '2026-11-24',
  markdown: `# Fund Reconciliation — Step by Step

*A plain-English guide to **Fund Reconciliation** (admin menu): the client's advance with Gifsy, and every voucher and payout charged to it.*

## What it shows

Each client **prepays** an advance. Spend comes off it:

| Spend | Charged to the advance |
|---|---|
| Vouchers (Hubble or manual) | Face value **less** the discount set for that **voucher item** |
| Cash redemptions (UPI / bank) | Face value **plus** the agency fee |
| Target / credit payouts | Gross award **plus** the agency fee |
| Visibility payouts | Gross award **plus** the agency fee |
| TDS 194C (gross-up) | What Gifsy actually pays as 194C TDS, in full, with its bank run (one line per TDS amount — never re-split later). When the yearly limit is crossed the line says it includes TDS for earlier payouts this year. A negative true-up is a credit line on the day it was recorded. |

Not on this ledger: points credits (money leaves only when points are redeemed), physical gifts, voucher dispersal campaigns, GST held back on visibility payouts, 194R TDS (the client pays it) and DEDUCT-method TDS.

**Nothing is ever blocked.** A low balance shows a red banner and sends an e-mail; vouchers and payouts carry on. Gifsy decides case by case whether to ask the client for a top-up.

Who can do what:

- **Settings** (agency fee, voucher item discounts, low-balance alert) are managed in the **Gifsy console**: **Clients** → the client → **Fund** section. Gifsy admins, and Gifsy staff with the "manage fund" permission and access to that client. Gifsy staff (who do not use the console client pages) open the same section while working in the client: **Fund Reconciliation → Rates & alerts → Change the fund settings** (\`/admin/fund/settings\`).
- **Money entries** (opening balance, advances, adjustments) are recorded on **Fund Reconciliation** while working inside the client — same people.
- Gifsy staff with "payouts: read" can open Fund Reconciliation read-only.
- The **client admin** sees everything read-only. The **Rates & alerts** tab there says "Managed by Gifsy in the console".

## Step 1 — Set up a client

**In the Gifsy console** (Clients → the client → **Fund**):

1. **Agency fee on payouts**: either **% of each payout** or a **flat ₹ per payout**, with an **effective from** date, then **Save agency fee**.
2. **Voucher discount by item**: every voucher item in the client's catalogue is listed with its code, brand text and any **Deleted** / **Inactive** badge. Click **Set %** on an item, enter the discount % and the effective-from date, then **Save discount**. An item with no discount is charged at face value and flagged.
3. **Low-balance alert**: the threshold in ₹ and the e-mail recipients (one per line or comma separated), then **Save alert settings**.

**On Fund Reconciliation** (inside the client):

4. **Opening balance** (tab **Receipts & adjustments** → **Opening balance**): the amount and the **as-of date**. It is the balance at the **start** of that date. Spend before the date is not tracked; spend on or after it is. You review it first, and the screen warns: the opening balance **can't be changed later** — check the amount and the date. A mistake is corrected with an Adjustment. Until it is recorded, the screen says "No opening balance recorded — all history is counted".

### Rate dates: future vs back-dated

Rates are never edited — a change is a new rate from a date.

- **A future date** schedules the rate. Nothing already committed changes. The console and the Rates & alerts tab show "Scheduled from [date]" under the current rate.
- **Today or an earlier date** (back-dated) re-prices the spend already committed from that date. Before anything is saved the console shows a preview — "This re-prices N lines committed from [date]; the balance changes by ±₹X. Confirm?" — and saves only when you press **Confirm and save**. If new spend arrives in between, the console says the figures changed and shows a fresh preview to confirm again.
- A back-dated rate leaves an information line **Rate change** in the statement (how many lines were re-priced and by how much the balance moved). The re-priced lines themselves carry the change.

## Step 2 — Record an advance received

When the client pays: **Receipts & adjustments** → **Record advance received**. Enter the amount in **rupees** (e.g. 150000 or 1500.50), the date received and the **UTR / reference** (required). Bank, payment mode and a note are optional.

Mistakes are corrected with a new entry (an Adjustment), never by editing — every entry keeps who recorded it and when.

## Step 3 — Adjustments

**Receipts & adjustments** → **Adjustment**: a **+ or −** amount in rupees (2500, +2500, -2500 and −2500 all work), a date and a **reason** (required).

- **Positive** adds to the advance, e.g. money recovered from an outlet.
- **Negative** takes money off the advance, e.g. a charge settled outside the portal.

**Recovering a reversed paid payout:** if a payout was already paid and is then reversed, the money is with the outlet. The Overview lists it under **To recover**. Recover it off-platform, then record a **positive** Adjustment with a reason such as "Recovered ₹2,500 for reversed payout CP-123".

## Step 4 — Read the Overview and the statement

The **Overview** cards:

| Card | Meaning |
|---|---|
| Advance received | Opening balance + every advance received |
| Adjustments | The total of all adjustments (±) |
| Committed (not yet paid) | Ordered / approved, money not yet gone |
| Paid out | Money that has gone |
| Returned | Spend that failed or was refunded and is already credited back (for information) |
| Balance (available) | What is left. Committed spend is already deducted |

Balance = advance received + adjustments − committed − paid out. The Payout Batches fund card shows the same figures.

Each piece of spend moves through **Committed → Paid**, or **Returned** if it fails or is refunded. It counts against the balance from the moment it is committed.

The **Statement** tab lists every entry with its date, reference, face value, discount, fee, TDS, the amount (red = off the advance, green = onto it), the running balance and the status. Filter by date, type, status, event or search, then press **Apply**. The period cards above the lines (**Totals cover all types for the period**) always count every type and status in the date range — the other filters change only the lines.

Small orange chips are **flags**. Under the filters, "What the flags mean" explains every flag on the page. Always look at them:

| Flag | Meaning | What to do |
|---|---|---|
| No item discount | No discount is set for this voucher item — charged at face value | Set the item's discount in the console (back-date it if it should apply to past vouchers) |
| No agency fee | No agency fee is set — no fee was charged on this payout | Set the agency fee in the console |
| Awaiting voucher provider | The voucher provider's (Hubble's) outcome is not known yet — counted as committed | Reconcile the Hubble order |
| Failed: re-bank | Failed at the bank and not reversed — still committed | Re-bank it or reverse it |
| Face recomputed | The order's value was worked out again from the copy saved when it was ordered (a refund had cleared the stored value) | Nothing — for information |
| Face unknown | No face value could be found (₹0 charged) | Check the source record |
| Date estimated | The source has no date for this event: a return is shown on the day it was committed, and a paid date is blank | Nothing — for information; the amount is right |
| Includes earlier TDS | The TDS for earlier payouts this year became due with this bank run (yearly limit crossed) | Nothing — information |
| Bank run not identified | The bank run this TDS was recorded with could not be identified — charged in full on the day recorded, status not tracked | Check the TDS entry against the payout downloads |

The Overview also warns about **returns of spend committed before the opening date** (not credited automatically — record an Adjustment if the client should get it back) and **entries dated before the opening date** (excluded).

## Step 5 — The Excel

**Statement** → **Download Excel**. It covers the From / To dates **applied** on screen (press **Apply** first — the button waits until you do; no dates = everything). Small files download straight away; big ones appear under **Downloads** a few minutes later. Sheets:

| Sheet | Contents |
|---|---|
| Summary | Opening, receipts, committed, paid, returned, adjustments and closing balance for the period, plus totals by spend type |
| Statement | Every line, as on the screen |
| Receipts | Every advance received, with its UTR |
| Rates | The discount % per voucher item and the agency fee in force over time |
| About | Plain-English definitions of every figure |

## Step 6 — Low-balance alerts

When the balance is below the client's threshold:

- a red **Low balance** banner shows on Fund Reconciliation (and the Payout Batches fund card turns red);
- an e-mail goes to the alert recipients **Monday to Saturday** while the balance stays low, **once an opening balance is recorded** (and not while the client is inactive). The banner shows when the last e-mail went and to how many recipients — and, in bold, if the last e-mail **failed** (the client admin sees a short "could not be delivered" note, never the mail-server error);
- the internal **Daily Ops Digest** has one line per client with the balance, committed amount and **LOW** when under the threshold.

**Environments:** the console's Fund section says loudly when e-mails are not live. **TEST** (staging) = the e-mail goes to one test address only, never to the client's recipients. **OFF** = nothing is sent at all. Only production sends to the real recipients. The test address must be an internal (gifsy) address, or nothing is sent and the console says so. The client's own view also says plainly when alert e-mails are switched off. Every daily check is recorded ("Last daily check: …") in the console and on the client's Rates & alerts tab — e.g. "Waiting for the opening balance", "Balance above the threshold", "E-mail sent" — so nothing is skipped silently. The client e-mails run as their own step of the daily run, even on a day the internal digest is not sent.

Spend is still never blocked.
`,
};
