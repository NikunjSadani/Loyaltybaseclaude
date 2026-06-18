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

**d) The paper trail — and who actually produces it (important clarification).**
Two documents matter, and **neither official one is "generated" by this platform**:
- **Form 26Q** = the **quarterly TDS return** the *deductor* files with the Income-Tax Department.
  The platform can **prepare the data** (deductee PAN, section, amount, TDS, challan refs); the actual
  **filing** goes through the government e-filing/TIN system (a return-prep utility → FVU file, or a
  TDS-filing service).
- **Form 16A** = the TDS **certificate** for the shopkeeper. It **must be downloaded from the
  government TRACES portal** (traces.gov.in) by the deductor **after** the 26Q is filed + processed —
  it has a unique TRACES number and is verifiable. **A private portal cannot mint a valid 16A.**
- **API?** The government doesn't expose a broad public "generate certificate" API. **Third-party
  TDS-compliance providers** (Clear/ClearTDS, KDK, TDSMAN, etc.) offer APIs to file 26Q + pull
  certificates — so automation is possible **via a third party**, later, if wanted.

So the platform's realistic job = **compute + track + EXPORT** the 26Q dataset and show the shopkeeper
an **internal** gross/TDS/net statement (informational, *not* the official certificate). The official
16A + the filing stay **off-platform** (TRACES + e-filing, or your accounting / a TDS service) — the
same "off-platform" call you already made for Gifsy→Client billing. The `TdsRecord` table already has
slots for `assessmentYear`, `quarterPeriod`, `formType`, `certificateNumber`, `certificateUrl` — those
hold the **section/period + a reference to the TRACES certificate once it's downloaded externally**, not
a platform-minted certificate.

---

## 4. What the platform would do (the proposed build — for your sign-off)

When you unblock 6.5, the TDS work would be:
1. **Tag every TDS by section** — 194R for incentive payouts, 194C/194J for visibility-service
   invoices — driven by *which rail* the payment is on (not a manual choice).
2. **Apply the right rate** per section + entity type + PAN-present (reuse the rates already in
   `lib/invoice.ts` / `payouts.service.ts`, confirmed by your CA).
3. **Track annual per-recipient-per-section aggregates** so thresholds trigger correctly.
4. **Record + EXPORT** (not generate certificates): populate `TdsRecord` with section/year/quarter;
   **export the 26Q dataset** + an **internal** gross/TDS/net statement for the shopkeeper. The official
   **Form 16A is downloaded from TRACES** and the **26Q is filed** off-platform (or via a future
   third-party TDS-filing API) — the platform stores a *reference* to the TRACES certificate, it does
   not mint one.
5. **No tax *advice* in the product** — the platform computes/withholds/reports per the rules you
   confirm; it doesn't advise shopkeepers.

---

## 5. What I need from you before building

1. **Confirm the two sections + rates/thresholds with your CA** — especially: is incentive really
   194R @ 10%, and is visibility 194C (contract) or 194J (professional)? The rate table above is the
   code's current assumption.
2. **Who is the legal deductor — Gifsy or the brand?** (TAN / whose books / who issues certificates.)
3. **Threshold period + reset** — financial year (Apr–Mar), per recipient, per section: confirm.
4. **Filing model (reframed — see §3d):** confirm the platform's role = **compute + track + export**
   the 26Q dataset + an internal statement only — the **official Form 16A (from TRACES) and the 26Q
   filing stay off-platform** (your accounting / a TDS service). Then decide **whether/when** you want a
   **third-party TDS-filing API integration** for automation, or keep it manual/external for now.

Once you confirm these, 6.5 (redemption-payout settlement bridge + sectioned TDS) can start. Until
then it stays on hold.
