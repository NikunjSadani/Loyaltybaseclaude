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
  updated: '2026-08-20',
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

Set per client (default **194C + Gross-up**):

- **Deduct** — tax is **withheld from the payout**; the **outlet bears** it (receives amount − TDS). Formula: \`TDS = base × rate ÷ 100\`.
- **Gross-up** — the outlet is **paid in full**; the **platform bears** the tax on top, deposits it against the outlet's PAN, raises a separate **TDS invoice**, and recovers it pro-rata from the contributing clients. Formula: \`TDS = base × rate ÷ (100 − rate)\` (so the outlet nets the full base).

## How it calculates

- **Per-PAN, per-year cumulative:** all of an outlet-owner's benefits for the year add into one running total; the threshold applies to that **total**. Once crossed, TDS is due on the **whole** total (retroactive), and later payouts carry the catch-up.
- **Rounding:** to the nearest whole rupee.
- **No PAN:** rate is 20%; on the live payout path a no-PAN outlet is **paid in full** and it becomes a report-only reconciliation item. Each no-PAN recipient is its **own deductee** — the threshold and the 20% apply to *that recipient's* yearly total, never to all no-PAN partners added together: **194R** per partner, **194C** per outlet (the same unit the payout tax step uses). On the **TDS screen** such a row reads **"NO PAN ON FILE · Partner Name (outlet codes)"**; in the **Excel export** the Deductee Name is **"Partner Name (NO PAN ON FILE)"**, PAN is blank and an **Outlet Code** column is added. To record a deposit (or an off-platform 194R benefit) for one, write **PANNOTAVBL** (or PANAPPLIED / PANINVALID / NA / N/A) in the PAN column **and** the partner's **Outlet Code** (any letter case) — the code must exist for that client. A **blank PAN is rejected** ("PAN is required — enter the PAN, or PANNOTAVBL if the deductee has none"), and a file without a PAN column is rejected as a whole. If that outlet's owner turns out to have a PAN on file, the row is counted under that PAN and the upload says so. For **194C** deposits, add the **Client** column (client slug) when the same Outlet Code exists in more than one client. A no-PAN deposit that can't be matched to a recipient — e.g. older deposits uploaded without an Outlet Code — appears on its own row **"Earlier no-PAN deposits (not linked to a partner)"**, with the deposit shown as a negative outstanding (a credit); the totals are always the sum of the rows.
- **Redemption payouts without PAN (per-client switch):** by default a partner with no PAN on file is **excluded** from a Redemption Payouts batch. A Gifsy admin can switch on **"Allow payouts without PAN"** for a client (client settings → Behaviour flags): those partners are then paid the full amount, and the TDS at the no-PAN rate is a **company-borne** liability shown in the TDS reports as "NO PAN ON FILE".
- **194R is report-only at payout:** an incentive (194R) payout has **nothing withheld** from it — the platform *reports* what's due per PAN for the client's filing, and the client deposits it (recorded via a deposit upload). Actual withholding at payout only happens for **visibility (194C)** payouts.

## When it fires (trigger points)

1. **At Confirm** (of the monthly credits batch): each visibility payout is **frozen** with its section + option (so a later config change can't rewrite it), and a **self-billed service invoice** is raised. *No tax withheld yet.*
2. **At Generate Bank File** (payout download): the tax is **computed and applied** — either deducted from the bank line, or grossed-up with a TDS invoice raised.
3. **Reports / CA export**: recomputed **on demand** whenever a report is opened — always current.

## What cumulates for 194R (the three inputs)

Everything below, for the **same PAN**, adds into that PAN's yearly 194R total:

| Input | Trigger (when it's added) |
|---|---|
| **Incentive payouts** paid on the platform | when the payout's **UTR is recorded** (status → Paid) |
| **Reward redemptions** (the ₹ value redeemed) | when the order reaches **Delivered** — cash: the payout UTR auto-delivers it; gift: the fulfilment steps |
| **Off-platform benefits** the client gave outside the system | when the client **uploads & applies** the off-platform 194R file |

Then **Deposits** (194R tax the client actually paid the government, uploaded) are **subtracted** → the **outstanding** amount. Below ₹20,000 total → no liability; once crossed → 10% (with PAN), grossed-up on the whole total.

![194R report — per-PAN base, liability, deposited, outstanding](/guides/tds/194r-report.png)

## Invoicing, GST & recovery (visibility payouts)

- **Self-billed invoice:** for a visibility service the platform raises the invoice *for* the outlet — seller = the outlet, buyer = TGSL. It locks once the payout UTR is recorded.
- **GST:** applies only to GST-registered outlets (18%). It's **held back** at payout and **released later** once the outlet proves it deposited that GST (GST Reimbursements screen).
- **Gross-up recovery:** when gross-up is used, the TDS cost is split **pro-rata across the contributing clients** ("in lieu of TDS"), shown on the Recovery screen.
- **RCM (unregistered outlets):** an unregistered outlet's invoice carries no GST; TGSL owes it under reverse charge, computed off-portal from the RCM report.

## Setting the rates & thresholds

The statutory **rates and thresholds are editable at the platform level** (they're the same for every client), on the **owner-only** *TDS Statutory* screen in the Gifsy console. They are **effective by financial year** — you add a new FY's values when the law changes, and closed years stay locked (past filings never move). The per-client choice (which section, deduct vs gross-up) is a separate, per-client *TDS Treatment* setting.

![TDS Statutory editor — rates & thresholds by financial year (owner only)](/guides/tds/tds-statutory.png)

## Where to do what

| Task | Screen |
|---|---|
| See 194R / 194C liability + download the CA export | **TDS** |
| Upload off-platform 194R benefits / record deposits | **TDS** (194R tab) |
| Set a client's treatment (section + deduct/gross-up) | **TDS Config** |
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
4. **Section/option are frozen at confirm** — changing a client's treatment never re-prices already-confirmed payouts.
5. **194C is platform-wide** (one outlet PAN aggregated across all clients); **194R is per-client**.`,
};
