# Credits upload — negative points become deductions (design note)

> Owner decision 2026-11-25. Branch `feat/upload-negative-deductions` (from prod `main` `d1aeb786`).
> **TENANT-SCOPED**: everything is behind one per-client setting, default OFF. With it OFF (Deoleo) the upload,
> the confirm, the reversals and every report behave exactly as before. Turned ON for Bajaj only.

## 1. What it does

In **Credits & Payouts → Upload**, a **negative POINTS value** (e.g. a target-achievement row of −320 because sales
returns exceeded sales) **deducts** those points from the outlet's wallet instead of being an error.

- **POINTS only.** A negative ₹ **PAYOUT** value stays an error: *"Payout amounts can't be negative — deduct via
  Reversals."*
- **Rounding:** the magnitude is rounded half-up to a whole point (−199.5 → −200, −199.4 → −199); a value whose
  magnitude rounds to 0 (−0.4) is skipped ("nothing to deduct").
- **Safety cap:** the rounded magnitude counts against the existing per-row points cap (`safetyCapPoints`).
- One upload row per (outlet, field), as today (the parser's duplicate check). The server also refuses a batch in
  which the same (outlet, field) has both a credit and a deduction (a line is one or the other — needed for undo).

## 2. The setting

| | |
|---|---|
| Key | `creditUploadNegativeDeductions` (row in `program_settings`, scalar boolean) |
| Default | `false` (absent row, a read error, anything but a strict `true` → OFF) |
| Read on the money path | `TenantSettingsService.getCreditUploadNegativeDeductionsUncached(clientId)` — uncached (like the visibility / GSTIN switches), only when a batch actually carries a negative row, so a Deoleo upload makes no extra read |
| Read by the screen | `EffectiveSettings.creditUploadNegativeDeductions` via `GET /v1/settings` (admins only — omitted for partner / sales, like `creditsPayouts`) |
| Write | the generic Gifsy-admin settings PUT; coerced to a strict boolean (only `true` / `"true"` turns it on) |

Turning it on for Bajaj (Gifsy admin, assumed into the Bajaj tenant):
`PUT /v1/admin/settings` body `{"key":"creditUploadNegativeDeductions","value":true,"category":"creditsPayouts"}`.
No UI toggle (deliberately — a Gifsy money switch, set once).

## 3. The ledger path reused (no parallel ledger)

A deduction is **one wallet movement through the single write path** `WalletService.applyMovement` → `applyMovementV2`
(row lock first, the WP0 oracle computes the transition, one guarded wallet `UPDATE` advancing `movementSeq`, a
`PointsLedger` row, a `WalletTransaction` row with `seq` / `pointsDelta` / `pointsLedgerId`, FIFO lot consumption).

- **Transition:** the WP0 oracle's existing debt-creating debit `legacyDebtDebit(d)` (design §3.2 "Legacy
  debt-creating debit"): `B −= d; D += max(0, d − H); lots consume min(d, H) FIFO`. This is the only WP0 debit that may
  take a balance below zero, and it keeps every engine invariant (I1 `D ≥ 0`, I2 `H = B + D ≥ 0`). The owner rule
  "negative wallets repay from future earnings" then holds automatically: the next credit repays `D` first (§3.2
  Credit, Q12). It is opted into by a new movement flag `allowDebt` used **only** by upload deductions — every other
  debit keeps its guarded (redemption, admin debit) or floored behaviour.
- **Row written:** `WalletTransaction` `DEBIT_ADJUSTMENT`, `points = pointsDelta = −d`, `referenceType 'CREDIT_BATCH'`,
  `referenceId = batch id`, metadata `{ kind: 'UPLOAD_DEDUCTION', fieldId, fieldName, outletCode, rowNum, period }`;
  `PointsLedger` `ADJUST`, `points −d`, `sourceType 'CREDIT_FIELD'`, `sourceId = fieldId`, remaining 0.
- **Passbook line:** "320 points deducted — Target Achievement, 2026-10" (+ " · <narration>" when the row has one);
  dated at confirm like the credits. The field name also resolves through `resolveCreditFieldNames` (it matches the
  batch row by signed amount).
- **Why not `/wallet/adjust`:** the manual debit is *guarded* (refuses when the wallet holds less), so it cannot
  express "negative wallets repay from future earnings"; the reversal engine's `applyCreditReversal` needs a credit
  position to reverse. The deduction uses the same primitive both of them use (`applyMovement` / the WP0 model).

### Unsequenced wallets (the `WALLET_NOT_SEQUENCED` gate)

A wallet with points history the wallet backfill has not sequenced writes through the pre-engine path, which floors
debits at 0 — a deduction there would silently deduct less than the row says. So, exactly like a POINTS reversal:
- the **preview** marks such an outlet ("wallet not prepared for deductions — Gifsy must run the wallet backfill");
- the **confirm** refuses the WHOLE batch (409 `WALLET_NOT_SEQUENCED` / `WALLET_NEEDS_ATTENTION`, outlets named,
  nothing credited or deducted, batch stays `PENDING_CONFIRM`) — checked read-only before the transaction and again
  under the wallet lock inside the movement (`allowDebt` never takes the legacy path);
- the refusal is audited (`REVERSAL_ENGINE_REFUSAL`, phase `CONFIRM_DEDUCTION`) so the attention banner lists it.
A brand-new (pristine) wallet is fine: its first movement is seq 1.

## 4. Confirm — atomic with the credits

`confirmBatch` keeps its ONE all-or-nothing transaction (timeout 180 s):
1. guarded `PENDING_CONFIRM → CONFIRMED` claim (a retry / double click can never deduct twice — the claim is in the
   same transaction, so a failed confirm rolls back whole and is retried safely);
2. PAYOUT entries (unchanged);
3. B9 wallet pre-lock in ascending id + sorted wallet creation — now over the credit **and** deduction outlets;
4. every credit row (CSV order, unchanged), **then** every deduction row (CSV order). Credits first keeps the passbook
   readable and makes the preview's "balance after" the true end state; the final balance and debt are the same in
   either order (the WP0 algebra).
The held-opening-balance pre-check covers deduction outlets too. An outlet that can't be resolved / isn't linked to a
partner is skipped WITH its reason exactly like a credit ("NOT deducted" on the done screen and in the report).

Response (only when the batch has deduction rows — a Deoleo response is unchanged): `pointsDeducted` (rows),
`pointsDeductedTotal`, `deductions[] { outletId, fieldName, points, balanceBefore, balanceAfter }`, skipped
deductions carry `kind: 'DEDUCTION'`.

`CreditBatch.totalPoints` stays the **credited** total (positive rows only; the DTO's `@Min(0)` is kept). The deducted
total is derived from the rows wherever it is shown.

## 5. Preview / confirm screen

- Summary cards: OK rows (credits + deductions, with the split), Skipped, Errors, **Total credited**, **Total
  deducted** (the last only when there are deductions).
- **"Will be deducted"** panel: row, outlet, field, typed value → rounded deduction.
- **Below-zero call-out** (no silent pass-through): `POST /v1/admin/credits/deduction-preview { outletCodes }` returns
  each deduction outlet's current balance and readiness; the panel lists every outlet whose balance would go below zero
  as "balance will go below zero: <current> → <after>" (after = current + this file's credits − its deductions), and
  every outlet whose wallet is not prepared (confirm will be refused) or not linked to a partner (will be skipped).
- Done screen: "N outlets credited · X pts · M deductions · Y pts deducted", plus "NOT deducted" rows.

## 6. Undo (reversal) semantics

Batch reversal is **per row** (maker-checker: the client requests on Payout Status, Gifsy approves). A deduction row
gets the same per-row request, labelled **Undo deduction**:
- **Create** (`POST /batches/:id/reversals`, `awardType POINTS`): the line is recognised as a deduction line by its
  wallet rows (`DEBIT_ADJUSTMENT`, `CREDIT_BATCH`, `kind UPLOAD_DEDUCTION`). Cap = Σ deducted − Σ already given back −
  Σ pending requests (never more than was deducted). Batch row lock, one pending request per line (the existing partial
  unique index), the one-engine marker audit row, the maintenance pause — all as for a credit reversal.
- **Approve** (Gifsy): batch lock → reversal lock → guarded flip → for each deduction row of the line (normally one)
  the SAME wallet that was charged gets the points back as a credit movement through `applyMovement`
  (`CREDIT_REVERSAL` / ledger `REVERSE` — not new earning, so `earnedPoints` / `lifetimeEarned` are untouched; a
  spendable lot with the tenant's normal expiry, like a refund), `referenceType 'CREDIT_REVERSAL'`, `creditReversalId`,
  and `reversedCreditTxId` = the deduction row (so "already given back" is exact per row). The credit repays the debt
  the deduction created first (WP0 credit transition), so undoing a deduction fully restores B and D.
  Passbook: "320 points given back — deduction undone (Target Achievement, 2026-10)".
- Partial undo (approve less than requested) works like a partial reversal. Reject moves nothing.
- Outcome text: "Approved · 320 pts given back to the wallet — deduction undone".
- No credit position is involved, so a deduction line never interacts with the position engine's caps.

## 7. Notifications

Today a credit sends "points credited" (bell + push + the tenant's configured SMS / WhatsApp). A deduction sends the
**free channels only** (bell + push) after commit: "Points deducted — 320 points were deducted from your wallet
(Target Achievement, October 2026). Balance now −220 points." No SMS / WhatsApp: there is no approved template and
adding a notification event is a platform-wide change (open question for the owner). Failure never affects the batch.

## 8. Reports and other consumers (all traced)

| Consumer | Behaviour with deductions |
|---|---|
| Upload report (xlsx) | rows carry the signed amount; Status "OK"; type column "Deduction" |
| Payout Status rows + report | negative rows shown as "Deduction −320", "Undo deduction" instead of "Reverse"; expanded batch shows credited / deducted totals |
| Points Ledger report | balance exact (signed sum); a deduction counts in *burn* like every other negative ADJUST (manual debits, reversal clawbacks) |
| Program Health "Issued", Finance "issued" / breakage | EARN only → stays the **gross** points issued; liability (positive balances) is exact |
| Daily ops digest `batchPoints` | `CreditBatch.totalPoints` = credited total (unchanged meaning) |
| Team "batch confirmed" email | adds `totalPointsDeducted` only when > 0 |
| Wallets in debt (reversal-engine screen) | a below-zero stretch caused by an upload deduction is explained ("Upload deduction · field · period · −320"), never "from imported history" |
| Fund / TDS / 194R | read only payout entries, redemptions and off-platform entries — **no TDS event** from a points deduction (verified: no TDS path reads wallet credits or POINTS rows) |
| Wallet backfill / verify | only touches un-sequenced wallets; a deduction is only ever written on a sequenced wallet |
| Position-engine gates (`assertReceivingWalletsSequenced`, `explainNoPosition`) | filter `CREDIT_POINTS_EARNED` → never mistake a deduction for a credit |

## 9. Edge cases

- Wallet goes below zero → allowed (owner rule), shown in the preview, the outlet can't redeem until it is ≥ 0, debt is
  repaid from future earnings.
- Outlet with a credit in one field and a deduction in another (same file): both apply; credits first.
- Outlet not found / not linked → skipped with the reason, listed "NOT deducted".
- Wallet not sequenced / blocked → whole confirm refused, named, audited.
- Held opening balance not yet posted for a deduction outlet → whole confirm refused (existing rule).
- Retry / double confirm → guarded claim; no double deduction.
- Setting turned OFF while a batch with deductions is pending → (OFF path is unchanged, see §10).
- A credit reversed in a later batch after a deduction: the credit's reversal cap is its own credit position; a later
  deduction does not reduce it (cross-batch, operator judgement — open question).

## 10. OFF path (Deoleo) — unchanged, and the latent gaps found

With the setting OFF nothing new runs: the parser errors "Amount cannot be negative", the server makes no extra read.
Found while tracing (pre-existing, every tenant, **not changed** because a fix is platform-wide and needs the owner's
approval): a hand-crafted API batch can (a) carry a negative POINTS row, which confirm silently ignores, and (b) carry a
negative PAYOUT row, which confirm turns into a negative payout entry. The UI never sends either.
