import type { Guide } from './index';

/**
 * Sales Import guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/sales-import, printable).
 * Audience: the Gifsy ops team AND the client's data team (e.g. Bajaj), who are not technical — keep it plain.
 * Every label quoted here is copied from the screens under platform/src/app/admin/sales-import/** (and the dashboard's
 * BillingComparison); change the guide in the same commit as any label it quotes.
 * Retention wording is deliberately switch-proof: SALES_RETENTION_V2 (api/src/sales-import/retention-window.ts) is OFF
 * by default, so the guide promises no specific day counts for files or month history.
 */
export const salesImportGuide: Guide = {
  slug: 'sales-import',
  title: 'Sales Import — Step by Step',
  summary:
    'Upload the distributor (DMS) sales file, read the month preview, apply months, send daily month-to-date files, recalculate after target or KPI changes, close and reopen months, and fix every warning the screens show.',
  updated: '2026-11-18',
  markdown: `# Sales Import — Step by Step

*A plain-English walk-through of the Sales Import screens: from the distributor's sales file to the figures outlets and dashboards show. Labels in **bold** are exactly what you see on screen.*

## In one paragraph

You upload the distributor (DMS) sales file. The portal reads it and shows a preview for each month in the file. You tick the months you want and press **Apply**. The KPIs set up for Sales Import are then **fully replaced** for every programme outlet in those months, and the outlet Targets cards and the dashboards show the new numbers. During the month you repeat this with each new daily file. When a month is final, you **close** it, and points can be computed for it.

## Who can do it

- **Sales Import** is switched on per client by Gifsy. If it is not, the page says **"Sales Import is not enabled"**.
- **Client admins** of the client, and **Gifsy admins** while assumed into the client, can open it.
- Some accounts can only look. They see messages such as "You can view sales imports, but you don't have permission to upload sales files", "You can view this preview, but you don't have permission to apply sales files" or "You can view the column mapping, but you don't have permission to change it". Ask your admin or Gifsy for access.
- **Only Gifsy** can **reopen** a closed month.

The section has three tabs: **Imports** (upload, list of files, preview and apply), **Months** (close, recalculate, reopen) and **Settings** (column mapping and KPIs).

## Before you start

### The file

- The distributor's **invoice-line export**, as **.xlsx or .csv**, up to **600 MB**.
- **One row per invoice line**, under a single heading row: outlet (customer) code, invoice date, amount and/or cases, and the product columns (brand, size and so on).
- **Not supported:** pivot or summary sheets (one column per month or brand), several sheets merged together, or subtotal rows. Keep using the manual achievement upload for those.

### One-time setup (Settings tab)

This is done once per client and reused for every file. Usually Gifsy does it with you.

1. **How to read the sales file** — type each heading exactly as it appears in the file (case and extra spaces do not matter):
   - **Outlet / customer code** and **Invoice date** (both required).
   - **Amount (₹)**, **Quantity (cases)**, or both (at least one).
   - Optional: **Outlet name (optional)**, **Sheet name (optional, .xlsx only)**.
   - **Header row**: leave **Find it automatically (rows 1–10)** unless the headings are lower down.
   - **Date order for dates typed as text** — Indian files are usually **Day-Month-Year (05-10-2026)**. Real Excel date cells are read correctly whatever this says.
   - **Product columns** — press **Add product column** for each column used to pick brands, sizes and so on. Changing a column's **Key** later breaks KPIs that use it; change the **Label** instead.
   - Press **Save column mapping**.
2. **KPIs from the sales file** — press **Add KPI**, choose the KPI, choose what it **Count**s (**Rupees (₹)**, **Cases (quantity)** or **Number of products bought (lines)**), and **Which products count** (**Pick products here**, or **From the target file, per outlet** for focus products). Use **Test against latest import** to see the monthly totals it would get, then **Save KPI**.

> A KPI listed under **KPIs from the sales file** comes **only** from the sales file. The manual achievement upload no longer accepts it. KPIs not listed there keep coming from the manual upload. Targets are uploaded as before.

## Step 1 — Upload the file

1. Open **Sales Import → Imports**. In **Upload a sales file**, drop the file on the box or click **browse**.
2. A progress bar shows **Uploading… N%**. **Keep this browser tab open** until it finishes. You can use other portal pages meanwhile, but closing or reloading the tab stops the upload.
3. If the upload stops part-way, press **Resume upload (N% sent)**. Or press **Discard this upload** and start again. You must resume or discard before choosing another file.
4. When it finishes, the import page opens by itself.

## Step 2 — Processing, and "Needs column mapping"

The file now shows one of these statuses (also in the **Imports** list):

| Status | What it means | What to do |
|---|---|---|
| **Queued** — "Waiting for the processor to start…" | In line to be read. | Wait. You can leave the page and come back. |
| **Processing** — "Reading the file…" | Being read. Big files take a few minutes. | Wait. |
| **Needs column mapping** | The portal could not find the columns it needs (new file layout, renamed headings, or no mapping saved yet). | See below. |
| **Ready** | Read successfully. The month preview is shown. | Go to Step 3. |
| **Failed** | Processing failed. The reason is shown. | Fix the file or the column mapping, then press **Reprocess**. |
| **Cancelled** | Cancelled or deleted. Nothing from it was imported. | Upload again if needed. |
| **Uploading / incomplete** | The upload never finished. | Keep the uploading tab open, or delete the import and upload again. |

**Needs column mapping:** the page shows **"The portal could not find the columns it needs"**, the reason, and the row it took as the heading row with the first rows of data. Press **Set up column mapping**, correct the headings so they match the file, press **Save column mapping**, then come back to the import and press **Reprocess**.

If some rows could not be read, the import page says **"N rows were skipped — show examples"**. A row is skipped when it has no outlet code, or an invoice date, amount or cases the portal cannot read. Skipped rows are not counted in any month. Use **Download all skipped-row examples** to see them all.

## Step 3 — Read the preview

The preview lists **Months in this file**, one row per month:

| Column | Meaning |
|---|---|
| **Month** | With an **Open** or **Closed** tag. Only open months can be ticked. |
| **Sales dates** | "This file: 01 Nov – 17 Nov", and under it what is in the portal now ("Applied now: up to 16 Nov", or "Never applied from a sales file"). |
| **Lines** | Invoice lines in the file for that month. |
| **Outlets found** | Customer codes that match a **programme outlet**. Only these are counted. |
| **Not in programme** | Customer codes that are **not** programme outlets. They are ignored. Click the number to download the list. |
| **₹ (outlets found)** / **Cases** | Totals for the matched outlets only. |
| **Warnings** | Short warning tags (explained below). |

Click a month to open it. It shows, for each KPI, **From this file**, **Stored now** and **Change**, plus how many programme outlets have no lines and **will be set to 0**.

### Matched and not-in-programme customers

- The file usually contains customers who are not in the loyalty programme. That is normal. They are left out of every figure.
- If a customer you expected to be in the programme shows under **Not in programme**, download the list and check its code against the outlet master. Fix the outlet master (or the code in the file), then press **Refresh preview** — the preview always uses today's outlet list.
- A blue note "N outlets were added to the programme after this file was processed. They are included…" just tells you the new outlets are counted. No action needed.

### Warnings and what to do

| Tag on screen | What it means | What to do |
|---|---|---|
| **Older data than last applied** | This file's sales for the month stop **earlier** than the file already applied. Applying would roll the month back to older numbers. | Usually: **don't apply** this month — you probably picked an old file. If you really mean it, tick the box "…Applying rolls that month back to this file's older data. I want to apply it anyway." |
| **Starts after the 1st** / **Ends before month end** | Partial month: the file does not cover the whole month. Applying replaces **all** of that month with only these dates. ("Ends before month end" is never shown for the current month.) | Only apply if this is really the full data you have. Tick "I understand this replaces the whole of <Month> with this partial file". |
| **Replaces manual values** | Some outlets have values for these KPIs from the manual achievement upload. | Applying replaces them with the sales-file values. Expected the first time a KPI moves to Sales Import. |
| **Negative values** | Some outlets come out negative (returns are bigger than sales). | They are stored as-is. Check with the distributor if it looks wrong. |
| **Column settings changed** | The column settings changed after this month was saved. | Check the totals before you recalculate. |

**Targets and focus products** (shown inside the month when they apply):

- **"Targets were uploaded after this month was last applied — apply again (or Recalculate) to use them."** Apply the latest file again, or use **Recalculate** (Step 6).
- **"No targets uploaded for this month yet — focus KPIs are not calculated."** Upload the month's targets first, then recalculate.
- **Focus brands** shows each product name from the target file and the products it counts. A red **"<name> — not found in sales data"** blocks the month: the message **"<Month> can't be applied until … fixed"** lists the problems.
  - If the name is a spelling mistake, fix it in the target file and upload the targets again.
  - If the product simply has not sold yet, press **Accept — not sold yet**. It then counts as 0 (you can **Undo** it).
  - **"could mean more than one product"** — make the name more specific in the target file.
  - **"N outlets have a target for this KPI but no product name in the target file"** — add the names and upload the target file again.
- **For your information** lists outlets with a target but no sales, and outlets with sales but no target. Nothing blocks; check them if the numbers look surprising.

## Step 4 — Apply

1. Tick the month(s) to update. Months that cannot be ticked say why under the month name (for example "… is CLOSED. Only Gifsy can reopen it.").
2. Tick any confirmation boxes the warnings ask for. Until everything is in order, the reasons are listed next to the button (for example "Tick at least one month.").
3. Press **Apply N months** and confirm. The message reminds you that the Sales Import KPIs are **fully replaced** for every programme outlet, outlets with no sales in the file get **0**, and other KPIs are not touched.
4. Each month shows a result card: **"<Month>: applied"** with "N outlets updated, M set to 0. Targets cards and dashboards now show these numbers." — or **"not applied"** with the reason. One month failing does not undo the others.

**What changes:** the outlets' achievement for the Sales Import KPIs (Targets cards on the outlet app, admin dashboards and reports) now shows the applied numbers. Nothing is credited: **points are only computed after the month is closed** (Step 7).

## Step 5 — Daily files during the month

Most distributors send a new file every day. Each one should cover the month **from the 1st up to the latest day** (month-to-date).

- **Each apply replaces the whole month.** A daily file does not "add on" to yesterday's; it replaces it. So every daily file must start on the 1st. A file with only yesterday's sales would wipe out the rest of the month (the preview warns **Starts after the 1st**).
- Daily routine: upload today's file → check the preview (Outlets found, totals, warnings) → tick the **current month** → **Apply**.
- If a file is the same file as an earlier upload, it is marked **Repeat file** and the page says "This is the same file as an earlier upload." Compare **This file** with **Applied now** before applying, so you don't roll the month back.
- **Day-by-day figures.** Every apply also stores the month's figures **day by day**. These power the comparison on the Overview dashboard's **Monthly billing progress** card: **"vs last month (to day N)"**, **"vs 3-month average (to day N)"** and **"N outlets billing slower than usual"**. They compare this month up to day N with the same days of earlier months. Day-by-day figures start from November 2026, so a comparison that needs an earlier month says so.
- **Finish last month properly.** In the first days of a new month, apply the distributor's **final, complete file for last month** (1st to last day). If last month's applied file stopped early, the comparison says "<Month>'s day-by-day sales only go up to day N".
- If the result card shows **"Daily figures not stored for <Month>: <reason>"**, the monthly figures **were** updated; only the day-by-day comparison has no data for that month. See Troubleshooting.

## Step 6 — Recalculate (after a target or KPI change)

Use **Recalculate** when the **sales are unchanged** but how they are counted changed:

- targets (or focus products in the target file) were uploaded again after the month was applied — the **Months** tab shows **Targets changed — recalculate** on that month;
- a KPI was added or changed under **Settings** (after saving, the screen points you to "Months → Recalculate from stored history").

Steps:

1. Open **Sales Import → Months** and press **Recalculate** on the month (or the **Targets changed — recalculate** tag). The month must be **open**.
2. The panel **Recalculate <Month> from stored history** shows a preview: how many outlets would change, and per KPI **Recalculated**, **Stored now** and **Change**. It also shows the same targets and focus-brand checks as the import preview. Resolve any blockers the same way.
3. Press **Recalculate <Month>** and confirm. The result says "<Month> recalculated: N outlets updated, M set to 0."

Recalculate uses the figures **saved at the month's last apply** — nothing is re-uploaded. Those saved figures keep **programme outlets only**, so an outlet that joined the programme after that apply cannot be picked up by recalculating: apply the sales file again instead. **If the sales themselves changed, upload and apply the new file instead.**

**Rebuild product list** (on the Months tab, only when shown) refreshes the list of products the KPI settings offer for that month. It does not change any figures.

## Step 7 — Close a month (and reopen it)

**The month states:** the current month is always open. The previous month stays open until someone closes it. Older months are closed unless Gifsy reopened them.

**Close** when the month's **final** file has been applied:

1. Open **Sales Import → Months** and press **Close <Month>**. (The current month cannot be closed.)
2. Confirm. Closing locks the month: sales files can no longer change it, and points can then be computed. If no sales file was ever applied to it, you are asked to confirm that too.
3. The screen says "<Month> is closed. You can now compute points for it in the Points Engine."

**Reopen (Gifsy only):** if a closed month must change, ask Gifsy. A Gifsy admin presses **Reopen** on the Months tab. If points were already credited or exported for that month, the screen warns first, and any difference must go through the existing reversal process. After reopening, apply the corrected file and **close the month again**.

## What data is kept

- **Uploaded files** (and their preview and "Not in programme" list) are kept for a **limited time only**. After that the import page says "This file's data was removed … (files are kept for a limited time)", and it can no longer be previewed, applied or reprocessed. **Always keep your own copy of every file you upload.**
- **Month figures saved for Recalculate** keep **programme outlets only** (customers not in the programme are not stored). Gifsy will limit these to the **current month and the 3 months before it**. When a month is older than what is kept, the screens say so (for example "<Month> is older than the stored sales lines … To change its figures, apply a sales file to it again.") — follow that message.
- **Day-by-day figures** (for the dashboard comparison) are kept for the **current month and the 3 months before it**. Applying an older month still updates its monthly figures but stores no day-by-day figures, and the result card says so.
- The **applied achievement figures** themselves (what outlets and dashboards show) are **not** deleted by any of this.

## Troubleshooting — every message and what to do

### Uploading

| Message | What to do |
|---|---|
| "Only .xlsx or .csv files are supported." / "The file is empty." / "The file is larger than 600 MB." | Export the file again in the right format, or split a very large period into two files by month. |
| The upload stopped; **Resume upload (N% sent)** is shown | Press it. If it keeps failing, check your connection, or **Discard this upload** and try again. |
| "This file has not finished uploading (N of M parts received)" | Keep the uploading tab open. If that tab was closed, delete the import and upload again; unfinished uploads are removed automatically. |

### Processing

| Message | What to do |
|---|---|
| "This file has been waiting for more than 2 minutes…" | Wait a little. If it does not start soon, contact Gifsy support. |
| "The processor has not reported progress for more than N minutes…" | It is picked up again automatically. You can also **Cancel processing**, or press **Reprocess**. |
| **Needs column mapping** — "No column mapping is saved for this tenant yet…" | Set up the column mapping under **Settings**, then **Reprocess**. |
| **Needs column mapping** — a heading row was not found / a column is missing or used twice | Compare the heading row shown with **Settings → How to read the sales file**. Fix the headings, **Save column mapping**, then **Reprocess**. |
| "Processing failed: <reason>" | Fix the file or the column mapping, then press **Reprocess**. |
| "N rows were skipped — show examples" | Open the examples. Usually a blank outlet code, an unreadable date or amount. Fix the source file and upload again if the skipped rows matter. |

### Preview and apply

| Message | What to do |
|---|---|
| "No usable invoice lines were found in this file." | The file has no rows the portal can use. Check it is the invoice-line export, not a summary. |
| "No KPIs are set up for Sales Import yet…" / "No importer-owned KPIs are defined yet. Add them in Sales Import settings." | Add the KPIs under **Settings → KPIs from the sales file** first. |
| "<Month> has not started yet." | The file contains future dates. Check the invoice dates and the **Date order** setting. |
| "<Month> is CLOSED. Only Gifsy can reopen it." | Ask Gifsy to reopen the month if it must change. |
| "The column mapping was changed after this file was processed, so no month can be applied from it." | Press **Reprocess** (or **Read again as a new import** if months were already applied from this file). |
| "<Month> can't be applied until … fixed" / "N problems with the focus products in the <Month> target file — see Focus brands." | Open the month and fix each item under **Focus brands** (see Step 3). |
| "Confirm the partial-month replacement for <Month>." | Tick the partial-month box under the month — or don't apply that month. |
| "Confirm that you want to roll a month back to this file's older data." | Tick the older-data box — or untick the month (usually the right choice). |
| "Nothing was applied: <reason>. The preview has been refreshed — check it and apply again." | Something changed since you looked (another file was applied, the KPIs or targets changed, the file was reprocessed). Re-check the refreshed preview and apply again. |
| "Nothing was applied: your session has expired. Sign in again, then apply." | Sign in again. |
| "This file's data was removed on <date> (files are kept for a limited time)…" | Upload the file again. |
| "<Month>: not applied" on a result card | Read the reason on the card; the other months were still applied. |

### "Daily figures not stored for <Month>: <reason>"

The monthly figures **were** applied. Only the day-by-day figures (used by "vs last month") are missing for that month. The reason says which case it is:

| Reason starts with | What to do |
|---|---|
| "This file was processed before day-by-day sales were stored…" | Press **Reprocess** on the import, then apply the month again. |
| "This month's stored sales lines were applied before day-by-day sales were stored…" (after **Recalculate**) | Apply the sales file to the month again. |
| "Day-by-day figures are kept only for the current month and the 3 months before it…" | Nothing to do — that month is too old for day-by-day figures. |
| "This month has too many sales lines for programme outlets…" | Contact Gifsy support. |
| "The day-by-day values did not add up to the monthly values…" | Contact Gifsy support. |
| "The last invoice day of the applied file for this month is unknown…" | Apply the sales file to the month again. |

### Months and recalculate

| Message | What to do |
|---|---|
| **Recalculate** greyed out with "Gifsy must reopen this month first" | The month is closed. Ask Gifsy to reopen it. |
| "<Month> has no stored history yet — it is saved each time a sales file is applied to the month." | Apply a sales file to the month first. |
| "<Month> is older than the stored sales lines…" | Apply a sales file to that month again to change it. |
| "<Month> cannot be recalculated: <reason>" | Follow the reason (often a focus-product problem — fix it under **Focus brands**). |
| "Nothing was changed: <reason>. The preview has been refreshed — check it and recalculate again." | Something changed meanwhile. Re-check and press **Recalculate <Month>** again. |
| "<Month> was not closed / not reopened: <reason>" | Read the reason. The current month can never be closed. |

### Dashboard comparison ("vs last month")

| Message | What it means |
|---|---|
| "…available from <Month>" / "day-by-day sales start from November 2026" | Not enough months of day-by-day figures yet. It fills in by itself. |
| "<Month>'s day-by-day sales only go up to day N" | The file applied to that month stopped early. Apply its final, complete file. |
| "there are no day-by-day sales for <Month>" | No day-by-day figures were stored for that month (see "Daily figures not stored" above). Apply the month's file again. |
| "day-by-day sales are kept for 4 months, and <Month> is older than that" | Expected — older months are not compared. |
| "…doesn't include <KPI>" | That KPI does not come from the sales file, so it has no day-by-day figures. |

## Things that confuse people

1. **Every apply replaces the whole month.** Daily files must be month-to-date (from the 1st), never "just yesterday".
2. **Only programme outlets count.** "Not in programme" customers are ignored on purpose.
3. **Applying does not credit points.** Points are computed only for **closed** months.
4. **Recalculate is for counting changes, not sales changes.** New sales → upload and apply the new file.
5. **A closed month can only be reopened by Gifsy.**
6. **Keep your own copy of every file** — the portal keeps uploaded files only for a limited time.`,
};
