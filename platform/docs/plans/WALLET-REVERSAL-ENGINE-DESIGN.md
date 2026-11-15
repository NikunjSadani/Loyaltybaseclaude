# Wallet Reversal Engine — Design, Decisions, Status & Resume Plan

> **READ THIS FIRST WHEN RESUMING.** This one file is the complete, self-contained record of the wallet reversal
> engine: why it exists, every owner decision, the full design, what is built, what is not, and the exact steps to
> finish it. Branch **`feat/wallet-reversal-engine`** (worktree `C:\Users\nikun\Loyaltybaseclaude\.claude\worktrees\reversal-engine`).

| | |
|---|---|
| **Status** | ⏸ **PAUSED 2026-11-13 by owner — FAST FOLLOW-UP AFTER BAJAJ GO-LIVE.** Design approved; foundations built; engine not built. |
| **Approval** | ✅ Owner approved 2026-11-13: the full design + all 14 decisions (Q1–Q14 = recommended A). ⚠️ PLATFORM-WIDE (approved in-session). |
| **Why paused** | Not needed for go-live or any data import (§11). Release ships a safe interim rule instead (§10). Machine/bandwidth prioritised for go-live: release → imports → targets/achievement import → client training deck. |
| **Built** | `679ed4c2` design doc · `f5677f1e` WP1 schema + migration · `7d64ab55` WP0 reference model (oracle) + 30 tests incl. property tests · `6fed2005` WP6 backfill + verify jobs (not yet run on any DB) · `bd131860` WP2 movement v2 + WP3 reversal engine & flag (credits.service not wired yet — WP4) |
| **Not built** | WP4 credits caps + wiring of the WP3 dispatcher · WP5 payout allocations · WP7 concurrency e2e · WP8 rollout |
| **Remaining effort** | ~7–8 h wall-clock with parallel agents (§13) |

---

## 1. Why this exists (history — so nobody repeats it)

Points credited to partner wallets (credit-batch uploads) can later be **reversed** (an admin approves a reversal).
Bajaj's prod import created **8 wallets with a NEGATIVE balance** (vendor sales returns; owner kept them negative,
2026-11-12). The old reversal code floored every reversal at 0, which on a negative wallet did the wrong thing — and an
audit found it could even **add** points (`Math.min(magnitude, negativeBalance)` → negative decrement).

Owner rules that a correct engine must satisfy:
- **R1** a reversal fully undoes a credit that landed on a negative wallet (−841, +500 → −341, reverse → −841).
- **R2** otherwise a reversal never pushes a wallet below 0 (old behaviour: floor 0, unrecovered remainder = shortfall);
  positive-balance behaviour and Deoleo (never negative) identical to today.
- **R3** results must not depend on the order in which several reversals are approved.
- **R4** points actually spent (redemptions, expiries) are history — never undone.
- **R5** a reversal never takes back more than the credit put in, never debits a wallet that didn't receive the credit,
  is never applied twice, and is concurrency-safe.

**Five patch rounds failed** (commits on `feat/payout-without-pan`): `76a75279` clamp → `234275de` floor = balance
before the credit → `008934e1` exact credit + cap + lock → `8d1bbc82` "order-independent" floor (broke Deoleo: pushed a
never-negative wallet to −300) → `3766dd2a` clamp to lowest pre-credit balance (still order-dependent on case d: −700 vs
−1000). Each round was caught by an independent dual money audit. **Root cause:** every patch reconstructed "where did
this credit's points go" from snapshots (`balanceBefore`, `createdAt` order, scans of earlier clawbacks), which go stale
under concurrency and don't record which debt a credit repaid once a later reversal restores it. Owner (2026-11-13):
*"I need the correct long-term solution so that the engine does not cause issues in future. This is real money related
points."* → this design.

## 2. The model in one paragraph
Each wallet keeps a tiny bit of extra state, maintained under its row lock on every movement: its **outstanding debt D**
and, per reversible credit, how much of that debt the credit **paid off (offset O_X)**. A new credit pays debt first.
A reversal then follows **one rule**: *take the credited points back from wherever they still are — the debt they repaid
comes back, and any points the wallet still holds are removed; points already spent are shortfall.* R1 and R2 fall out
of that single rule, R3 is a theorem, and a reversal is O(1) — no history scan.

## 3. Formal model

