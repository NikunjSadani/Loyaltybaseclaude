# Milestone C · Payout & invoice correctness

Protects money flows. Follow Milestone B's TDD shape (pure function + test → wire → verify).

## Task C1 — Enforce "Visibility never clubs" (Gap #7)

**Context (spec §00 financial relationships, §02 WF2/WF3):** payout parameters share one bank
transfer + **one UTR**, *except* any `CreditField` with `isSeparatePayout = true` (Visibility),
which must be paid — and downloaded — **on its own**. If the bank-download grouping doesn't honor
this, Visibility gets clubbed and the invoicing/tax model breaks.

**Steps**
1. **Read first:** the download-generation handler
   [`src/app/api/admin/credits/payout-downloads/route.ts`](../../src/app/api/admin/credits/payout-downloads/route.ts)
   and note exactly how it currently groups `CreditPayoutEntry` rows (by `groupType`/`fieldId`?)
   and the `CreditField.isSeparatePayout` flag. Get the real field names from the code/schema —
   don't assume.
2. **Extract the decision into a pure function** `groupEntriesForDownload(entries, fields)` in a
   new `src/lib/credits-download.ts`, returning an array of groups where **each `isSeparatePayout`
   field is its own group** and all clubbable fields combine per outlet/bank as the code does today.
3. **RED:** unit-test it in `src/lib/__tests__/credits-download.test.ts`:
   - two clubbable fields for one outlet → **one** group (one UTR).
   - a Visibility (`isSeparatePayout`) field → **its own** group, never merged.
   - mixed batch → clubbable grouped together, separate ones isolated.
4. **GREEN:** implement the function; then make the route call it instead of its inline grouping.
5. **Verify** manually: generate a download for a batch containing Visibility + Monthly-Target;
   confirm Visibility is a separate download/group.

**Commit(s):** `feat(credits): group payout downloads, keep isSeparatePayout on own UTR (#7)`
**DoD:** pure grouping fully unit-tested incl. the Visibility-isolation case; route uses it.

## Task C2 — Validate the partner-edited invoice number (Gap #8)

**Context:** outlets can edit `AutoInvoice.invoiceNumber` via
[`src/app/api/partner/invoices/[id]/route.ts`](../../src/app/api/partner/invoices/[id]/route.ts)
(PATCH). Today an empty/duplicate/garbage number could be saved, and it can be edited even after
finalisation.

**Steps**
1. **Pure validator** `validateInvoiceNumber(value)` in `src/lib/invoice.ts` (reuse the file if it
   exists — `grep`): non-empty, trimmed, max length, allowed charset (decide format with owner;
   start permissive). Return `{ ok: true } | { ok: false, error }`.
2. **RED:** unit-test it — valid, empty, whitespace-only, too-long.
3. **GREEN:** implement; call it in the PATCH route; return `err(...)` on failure.
4. **Uniqueness + lock** (DB-aware, so test with a fake-tx or wiring test per `01-how-we-test.md`):
   reject if another `AutoInvoice` for the same `clientId` already uses the number; reject edits
   once the invoice is finalised/sent (`emailSentAt` set, or a status field — check the model).
5. Update gap-register #8.

**Commit(s):** `feat(invoices): validate + lock partner-edited invoice number (#8)`
**DoD:** validator unit-tested; route rejects empty/dupe/locked; manual PATCH check.

## Task C3 — Money-unit safety at the Credits↔Payouts seam (Gap #19)

**Context:** Payouts use **integer paise** (`amountPaise`); Credits use **`Decimal` INR**
(`amountInr`). Anywhere these meet, a silent ×100 error can happen.

**Steps (YAGNI — only build what's used)**
1. `grep` for places that read one money type and write the other. If there are **none**, there's
   nothing to convert — just add `toPaise(rupees)` / `toRupee(paise)` helpers in `src/lib/utils.ts`
   *only if a conversion site exists*, with unit tests (e.g. `toPaise(12.34) === 1234`, rounding
   rules), and use them at that site. If there are no conversion sites, **don't add helpers** —
   instead add a short note to `spec/03-data-model.md` documenting the convention so future code
   stays consistent.
2. RED/GREEN as usual if you write the helpers.

**Commit:** `feat(utils): paise⇄rupee helpers at the credits/payouts boundary (#19)` *(only if needed)*
**DoD:** either tested helpers used at a real seam, or a documented convention — not speculative code.
