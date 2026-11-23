import type { Guide } from './index';

/**
 * "Fund reconciliation" guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/fund).
 * Audience: the Gifsy ops team. Keep it plain and concise. Design: platform/docs/plans/FUND-RECONCILIATION-DESIGN.md.
 * The labels quoted here are the ones on the /admin/fund screen — if the screen's wording changes, update this guide too.
 */
export const fundGuide: Guide = {
  slug: 'fund',
  title: 'Fund Reconciliation — Step by Step',
  summary:
    "Track a client's prepaid advance: set up the opening balance and rates, record advances and adjustments, read the statement and Excel, and handle low-balance alerts.",
  updated: '2026-11-23',
  markdown: `# Fund Reconciliation — Step by Step

*A plain-English guide to **Fund Reconciliation** (admin menu): the client's advance with Gifsy, and every voucher and payout charged to it.*

## What it shows

Each client **prepays** an advance. Spend comes off it:

| Spend | Charged to the advance |
|---|---|
| Vouchers (Hubble or manual) | Face value **less** the brand discount for this client |
| Cash redemptions (UPI / bank) | Face value **plus** the agency fee |
| Target / credit payouts | Gross award **plus** the agency fee |
| Visibility payouts | Gross award **plus** the agency fee |
| TDS 194C (gross-up) | The TDS Gifsy pays on top of the payout |

Not on this ledger: points credits (money leaves only when points are redeemed), physical gifts, voucher dispersal campaigns, GST held back on visibility payouts, 194R TDS (the client pays it) and DEDUCT-method TDS.

**Nothing is ever blocked.** A low balance shows a red banner and sends an email; vouchers and payouts carry on. Gifsy decides case by case whether to ask the client for a top-up.

Who can do what: **Gifsy admins** (working inside the client) record money and set rates. The **client admin** sees everything read-only.

## Step 1 — Set up a client

Open the client, then **Fund Reconciliation**.

1. **Opening balance** (tab **Receipts & adjustments** → **Opening balance**): the amount and the **as-of date**. It is the balance at the **start** of that date. Spend before the date is ignored; spend on or after it is tracked. It can be recorded only once — correct it later with an Adjustment. Until it is recorded, the screen says "No opening balance recorded — all history is counted".
2. **Agency fee** (tab **Rates & alerts** → **Set agency fee**): either **% of each payout** or a **flat ₹ per payout**, with an **effective from** date.
3. **Voucher discounts** (same tab, **Voucher discount by brand** → **Set rate** on each brand): the discount % and the effective-from date. A brand with no rate is charged at face value and flagged.
4. **Low-balance alert** (same tab): the threshold in ₹ and the email recipients (one per line or comma separated), then **Save alert settings**.

Rates are never edited. A change is a new rate from a date, so past spend keeps the rate that applied when it was committed.

## Step 2 — Record an advance received

When the client pays: **Receipts & adjustments** → **Record advance received**. Enter the amount in **rupees** (e.g. 150000 or 1500.50), the date received and the **UTR / reference** (required). Bank, payment mode and a note are optional.

Mistakes are corrected with a new entry (an Adjustment), never by editing — every entry keeps who recorded it and when.

## Step 3 — Adjustments

**Receipts & adjustments** → **Adjustment**: a **+ or −** amount in rupees, a date and a **reason** (required).

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

Each piece of spend moves through **Committed → Paid**, or **Returned** if it fails or is refunded. It counts against the balance from the moment it is committed.

The **Statement** tab lists every entry with its date, reference, face value, discount, fee, TDS, the amount (red = off the advance, green = onto it), the running balance and the status. Filter by date, type, status, event or search. Small orange chips are **flags** — always look at them:

| Flag | What to do |
|---|---|
| No brand rate | Set a discount for that brand (charged at face until you do) |
| No agency fee | Set the agency fee (no fee is charged until you do) |
| Hubble: reconcile | Reconcile the Hubble order; it counts as committed meanwhile |
| Failed: re-bank | The bank payment failed; it stays committed until it is re-banked or reversed |
| Face unknown | No face value could be found (₹0 charged) — check the source record |

The Overview also warns about **returns of spend committed before the opening date** (not credited automatically — record an Adjustment if the client should get it back) and **entries dated before the opening date** (excluded).

## Step 5 — The Excel

**Statement** → **Download Excel** (uses the From / To dates you set; blank = everything). Small files download straight away; big ones appear under **Downloads** a few minutes later. Sheets:

| Sheet | Contents |
|---|---|
| Summary | Opening, receipts, committed, paid, returned, adjustments and closing balance for the period, plus totals by spend type |
| Statement | Every line, as on the screen |
| Receipts | Every advance received, with its UTR |
| Rates | The discount % and agency fee in force over time |
| About | Plain-English definitions of every figure |

## Step 6 — Low-balance alerts

When the balance is below the client's threshold:

- a red **Low balance** banner shows on Fund Reconciliation (and the Payout Batches fund card turns red);
- one email a day goes to the alert recipients while the balance stays low. The banner shows when the last email went — and, in bold, if the last email **failed**;
- the internal **Daily Ops Digest** has one line per client with the balance, committed amount and **LOW** when under the threshold.

Spend is still never blocked.
`,
};
