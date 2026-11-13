# Wallet Reversal Engine — Long-Term Design (POINTS + PAYOUT reversals)

**Status:** ✅ APPROVED by owner 2026-11-13 — all 14 recommended choices (Q1–Q14 = A), platform-wide approved in-session. BUILDING. **⚠️ PLATFORM-WIDE** (shared `WalletService.applyMovement`,
`wallets` / `wallet_transactions` / `points_ledger` schema, credit-reversal approval) → reaches every tenant incl. LIVE
Deoleo. Build starts ONLY on the owner's explicit YES.
**Why:** owner 2026-11-13 — "real money related points; I need the correct long-term solution so the engine does not
cause issues in future". Supersedes the reversal-floor patches 234275de → 008934e1 → 8d1bbc82 → 3766dd2a.
**Related:** POINTS-EXPIRY-FIFO-DESIGN.md (lots / remainingPoints), BAJAJ-PROD-OUTLET-IMPORT.md §9b (8 negative wallets).

## 0. Why the patches kept failing
Every patch derived "how far may this reversal push the wallet" from snapshots — `balanceBefore` of the reversed
credit, `createdAt` ordering, a scan of earlier clawbacks. Structurally broken:
1. `balanceBefore` is stale under concurrency (read before the atomic increment).
2. A snapshot doesn't say where a credit's points are NOW (after other credits/reversals changed the debt).
3. `createdAt` is tx-start time (DB default) or clock-skewed app time — no per-wallet total order.
4. Counterfactual replay is the wrong target (contradicts R2 parity on positive wallets, §1.4).
HEAD 3766dd2a still fails case (d): reverse E then X → −700; X then E → −1000.
The fix: a minimal piece of state maintained incrementally under the wallet lock; a reversal is then a closed-form O(1)
decision with no history scan.

## 1. Formal model
### 1.1 State (per wallet)
| Symbol | Meaning | Stored as |
|---|---|---|
| `B` | balance (may be < 0) | `wallets.redeemablePoints` (unchanged) |
| `D` | outstanding debt not offset by any credit, `D ≥ 0` | NEW `wallets.debtPoints` |
| `H` | holdings = `B + D ≥ 0` | derived |
| `O_X` | how much of credit X currently pays off debt, `0 ≤ O_X ≤ a_X` | NEW `wallet_credit_positions.offsetPoints` |
| `a_X` | amount of credit X | position.amount |
| `ρ_X` | total reversal approved against X | position.reversedPoints |

Invariants: I1 `D ≥ 0`; I2 `H ≥ 0`; I3 `0 ≤ O_X ≤ a_X`; I4 `ρ_X ≤ a_X`; I5 a wallet never < 0 (Deoleo) has `D = 0`, all `O_X = 0`.

