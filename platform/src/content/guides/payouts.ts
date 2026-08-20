import type { Guide } from './index';

/**
 * Payouts operations guide — SINGLE SOURCE of the guide text (rendered on the portal at
 * /admin/guides/payouts and printable from there). Screenshots live in
 * public/guides/payouts/*.png and are refreshable via scripts/capture-payout-screens.mjs.
 * Keep the wording plain — the audience is an entry-level ops employee.
 */
export const payoutsGuide: Guide = {
  slug: 'payouts',
  title: 'Payouts — How It Works',
  summary:
    'How money reaches an outlet: the monthly Credits & Payouts flow, redemption cash-out, and the automatic tax/invoicing layer. Written for someone new to the team.',
  updated: '2026-08-20',
  markdown: `# Payouts — How It Works

*A plain-English guide to how the platform handles payouts. If you are new to the team, read this once top-to-bottom; after that, use it as a lookup. This describes what the platform can do — not any one client's setup.*

## The one thing to remember

**The portal does not send money. The bank sends money.**

The portal helps you *prepare* a payout, gives you a **bank file** to hand to the bank, and then records the **UTR** (the bank's reference number for a completed transfer). Recording the UTR is how the portal knows a payment is done — it is the **"mark as paid"** step. Nothing is paid until a UTR is recorded.

## Before you start: work inside a brand

Payouts always happen **inside a client's (brand's) workspace**. From the operator console, click **"Work in brand"** at the top and pick the client. You'll see an amber banner — *"working in <Brand>"* — which means you're now acting inside that brand. Everything in this guide is done from that brand's admin menu on the left.

## The big picture (30 seconds)

The platform can move money to an outlet in **two ways**:

1. **Monthly Credits & Payouts** — *the main one.* Someone uploads a spreadsheet of amounts, confirms it, generates a bank file, the bank pays, and the UTRs are recorded. Money is *pushed* to outlets; the outlet does nothing.
2. **Redemption cash-out** — an outlet spends its own points and asks for cash. These are batched, the bank pays, and UTRs are recorded.

On top of those, the platform has a **tax & invoicing layer** (TDS, self-billed invoices, GST) that runs **automatically** for a special category of payout called **visibility payouts**. It's explained in its own section below.

## Words you'll see (plain English)

| Word | What it means |
|---|---|
| **Wallet** | An outlet's points balance, like a prepaid account. |
| **Points** | What an outlet earns. Not money yet. |
| **Payout** | Actual cash sent to an outlet's bank account. |
| **Batch** | One upload / one group of payments worked on together. |
| **Entry** | One outlet's line inside a batch. |
| **Bank file** | The Excel file downloaded and given to the bank to make transfers. |
| **UTR** | The bank's reference number for a completed transfer. Recording it = "this one is paid." |
| **KYC** | An outlet's verification. Only **KYC-approved** outlets can be paid. |
| **Paise** | Money is stored in paise. ₹1 = 100 paise. (Screens show rupees; this is just so a large raw number never surprises you.) |
| **Visibility payout** | A payout for a marketing/branding activity (e.g. displaying posters). These carry tax & invoicing — see the tax section. |
| **TDS** | Tax Deducted at Source — a slice of certain payouts that must go to the tax authority instead of the outlet. |
| **Self-billed invoice** | An invoice the platform generates *on the outlet's behalf* for a service payout. |
| **GST** | The tax component on a service invoice, handled separately (held back, then released). |

## Flow A — Monthly Credits & Payouts (the main flow)

> **Status words for this flow:** **Pending → Processing → Paid.** (Or **Failed** / **Reversed** — see below.)
>
> **Menu:** in the brand's admin menu, open **Credits & Payouts**.

### The 5 steps

**Step 1 — Upload the spreadsheet** *(Credits & Payouts → Upload Credits)*
- **The operator does:** Download the template, fill in each outlet and amount, and upload it.
- **The system does:** Creates a **batch** marked **Pending confirm**. Nothing is paid or credited yet — this is just a draft.

![Upload Credits screen](/guides/payouts/upload.png)

**Step 2 — Confirm the batch**
- **The operator does:** Review the batch and click **Confirm**.
- **The system does:** Locks the amounts in. Point rows are added to wallets; cash rows become **payout entries** marked **Pending** (waiting for a bank file). *(If any rows are visibility payouts, the tax & invoicing layer also kicks in here — see that section.)*

You can watch each batch's state on **Payout Status** (Confirmed = credited/paid; Pending = awaiting a bank file / UTR):

![Payout Status screen](/guides/payouts/payout-status.png)

**Step 3 — Generate the bank file** *(Credits & Payouts → Payout Download)*
- **The operator does:** Pick the period and click **Generate & Download**.
- **The system does:** Groups all pending amounts **by outlet** (two rows for the same outlet are added into one line — no double-paying) and flips those entries to **Processing**. Outlets that are **not KYC-approved** (or are inactive) are **held back** and left as **Pending** — they are not lost, they simply wait for a later file.

![Payout Download screen](/guides/payouts/payout-download.png)

**Step 4 — Pay at the bank (offline)**
- **A person does:** Give the downloaded file to whoever makes the bank transfers. The transfers happen at the bank, **outside the portal**.

**Step 5 — Record the UTRs (mark as paid)** *(same Payout Download screen → Upload UTR Results)*
- **The operator does:** Put each transfer's **UTR** into the file, re-upload it, **preview**, then **apply**.
- **The system does:** Flips each entry to **Paid** (with its UTR) or **Failed**. The batch shows as **Paid** (or **Partially paid** if some failed).

✅ **Done** = the entry shows **Paid** with a UTR.

## Flow B — Redemption cash-out (outlet spends points for cash)

> **Status words for this flow:** **Pending → Initiated → Success.** (Or **Failed** / **Reversed**.)
>
> **Menu:** in the brand's admin menu, open **Payout Management**.

![Redemption Payout Management screen](/guides/payouts/redemption-payouts.png)

### The steps

**Step 1 — Outlet redeems** — The outlet (or a sales rep for them) chooses "cash" and confirms with an **OTP**.
- **The system does:** Debits their wallet points, freezes the rupee value, and creates a **payout transaction** marked **Pending**.

**Step 2 — Batch and process** — **The operator does:** Create a batch, add the pending transactions, and **process** it.
- **The system does:** Checks each one has KYC-approved status, a PAN, and bank details. Valid ones become **Initiated**; the rest are excluded until fixed.

**Step 3 — Pay at the bank (offline)** — same as Flow A: the transfers happen at the bank.

**Step 4 — Record the UTRs** — **The operator does:** Upload the UTRs.
- **The system does:** Flips each to **Success** or **Failed**.

✅ **Done** = the transaction shows **Success**.

*(If an outlet redeems for a **gift** instead of cash, there is no bank payout — the rewards team fulfils and ships the gift.)*

### Look up any outlet's balance — Outlet Wallet

Use **Outlet Wallet** to check an outlet's current points and its full history at any time.

![Outlet Wallet screen](/guides/payouts/outlet-wallet.png)

## The tax & invoicing layer (visibility payouts)

Some payouts are for a **service the outlet performed** — typically a **visibility / branding activity** (putting up posters, displays, etc.). By law these carry **tax (TDS)** and need an **invoice**. The platform handles all of this **automatically** — it is not extra manual work — but you should understand what it's doing so the numbers make sense.

This layer runs **only** for payout columns marked as **visibility payouts**. Ordinary incentive payouts skip it.

**What happens, and when:**

1. **At confirm (Step 2 of Flow A):** for each visibility outlet, the system generates a **self-billed service invoice** (an invoice made on the outlet's behalf) and decides the tax treatment.
2. **At bank-file generation (Step 3):** the system applies **TDS** in one of two ways (configured per client):
   - **Deduct** — the tax is *withheld* from the outlet's payout. The outlet receives the amount **minus** TDS; the platform sends the TDS to the tax authority. (The outlet bears the tax.)
   - **Gross-up** — the outlet is paid the **full** amount, and the platform pays the tax **on top**, raising a separate **TDS invoice** and recovering it from the client. (The client bears the tax.)
3. **GST** on a service invoice is **held back** at payout time and **released later**, once the outlet proves it deposited that GST — done on the **GST Reimbursements** screen.
4. **After the UTR is recorded**, the related invoice is **locked** (its number can no longer be changed).

**Two tax sections you may see named:**
- **194C** — for a service (like visibility). The **platform** is the deductor.
- **194R** — for a benefit/incentive. The **client** is the deductor. (Ordinary incentive payouts are stamped 194R but withhold nothing.)

**The tax screens (mostly read-only reports):**

![TDS screen](/guides/payouts/tds.png)

![Self-billed Invoices screen](/guides/payouts/invoices.png)

![GST Reimbursements screen](/guides/payouts/gst-reimbursements.png)

> You rarely touch these screens for a normal payout — the layer runs on its own. The manual actions here (releasing GST, uploading tax deposits, marking an invoice paid) are done by a senior Gifsy admin. If a payout you're working on shows tax/invoice activity and you're unsure, **check with your manager.**

## Money & numbers you'll see

- **Points are not money.** An outlet earns points; a payout turns points/awards into rupees.
- **Points → rupees** uses a **conversion rate**, and the rate is **frozen at the moment of confirm/redeem**. So if the rate changes later, old payouts are **not** re-priced. You don't calculate this — the system does.
- **KYC gate:** points can build up before KYC, but **money only goes to KYC-approved outlets.** Non-approved outlets are held out of the bank file automatically.

## Things that confuse people (please read)

1. **"Paid" vs "Success" mean the same thing** — they're just different words in the two flows. Flow A ends in **Paid**; Flow B ends in **Success**. Both mean "money sent, UTR recorded."
2. **The UTR upload is the paid button.** Generating the bank file does **not** mean it's paid. It's paid only after a UTR is recorded.
3. **Held ≠ lost.** An outlet missing from a bank file is almost always **held for KYC** (not approved yet). It will come out in a later file once approved.
4. **Duplicate outlet rows are added together**, not paid twice.
5. **Failed can be retried; Reversed cannot.**
   - **Failed** = the bank rejected it. It goes back into the pool and can be included in a later bank file.
   - **Reversed** = it was deliberately clawed back (through an approved reversal request). It will **never** be paid again.
6. **Preview before apply.** When uploading UTRs, always preview first — the system flags duplicate UTRs and errors before anything changes.
7. **TDS is automatic.** If a payout is a visibility payout, tax and invoicing happen on their own — you don't hand-calculate them.

## Quick status reference

**Flow A — Credits & Payouts**

| Status | Meaning | What happens next |
|---|---|---|
| Pending | Confirmed, waiting for a bank file | Generate the bank file |
| Processing | Included in a generated bank file | Pay at bank, then record UTR |
| Paid | UTR recorded — money sent | Done |
| Failed | Bank rejected it | Will be re-included in a later file |
| Reversed | Deliberately clawed back | Never re-paid |

**Flow B — Redemption cash-out**

| Status | Meaning | What happens next |
|---|---|---|
| Pending | Created, not yet batched | Add to a batch and process |
| Initiated | Validated, ready to pay | Pay at bank, then record UTR |
| Success | UTR recorded — money sent | Done |
| Failed | Bank rejected it | Re-batch after fixing |
| Reversed | Clawed back | Never re-paid |

## Who can do what

- **Gifsy operator:** upload, confirm, generate bank files, record UTRs, process batches. This is the day-to-day payout work.
- **Senior Gifsy admin:** approves a **reversal** (clawing money back), releases held-back GST, uploads tax deposits, marks invoices paid. Raise the request; they approve.
- **The client's admin:** can upload and confirm credit batches too, and view tax reports.
- **The outlet:** only redeems and views its own wallet/history — it never sees the operator screens.

## If something looks wrong

- An outlet you expected is **missing from the bank file** → check its **KYC status** first (most common reason: not approved yet).
- A payment shows **Failed** → confirm the bank details, then include it in the next bank file.
- You're unsure whether something is **paid** → look for a **UTR** on the entry. No UTR = not paid yet.
- Anything involving **TDS, invoices, or reversals**, or a number that doesn't add up → **ask a senior admin before acting.** Payouts are real money; when in doubt, check first.`,
};