### 3.1 State (per wallet)
| Symbol | Meaning | Stored as |
|---|---|---|
| `B` | balance (may be < 0) | `wallets.redeemablePoints` (unchanged) |
| `D` | outstanding debt not offset by any credit, `D ≥ 0` | `wallets.debtPoints` (WP1 ✅) |
| `H` | holdings = `B + D ≥ 0` | derived |
| `O_X` | how much of credit X currently pays off debt, `0 ≤ O_X ≤ a_X` | `wallet_credit_positions.offsetPoints` (WP1 ✅) |
| `a_X` | amount of credit X | `wallet_credit_positions.amount` |
| `ρ_X` | total reversal approved against X | `wallet_credit_positions.reversedPoints` |

Invariants: **I1** `D ≥ 0`; **I2** `H ≥ 0`; **I3** `0 ≤ O_X ≤ a_X`; **I4** `ρ_X ≤ a_X`; **I5** a wallet that was never
< 0 (all of Deoleo) has `D = 0` and every `O_X = 0` (induction over the transitions).

### 3.2 Transitions (applied in per-wallet `seq` order)
| Movement | Effect |
|---|---|
| **Credit** `a > 0` (EARN, BONUS, CREDIT_ADJUSTMENT, redemption refund, vendor-import earn) | `o = min(a, D)`; `D −= o`; `B += a`; if reversible: `O_X = o`; lot remaining = `a − o` (credit repays debt first) |
| **Spend** `s` (redemption, admin debit — guarded `B ≥ s`) | `B −= s`; FIFO lots (as today); spent = history (R4) |
| **Expiry** of lot with remaining `h` | `e = min(h, max(0, B))` (today's clamp); `B −= e`; excess `h − e` was covering debt → `D −= (h − e)`, owner credit `O += (h − e)`. With D = 0: `e = h` (identical to today) |
| **Legacy debt-creating debit** `d` (vendor-import "Points reversed" history only) | `B −= d`; `D += max(0, d − H)` |
| **Reversal** of X by `r ≤ a_X − ρ_X` | `p = min(r, O_X)` (restore the debt X paid off); `c = min(r − p, H)` (remove points still held); `B −= p + c`; `D += p`; `O_X −= p`; `ρ_X += r`; **shortfall = r − p − c** |

### 3.3 The one rule and how the owner rules fall out
Floor of a reversal of X = `−(D + O_X)`.
- **R1:** −841, X +500 → D 341, O_X 500, B −341; reverse → −841. ✅
- **R2:** never-negative wallet → D = 0, O_X = 0 → decrement `min(r, B)` = **byte-identical to today** (Deoleo). ✅
- **R4:** spends/expiries never reversed; they only shrink H. ✅
- **R5:** cap `r ≤ a_X − ρ_X`; wallet = the one in X's position row (never the outlet's current partner); allocation
  row unique per (reversal, credit). ✅
- **R2 refinement (forced by R1 + R3 — owner-approved Q1):** on a wallet that *had debt*, a reversal may go below 0,
  down to the debt it restores. Example T-R2*: `−100; X +100; Z +200; redeem 200; Y +200 (B 200)` — reverse Z then X →
  −100; by R3, X then Z must also end at −100, so Z's reversal crosses 0 although Z landed at 0. No rule satisfies R1 +
  R3 and keeps Z ≥ 0. **Never reachable for Deoleo (I5).**
- **Credits repay debt first (Q12):** otherwise `import +1000, vendor debit 1500, +2000` leaves latent D = 500 on a
  B = 1500 wallet, and a later reversal could push a positive wallet negative.

