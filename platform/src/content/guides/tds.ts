import type { Guide } from './index';

/**
 * TDS module guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/tds, printable).
 * Screenshots live in public/guides/tds/*.png (capture via scripts/capture-tds-screens.mjs).
 * Audience: the Gifsy ops team. Keep it plain and concise.
 */
export const tdsGuide: Guide = {
  slug: 'tds',
  title: 'TDS — How It Works',
  summary:
    'The whole TDS module in one place: the two sections (194R/194C), the two options (deduct/gross-up), how it calculates, when it fires, what cumulates for 194R, invoicing/GST, and where to set the rates.',
  updated: '2026-11-13',
  markdown: `# TDS — How It Works

*A plain-English guide to the entire TDS module — sections, calculation, triggers, what cumulates, invoicing, and where to configure it. This describes what the platform does, not any one client's setup.*

## The one idea: classification decides everything

TDS only attaches to **payouts going out to an outlet**, and what happens is decided by how the payout is **classified** — a setting on each payout column ("credit field"):

- **INCENTIVE** (a reward/benefit) → **Section 194R**.
- **VISIBILITY** (payment for a marketing/branding *service*) → **Section 194C** (or 194R if a client is configured that way).

Everything below follows from that one switch. All money is stored in paise (₹1 = 100 paise).

## The two sections

| | **194R** | **194C** |
|---|---|---|
| Applies to | Benefits/incentives + reward redemptions + off-platform gifts | Visibility/marketing **service** payouts |
| Who deducts | The **client/brand** | **Gifsy / TGSL** (the platform, one PAN) |
| Reporting scope | Per client | **Platform-wide** (one outlet PAN across every brand) |
| Rate — with PAN | **10%** | **1%** (Individual/HUF) or **2%** (other entities) |
| Rate — no PAN | **20%** | **20%** |
| Threshold (per financial year) | above **₹20,000** | above **₹30,000** single **or ₹1,00,000** for the year |

Thresholds are strict "greater than", measured on the **cumulative total per PAN** for the financial year (FY = Apr–Mar, IST).

## The two options (who bears the tax)

Set per client on the **TDS Treatment** screen (default **194C + Gross-up**). What each part of that setting actually reaches:

- **Methodology (Deduct / Gross-up)** — recorded on **every credit-upload ₹ payout** (visibility **and** incentive), but it only changes what is paid on **visibility** payouts:
  - **Deduct** — tax is **withheld from the payout**; the **outlet bears** it (receives amount − TDS). Formula: \`TDS = base × rate ÷ 100\`.
  - **Gross-up** — the outlet is **paid in full**; the **platform bears** the tax on top, deposits it against the outlet's PAN, raises a separate **TDS invoice**, and recovers it pro-rata from the contributing clients. Formula: \`TDS = base × rate ÷ (100 − rate)\` (so the outlet nets the full base).
- **Incentive payouts are never deducted**, whichever methodology is set — the **194R report** shows their **gross-up liability**, and **no TDS invoice** is raised for them.
- **Section (194C / 194R)** — applies **only to visibility payouts**. Incentive payouts are **always 194R**.
- **Points redemptions** are **never deducted from the partner** — they only count towards the client's **194R report liability**.
- **Each payout records the method when its batch is confirmed — set this before the first live payout batch.**

## How it calculates

- **Per-PAN, per-year cumulative:** all of an outlet-owner's benefits for the year add into one running total; the threshold applies to that **total**. Once crossed, TDS is due on the **whole** total (retroactive), and later payouts carry the catch-up.
- **194C vs 194R — whose payouts add up:** **194C** totals a PAN across **all clients** (Gifsy is the single deductor). **194R** — including visibility payouts on a client set to 194R — is worked out **per client**: the same PAN's 194R payouts under two different clients are **never** added together, so each client's ₹20,000 threshold, catch-up and recovery stand on their own.
- **Rounding:** to the nearest whole rupee.
- **No PAN:** rate is 20%; on the live payout path a no-PAN outlet is **paid in full** and it becomes a report-only reconciliation item. Each no-PAN recipient is its **own deductee** — the threshold and the 20% apply to *that recipient's* yearly total, never to all no-PAN partners added together: **194R** per partner, **194C** per outlet (the same unit the payout tax step uses). On the **TDS screen** such a row reads **"NO PAN ON FILE · Partner Name (outlet codes)"**; in the **Excel export** the Deductee Name is **"Partner Name (NO PAN ON FILE)"**, PAN is blank and the **Outlet Code** column names that partner's outlets (in the **194C** export the Outlet Code column is added only when such a row exists; the **194R** export always carries it — see "194R Excel export: outlet columns" below). To record a deposit (or an off-platform 194R benefit) for one, write **PANNOTAVBL** (or PANAPPLIED / PANINVALID / NA / N/A) in the PAN column **and** the partner's **Outlet Code** (any letter case) — the code must exist for that client. A **blank PAN is rejected** ("PAN is required — enter the PAN, or PANNOTAVBL if the deductee has none"), and a file without a PAN column is rejected as a whole. If that outlet's owner turns out to have a PAN on file, the row is counted under that PAN and the upload says so. For **194C** deposits, add the **Client** column (client slug) when the same Outlet Code exists in more than one client. A no-PAN deposit that can't be matched to a recipient — e.g. older deposits uploaded without an Outlet Code — appears on its own row **"Earlier no-PAN deposits (not linked to a partner)"**, with the deposit shown as a negative outstanding (a credit); the totals are always the sum of the rows.
- **194R Excel export: outlet columns:** every row carries **Outlet Code**, **Outlet Name** and **Outlet Type** — the outlets whose payouts make up that row's amount for the year (paid incentive credits, imported vendor payouts when they are counted, and off-platform entries that name an Outlet Code; deposits and redemptions don't add outlets). Several outlets are listed comma-separated, sorted by code, with names and types in the same order as the codes. If a PAN row has no such outlet (for example an off-platform entry uploaded with only a PAN), it shows the outlets of this client's partners holding that PAN (never the parent of a group); if there are none, the cells are blank. A no-PAN row shows that partner's outlets; the "NO PAN ON FILE" and "Earlier no-PAN deposits" rows stay blank. These columns are for identification only — no amount changes.
- **Redemption payouts without PAN (per-client switch):** by default a partner with no PAN on file is **excluded** from a Redemption Payouts batch. A Gifsy admin can switch on **"Allow payouts without PAN"** for a client (client settings → Behaviour flags): those partners are then paid the full amount, and the TDS at the no-PAN rate is a **company-borne** liability shown in the TDS reports as "NO PAN ON FILE".
- **194R is report-only at payout:** an incentive (194R) payout has **nothing withheld** from it — the platform *reports* what's due per PAN for the client's filing, and the client deposits it (recorded via a deposit upload). Actual withholding at payout only happens for **visibility** payouts on the **Deduct** methodology.

## When it fires (trigger points)

1. **At Confirm** (of the monthly credits batch): every payout is **frozen** with its section + option (incentive → always 194R) (so a later config change can't rewrite it), and a **self-billed service invoice** is raised. *No tax withheld yet.*
2. **At Generate Bank File** (payout download): for **visibility** payouts only, the tax is **computed and applied** — either deducted from the bank line, or grossed-up with a TDS invoice raised.
3. **Reports / CA export**: recomputed **on demand** whenever a report is opened — always current.

## What cumulates for 194R (the three inputs)

Everything below, for the **same PAN**, adds into that PAN's yearly 194R total:

| Input | Trigger (when it's added) |
|---|---|
| **Incentive payouts** paid on the platform | when the payout's **UTR is recorded** (status → Paid) |
| **Reward redemptions** (the ₹ value redeemed) | when the order reaches **Delivered** — cash: the payout UTR auto-delivers it; gift: the fulfilment steps |
| **Off-platform benefits** the client gave outside the system | when the client **uploads & applies** the off-platform 194R file |

Then **Deposits** (194R tax the client actually paid the government, uploaded) are **subtracted** → the **outstanding** amount. Below ₹20,000 total → no liability; once crossed → 10% (with PAN), grossed-up on the whole total.

### Imported (vendor) payout history — per-client setting

Payout history imported from a client's previous vendor (already paid off-platform) is **left out of 194R by default**. A Gifsy Admin can switch on **"Count imported (vendor) payouts in the 194R report"** for one client on the **TDS Treatment** screen, with a **from date** (e.g. \`2026-04-01\`):

- Imported vendor **incentive payouts** **paid on or after that date** are added to each retailer's 194R total exactly like a platform payout — same PAN / no-PAN deductee (no PAN → its own row at 20%), same ₹20,000 threshold, and **deposits** uploaded with **TDS for month** subtract as usual. Imported payouts **before** the date stay excluded (e.g. a closed financial year). Other kinds of imported history are never counted automatically.
- It is **report / liability only**. Nothing is deducted from any future payout, no TDS invoice is raised and nothing is recovered automatically — the retailers were already paid in full. Because nothing was withheld from those payouts, the liability is **payer-borne for every client** (whatever its Deduct / Gross-up setting); who finally bears it is settled outside the platform.
- **Retailer TDS paid later must be uploaded as deposits only** (TDS → Deposit Upload, with **TDS for month**) — **never as off-platform benefits**: the imported payouts are already in the base, so an off-platform upload would count them twice.
- Wherever a 194R figure includes them — the **194R** screen, the 194R **Excel export** (Summary sheet), the liability tracker and the **Finance dashboard** 194R tile — it says **"Includes imported (vendor) payouts paid on/after <date>"**. The note appears only for a financial year the date reaches into (a 1 Apr 2026 date shows nothing on FY 2025-26).
- The date must be between **1 Jan 2000** and **one year from today**. A date before the **current** financial year also counts earlier years, so the screen warns and asks you to confirm; **Switch off** asks to confirm too.
- Switching it off (or never switching it on — the default for every client) leaves the report exactly as before. Every change is audit-logged. If the stored setting can't be read or is invalid, the 194R report shows an error instead of silently leaving the imported payouts out; the TDS Treatment screen still opens with a red "stored value is invalid" banner so a Gifsy Admin can re-save a date or switch it off.

![194R report — per-PAN base, liability, deposited, outstanding](/guides/tds/194r-report.png)

## Recording deposits — "TDS for month"

Every deposit counts against the **financial year of the month whose TDS it pays**, not the year of the deposit date — so March's TDS deposited on 7 April (or by 30 April) reduces **March's** year, not the next one.

- The deposit template (TDS → Deposit Upload → **Download Template**) has an optional **TDS for month** column. Accepted: \`2026-03\`, \`03/2026\`, \`Mar-2026\`, \`March 2026\`, \`Mar-26\`, or an Excel date (its month is used).
- **Left blank**, the month is decided by the deposit date: deposited on the **1st–7th** → the **previous month**; deposited **8–30 April** → **March** of that year; otherwise the deposit's **own month**. The upload preview notes every deposit this puts in an earlier financial year.
- The month column may be headed **TDS for month**, **TDS for Month (YYYY-MM)**, **For month** or **Period**. Any other month-like column is ignored, and the preview says so.
- A row is rejected (with its row number) if the month can't be read, is in the **future**, is **after** the deposit date's month, or is **more than 12 months before** it. A month that puts the deposit in a different financial year than the deposit date normally would is allowed but flagged in the preview.
- **Dates are read day-first** (Indian format): \`07/04/2026\` is **7 April 2026**. Accepted: \`DD/MM/YYYY\`, \`DD-MM-YYYY\`, \`DD-Mon-YYYY\` (\`07-Apr-2026\`), \`YYYY-MM-DD\`, or an Excel date. A time without a zone is read as India time. Anything else is rejected.
- **Do not upload TDS that Gifsy already withheld from a payout** (the *deduct* method). It is already counted as **withheld** on the 194C report, so uploading it as a deposit counts it twice. For a **194R** client's visibility payouts, the withholding is tracked **per client** — it is never netted against TDS withheld for the same PAN under another client.
- **An uploaded deposit cannot be edited or deleted**, so check the preview before you apply. A deposit that was already uploaded (same PAN, outlet, date and amount, from any earlier file) is **skipped**; if the earlier upload had a different TDS for month, the row is **rejected** rather than added a second time.
- The 194R/194C reports and Excel exports show the **TDS for month(s)** of the deposits counted on each row. A PAN whose deposit belongs to a year in which it was paid nothing still appears in that year (base 0, outstanding negative = the deposit), so totals always equal the sum of the rows.

## Invoicing, GST & recovery (visibility payouts)

- **Self-billed invoice:** for a visibility service the platform raises the invoice *for* the outlet — seller = the outlet, buyer = TGSL. It locks once the payout UTR is recorded.
- **GST:** applies only to GST-registered outlets (18%). It's **held back** at payout and **released later** once the outlet proves it deposited that GST (GST Reimbursements screen).
- **Gross-up recovery:** when gross-up is used, the TDS cost is recovered "in lieu of TDS", shown on the Recovery screen. Under **194C** it is split **pro-rata across the contributing clients**; under **194R** it is recovered **100% from the paying client** (194R is worked out per client).
- **RCM (unregistered outlets):** an unregistered outlet's invoice carries no GST; TGSL owes it under reverse charge, computed off-portal from the RCM report.

## Setting the rates & thresholds

The statutory **rates and thresholds are editable at the platform level** (they're the same for every client), on the **owner-only** *TDS Statutory* screen in the Gifsy console. They are **effective by financial year** — you add a new FY's values when the law changes, and closed years stay locked (past filings never move). The per-client choice (which section for visibility payouts, deduct vs gross-up for credit-upload payouts) is a separate, per-client *TDS Treatment* setting.

![TDS Statutory editor — rates & thresholds by financial year (owner only)](/guides/tds/tds-statutory.png)

## Where to do what

| Task | Screen |
|---|---|
| See 194R / 194C liability + download the CA export | **TDS** |
| Upload off-platform 194R benefits / record deposits | **TDS** (194R tab) |
| Set a client's treatment (section for visibility; deduct/gross-up for all credit-upload payouts) | **TDS Treatment** |
| Count a client's imported (vendor) payouts in 194R from a date (Gifsy Admin) | **TDS Treatment** |
| Set the statutory rates & thresholds (owner only) | **Gifsy → TDS Statutory** |
| Per-payout TDS report (frozen section/option) | **TDS Payouts** |
| Gross-up recovery / attribution | **TDS Recovery** |
| Unregistered / reverse-charge source list | **RCM** |
| Self-billed invoices (view, generate, mark paid) | **Invoices** |
| Release held-back GST | **GST Reimbursements** |

## Things that confuse people

1. **194R is reported, not withheld at payout** — the client deposits it; the platform only computes and reports it.
2. **Gross-up liability is ~11%, not 10%** — it's grossed up (\`× 10/90\`) because the platform pays the tax *on top*, not out of the outlet's amount.
3. **The threshold is on the year's total per PAN**, not per payout — a small payout can still cross it once the running total does.
4. **Section/option are frozen at confirm** — changing a client's treatment never re-prices already-confirmed payouts, so set it before the first live payout batch.
5. **194C is platform-wide** (one outlet PAN aggregated across all clients); **194R is per-client**.
6. **A deposit belongs to the year of the month it pays for** — an April deposit of March's TDS shows in the *previous* year's report. Use the **TDS for month** column to say exactly which month a deposit covers.`,
};