### 1.2 Transitions (applied in per-wallet `seq` order)
| Movement | Effect |
|---|---|
| Credit `a > 0` | `o = min(a, D)`; `D −= o`; `B += a`; reversible X: `O_X = o`; lot remaining `a − o` (a credit repays debt first) |
| Spend `s` (redemption, admin debit — guarded `B ≥ s`) | `B −= s`; FIFO lots (as today); spent points are history (R4) |
| Expiry of lot remaining `h` | `e = min(h, max(0, B))` (today's clamp); `B −= e`; `D −= (h − e)`, owner `O += (h − e)` |
| Legacy debt-creating debit `d` (vendor import only) | `B −= d`; `D += max(0, d − H)` |
| Reversal of X by `r ≤ a_X − ρ_X` | `p = min(r, O_X)`; `c = min(r − p, H)`; `B −= p + c`; `D += p`; `O_X −= p`; `ρ_X += r`; shortfall `r − p − c` |

### 1.3 The ONE rule
> A reversal removes the credited points from wherever they still are — the debt they paid off (which comes back) and
> the points the wallet still holds — and nothing else. Points that were spent are shortfall.

Floor = `−(D + O_X)`.
- R1 falls out: −841, X +500 → D 341, O_X 500, B −341; reverse → −841.
- R2 falls out: never-negative wallet → D = 0, O_X = 0 → decrement `min(r, B)` = byte-identical to today (Deoleo).
- R4: spends/expiries never reversed. R5: cap `r ≤ a_X − ρ_X`; wallet = the one that received X; allocation unique per (reversal, credit).
- **R2 refinement (forced by R1 + R3):** "never below 0" becomes "never below the wallet's restored debt" — only on
  wallets that had debt; Deoleo can never reach it (I5). Example T-R2*. → Q1.
- Credits repay debt first (Q12) — otherwise latent debt lets a later reversal push a positive wallet negative.

### 1.4 Why not counterfactual replay
Case (a) `0, f1 +500, redeem 500, f2 +300`: replay without f1 makes the redemption unaffordable → either undo it (violates
R4) or clamp it (final 300 vs today's 0). So the outcome is "remove X's units from where they are now"; `(D, O_X)` is
exactly the information a replay needs, kept live.

### 1.5 Theorem (R3 order independence)
Each reversal draws first from a private pool `O_{X_i}` (only reversals of X_i touch it), then the common pool H. Total
private draw per credit = `min(Σr, O_X)` in any order; greedy draws from one pool total `min(Σresidual, H)` in any order.
⇒ final B, D, O and Σ shortfall are order-free. ∎ (Split of shortfall between reversals depends on order only when H
binds; per-wallet totals don't — Q2.)

## 2. Data model (additive; zero balance change)
- `Wallet`: `debtPoints Int @default(0)`, `movementSeq Int @default(0)`.
- `WalletTransaction`: `seq Int?` (unique per wallet; NOT NULL after backfill), `pointsDelta Int?` (actual balance
  change), `reversedCreditTxId String?`, `creditReversalId String?`, `pointsLedgerId String? @unique`.
- NEW `WalletCreditPosition` (one per reversible credit-batch POINTS credit): walletId, creditTxId @unique, lotId, batchId,
  outletCode, fieldId, amount, offsetPoints, reversedPoints, attribution (EXACT | LEGACY_REPLAY | MANUAL | UNRESOLVED).
- NEW `CreditReversalAllocation` (reversal × position): requested, debtRestored (p), recovered (c), shortfall; unique.
- NEW `PayoutReversalAllocation` (reversal × payout entry): amountPaise, state RESERVED | APPLIED_CANCELLED |
  APPLIED_RECEIVABLE | RELEASED, tdsOffsetPaise; partial unique index on live states ⇒ an entry is never consumed twice.
- SQL CHECKs: position bounds; `debtPoints ≥ 0`; `redeemablePoints + debtPoints ≥ 0` (NOT VALID → VALIDATE after backfill).
- Runtime `applyMovement` v2: lock wallet FOR UPDATE first, then read B/D/seq; compute transition; single UPDATE
  RETURNING; insert WT with seq/pointsDelta/exact balanceBefore; ledger row + link; positions for credit-batch credits.
- Lock order: credit_batches → wallets (ascending id) → positions → points_ledger → payout entries (ascending id);
  confirmBatch pre-locks target wallets ascending.
- Deleted: clawedBackForEarlierCredits, runtime findOriginalBatchCredit, legacy creditedPointsForBatchRow heuristic,
  debitFloor, patchReversal's current-partner wallet resolution.

## 3. Algorithms
- Approve POINTS reversal: lock batch; positions for (batch, outlet, field) FOR UPDATE ordered by seq; refuse if none or
  UNRESOLVED; cap `Σ(amount − reversedPoints)`; per position: lock wallet, p/c/s as §1.2, clawback movement, own-lot-first
  lot draw, allocation row. O(k) — no history scan.
- Create cap = `Σ(amount − reversedPoints) − Σ pending requested`.
- Backfill (one-off, per wallet, resumable, advisory lock): order rows by chain-following `balanceAfter` (exact) to fix
  stale balanceBefore; assign seq/pointsDelta; link ledger; replay §1.2 to compute D and O; historical clawbacks kept as
  recorded and only classified (p = min(|δ|, O_X)); positions (metadata → EXACT, offline replay → LEGACY_REPLAY, else
  UNRESOLVED); assert replayed B == redeemablePoints. No write to balances, counters or lots. Anomalies → list for owner.
  Bajaj ~29k events / 2,281 wallets ≈ seconds.

## 4. FIFO lots / expiry
Lot mirror becomes `Σ remaining = H = B + D` (today's `= B` is the D = 0 case). New credit lot remaining `a − o`.
Reversal's recovered part consumes the reversed credit's OWN lot first, then FIFO (bug fix: today the oldest lot is burnt
and the reversed credit's lot lives on — Q7). Expiry keeps today's clamp; excess reclassified as debt repayment.

## 5. PAYOUT (₹) reversals
Current HEAD bugs: (1) a PAID entry stays PAID after a reversal → a second reversal re-consumes it (double receivable)
while the next PENDING entry still gets paid; (2) greedy oldest-first refuses valid exact subsets.
Rules: P1 entry-targeted (UI preselects unallocated entries; requested = Σ selected; whole entries only — Q9); P2
reservation at create (unique live allocation per entry; reject → RELEASED); P3 bank downloads / re-bank skip reserved
entries (Q10); P4 approve: PENDING/FAILED → REVERSED + withholding offset; PROCESSING → refuse; PAID → receivable
(allocation makes it unreachable for other reversals); P5 cap structural; P6 shortfall = Σ receivables (Q11). Backfill
existing PAYOUT reversals; ambiguous flagged.

## 6. Test matrix (every scenario in BOTH approval orders)
| ID | History | Final (both orders) |
|---|---|---|
| T-a | 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 | B 0, D 0; Σrec 300, Σsf 500 (= today) |
| T-b | −841, f1 +500, f2 +300 | B −841, sf 0 |
| T-c | −100, E +500, redeem 400, X +300 | B −100; Σrec 400, Σsf 400 |
| T-d | −1000, D +1200, E +500, reverse D, X +300; reverse E & X | B −1000, sf 0 (HEAD: −700 vs −1000 ✗) |
| T-R2* | −100, X +100, Z +200, redeem 200, Y +200 | B −100 (R2 refinement, Q1) |
| T-e1..3 | concurrent credits / reversal vs redeem / double approval | seq contiguous; never < floor; one allocation |
| T-f1/f2 | legacy credit, outlet relinked / unresolved | debits only the receiving wallet / 400 until mapped |
| T-g1..3 | partial reversals | cap enforced; B identical both orders |
| T-h/h2 | unknown credit / historical unresolvable clawback | 400 / classified, balances untouched |
| T-x1 | expiry with debt | = today's clamp |
| T-pay1..5 | double consumption, exact subset, reservation vs download, PROCESSING, TDS offset | receivable once; approve OK; skipped; refused; offset once |
| DE-1..8 | Deoleo-style positive histories | identical to today (DE-4 lot fix only) |
| DE-9/10 | property tests: random D = 0 histories; random negative starts × all permutations of ≤ 4 reversals | v2 = `min(r, B)`; order-free B, D, O, Σsf |

## 7. Rollout
1. Owner YES (platform-wide). 2. Additive migration staging → prod. 3. `applyMovement` v2 for all tenants (B-neutral;
Deoleo D = 0). 4. Backfill staging → prod (backup, shown SQL, `current_database()` guard) + verification queries
(V0 balances identical before/after; V1 seq contiguity; V2 chain; V3 last row = balance; V4 holdings ≥ 0; V5 Deoleo zero
debt; V6 Bajaj 8 negative wallets covered by debt; V7 position coverage; V8 reversed = Σ allocations; V9 no payout entry
in two live reversals). 5. Per-tenant flag `reversalEngine: LEGACY | SHADOW | V2` (default LEGACY); SHADOW logs diffs;
Bajaj → V2 first; Deoleo → V2 after N weeks of zero diff. Until V2: refuse POINTS reversals on wallets with debt/offsets
(Q14). 6. Validate CHECKs, seq NOT NULL. 7. Remove legacy code; docs sweep.

## 8. Work packages
WP0 pure reference model + property tests (the oracle) · WP1 schema + migration · WP2 applyMovement v2 · WP3 reversal
engine · WP4 credits POINTS caps/allocations/SHADOW · WP5 PAYOUT allocations + UI + download hold · WP6 backfill + anomaly
report + manual mapping + verification SQL · WP7 Postgres e2e concurrency tests · WP8 rollout/flag/docs.
Orchestrator: dual adversarial audit of WP2/3 against WP0; full gates; staging runtime verify (one Bajaj negative wallet,
one Deoleo wallet).

## 9. Owner decisions (recommendation = A)
Q1 R2 refinement on wallets with debt (A accept / B refuse reversals on debt wallets) · Q2 shortfall attribution
(A first-approved-first / B pro-rata) · Q3 fungibility on positive wallets (A keep = today / B strict per-credit) · Q4
outlet relinked (A debit receiving wallet / B refuse / C current owner) · Q5 unattributable legacy credit (A refuse until
mapped / B refuse / C floor 0 on current owner) · Q6 expiry on debt wallet (A today's clamp / B full) · Q7 lot removed by a
reversal (A reversed credit's own lot first / B oldest) · Q8 show debt to partner (A no / B yes) · Q9 partial PAYOUT entry
(A whole only / B split) · Q10 pending PAYOUT reversal holds entry out of downloads (A yes / B no) · Q11 reversed PAID
payouts (A receivable only / B receivable ledger + TDS) · Q12 credits repay debt first (A yes / B no) · Q13 historical
clawbacks (A keep as recorded / B re-decide) · Q14 interim before V2 (A refuse reversals on debt wallets / B legacy floor).