### 3.4 Why not "replay the wallet without the credit"
Case (a) `0, f1 +500, redeem 500, f2 +300`: replay without f1 makes the redemption unaffordable → either undo it
(violates R4) or clamp it (final 300 vs today's 0, violates R2 parity). The outcome is defined as "remove X's units
from where they are *now*"; `(D, O_X)` is exactly the information a replay would need, kept live.

### 3.5 Theorem (R3 order independence)
Each reversal draws first from a **private pool** `O_{X_i}` (only reversals of X_i touch it), then the **common pool**
H. A private draw leaves H unchanged. (i) For one credit, total private draw = `min(Σr, O_X)` in any order (induction).
(ii) Greedy draws from one pool total `min(Σresidual, H)` in any order. ⇒ final B, D, every O, Σ shortfall are
order-free. ∎ The *split* of shortfall between reversals depends on order only when H binds (cases a, c); per-wallet
totals don't (Q2).

## 4. Data model (WP1 ✅ built — `f5677f1e`, migration `api/prisma/migrations/20261117120000_wallet_reversal_engine`)
Purely additive; existing code keeps working.
- **`Wallet`**: `debtPoints Int @default(0)`, `movementSeq Int @default(0)`, relation `creditPositions`.
- **`WalletTransaction`**: `seq Int?` (unique `(walletId, seq)`; NULLs allowed pre-backfill), `pointsDelta Int?` (actual
  balance change; `points` keeps the requested magnitude), `reversedCreditTxId String?` (self-relation
  `WalletTxReversedCredit`), `creditReversalId String?`, `pointsLedgerId String? @unique` (1:1 with its ledger row);
  FK onDelete NoAction for the self/ledger links, Restrict for creditReversalId.
- **`WalletCreditPosition`** (`wallet_credit_positions`): `walletId, creditTxId @unique, lotId? @unique, batchId,
  outletCode?, fieldId?, amount, offsetPoints @default(0), reversedPoints @default(0), attribution`, timestamps;
  indexes walletId, (batchId, outletCode, fieldId), attribution. Nullable outletCode/fieldId only for UNRESOLVED (CHECK).
- **`CreditReversalAllocation`** (`credit_reversal_allocations`): `creditReversalId, positionId, requested,
  debtRestored (p), recovered (c), shortfall`, unique (creditReversalId, positionId).
- **`PayoutReversalAllocation`** (`payout_reversal_allocations`): `creditReversalId, payoutEntryId, amountPaise BigInt,
  state @default(RESERVED), tdsOffsetPaise BigInt @default(0)`, unique (creditReversalId, payoutEntryId) + **partial
  unique index on payoutEntryId WHERE state IN live states** → an entry can never be consumed by two live reversals.
- Enums `CreditAttribution {EXACT LEGACY_REPLAY MANUAL UNRESOLVED}`, `PayoutAllocationState {RESERVED APPLIED_CANCELLED
  APPLIED_RECEIVABLE RELEASED}`. New-table FKs onDelete Restrict.
- Raw-SQL CHECKs in the migration: `debtPoints ≥ 0`, `movementSeq ≥ 0`, `seq IS NULL OR seq > 0`, position bounds
  (`amount > 0`, `0 ≤ offset ≤ amount`, `0 ≤ reversed ≤ amount`, non-UNRESOLVED requires outletCode+fieldId),
  allocation sums (`p + c + shortfall = requested`, all ≥ 0), payout `amountPaise > 0`, `tdsOffsetPaise ≥ 0`.
- **Deliberately NOT in WP1:** the holdings CHECK `redeemablePoints + debtPoints >= 0`. Reason: until the backfill sets
  D, the 8 Bajaj negative wallets have D = 0, so even a normal credit (−841 + 500 = −341) would violate it. It goes in
  the **post-backfill migration** (with `seq` NOT NULL) — §9 step 6. SQL is in a comment at the end of the WP1 migration.
- Assumes PostgreSQL ≥ 11 (Cloud SQL): constant-default columns add without a table rewrite.

## 5. Runtime write path — `applyMovement` v2 (WP2, NOT built)
1. `SELECT … FROM wallets WHERE id=$1 FOR UPDATE` — **lock first, then read** B, D, movementSeq (fixes stale balanceBefore).
2. Compute the transition by **calling the WP0 pure functions** (never re-implement the math).
3. Single `UPDATE wallets SET redeemablePoints, debtPoints, movementSeq = movementSeq + 1, counters … RETURNING`;
   guarded debits keep `WHERE redeemablePoints >= s` as defence in depth.
4. Insert WalletTransaction with `seq`, `pointsDelta`, `balanceBefore = balanceAfter − pointsDelta` (exact), then the
   PointsLedger row and set `pointsLedgerId`.
5. Credit-batch POINTS credits also insert their `WalletCreditPosition` (`O_X = o`, `lotId`, attribution EXACT).
- **Lock order (deadlock-free):** credit_batches → wallets (ascending id) → wallet_credit_positions → points_ledger →
  credit_payout_entries (ascending id). `confirmBatch` pre-locks all target wallets ascending.
- State maintenance runs for **all tenants** and is **B-neutral** (balances/counters/lots identical when D = 0).
- **To delete** once V2 replaces them: `clawedBackForEarlierCredits`, runtime `findOriginalBatchCredit` (logic moves to
  the one-off backfill), legacy half of `creditedPointsForBatchRow`, `debitFloor`, patchReversal's current-partner wallet
  resolution.

## 6. Reversal algorithm (WP3/WP4, NOT built)
```
approve POINTS reversal (credit batch B, outlet O, field F, amount r):
  lock credit_batches row
  positions = wallet_credit_positions WHERE batch=B AND outlet=O AND field=F ORDER BY creditTx.seq FOR UPDATE
  if none or any UNRESOLVED → 400 ("map credit first" / settle off-platform)        -- R5, Q5
  cap = Σ(amount − reversedPoints); r > cap → 400                                     -- R5
  guarded flip CreditReversal PENDING_GIFSY → APPROVED/PARTIAL                        -- never twice
  for pos in positions (oldest seq first) while remaining > 0:
     r_i = min(remaining, pos.amount − pos.reversedPoints)
     lock wallet pos.walletId FOR UPDATE; (p, c, shortfall) = WP0.reverse(state, pos, r_i)
     applyMovement(DEBIT_ADJUSTMENT, points −r_i, pointsDelta −(p+c), debt += p, reversedCreditTxId, creditReversalId)
     lots: draw c from pos.lotId first, then FIFO                                    -- Q7
     pos.offsetPoints −= p; pos.reversedPoints += r_i
     insert CreditReversalAllocation(r_i, p, c, shortfall)                            -- unique → idempotent
  CreditReversal.shortfallPaise = Σ shortfall
create cap = Σ(amount − reversedPoints) − Σ pending requested
```
O(k) rows (k = positions for the (batch, outlet, field), normally 1) + O(L) lots. No wallet-history scan.

## 7. FIFO lots / expiry (WP2)
Lot mirror becomes `Σ remaining(non-expired) = H = B + D` (today's `= B` is the D = 0 case). New credit lot remaining
`a − o`. Reversal's recovered part `c` consumes **the reversed credit's own lot first**, then FIFO — a bug fix: today the
oldest lot is burnt and the reversed credit's own lot survives (extends expiry of reversed points). Expiry keeps today's
clamp; excess is reclassified as debt repayment. Redemption refund is a credit (repays debt first).

## 8. PAYOUT (₹) reversals (WP5, NOT built)
Bugs found by audit in the patched code (fixed only by WP5; the release's interim rule mitigates — §10):
(1) a PAID entry stays PAID after a reversal records its receivable → a second reversal re-consumes it (double
receivable) while another entry still gets paid; (2) greedy oldest-first refuses valid exact subsets ([₹300, ₹500],
reverse ₹500 → refused).
Rules: **P1** entry-targeted — the reversal names its entries (UI preselects unallocated entries of the
(batch, outlet, field); operator can deselect); requested = Σ selected; whole entries only (Q9). **P2** reservation at
create (RESERVED allocation; partial unique index; reject → RELEASED). **P3** bank downloads / re-bank skip RESERVED
entries (Q10). **P4** approve (batch lock → entries FOR UPDATE ascending): PENDING/FAILED → REVERSED + withholding offset
→ APPLIED_CANCELLED; PROCESSING (legacy only) → refuse; PAID → APPLIED_RECEIVABLE (entry stays PAID, unreachable to
others). **P5** cap structural. **P6** shortfall = Σ receivables; receivable ledger + TDS correction out of scope (Q11).
Backfill existing PAYOUT reversals; ambiguous → flagged.

## 9. One-off backfill (WP6, NOT built) + rollout
**Backfill** (per wallet, own tx, advisory lock + wallet FOR UPDATE, resumable: skip wallets with movementSeq > 0):
1. Order rows by **chain-following** exact `balanceAfter` from 0 (δ = points for credits/guarded debits/vendor rows;
   `points ≤ δ ≤ 0` for floored debits), ±10 s window search when createdAt order breaks; no unique continuation →
   anomaly list, no writes.
2. Assign `seq`, `pointsDelta`; pair WalletTransaction ↔ PointsLedger; set `movementSeq = n`.
3. Call WP0 **`replay()`** to compute D and offsets. Historical clawbacks kept as recorded and only classified
   (`p = min(|δ|, O_X)`); excess beyond holdings → debt + flag (Q13).
4. Positions for every credit-batch credit: metadata → EXACT; offline legacy replay (port of today's
   `findOriginalBatchCredit`) → LEGACY_REPLAY; else UNRESOLVED (reversal refused until Gifsy maps it → MANUAL, Q5).
   `reversedPoints` + legacy allocations from APPROVED/PARTIAL CreditReversals.
5. Assert replayed B == redeemablePoints, `H ≥ 0`, `D ≥ 0`, `0 ≤ O ≤ a`. **Never writes balances, counters or lots →
   zero balance change by construction.** Bajaj prod ≈ 29k events / 2,281 wallets → seconds.

**Rollout:**
1. Owner YES (done 2026-11-13). 2. Additive migration staging → prod (in-VPC `migrate deploy` job). 3. `applyMovement`
v2 for all tenants (B-neutral). 4. Backfill staging → prod (backup, shown SQL, `current_database()` guard) + verification
V0–V9 below; anomaly list → owner. 5. Per-tenant flag **`reversalEngine: LEGACY | SHADOW | V2`** (default LEGACY):
SHADOW computes v2 next to legacy, applies legacy, stores the diff; **Bajaj → V2 first; Deoleo → V2 only after weeks of
zero shadow diff.** Until V2 for a tenant: refuse POINTS reversals on wallets with debt/offsets (Q14). 6. Post-backfill
migration: add+VALIDATE holdings CHECK, `seq` NOT NULL. 7. Remove legacy floor code; docs sweep.

**Verification queries (read-only; guard each session with `SELECT current_database()`):**
```sql
-- V0 snapshot before AND after backfill (must be identical)
SELECT cp."clientId", count(*), sum(w."redeemablePoints"), sum(w."earnedPoints"), sum(w."lifetimeEarned"),
       sum(w."redeemedPoints"), sum(w."expiredPoints")
FROM wallets w JOIN channel_partners cp ON cp.id = w."partnerId" GROUP BY 1 ORDER BY 1;
-- V1 seq contiguity
SELECT w.id FROM wallets w LEFT JOIN wallet_transactions t ON t."walletId" = w.id
GROUP BY w.id, w."movementSeq" HAVING coalesce(max(t.seq),0) <> count(t.id) OR coalesce(max(t.seq),0) <> w."movementSeq";
-- V2 chain integrity
SELECT * FROM (SELECT "walletId", seq, "pointsDelta", "balanceAfter",
  lag("balanceAfter") OVER (PARTITION BY "walletId" ORDER BY seq) AS prev FROM wallet_transactions) x
WHERE "balanceAfter" <> coalesce(prev, 0) + "pointsDelta";
-- V3 last row == wallet balance
SELECT w.id FROM wallets w JOIN LATERAL (SELECT "balanceAfter" FROM wallet_transactions t
  WHERE t."walletId" = w.id ORDER BY seq DESC LIMIT 1) l ON true WHERE l."balanceAfter" <> w."redeemablePoints";
-- V4 holdings non-negative
SELECT id FROM wallets WHERE "debtPoints" < 0 OR "redeemablePoints" + "debtPoints" < 0;
-- V5 Deoleo zero debt / zero offsets (expect 0 rows) and min balanceAfter >= 0
-- V6 negative wallets (Bajaj expect 8) are covered by debt
SELECT id, "redeemablePoints", "debtPoints" FROM wallets WHERE "redeemablePoints" < 0;
-- V7 position coverage + attribution counts; V8 reversedPoints == Σ allocations ≤ amount;
-- V9 no payout entry in two live reversals (GROUP BY payoutEntryId HAVING count(*) > 1 on live states)
```

### 9.1 WP6 backfill / verify runbook (`6fed2005` — NOT yet run on any DB)
Same API image, Cloud Run Job, `--command=node`. Every DB step needs the owner's OK; prod also needs a fresh backup.
1. **DRY_RUN** (default; reads only): `EXPECTED_DB=gifsy_staging TENANTS=bajaj,deoleo` → args `dist/wallet/backfill/backfill.main.js`.
   Prints per tenant: planned/noop/done/BLOCKED counts, rows to sequence, positions by attribution, allocations, every
   debt wallet (`B → D (H)`), every anomaly (BLOCKING = that wallet gets no writes; WARNING = written + flagged). The
   anomaly list goes to the owner. Save the `V0` numbers it is about to print in APPLY.
2. **APPLY**: add `BACKFILL_APPLY=true BACKFILL_CONFIRM="APPLY gifsy_staging"` (exact). A tenant with BLOCKED wallets is
   refused (exit 3) unless `ALLOW_BLOCKED=true`. Optional staging: `MAX_WALLETS=n`, `RESUME_AFTER_WALLET=<id>`. Re-runs
   are safe (done wallets skipped). Exit 4 = V0 changed during the run → stop, investigate (concurrent traffic / bug).
   Run with POINTS reversal approvals paused (a clawback committed mid-run on a backfilled wallet shows up in V1).
3. **VERIFY** (read-only): args `dist/wallet/backfill/verify.main.js`, env `EXPECTED_DB`, `TENANTS`,
   `V0_BASELINE_JSON='[…the "V0 before" objects APPLY printed…]'`, `NEVER_NEGATIVE_TENANTS=deoleo` (default),
   prod only: `EXPECTED_NEGATIVE_BALANCES='{"bajaj":[-840,-612,-520,-360,-360,-297,-280,-280]}'`. Exit 0 = all PASS, 5 = a FAIL.
4. Only after 1–3 pass for every tenant AND WP2 is live on every write path: ship
   `platform/docs/plans/sql/wallet-reversal-post-backfill.DRAFT.sql` as a real migration (instructions in its header).

## 10. Interim rule shipped in the release (until V2 is live for a tenant) — decision Q14
Built on `feat/payout-without-pan` (release track, 2026-11-13): POINTS reversals use the simple pre-patch semantics
(floor 0, never adds points, shortfall recorded) **and are refused on any wallet that currently carries debt or where the
credit landed on a negative balance** ("This wallet carries debt; reversals on it are paused until the new reversal
engine is live — contact Gifsy"). PAYOUT reversals: whole entries only, never consume an entry twice, PROCESSING refused,
TDS offset only for PENDING/FAILED. ⇒ Today only Bajaj's 8 negative prod wallets are affected, and only if someone
reverses a points batch on them. When resuming, **merge the release branch into this branch first** (WP5 builds on it).

## 11. Criticality (owner question, 2026-11-13)
Not needed for go-live or for any import (payout history, partial TDS, targets/achievement, points). It only matters when
an admin reverses a points credit batch; correctness matters most on wallets carrying debt (Bajaj's 8). Bajaj has no live
credit batches on prod yet. Worth doing properly once Bajaj runs monthly credits/reversals — real-money points.

## 12. Owner decisions (all approved = A, 2026-11-13)
| # | Situation | Approved (A) | Alternative rejected |
|---|---|---|---|
| Q1 | Wallet that already had debt: may a reversal go below 0 down to the debt it restores? | Yes — only rule consistent with "fully undo" + "order-independent"; never on never-negative wallets (Deoleo) | Refuse reversals on debt wallets |
| Q2 | Several reversals, not enough points left — who carries the shortfall? | First approved recovers first (as today); wallet totals identical either way | Pro-rata |
| Q3 | Credit's points already spent, wallet holds other points — take those? | Yes, as today (Deoleo unchanged) | Only that credit's own unspent points |
| Q4 | Outlet moved to another partner after the credit | Take back from the wallet that received it | Refuse / take from new owner |
| Q5 | Old credits whose exact credit can't be determined | Refuse until Gifsy maps it manually | Refuse permanently / floor 0 on current owner |
| Q6 | Points expiring on a wallet with debt | Today's clamp (never pushes below 0); excess counts as debt repayment | Expire in full |
| Q7 | Which earned points a reversal removes | That credit's own lot first (fixes hidden expiry bug) | Oldest lot first (today) |
| Q8 | Show debt ("points owed") to partners | No — balance only | Show it |
| Q9 | Reverse part of one payout entry | Whole entries only (operator picks entries) | Allow splitting |
| Q10 | Pending payout reversal — keep entry out of bank files? | Yes | No (refuse approval if already sent) |
| Q11 | Reversing an already-PAID payout | Record the receivable only (for now) | Receivable ledger + TDS correction |
| Q12 | Does a new credit pay off existing debt first? | Yes (prevents hidden debt pushing a positive wallet negative) | No |
| Q13 | Historical reversals already done | Keep as recorded; backfill only classifies | Recalculate (would change balances) |
| Q14 | Until the engine is on for a tenant | Refuse points reversals on wallets with debt (Bajaj's 8) | Keep the patched logic (known order bug) |

## 13. Work packages & resume plan
| WP | Scope | Status | Depends | Est. |
|---|---|---|---|---|
| WP0 | Pure reference model `api/src/wallet/reversal-model.ts` + `reversal-model.spec.ts` — the ORACLE | ✅ `7d64ab55` (30 tests; jest + `tsc -p tsconfig.build.json` pass in the worktree) | — | — |
| WP1 | Prisma schema + migration | ✅ `f5677f1e` | — | — |
| WP2 | `applyMovement` v2 (lock-first, seq, pointsDelta, D/O, ledger link, positions, expiry reclassification) calling WP0 | ✅ `bd131860` — `WalletService.movementPath` rollout guard: movementSeq > 0 → v2 maintenance (any flag); movementSeq = 0 + LEGACY → pre-engine path byte-identical; SHADOW/V2 → v2 only for a pristine wallet, un-backfilled history → 409. Expiry with e = 0 writes no row (D/O only). Tests `wallet.reversal-engine.spec.ts` | WP0, WP1 | — |
| WP3 | Reversal engine `applyCreditReversal` §6; own-lot-first; LEGACY/SHADOW/V2 flag; delete legacy floor helpers | ✅ `bd131860` — `applyCreditReversal`, `v2PointsReversalCap`, `reverseCreditBatchPoints` (flag `program_settings.reversalEngine`, absent → LEGACY, malformed → refused; SHADOW diff → audit_logs `REVERSAL_ENGINE_SHADOW`). Legacy floor helpers kept: LEGACY still needs them (removal = rollout step 7). `patchReversal` still calls the LEGACY pair directly → switch to the dispatcher in WP4 | WP2 | — |
| WP4 | credits.service POINTS: position-based caps at create/approve, wallet from position, allocations, shortfall totals, SHADOW | ✅ branch `feat/wre-wp4` — mode resolved once per request (POINTS create/approve only; reject/PAYOUT never read it). **V2**: create cap Σ(a − ρ) − Σ pending, `originalPaise` = Σ position amounts, approve cap Σ(a − ρ) under the batch lock, then `reverseCreditBatchPoints(mode V2)` (receiving wallet, allocations, Σ shortfall → `shortfallPaise`); no current-partner / debt gate; no position / UNRESOLVED → 400. **SHADOW**: LEGACY decides + applies; v2 create-cap diff (audit `REVERSAL_ENGINE_SHADOW`, action CREATE) + approve diff (dispatcher). **LEGACY**: code path unchanged — golden snapshot generated on `1aa5084e` (`api/src/credits/__fixtures__/legacy-reversal-golden.json`). `confirmBatch` resolves the mode once per batch (`creditEarn` → `movementPath(knownMode)`): 2,000-row confirm 24,004 → 20,005 queries (LEGACY), 28,004 → 24,005 (V2). Tests `credits.reversal-engine.spec.ts` | WP3 | — |
| WP5 | PAYOUT allocations §8: entry-selection DTO + UI, reservation, download/re-bank hold, approve rules, backfill of existing PAYOUT reversals | ⬜ | WP1 + release branch merged in | ~2 h (parallel with WP2/3) |
| WP6 | Backfill job §9 (pure module using WP0 `replay()` + Cloud Run job script, DRY_RUN default, resumable) + verify job V0–V9 + draft post-backfill migration | ✅ `6fed2005` — `api/src/wallet/backfill/` (planner, runner, Prisma store, `backfill.main.ts`, `verify.main.ts`) + 30 fixture tests; draft `platform/docs/plans/sql/wallet-reversal-post-backfill.DRAFT.sql`. Not yet run on any DB (runbook §9.1) | WP0, WP1 | — |
| WP7 | Postgres e2e concurrency tests (concurrent credits, reversal vs redeem, double approval, reservation vs download) | ⬜ | WP2–WP5 | ~1 h |
| WP8 | Flag rollout, shadow-diff report, docs sweep, prod runbook | ⬜ | all | with staging |
| — | Dual independent money audit + fix round; full `scripts/gates.sh`; staging (migration, backfill, V0–V9, one Bajaj negative wallet + one Deoleo wallet with real logins) | ⬜ | all | ~3 h |

**Resume checklist:**
1. `git -C <repo> merge` the release branch (`feat/payout-without-pan`, after it's on main) into `feat/wallet-reversal-engine`; re-run WP0 tests.
2. `npm ci` in `api/` + `platform/` of the worktree if node_modules are missing; `npx prisma generate`.
3. Launch WP2+3 (one agent), WP5, WP6 in parallel (targeted tests only — the machine crashes when several full suites run at once); then WP4 + WP7; then integration + full gates (one at a time).
4. Dual money audit (two independent reviewers) → fix round → full gates.
5. Staging rollout per §9 (owner OK for staging DB ops is standard; prod migration/backfill needs owner OK + backup).
6. Bajaj → V2; Deoleo SHADOW for weeks → V2 only after zero diffs (owner decision at that time).

## 14. WP0 reference model — exported API (for WP2/WP3/WP6)
```ts
interface WalletState { B: number; D: number; seq: number }
interface CreditPosition { id: string; amount: number; offset: number; reversed: number; lotRemaining: number }
interface Lot { id: string; creditId: string | null; remaining: number }
interface WalletModel { state: WalletState; positions: Record<string, CreditPosition>; lots: Lot[] } // lots FIFO = array order
interface Movement { kind: 'CREDIT'|'SPEND'|'EXPIRY'|'LEGACY_DEBT_DEBIT'|'REVERSAL'; seq; refId; pointsRequested;
  pointsDelta; debtDelta; offsetDelta; offsetPositionId; lotDraws: {lotId; points}[]; shortfall; debtRestored; recovered }
class ReversalModelError extends Error
emptyModel(); holdings(s); credit(m, {id, amount, reversible}); spend(m, s); expire(m, lotId); legacyDebtDebit(m, d);
reverse(m, creditId, r); reversalFloor(m, creditId) /* −(D+O_X) */; legacyReversalDecrement(B, r) /* min(r, max(0,B)) */;
checkInvariants(m, {neverNegative?}); run(events, start?);
replay(historicalEvents, expectedBalance?) → { state, positions, classifications, anomalies }
// anomaly codes: CLAWBACK_UNKNOWN_CREDIT | CLAWBACK_BEYOND_HOLDINGS | CLAWBACK_OVER_CAP | EXPIRY_EXCESS_EXCEEDS_DEBT |
//   EXPIRY_LOT_LESS_THAN_EXPIRED | BAD_DELTA_SIGN | DUPLICATE_CREDIT | FINAL_BALANCE_MISMATCH
```
WP0 notes: T-R2* gives −100 when X & Y (or X, Y & Z) are reversed (X alone → +100); replay keeps over-holdings historical
clawbacks as recorded (excess → debt, flagged CLAWBACK_BEYOND_HOLDINGS); zero-delta clawbacks valid; non-reversal debits
add debt `max(0, |δ| − H)`; the model never emits −0.

## 15. Test matrix (WP0 ✅ covers every row; WP2–WP7 must match WP0 exactly)
| ID | History | Final (all approval orders) |
|---|---|---|
| T-a | 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 | B 0, D 0; Σrecovered 300, Σshortfall 500 (= today) |
| T-b | −841, f1 +500, f2 +300; reverse both | B −841, shortfall 0 |
| T-c | −100, E +500, redeem 400, X +300; reverse E, X | B −100; Σrec 400, Σsf 400 (split [100,300] or [0,400] by order, Q2) |
| T-d | −1000, D +1200, E +500, reverse D, X +300; reverse E, X | B −1000, sf 0 (patched code: −700 vs −1000 ✗) |
| T-R2* | −100, X +100, Z +200, redeem 200, Y +200; reverse X & Y | B −100 (Q1) |
| T-g1..3 | partial reversals | cap enforced; B identical across orders |
| T-x1 | expiry with debt | = today's clamp |
| T-e1..3 | concurrent credits / reversal vs redeem / double approval | seq contiguous; never below floor; one allocation (WP7) |
| T-f1/f2 | legacy credit, outlet relinked / unresolved | debit only the receiving wallet / 400 until mapped (WP4) |
| T-h/h2 | unknown credit / historical unresolvable clawback | 400 / classified, balances untouched (WP4/WP6) |
| T-pay1..5 | double consumption, exact subset, reservation vs download, PROCESSING, TDS offset | receivable once; approve OK; skipped; refused; offset once (WP5) |
| DE-1..8 | Deoleo-style positive histories | identical to today (DE-4: lot fix only) |
| DE-9 | 2,500 random never-negative histories | every reversal decrement == min(r, B) |
| DE-10 | 2,500 negative starts × all permutations of ≤4 reversals | identical B, D, offsets, ρ, Σsf; invariants hold |
