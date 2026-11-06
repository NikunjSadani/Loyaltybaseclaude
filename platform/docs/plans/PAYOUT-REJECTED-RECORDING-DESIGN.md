# Recording rejected / failed payouts — design & scope

**Status:** ✅ SHIPPED to staging 2026-11-04 (develop `f162a8d`, platform-wide, owner-approved; prod cutover gated). Built with the DEDICATED-COLUMN design (owner chose this over narration-reuse): `CreditPayoutEntry.failureReason` + `attemptedAt` (migration `20261104130000`), capture reason+date+UTR on the FAILED flip, `paidAt` stays null, re-bank clears the fields, admin Payments report gains a "Failure Reason" column + failure-date display + newest-failure-first ordering (non-PAID filter), default/PAID byte-identical. Dup-UTR guard scoped to `status:'PAID'` (audit fix). Full gates + money-path audit (clean) + runtime-verified on deployed staging (2 seeded FAILED rows returned under the FAILED filter with reason/date/UTR, correctly ordered; 0 leaked into the default view). Reason model = reuse FAILED (no enum change); admin-only; NO backfill; raw reason. The §3 decisions below are RESOLVED as just described.
**Trigger:** Bajaj's payout file carries Rejected/Failed/Reversed rows *with bank reasons*; today the portal has no honest place to store them (we import only the `Done`/`PAID` rows). This doc scopes recording them for audit.

---

## 1. Current state (what the model does today)

- **`CreditEntryStatus` = `PENDING · PROCESSING · PAID · FAILED · REVERSED`** (`api/prisma/schema.prisma`). **There is no `REJECTED` value, and no rejection-reason column** (only free-text `narration`).
- `FAILED` / `REVERSED` are written **only as transitions of payouts the portal itself generated and attempted to pay** — `FAILED` in `applyBankResponse` (requires a prior `PROCESSING` + a payout-download), `REVERSED` in the clawback path. There is **no path that ingests an externally-settled rejected/failed payout as history.**
- When a live disbursement fails, we set `status='FAILED'` but **store no bank reason** — the "why" is lost.
- Read surfaces exclude non-success: the **partner statement** shows only `PENDING/PROCESSING/PAID` (FAILED/REVERSED hidden); the **admin payments report** selects `paidAt IS NOT NULL` (so failed/rejected never appear).

**Net:** we neither store nor surface rejected payouts, external *or* live. Two wins if we add it: (a) a complete audit trail for the historical import, and (b) the bank reason captured on *live* failures going forward.

---

## 2. Proposed design

### 2a. Schema (additive, backward-compatible)
1. **Add a rejection/failure reason column** to `CreditPayoutEntry`:
   `failureReason String?` (nullable; holds the bank/vendor reason e.g. "Account Closed", "INVALID_ACCOUNT_FAIL"). Additive-nullable → zero backfill, Deoleo byte-identical.
2. **Decide the status representation** (owner decision — see §3): either
   - **(A) Reuse `FAILED`** for all non-success external rows (simplest — no enum change; "rejected" and "failed" collapse into FAILED + a reason), **or**
   - **(B) Add `REJECTED`** to `CreditEntryStatus` (distinguishes a bank *rejection* from a technical *failure* / a *reversal*). Enum add is additive but touches every status switch/exhaustiveness check.
   Recommendation: **(A) reuse FAILED + reason** unless the business genuinely treats rejected ≠ failed in reporting. It needs no enum migration and the reason column carries the nuance.
3. (Optional) `attemptedAt DateTime?` — when the payout was attempted (distinct from `paidAt`, which stays null for non-success).

### 2b. Live path — capture the reason going forward
In `applyBankResponse` (credits.service.ts), on a failed row set `failureReason = <bank reason>` alongside `status='FAILED'`. One-line change; makes every *future* failed disbursement self-explaining.

### 2c. Ingestion — record historical rejected payouts
Extend the backfill to also write the Rejected/Failed/Reversed rows (currently dropped) as `status='FAILED'` (or `REJECTED`), `failureReason = <file's Reason For Rejection>`, `paidAt=null`, `utr=null`, under the same VENDOR_IMPORT batch. For Bajaj that's the **579** non-Done rows the current import drops.

### 2d. Read surfaces
- **Admin payments report:** add a filter/column for FAILED/REJECTED with the reason (change the `paidAt IS NOT NULL` selector to optionally include non-success). This is the primary audit surface.
- **Partner statement:** decide whether partners see a failed payout at all (§3). Likely show a soft "payout could not be processed — being re-attempted" rather than the raw bank reason, OR keep it admin-only.

---

## 3. Decisions needed from the owner
1. **Status model:** reuse `FAILED` + reason (recommended, no enum change) **or** add a distinct `REJECTED` value?
2. **Partner visibility:** should a retailer see their own failed/rejected payout (and in what wording), or is this admin-audit-only?
3. **Backfill the 579 historical non-Done rows** now (as part of the Bajaj import), or only capture reasons on live failures going forward?
4. **Reason taxonomy:** store the raw bank string, or normalize to a small set (Account Closed / Invalid Account / Blacklisted / Technical / …)? Raw is faster; normalized is better for reporting.

---

## 4. Effort & sequencing (≈ a few focused days)
1. Prisma migration: `CreditPayoutEntry.failureReason String?` (+ `REJECTED` enum value if §3.1 = B). Additive. (`prisma generate` before gating.)
2. `applyBankResponse`: persist the bank reason on FAILED. + a regression test.
3. Admin payments report: include non-success + reason column; filter.
4. (If §3.2 = show) partner statement: surface a safe message for non-success entries.
5. (If §3.3 = yes) extend the VENDOR_IMPORT backfill to ingest the 579 non-Done rows with reasons.
6. Gates + dual audit (money-adjacent) + runtime verify (admin report shows a rejected entry with reason).

**⚠️ PLATFORM-WIDE** (shared CreditPayoutEntry model + read paths → reaches live Deoleo) → owner approval + keep Deoleo byte-identical (the migration is additive-nullable, so it is).

## 5. Out of scope
Re-attempting/re-banking rejected payouts (that already exists for portal-generated FAILED via GLM-2); changing the disbursement flow; any money movement. This is **recording + surfacing** only.
