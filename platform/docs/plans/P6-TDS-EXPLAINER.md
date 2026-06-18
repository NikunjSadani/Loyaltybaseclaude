# P6 — TDS structure explainer (for owner review BEFORE any TDS build)

> **Status: explainer for review — NO TDS code is being written.** P6 task 6.5 (Payouts + TDS)
> stays **ON HOLD** until you've read this and confirmed the design + the rates/sections with your
> tax advisor (CA). I'm not a tax advisor — the rates/thresholds below are how the system is
> currently coded + the standard Indian sections they map to; **treat them as "to be confirmed by
> your CA," not as tax advice.**

---

## 1. The one idea to hold onto

**TDS = "tax deducted at source."** When you (or Gifsy on your behalf) pay money to a shopkeeper,
a slice is **withheld and deposited with the government** against that shopkeeper's tax, and the
shopkeeper gets the **rest** plus a **certificate** they can use when filing their own taxes.

So every payout has three numbers:
- **Gross** — what was earned/billed.
- **TDS** — the slice withheld and paid to the government.
- **Net** — what actually reaches the shopkeeper's bank (Gross − TDS).

The shopkeeper always **sees the gross** (on their incentive/invoice); the TDS is handled in the
background for compliance.

---

## 2. Why there are TWO different TDS rules in this platform

This is the crux of gap #25, and the reason TDS can't be one flat rate. **The two money rails are
two different *kinds* of payment in the eyes of tax law**, so they fall under **different sections**:

| Rail | What it legally is | TDS section | Typical rate | Where it lives today |
|---|---|---|---|---|
| **Incentive / cash award** (the brand rewards a shopkeeper for hitting a target) | A **benefit / perquisite** arising from business | **194R** | **10%** | `api/src/payouts/payouts.service.ts` — flat 10% over a ₹20,000 threshold |
| **Visibility service** (the shop runs your display/branding and *invoices you* for the service) | A **service rendered** (advertising/marketing) — a contractor/professional payment | **194C / 194J** | **1%** individual/HUF · **2%** others · **20%** if no PAN | `platform/src/lib/invoice.ts` `computeTDS` |

**The plain-English difference:** an *incentive* is a reward you give (a perk) → **194R**. A *visibility
service* is something the shop **sells you** and bills for → **194C/194J**. Same shopkeeper, two
different tax treatments depending on *why* the money moves.

> The current code already computes **both** — but it does **not record which section** each
> deduction belongs to. That single missing label is gap #25. The build (when unblocked) is mostly
> about **tagging each TDS record with its section + applying the right rate/threshold**, not
> inventing new math.

---

## 3. The pieces, in plain English

**a) Who bears the deduction?**
The shopkeeper bears it (it's *their* tax) — but **the payer withholds and deposits it**. So the
shopkeeper receives **net**, and the withheld amount is paid to the government on their behalf. They
later claim it as credit when they file their return. **Open question for you:** is the legal
"deductor" **Gifsy** or **the brand**? That determines whose TAN is used, whose books the TDS sits
in, and who issues the certificates. *(This is a decision for you + your CA — it changes how we model
it.)*

**b) PAN matters.**
No PAN on file → the rate jumps (commonly **20%**, under §206AA). So KYC's PAN capture (already built
in P3) feeds directly into the TDS rate. A missing PAN = a much bigger withholding.

**c) Thresholds are ANNUAL and PER-RECIPIENT.**
TDS usually only kicks in once a recipient crosses a yearly limit:
- **194R:** ~₹20,000 per recipient per financial year.
- **194C:** ~₹30,000 per single payment, or ~₹1,00,000 aggregate per year.
- **194J:** ~₹30,000 per year.

This means the platform has to **track running yearly totals per shopkeeper per section** to know
when to start deducting — not just look at one payout in isolation. *(Today's code checks a single
payment against a flat threshold; proper threshold tracking is part of the build.)*

**d) The paper trail.**
Compliance needs: a **TDS certificate (Form 16A)** to the shopkeeper each quarter, and the data for
the **quarterly TDS return (Form 26Q)** to the government. The `TdsRecord` table already has slots for
`assessmentYear`, `quarterPeriod`, `formType`, `certificateNumber`, `certificateUrl` — so the schema
anticipates this; it's just not populated/sectioned yet.

---

## 4. What the platform would do (the proposed build — for your sign-off)

When you unblock 6.5, the TDS work would be:
1. **Tag every TDS by section** — 194R for incentive payouts, 194C/194J for visibility-service
   invoices — driven by *which rail* the payment is on (not a manual choice).
2. **Apply the right rate** per section + entity type + PAN-present (reuse the rates already in
   `lib/invoice.ts` / `payouts.service.ts`, confirmed by your CA).
3. **Track annual per-recipient-per-section aggregates** so thresholds trigger correctly.
4. **Record + report**: populate `TdsRecord` with section/year/quarter; produce Form-16A certificate
   data + 26Q return data; show gross to the shopkeeper, net to the bank.
5. **No tax *advice* in the product** — the platform computes/withholds/reports per the rules you
   confirm; it doesn't advise shopkeepers.

---

## 5. What I need from you before building

1. **Confirm the two sections + rates/thresholds with your CA** — especially: is incentive really
   194R @ 10%, and is visibility 194C (contract) or 194J (professional)? The rate table above is the
   code's current assumption.
2. **Who is the legal deductor — Gifsy or the brand?** (TAN / whose books / who issues certificates.)
3. **Threshold period + reset** — financial year (Apr–Mar), per recipient, per section: confirm.
4. **Certificate + return issuance** — does the platform generate Form 16A / 26Q data, or does that
   happen in your external accounting? (Mirrors the "Gifsy→Client billing is off-platform" call.)

Once you confirm these, 6.5 (redemption-payout settlement bridge + sectioned TDS) can start. Until
then it stays on hold.
