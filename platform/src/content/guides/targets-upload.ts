import type { Guide } from './index';

/**
 * Targets upload guide — SINGLE SOURCE of the guide text (rendered at /admin/guides/targets-upload, printable).
 * Audience: Gifsy ops and the client admin team — keep it plain. Every label quoted here is copied from
 * platform/src/app/admin/targets/upload/page.tsx and components/admin/target-upload-history.tsx; change the guide in the
 * same commit as any label it quotes.
 */
export const targetsUploadGuide: Guide = {
  slug: 'targets-upload',
  title: 'Targets Upload — Preview, Confirm & History',
  summary:
    'Download the targets template, upload the filled file, read the preview (new vs overwritten targets, rejected rows), confirm what will not be applied, apply, and find past uploads and their files.',
  updated: '2026-11-25',
  markdown: `# Targets Upload — Preview, Confirm & History

*Labels in **bold** are exactly what you see on the **Targets** upload page.*

## In one paragraph

You download the template, fill in the targets and pick the file. The portal **checks the file and shows a preview — nothing is saved at this step** (since 25 Nov 2026 this is the only way to upload targets, for every program). The preview tells you how many outlet-month targets will be saved, how many of them **replace targets that already exist**, and which rows will not be saved and why. You tick one **"I understand…"** box for each thing that will not be applied as typed, then press **Confirm & apply** within 30 minutes. Only then are the targets saved — **the whole file together, or nothing at all**. Every applied upload is listed in **Upload history**, with its file.

## Step 1 — Download the template

1. Choose the months (**From** / **To**, or a **Quick select** chip) and press **Download Template**.
2. The file lists every outlet with one column per enabled KPI per month. Leave a cell **blank** for "no target" (blank is not saved as 0).

## Step 2 — Pick the filled file (preview)

1. Drop the file on the box or click **browse**. The page shows **"Checking the file… nothing is saved at this step."**
2. The **Preview — nothing has been saved yet** panel opens:
   - **"If you confirm, N outlet-month targets will be saved (X new, Y replacing existing targets)."**
   - **"N outlet-months will be overwritten"** (amber) — these outlets already have targets for that month. Confirming **replaces** their stored values with the file's values; a KPI left blank in the file is **removed** for that outlet-month. The panel shows the split per month and a few examples (*Month Target 10 → 12; Focus Pack 5 → removed*).
   - The **Total rows / Accepted / Rejected / Blank / Months** cards, the **Rejected rows** list with the reason for each row (download it with the error-report button), and any past months that **will be skipped (locked)**.
3. Picking a file never changes anything. To start over, press **Cancel** or pick another file.

## Step 3 — Confirm what will not be applied

For each kind of problem in the file, a box must be ticked before **Confirm & apply** is enabled. Only the kinds present in your file appear, each with a few examples of the rows or outlets it covers. A tick counts for exactly the number and the items shown — if they change before you confirm, nothing is saved and the boxes are shown again with the new numbers:

| Box | Meaning |
|---|---|
| **I understand N rejected rows will not be saved** | Unknown or removed outlet codes, or bad KPI values. Fix them and upload those rows again later. |
| **I understand N existing outlet-month targets will be replaced** | Those outlets' targets for that month are overwritten. |
| **I understand N outlet-month targets in past (locked) months will not be saved** | Targets for a month already in the past cannot be changed. |
| **I understand N blank rows will not be saved** | Rows with no values at all (normal for outlets without a target). |
| **I understand N values for KPIs that don't apply to the outlet will be ignored** | The KPI does not apply to that outlet type / programme. |

The preview also says until when it can be confirmed (**This preview can be confirmed until …**). Until every box is ticked the page says **"Tick the remaining box above to enable Confirm & apply."** If nothing in the file can be saved, the button stays disabled and the reason is shown (for example **"Nothing to apply — every month in this file is in the past, and past months are locked."**).

## Step 4 — Confirm & apply

1. Press **Confirm & apply** once (the button shows **Applying…**; a second click does nothing). Keep the page open.
2. The portal saves exactly the file you previewed. It checks the file again against today's outlets and targets:
   - If what will not be applied changed since the preview (for example another upload added targets for the same outlets, so more targets would be replaced), **nothing is saved**: the page checks the same file again, shows the new numbers with the boxes unticked, and you confirm again.
   - If the preview is older than 30 minutes, **nothing is saved** and the file is checked again the same way.
3. The green **Targets submitted successfully** box shows how many outlet-month targets were saved (new and overwritten), and **Not applied as typed** lists what was not saved. Check the stored targets anytime with **Download Final Targets**.

**Messages you may see on Confirm:**

- **"This preview was already applied on … — it was not applied again."** The first press really did save it (for example after a network drop). Check with **Download Final Targets** or in **Upload history**. To upload the same file again, pick it again for a new preview.
- **"Saving the targets failed, so NOTHING from this file was saved…"** Nothing changed. Press **Confirm & apply** again to retry; if it keeps failing, contact Gifsy support with the reference shown.
- **"The file could not be stored, so nothing was saved…"** Nothing changed. Press **Confirm & apply** again.
- **"This file is not the one you previewed…"** Pick the file again.
- **"Couldn't reach the server (network error). Some or all of it may have been saved…"** Press **Confirm & apply** again: if the first attempt went through you will see "already applied" (it is never applied twice); otherwise it is saved now.
- **"The targets were saved, but the sales team could not be notified about them."** The targets are saved; tell the sales team yourself.

## Upload history

At the bottom of the page, **Upload history** lists uploads newest first (times in IST), 100 at a time — it says **Showing the newest 100 uploads** and **Load older uploads** shows the next 100: **When (IST)**, **Who**, **Month(s)**, **Accepted**, **Rejected**, **Overwritten** and **File**.

- **Download file** gets the exact file that was applied.
- **File not kept** — uploads made before the preview step was introduced (25 Nov 2026) did not keep their file.
- **Failed — nothing saved** — that attempt changed nothing (a save is all or nothing). Upload the file again if it was not retried.
- **Did not finish — nothing saved** — the save was interrupted; nothing from it was saved.
- **Being saved…** — the upload is being saved right now; refresh in a minute.
- **Failed part-way (older upload) — may be partly saved** — only uploads from before 25 Nov 2026, when large files were saved in parts. Check with **Download Final Targets**.
`,
};
