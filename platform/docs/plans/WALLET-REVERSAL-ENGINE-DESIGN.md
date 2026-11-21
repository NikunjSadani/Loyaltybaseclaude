# Wallet Reversal Engine — Design, Decisions, Status & Resume Plan

> **READ THIS FIRST WHEN RESUMING.** This one file is the complete, self-contained record of the wallet reversal
> engine: why it exists, every owner decision, the full design, what is built, what is not, and the exact steps to
> finish it. **Release branch: `feat/wre-release`** (from prod `7ba69566`; worktree
> `C:\Users\nikun\Loyaltybaseclaude\.claude\worktrees\wre-release`) = the main build `feat/wallet-reversal-engine` +
> fix rounds A + B, merged with everything that shipped on 2026-11-19 (§8.3). Older branches are history only.

| | |
|---|---|
| **Status** | ⏸ **PAUSED 2026-11-13 by owner — FAST FOLLOW-UP AFTER BAJAJ GO-LIVE.** Design approved; foundations built; engine not built. |
| **Approval** | ✅ Owner approved 2026-11-13: the full design + all 14 decisions (Q1–Q14 = recommended A). ⚠️ PLATFORM-WIDE (approved in-session). |
| **Why paused** | Not needed for go-live or any data import (§11). Release ships a safe interim rule instead (§10). Machine/bandwidth prioritised for go-live: release → imports → targets/achievement import → client training deck. |
| **Built** | `679ed4c2` design doc · `f5677f1e` WP1 schema + migration · `7d64ab55` WP0 reference model (oracle) + 30 tests incl. property tests · `6fed2005` WP6 backfill + verify jobs (not yet run on any DB) · `bd131860` WP2 movement v2 + WP3 reversal engine & flag (credits.service not wired yet — WP4) · `4187cb6d` WP5 PAYOUT allocations/reservations (SHADOW/V2) |
| **Policy round A** | branch `feat/wre-pol-a` (2026-11-16): owner decisions P-A1..P-A5 (§12.1) — blocked wallets keep today's rules, backfill never stops on blocked wallets, unmapped credit refuses only its outlet line, "recovered X, owed Y", per-tenant approvals-paused switch; tenant-flag reads through the caller's tx (WP7 pool finding fixed); WP5 payout planner wired into WP6; call-out endpoint + banner |
| **Fix round A** | branch `feat/wre-fix-a` (2026-11-16): money-audit points-side fixes M1–M3, L1–L6 (§12.2) — malformed flag no longer stops activity, expiry isolated, settings fence + GIFSY mode endpoint, no silent LEGACY pass-through on sequenced wallets, Deoleo LEGACY path statement-identical to origin/main (parity spec) |
| **Merged with prod (2026-11-19)** | `feat/wre-release` — conflicts with the shipped TDS rules resolved by owner decisions (M2 = A, TDS credit rebuilt on the shipped whole-year 194R calculation; credits tenant-scoped, Deoleo byte-identical) — §8.3 |
| **Fix round (2026-11-19, dual audit)** | Owner D1 = a PAID 194C payout can't be reversed (every tenant); D2 = a fully withheld PAID 194R payout reversed on V2 gets a TDS credit (replaces M1); audit A2/A4/A5/B2–B9 — §8.4 |
| **Fix round 3 (2026-11-19, dual re-audit)** | Usable-only credits (A1), D2 entries keep their report flags (A2), LEGACY approve re-checks D1 + row locks (A3), bank-file FY everywhere (A4), honest gross-up text + "netted" row line (A5), section-less D2 (A6); migrations = 44 files, one live table each (B1/B6); V2 modal loading/error (B2); gross-era backfill BLOCKING (B3); B4/B5/B7/B8 — §8.5 |
| **Over-reversal = debt (owner 2026-11-19)** | V2 POINTS reversal larger than what the wallet holds → the rest becomes wallet DEBT repaid from future earnings, nothing written off (R2 changed); plain-words POINTS outcome summary on every tenant (LEGACY keeps its floor-0 write-off wording) — branch `fix/wre-overreversal-debt`, §8.6 |
| **Fix round (2026-11-19, dual audit + owner decisions 1–2)** | Expired points are not recovered twice (V2: the reversed credit's own expired points count as recovered); the retailer sees a negative balance as it is (no ₹, plain-words note, self-explaining passbook row); liability KPIs / group total exclude debt; Debt column; wallets-in-debt list + Excel; V6b INFO; oracle handles pre-rule rows — §8.7 |
| **Fix round 3 + D1–D3 (2026-11-19)** | One "points owed" definition (D1); liability = positive balances everywhere with the split explained (D2, platform-wide); D3 not required (known limitation); A4–A8, B1–B7 — §8.8 |
| **Not built** | WP7 missing tests · WP8 shadow-diff report · REPLAY tool (rollout: replay Bajaj's past reversals on a data copy → V2) · dual money audit · staging run |
| **Remaining effort** | ~7–8 h wall-clock with parallel agents (§13) |
| **⚠️ LEGACY RETIRED (2026-11-21)** | Owner (platform-wide, approved): "the new engine is better; move Deoleo to it and completely retire the old engine." Branch `feat/retire-legacy-wallet-engine` — **read §0 first; it overrides every LEGACY / SHADOW / mode-switch passage below** (kept as history). |

---

## 0. LEGACY retired — one engine for every tenant (2026-11-21, branch `feat/retire-legacy-wallet-engine`)

**What changed (every tenant — Deoleo, Bajaj, every future client):**
- **No engine mode.** The per-tenant `reversalEngine` setting (LEGACY | SHADOW | V2), its reader, the GIFSY switch
  `POST /v1/admin/credits/reversal-engine/mode` (+ DTO, audit entity `REVERSAL_ENGINE_MODE`) and the SHADOW diff are
  deleted. An old `reversalEngine` row (Bajaj staging has `V2`) is **ignored** — nothing reads it; the generic
  settings PUT still refuses the key ("retired — nothing was changed"). The §9.1 maintenance **pause stays** (the
  backfill uses it).
- **POINTS reversals** (create + approve) are always the position engine (§6): receiving wallet(s), oldest credit
  first, over-reversal → debt repaid from future earnings. The LEGACY floor-0 clawback (`clawbackAward`), the Q14
  debt refusal (`assertPointsReversalAllowed`, `DEBT_REVERSAL_PAUSED_MESSAGE`), the legacy credit pairing
  (`findOriginalBatchCredit` / `pairLegacyBatchCredits` / `creditedPointsForBatchRow`) and the legacy stored-rows
  POINTS cap are deleted, with their tests and the LEGACY golden fixture
  (`api/src/credits/__fixtures__/legacy-reversal-golden.json`) — status-table mentions of it below are history.
- **PAYOUT reversals** always name and reserve whole entries (§8). A PAYOUT reversal still PENDING from before the
  retirement (no allocation rows) is approved through the interim whole-entry path — kept only so no pending request
  is stranded (decided by the data, as before).
- **Movements:** a SEQUENCED or PRISTINE wallet is always written by the tracked path (seq / pointsDelta / D /
  positions). Before, on a LEGACY tenant (every prod tenant) even a brand-new wallet was written UN-sequenced. Only a
  wallet that already has un-sequenced history keeps the pre-engine write path (owner Q1: never block earn / redeem,
  never a mixed history) — logged loudly.
- **Batch confirm:** the B9 ascending wallet pre-lock runs for every tenant; the confirm no longer takes the (mode)
  shared advisory lock.

**SAFETY GATE (the one rule that replaces the mode switch's precondition):** before any POINTS reversal is created or
approved, every wallet that received that (batch, outlet, field) credit — and, when no credit position exists, the
outlet's current partner's wallet — must be sequenced or pristine. Otherwise the request is REFUSED, loudly, with
nothing written:
- history but `movementSeq = 0` and not BLOCKED → **409 `WALLET_NOT_SEQUENCED`**: "Can't reverse: the wallet of
  outlet X (program Y) has points history that has not been prepared for reversals yet. Gifsy must run the wallet
  backfill for Y first, then retry. Nothing was changed …";
- BLOCKED by the backfill → 409 `WALLET_NEEDS_ATTENTION` with the backfill's reason (unchanged);
- every refusal is audited (`REVERSAL_ENGINE_REFUSAL`) and listed on the attention banner. Never a fall-back to
  "subtract from the balance", never a partial apply.

**Readiness (never silent):** `GET /v1/admin/credits/reversal-engine/attention` → `readiness { unsequencedWithHistory,
blocked, ready, message }` for every tenant (the `mode` / `effectiveMode` / `modeWarning` fields are gone); the
credits → Payout Status banner mounts for every tenant and shows the message; the Daily Ops Digest adds "N wallets
with points history not yet prepared for reversals — run the wallet backfill" (+ blocked) when > 0. Predicate:
`movementSeq = 0` AND backfillStatus NULL/DONE AND (any balance / counter ≠ 0 OR any transaction row).

**Tenants at the retirement:** Bajaj prod — backfill APPLIED 2026-11-21 (2,281 wallets sequenced, 0 blocked, 0
un-sequenced with history, 8 debt wallets 3,549 pts); **no switch call is needed**. ⚠️ Until this release deploys,
prod still runs LEGACY, so any Bajaj wallet created / first credited after the backfill is written un-sequenced —
check the readiness line after deploy and re-run the Bajaj backfill if it is > 0. Deoleo — 98 wallets, zero wallet
transactions: **nothing to backfill**; its first movements are sequenced from seq 1. Bajaj staging — already V2
(its `reversalEngine` row is now ignored).

**Fix round after the dual audit (2026-11-21, no blocker / no number-changing bug):**
- A1: every POINTS reversal created now gets a marker audit row (`POINTS_REVERSAL_ENGINE_MARKER`, entityId = reversal
  id, same transaction). Approve refuses a POINTS reversal without it (409 `RAISED_UNDER_OLD_ENGINE`: "raised under the
  old reversal engine … reject it and re-raise it") — never a silent switch of rules. Prod had 0 reversals at the
  retirement; Bajaj staging's pending POINTS reversals must be re-raised. Reject needs no marker.
- B1: `WALLET_NOT_SEQUENCED` names the client by display name (`branding.displayName` → `internalName` → slug) and
  the next step "Gifsy: run the wallet backfill (dry run, then APPLY) for this client — see
  BAJAJ-PROD-FOLLOWUPS-RUNBOOK §C" (same wording in the readiness line and the digest bullet).
- A2: the unsequenced-movement warning is logged once per wallet per hour per process, with a running counter.
- A3: with no credit position, the gate also checks wallets holding a pre-metadata credit of the batch (no
  outletCode; `{fieldId}` of this field or nothing) for exactly a batch-row amount of the line — a previous partner.
- A4: batch confirm keeps ONE atomic transaction (chunking would risk a partially credited batch); instead a
  redemption takes its wallet row lock first with `lock_timeout 5s` and, if a confirm holds it, refuses with "Points
  are being updated for this wallet right now … try again in a minute. Nothing was deducted."
- Post-deploy check for every tenant, rollback note (prefer forward fix) and the Deoleo retailer-visible change:
  `BAJAJ-PROD-FOLLOWUPS-RUNBOOK.md` §C-POST / "Rollback of the retirement release" / "Deoleo — what changes".

**Migrating a client with imported points history (playbook rule):** import → run the wallet backfill (DRY RUN →
backup → APPLY → VERIFY, §9.1) **before the client's first points reversal**. The readiness line shows "N wallets not
yet prepared" until it is done, and every reversal touching such a wallet is refused (`WALLET_NOT_SEQUENCED`).
A brand-new client with no imported history needs nothing.

---

## 1. Why this exists (history — so nobody repeats it)

Points credited to partner wallets (credit-batch uploads) can later be **reversed** (an admin approves a reversal).
Bajaj's prod import created **8 wallets with a NEGATIVE balance** (vendor sales returns; owner kept them negative,
2026-11-12). The old reversal code floored every reversal at 0, which on a negative wallet did the wrong thing — and an
audit found it could even **add** points (`Math.min(magnitude, negativeBalance)` → negative decrement).

Owner rules that a correct engine must satisfy:
- **R1** a reversal fully undoes a credit that landed on a negative wallet (−841, +500 → −341, reverse → −841).
- **R2** ~~otherwise a reversal never pushes a wallet below 0 (old behaviour: floor 0, unrecovered remainder = shortfall)~~
  — **changed by owner decision 2026-11-19 (V2 engine only):** a reversal always takes back the whole amount; whatever
  the wallet no longer holds (already redeemed / expired) becomes wallet **debt**, repaid from future earnings — nothing
  is written off. Example: reverse 10,000 from a wallet holding 7,014 → balance −2,986, debt 2,986. A reversal the
  wallet can cover is unchanged (= today). **LEGACY (Deoleo) keeps the floor-0 rule and its written-off shortfall.**
  Reversals approved before the change keep their recorded outcome (no history rewrite). §8.6.
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
comes back, and any points the wallet still holds are removed; points already spent become debt* (owner 2026-11-19 —
before that: *are shortfall*). R1 and R2 fall out
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
| **Reversal** of X by `r ≤ a_X − ρ_X` | `p = min(r, O_X)` (restore the debt X paid off); `c = min(r − p, H)` (remove points still held); **`q = min(r − p, E_X − ε_X)`** (X's own points that already expired — counted as recovered, owner decision 1, §8.7); `c = min(r − p − q, H)`; **owed `s = r − p − q − c`** (already spent); `B −= r − q`; `D += p + s`; `O_X −= p`; `ε_X += q`; `ρ_X += r`; shortfall 0 (owner 2026-11-19 — before: `B −= p + c`, `D += p`, shortfall = s). H drops by exactly c. |

### 3.3 The one rule and how the owner rules fall out
Floor of a reversal of X = `−(D + O_X)`.
- **R1:** −841, X +500 → D 341, O_X 500, B −341; reverse → −841. ✅
- **R2 (as changed 2026-11-19):** never-negative wallet → D = 0, O_X = 0 → taken from the wallet `c = min(r, B)` = today's
  decrement; the rest `r − c` becomes debt instead of shortfall, so the balance ends at `B − r`. Identical to today
  whenever `r ≤ B`. Deoleo runs LEGACY (floor 0) and is unaffected. ✅
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
totals don't (Q2). **Still holds after 2026-11-19:** `B_final = B_0 − Σr` trivially, `Σs = Σ(r − p) − Σc` and Σp, Σc are
order-free, so `D_final = D_0 + Σp + Σs` is too; the *split* of owed between reversals follows Q2 (first approved
recovers first).

## 4. Data model (WP1 ✅ built — `f5677f1e`, migration originally `20261117120000`; since the 2026-11-19 fix round (B3) split — since fix round 3 (B1/B6) into 44 files `api/prisma/migrations/20261119120000_wre_columns_wallets` … `20261119124300_wre_validate_…`, one live table per file, §8.5; + `20261119124400_wre_allocation_over_reversal_debt` + `…124500` = 46, §8.6–8.7)
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
  debtRestored (p), recovered (c), owed, overReversalDebt, shortfall`, unique (creditReversalId, positionId). `owed` = taken
  beyond holdings, booked as debt: a historical clawback (backfill, Q4, `overReversalDebt` false) or a V2 over-reversal
  (owner 2026-11-19, `overReversalDebt` true — migration `20261119124400_wre_allocation_over_reversal_debt`).
- **`PayoutReversalAllocation`** (`payout_reversal_allocations`): `creditReversalId, payoutEntryId, amountPaise BigInt,
  state @default(RESERVED), tdsOffsetPaise BigInt @default(0)`, unique (creditReversalId, payoutEntryId) + **partial
  unique index on payoutEntryId WHERE state IN live states** → an entry can never be consumed by two live reversals.
- Enums `CreditAttribution {EXACT LEGACY_REPLAY MANUAL UNRESOLVED}`, `PayoutAllocationState {RESERVED APPLIED_CANCELLED
  APPLIED_RECEIVABLE RELEASED}`. New-table FKs onDelete Restrict.
- Raw-SQL CHECKs in the migration: `debtPoints ≥ 0`, `movementSeq ≥ 0`, `seq IS NULL OR seq > 0`, position bounds
  (`amount > 0`, `0 ≤ offset ≤ amount`, `0 ≤ reversed ≤ amount`, non-UNRESOLVED requires outletCode+fieldId),
  allocation sums (`p + c + owed + shortfall = requested`, all ≥ 0 — `owed` added by policy round A, Q4), payout
  `amountPaise > 0`, `tdsOffsetPaise ≥ 0`, BLOCKED wallet ⇒ reason. Policy round A also added `wallets.backfillStatus /
  backfillBlockedReason / backfillCheckedAt` (+ index) — §12.1.
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
- **Lock order (deadlock-free):** [engine advisory lock, shared] → credit_batches → credit_reversals (the one being
  approved) → wallets (ascending id) → wallet_credit_positions → points_ledger → credit_payout_entries (ascending id).
  V2 and LEGACY approve both take batch → reversal (fix round A, L3). **`confirmBatch` does NOT pre-lock its wallets
  ascending (fix round A, L3 decision):** each LEGACY credit is one atomic `UPDATE` (implicit row lock) exactly as on
  origin/main, and pre-locking would add statements to every Deoleo confirm (L5 parity). Two concurrent confirms that
  share wallets in opposite row orders can deadlock — Postgres detects it and aborts ONE transaction, which rolls back
  whole (confirm is all-or-nothing, `PENDING_CONFIRM` stays) and is safely retried; no money effect. This is the
  pre-existing origin/main behaviour; the guarded `PENDING_CONFIRM → CONFIRMED` flip still prevents a double credit.
- State maintenance runs for **all tenants** and is **B-neutral** (balances/counters/lots identical when D = 0).
- **To delete** once V2 replaces them: `clawedBackForEarlierCredits`, runtime `findOriginalBatchCredit` (logic moves to
  the one-off backfill), legacy half of `creditedPointsForBatchRow`, `debitFloor`, patchReversal's current-partner wallet
  resolution.

## 6. Reversal algorithm (WP3/WP4, NOT built)
```
approve POINTS reversal (credit batch B, outlet O, field F, amount r):
  lock credit_batches row
  positions = wallet_credit_positions WHERE batch=B AND outlet=O AND field=F ORDER BY creditTx.seq FOR UPDATE
  if none → 409 wallet needs attention / credit unmapped, or 400 settle off-platform -- R5, Q5, P-A1
  if an UNRESOLVED credit could be THIS line's → 409 "map it first" (line only)      -- P-A3
  cap = Σ(amount − reversedPoints); r > cap → 400                                     -- R5
  guarded flip CreditReversal PENDING_GIFSY → APPROVED/PARTIAL                        -- never twice
  for pos in positions (oldest seq first) while remaining > 0:
     r_i = min(remaining, pos.amount − pos.reversedPoints)
     lock wallet pos.walletId FOR UPDATE; (p, q, c, s) = WP0.reverse(state, pos + E_X/ε_X, r_i) -- q expired, s owed
     applyMovement(DEBIT_ADJUSTMENT, points −r_i, pointsDelta −(r_i − q), debt += p + s, reversedCreditTxId, creditReversalId)
     lots: draw c from pos.lotId first, then FIFO                                    -- Q7
     pos.offsetPoints −= p; pos.reversedPoints += r_i
     insert CreditReversalAllocation(r_i, p, c, owed s, alreadyExpired q, overReversalDebt s > 0, shortfall 0) -- unique
  CreditReversal.shortfallPaise unchanged (0 — nothing written off; owner 2026-11-19)
create cap = Σ(amount − reversedPoints) − Σ pending requested
```
O(k) rows (k = positions for the (batch, outlet, field), normally 1) + O(L) lots. No wallet-history scan.

## 7. FIFO lots / expiry (WP2)
Lot mirror becomes `Σ remaining(non-expired) = H = B + D` (today's `= B` is the D = 0 case). New credit lot remaining
`a − o`. Reversal's recovered part `c` consumes **the reversed credit's own lot first**, then FIFO — a bug fix: today the
oldest lot is burnt and the reversed credit's own lot survives (extends expiry of reversed points). Expiry keeps today's
clamp; excess is reclassified as debt repayment. Redemption refund is a credit (repays debt first).

**Bajaj negative wallets and expiry (fix round A, M4 — no code change):** Bajaj has **no points expiry** — verified on
prod 2026-11-16 (owner-relayed check): 0 of 29,283 points-ledger lots carry an `expiresAt` — so the expiry sweep never
touches a Bajaj lot and the 8 negative wallets are unaffected. Behaviour stays as today (Q6 clamp,
excess = debt repayment) should Bajaj ever configure expiry. An expiry that only repays debt (e = 0, x > 0) now leaves an
audit trace (L1, §12.1 fix round A).

## 8. PAYOUT (₹) reversals (WP5 ✅ `4187cb6d` — SHADOW/V2 tenants; LEGACY keeps the §10 interim rule)
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

**As built (WP5, `api/src/credits/payout-reversal-v2.ts`):**
- Create (`createReversal`): flag SHADOW or V2 → `payoutEntryIds` required, Σ = requestedPaise, each a selectable entry of
  the (batch, outlet, field) (not REVERSED, not held by a live allocation, not consumed by an interim/legacy approval —
  same `consumedPayoutEntryIds` + pre-column cutoff rule as §10); entries locked FOR UPDATE ascending → RESERVED rows
  + audit row. LEGACY → the interim exact-subset path, byte-identical; `payoutEntryIds` refused there and for POINTS.
  PROCESSING entries may be reserved (approval refused until the UTR / failure is recorded). SHADOW = V2 for PAYOUT
  (no money math to shadow) — owner question.
- Approve / reject (`patchReversal`) dispatch on the reversal's allocation rows, NOT the flag (a rollback to LEGACY
  never strands a reservation; a pending reversal raised under LEGACY keeps the interim path). Approve also writes
  `consumedPayoutEntryIds` so the interim selector stays correct after a flag rollback.
- Downloads: `reversalAllocations: none RESERVED` on the read + a post-claim re-check in the download tx (race →
  409, rolled back, retry). Held entries are reported: `X-Reversal-Held-Count/-Paise` headers → amber notice on the
  payout screen, suffix on the "nothing payable" refusal, audit row `PAYOUT_DOWNLOAD_REVERSAL_HOLD`.
- Call-outs (owner rule 2026-11-15, no silent pass-throughs): picker shows every entry + why it's blocked; pending
  card lists held entries + what approval will do; approve/reject result (`payoutOutcome`: cancelled / receivable /
  TDS offset or why not / released) shown on the payout screen; receivable = "Pending" in Processed Reversals; audit
  rows `PAYOUT_REVERSAL_ALLOCATION` (CREATE/APPROVE/REJECT) for every step.
- Backfill: `planPayoutAllocationBackfill` (pure; **wired into the WP6 runner by policy round A** — flags in the run's
  anomaly list + ATTENTION block, rows inserted on APPLY under the batch row locks after an identical re-plan, verify V9b) — consumed ids → APPLIED_* rows; pre-column approvals derived only
  when all / exactly one subset of settled entries fits (WARNING `DERIVED_LEGACY`), else `AMBIGUOUS_LEGACY`
  (BLOCKING); `DOUBLE_CONSUMPTION`, `ENTRY_MISSING`, `ENTRY_NOT_SETTLED`, `AMOUNT_MISMATCH` (BLOCKING),
  `SHORTFALL_MISMATCH` (BLOCKING since fix round 3 — B3: no rows; "approved under the old gross rule — needs a decision"), `PENDING_LEGACY` (INFO). Never writes entries/reversals/money; re-runs skip
  reversals that already have rows. **Wired into the WP6 runner by policy round A** (it loads the tenant's PAYOUT
  reversals + their entries + existing allocations, print the flags in the anomaly list, and `createMany` the rows
  in APPLY). V2 is correct without it (create excludes legacy-consumed entries itself); it completes V9/reporting.
- Tests: `payout-reversal-v2.spec.ts` (in-memory Prisma fake with rollback + the live partial unique index):
  T-pay1..5, reservation-vs-download (skip + race), lock order, double approval, flag rollback, backfill, call-outs;
  platform `status-payout-reversal-entries.test.tsx`, `payout-reversal-held-entries.test.tsx`.
- ⚠️ Superseded by §8.1 (2026-11-16): SHADOW no longer takes this path for PAYOUT reversals; a PAID entry's receivable
  is now the NET cash received and its withheld TDS becomes a TDS credit.

### 8.1 Policy round B (owner decisions 2026-11-16) — as built on `feat/wre-pol-b`
**B1 — SHADOW = LEGACY for PAYOUT reversals.** Only `V2` picks entries / reserves them. `createReversal` takes the
engine path only when the flag is `V2`; `GET …/payout-reversal-entries` returns `mode` = the effective PAYOUT mode
(`V2` or `LEGACY`) plus `engineMode` (the raw flag), so the status screen shows the amount form on SHADOW. Approve /
reject still dispatch on allocation rows (a reversal reserved under SHADOW before this change still completes).

**B2 — reversing a PAID entry whose TDS was DEDUCTED (V2 only; LEGACY/SHADOW keep the full-amount receivable).**
⚠️ Superseded in part by §8.2 (fix round B): the credit is CAPPED (H1), scoped by DEDUCTOR not tenant (D4 — 194C credits
are usable by every programme on the PAN), and the base exclusion uses the `tdsBaseReversedAt` marker for every V2
PAID reversal (D1). Read §8.2 for the current rules.
- Receivable = `amountPaise − tdsDeductedPaise` (net cash received), stored on the allocation (`receivablePaise`) and
  summed into `CreditReversal.shortfallPaise`.
- Credit = the entry's own withholding as booked in the TDS ledger (Σ `tdsDeductedThisPaise` for the entry, capped at
  the stamp) **+ any earlier TDS credit that had been applied to this payout** (that TDS was attributed to the
  now-reversed income; all of it is deposited). One `TdsCredit` row per reversed entry (`sourcePayoutEntryId` unique),
  keyed **(tenant, PAN, section, FY)**; the PAN is the one the payout was deducted under (ledger row, else the applied
  credit's PAN). Withheld but not traceable to the ledger (e.g. imported history) → no credit, called out. GROSS_UP
  (`tdsDeductedPaise = 0`) → receivable = amount, no credit, called out ("no TDS was withheld from the retailer; the
  program paid it on top").
- The source entry's base **leaves the PAN's cumulative TDS base** (`tdsCredit: { is: null }` on the prior-base reads
  of `buildPayoutTdsPlan` and the TDS liability report `tds.service` 194R/194C) — the income was reversed. This is what
  keeps the cumulative ledger consistent: Σ deposited − TDS due on the remaining income = Σ outstanding credit.
- **Application** (bank download, under the existing PAN advisory lock `PAN|<pan>|<fy>`): for each DEDUCT group the plan
  hides OTHER tenants' outstanding credits from the cross-tenant prior-deducted figure and computes the deduction with
  and without this tenant's own credits (`deductWithCredits`, `api/src/credits/tds-credit.ts`); the difference is the
  credit applied (0 ≤ applied ≤ outstanding, ≤ TDS due), split over the entries by their TDS due, drawn FIFO. E.g. due
  ₹500, credit ₹200 → ₹300 withheld; due ₹310, credit ₹400 → ₹0 withheld, ₹90 carried forward. The ledger records the
  NEW cash withheld. One `TdsCreditApplication` per (credit, entry); `appliedPaise` bumped with a guarded UPDATE
  (`appliedPaise + x ≤ amountPaise`, else the download rolls back) + SQL CHECK + partial unique live index.
- **Undo**: an application is RELEASED (credit restored, `releasedAt` + reason) when the payout it reduced never happens
  — UTR FAILED (`uploadUtr`) or the entry cancelled by a reversal (V2 and LEGACY cancel paths). A re-bank re-applies.
  A reversal that is REJECTED never created a credit (credits are created at approve only).
- Credits are FY-scoped (the DEDUCT ledger is per FY) — see open question O2.
- No credits on a tenant (every LEGACY tenant, Deoleo) → `buildPayoutTdsPlan` takes the unchanged branch (bit-for-bit
  the old computation), one extra indexed read; the base exclusion filters nothing.

**B3 — approve/reject OUTCOME SUMMARY on every tenant (display only).** `PATCH /reversals/:id` returns
`payoutOutcome { headline, lines[], cancelled[], receivable[], receivablePaise, tdsCreditPaise, released[] }` for every
PAYOUT reversal (LEGACY path builds it from what it did; data written is unchanged). Lines: "Entry cancelled · ₹5,000 ·
will not be paid", "Recorded as owed · ₹9,800 · ₹200 TDS credit carried forward on PAN XXXXX1234F", "Entry released ·
₹500 · goes into the next bank file again", LEGACY reject "Rejected · no payout entry was held or changed".

**Call-outs (owner rule: no silent pass-throughs)**
| Event | Where it is said |
|---|---|
| Entry cancelled (± TDS offset, ± credit it had used returned) | approve outcome line; audit `PAYOUT_REVERSAL_ALLOCATION` APPROVE |
| Receivable recorded (net) + TDS credit created | outcome line + headline; allocation `receivablePaise/tdsCreditPaise`; audit APPROVE metadata |
| GROSS_UP receivable (no credit) / untracked TDS (no credit) | outcome line + `tdsNote` |
| LEGACY PAID receivable with TDS withheld (not adjusted) | outcome line + `tdsNote` |
| Rejected / released | outcome headline + lines; audit REJECT (V2) |
| TDS credit applied at a download | `X-Tds-Credit-Applied-Count/-Paise` headers → blue notice on the payout screen; `tdsCreditApplied[]` (per entry: due / credit / withheld); audit `TDS_CREDIT_APPLIED` |
| TDS credit returned (payout FAILED) | UTR apply result `tdsCreditReleased[]` → "TDS credit returned" panel |
| Credits outstanding / applied / released | TDS payout report JSON `tdsCredits` + panel on /admin/tds-payouts; export kind `tds-payouts` extra sheet "TDS Credits" (only when the scope has credits — Payouts/Summary stay byte-identical) |

**Schema** — NEW migration (then `20261117130000_payout_reversal_tds_credit`; now part of the split `20261119120000…124300` files, §8.5):
`payout_reversal_allocations.receivablePaise/tdsCreditPaise` (+ CHECK receivable ≤ amount, both ≥ 0); tables
`tds_credits` (unique `sourcePayoutEntryId`, CHECK `0 ≤ applied ≤ amount`, amount > 0) and `tds_credit_applications`
(partial unique `(tdsCreditId, payoutEntryId) WHERE releasedAt IS NULL`). Verified to apply on PGlite after all 73
earlier migrations.

**Tests** — `api/src/credits/tds-credit.spec.ts` (pure: owner example, partial, threshold, tenant scope, FIFO, 2,000-case
property test, idempotent release); `payout-reversal-v2.spec.ts` "Policy round B" (9 end-to-end service cases: net
receivable + credit + PAN lock, idempotency, GROSS_UP, applied next payout, partial/carry-forward over 3 downloads,
concurrency rollback + no double use, undo + re-apply, credit of a payout that itself used credit, tenant scope) and
SHADOW = LEGACY + LEGACY outcome summary with data unchanged; `credits.service.spec.ts` UTR FAILED release;
`tds-reports.service.spec.ts`, `tds-payouts.kind.spec.ts` (extra sheet, Payouts/Summary parity); platform
`payout-reversal-held-entries.test.tsx`, `tds-payouts-api.test.tsx`.

**Open questions (owner)** — answered 2026-11-16, see §8.2: O1 → D1 (the reversed base ALWAYS leaves), O2 → D2 (stays
in its FY, said on the report/export), O3 → D3 (keep the automatic hand-back, make it visible + flag the PAN).

**L4 — a reservation made earlier still dispatches by DATA.** Approve / reject look only at the reversal's allocation
rows (`patchPayoutReversalV2` returns null when there are none): a PAYOUT reversal reserved while the tenant was V2 (or
SHADOW before B1) completes on the engine path even after the flag goes back to LEGACY/SHADOW, and a reversal raised
under LEGACY keeps the interim path even after the flag becomes V2. The flag only decides how NEW requests are created.

### 8.2 Fix round B (owner decisions D1–D5 + money/screens audit, 2026-11-16) — as built on `feat/wre-fix-b`
**Schema** (inside the never-applied `20261117130000` migration; Prisma client regenerated in the shared
`node_modules`): `credit_payout_entries.tdsBaseReversedAt` / `tdsBaseReversalId` (D1 marker) and
`credit_reversals.requestRemarks` (D5). Nullable, metadata-only ALTERs.

- **D1 — a reversed PAID payout ALWAYS leaves the PAN's yearly TDS base** (V2 approve marks the entry whether or not TDS
  was withheld; LEGACY and backfilled receivables are NOT marked — Q13). Every base read uses the marker instead of
  `tdsCredit: { is: null }`: `buildPayoutTdsPlan` (PAN + no-PAN paths), `panPositionForReversal`, `tds.service`
  194R/194C. The 194R/194C liability rows carry an optional `reversal { reversedPaise, items[], belowThresholdAfterReversal,
  notes[] }` — "₹X reversed on <date>", "PAN below threshold after reversal" — and a PAN whose whole base was reversed
  still gets a base-0 row. Rows without a reversal are byte-identical (summary gains `reversalFlags` only when > 0).
- **H1 — credit cap.** `credit = min(own + earlier, max(0, Σ ledger − Σ outstanding credits − due(remaining base)))` in the
  deductor scope, threshold on the remaining COMBINED base (`reversalCreditCap` + `CreditsService.panPositionForReversal`,
  run after the marker, under the PAN locks — now also the PAN the base counts under today). The rest of own + earlier
  is called out: "₹X of this TDS covers the retailer's other payouts — no credit". Auditor example (194R 10 %, ₹20,000):
  A ₹15k · B ₹10k (₹2,500 withheld) · C ₹10k (₹1,000) → reversing B credits ₹1,000 (was ₹2,500); D ₹10k next → the
  ₹1,000 credit covers D's own TDS exactly. Cross-tenant 194C case (Bajaj's catch-up covered Deoleo's payouts): credit =
  the drop in the PAN's TDS due only.
- **D2 — unused credit stays in its FY**: TDS payouts report / export "TDS Credits" sheet say "₹X unused credit for FY …,
  not carried forward" once the FY has closed; every credit shows its scope ("Scoped to FY … · 194C · usable by any
  programme on this PAN" / "· 194R · this programme only", L2).
- **D3 — hand-back made visible.** The withholding is unchanged (`computeDeduction(prior = ledger)`), but when the PAN has
  engine-reversed base in scope the plan explains the difference: `deductWithCredits(priorDuePaise)` splits the TDS due
  on the payout into hand-back + credit + withheld. Line on the payout's TDS: "₹X less TDS: adjusted after a reversal
  brought PAN below the limit" (download response `tdsAdjustments[]`, header `X-Tds-Adjustment-*`, audit
  `TDS_REVERSAL_ADJUSTMENT`, TDS payout report row `tdsNote`); approve outcome says "₹X over-deducted TDS handed back on
  the next payout"; the 194C liability row flags "₹X TDS withheld beyond what is now due — handed back on the next payout".
  No reversal on the PAN → the old branch, no line (Deoleo identical).
- **D4 — scope by deductor** (`deductorScopeClientId` / `inDeductorScope`): 194C (Gifsy) → base, ledger and credits across
  ALL tenants incl. Deoleo; a credit raised by another programme is used and said so ("₹X adjusted from earlier TDS
  credit (another programme)"; `otherProgrammePaise`; the guarded UPDATE allows a 194C credit for any payer).
  194R (the client) → base, ledger, credits and gross-up recovery strictly within the client (plan + position + report).
  ⚠️ This also changes the 194R plan for a PAN paid by TWO clients' visibility 194R streams in one FY (it used to be
  pooled) — see open question F1.
- **D5 — remarks on every tenant**: `CreateReversalDto.remarks` (≤ 1,000) → `requestRemarks` (written only when typed);
  approve/reject `remarks` trimmed (blank → null), ≤ 1,000; both in the reversal list + V2 audit rows (CREATE / APPROVE /
  REJECT); screens send and show them (status page both create paths, payout page approve/reject + cards).
- **M2** — a reversal after the payout's month closed flags the liability row "Changed after reversal on <date> — revise
  return if already filed" (`items[].retroactive`).
- **L1** — payments report rows: `reversal { receivablePaise, tdsCreditPaise, reversedAt, note }` and `tdsCreditPaise` /
  `tdsNote` (same page query; the export is unchanged). TDS payout report rows: `reversedNote`, `tdsNote`, `clientName`.
- **L3** — shortfall written on every approval that recorded a receivable, also ₹0; headline "₹0.00 owed — the whole
  amount paid was withheld as TDS". **L5** — one wording for a reversed PAID entry (`paidEntryOutcomeText`: net owed,
  TDS withheld, credit or why none, H1/D1/D3) and one for a download TDS line (`tdsAdjustmentNote`); the screens share
  `platform/src/lib/payout-reversal-copy.ts`. **L6** — a credit whose source outlet's retailer now has another PAN:
  "Credit on previous PAN XXXXX — not applied automatically".
- **Screens**: bank-file notices read `GET …/payout-downloads/:id/summary` (or `latest-summary?period&groupType&fieldId`)
  JSON after each download (headers are only a fallback); picker loading / failed-load retry / Submit gating, no PAID
  pre-tick, reload after a taken entry, Approve disabled while a held entry is PROCESSING, outcome cleared per action,
  `finally` on every submit, notices cleared on period change, one 2-decimal ₹ formatter (`lib/money-format.ts`), dialog
  a11y (role/aria-modal/Escape/focus trap/return focus), TDS credits panel server-paged (`creditPage`/`creditLimit`,
  `creditsOnly=true` for a page flip) with tenant name + masked PAN. The attention banner mounts only when the attention
  response `mode` is not LEGACY (Deoleo's status screen is unchanged).

**Open question F1 (owner)** — D4 makes the 194R payout plan per client. A retailer PAN paid by two clients' 194R
visibility streams in the same FY used to be pooled (one threshold, one ledger across both); it is now per client, which
is what the 194R liability report already did. Deoleo's numbers change only for such a shared PAN. Recommendation: keep
(the client is the deductor, the report already works this way); check prod for shared 194R PANs before release.

### 8.3 Merge with prod `7ba69566` (owner decisions 2026-11-19) — as built on `feat/wre-release`
Prod shipped its own TDS rules (VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md §9): 194R on ONE whole-year shared definition
(`tds-194r.shared.ts`, used by the payout engine and the 194R report), keyed by the payee PAN snapshot, one advisory lock
`R194|client|FY`, offsets in the original FY, a fully withheld payout settled without the bank, "excess = flag only". WRE's
fix round B had built the TDS credit on the pre-ship 194R code. Owner decisions:

| # | Decision | As built |
|---|---|---|
| M1 (⚠️ SUPERSEDED by D2, §8.4) | V2 reversal of a PAID payout FULLY withheld as TDS | The SHIPPED rule (same as LEGACY): entry → REVERSED, withholding offset (negative ledger row in its original FY) under the `R194\|client\|FY` lock (194C: its `PAN\|…` lock), no receivable, any credit it used released; allocation `APPLIED_CANCELLED` (`payout-reversal-v2.ts`, `isFullyWithheld` branch). |
| M2 (= A) | TDS credit on the shipped whole-year 194R calculation | **D1** filter inside `collect194RBases` (a marked PAID payout is left out and reported via `reversedSink`) → engine and report share it (parity spec `tds-194r.spec.ts` "WRE D1 + credit"). **Cap (H1)** `CreditsService.panPosition194R`: base from `collect194RBases`, TDS due = `liability194R(…, CURRENT method).deductPartPaise` (the report's own figure), ledger = `deducted194RByRetailer`, open credits = `openCredits194RByRetailer`. **Credit** keyed on the ledger row's own key (`retailerKeyOfLedgerPan` — the payee snapshot key, incl. `__NO_PAN__:<partner>`), in the ledger row's FY, under `R194\|client\|FY` (bank-file FY + ledger FYs + credit FYs, one sorted lock statement). **Engine** `plan194RDeductions`: no credit and no reversed base for the retailer → the shipped computation unchanged; otherwise `deductWithCredits` — the withholding is STILL `computeDeduction(prior = ledger)` on the D1 base (a credit is TDS already in the ledger; subtracting it from "already deducted" as well would withhold it twice), the credit / hand-back only explain + split it and draw credits FIFO. **Excess** (194R report) = deducted − OPEN credits − retailer's share (an APPLIED credit is not subtracted: once applied it covers the later payout's share — subtracting it too would hide real excess). |
| M3 (194C part SUPERSEDED by D1, §8.4 — no 194C credit / base marker exists any more) | Cross-programme 194C credit (old D4) | NOT acceptable: a credit is used ONLY by the client that raised it (`loadOpenTdsCredits({ clientId })`, guarded UPDATE `"clientId" = payer`). The 194C D1 base exclusion and the D3 hand-back apply only to the reversing tenant's own entries (`NOT { tdsBaseReversedAt: { not: null }, clientId }`) → another programme's (Deoleo's) 194C download is byte-identical. The H1 cap for 194C uses that same tenant view against the cross-tenant ledger. |
| M4 | LEGACY approval | Prod's rules (net receivable; fully withheld → reversed + offset); the WRE outcome summary rewritten to say exactly that ("Recorded as owed · ₹294.00 (paid ₹300.00 − TDS ₹6.00) …", "Entry reversed · … nothing reached the retailer — nothing owed"). |
| M5 | Daily Ops Digest tripwire | The D1 marker on a PAID entry is a RAW `UPDATE` (a Prisma update would bump `updatedAt` and re-count the old payment as paid today) — registered in `digest-recorded-time-guard.spec.ts` together with the two V2 status flips. |

Known limit (for the audit): the Gifsy-wide 194C liability report still excludes a V2-reversed 194C payout from the PAN's
base (report view, all tenants), while other tenants' payout plans keep counting it (M3). No V2 tenant has 194C DEDUCT
visibility today (Bajaj = 194R GROSS_UP).

### 8.4 Fix round after the dual audit (owner decisions 2026-11-19) — as built on `feat/wre-release`
| # | Decision / finding | As built |
|---|---|---|
| **D1** (owner, ⚠️ PLATFORM-WIDE — every tenant incl. LEGACY / Deoleo, explicitly approved) | A 194C payout can't be reversed once PAID | `credits/reversal-194c.ts`: any reversal that would touch a PAID entry whose EFFECTIVE section is 194C (frozen `SEC_194C`, or a legacy visibility row without a frozen section) is refused 400 **"194C payouts can't be reversed once paid"** + the amount(s). LEGACY: the exact-subset chooser prefers a fitting subset without one, then refuses at create AND approve (an entry paid in between). V2: the picker shows it blocked (`PAID_194C`: "Paid 194C payout — 194C payouts can't be reversed once paid") and approve refuses it. Before PAID nothing changes. The 194C credit / base-leave machinery is GONE: no 194C TdsCredit, no 194C `tdsBaseReversedAt`; the 194C payout plan, the 194C report filter and its row flags are back to 7ba69566 — Deoleo's 194C figures can never move (audit A#1 / B#1). |
| **D2** (owner) | A FULLY withheld PAID 194R payout reversed on V2 gets a TDS credit (replaces M1's negative ledger row) | `payout-reversal-v2.ts`: the entry is REVERSED (status only — the TDS stays withheld/deposited, stamp + ledger untouched), receivable 0 (the retailer owes nothing), and `recordReceivableTds(fullyWithheld)` creates the credit with the SAME cap / key / FY / `R194\|client\|FY` lock as a partly withheld one; allocation `APPLIED_CANCELLED` with `tdsCreditPaise`. Outcome bucket `reversedWithheld` + line "Entry reversed · … nothing reached the retailer — nothing owed · ₹X TDS credit carried forward". LEGACY keeps the shipped rule (offset), worded the same way (B4). |
| A2 | Incentive payout without a frozen section took 194C locks | Every PAID entry that reaches the receivable path is 194R (D1) → `receivablePanLockKeys` always takes `R194\|client\|FY` (bank-file FY + ledger FYs + credit FYs); the approval note cites the bank-file FY ("taken off X's FY … 194R base (the FY of its bank file)") and the payee snapshot key. |
| A4 | Open credit lowering the excess must be visible | `openTdsCreditPaise` serialised on 194R rows (API), an "Open TDS Credit (₹)" export column (only when a row has one), and a row note "₹X open TDS credit … not counted as excess" (screen + export). |
| A5 | GROSS_UP credit can never be used and hides excess | A 194R credit is created only while the client's CURRENT method is DEDUCT; otherwise none — the withheld TDS stays the report's flagged excess, and the approval outcome says so ("not credited — the programme is on gross-up now; flagged as TDS taken in excess"). |
| B2 | Backfill planner recorded gross receivables | `planPayoutAllocationBackfill` records NET (`amount − tdsDeductedPaise`), matching prod's interim rule; the store reads `tdsDeductedPaise`. |
| B3 | One long-locking migration | Split (superseded by fix round 3 B1/B6: 44 files, one live table each — §8.5) — see the runbook below. |
| B4 | LEGACY wording | Cancelled unpaid entry: same TDS wording as V2 (never "no TDS withheld" when withheld but not offset); a fully withheld PAID entry is no longer "cancelled" — headline "N fully-withheld payout(s) reversed (₹X) — nothing reached the retailer, nothing owed", the processed-reversals list says "(was paid — fully withheld as TDS) — reversed · nothing owed". |
| B5 | LEGACY / Deoleo byte-identity | `clientName` + WRE notes only on rows that carry a note; `tdsCredits` block only when the scope has credits; `requestRemarks` omitted when null; the channel-partner `wallets` include omits the WRE columns; the PAYOUT reversal modal shows the amount form immediately (no wait on the entries read; V2 switches to the picker once it answers). Exceptions listed in the release report. |
| B6 | FAILED UTR releasing a credit without its lock | The UTR upload also locks the credit's key for every entry with a live credit application. |
| B7 | Raw UPDATEs without tenant | `"clientId"` added to the base-marker and credit-release UPDATEs. |
| B8 | Log-only capped offset on expiry | Reachable (backfill never rewrites lots) → audit row `POINTS_EXPIRY_OFFSET_CAPPED` + attention endpoint `expiryOffsetCapped[]` + banner section. |
| B9 | Lock order confirm vs V2 reversal | `confirmBatch` on a SHADOW/V2 tenant pre-locks every existing target wallet in ascending id (one statement) before crediting; LEGACY unchanged. |

**Worked example (D2 — Ramesh, 194R on DEDUCT, 10 %, ₹20,000 FY limit):** payout 1 ₹19,000 (no TDS, under the limit);
payout 2 ₹1,500 → the year reaches ₹20,500 → ₹2,050 due, the whole ₹1,500 is withheld (fully withheld, ₹0 reached
Ramesh, ₹550 carried forward). Payout 2 is reversed. Next payout ₹10,000 → year (without payout 2) ₹29,000 → ₹2,900 due.
*Old rule (negative ledger row):* the ₹1,500 is taken off the ledger → ₹2,900 withheld → **Ramesh gets ₹7,100**, although
₹1,500 of his TDS already sits with the government. *D2 (credit):* the ₹1,500 stays deposited as a credit → only ₹1,400
withheld → **Ramesh gets ₹8,600**; deposited in total ₹1,500 + ₹1,400 = ₹2,900 = the TDS due on ₹29,000 — never twice.

**Migration runbook (B3, fix round 3 B1, final item 9).** Run the prod deploy in a QUIET WINDOW (night — no confirms,
bank downloads or UTR uploads running). The reason: every file locks at most one live table EXCEPT the two FKs between
two live tables — `20261119121100_wre_nv_wallet_transactions_creditReversalId_fkey` (wallet_transactions +
credit_reversals) and `20261119121200_wre_nv_wallet_transactions_pointsLedgerId_fkey` (wallet_transactions +
points_ledger) — which take both tables' locks at once (their VALIDATE files `…122800…` / `…122900…` only take SHARE
UPDATE EXCLUSIVE). `migrate deploy` applies the 44 files in order, each in its own transaction with
`SET lock_timeout = '5s'`. If a file fails (e.g. `lock_timeout` on a busy table) Prisma records it as failed and refuses
further deploys with **P3009**. Recovery: (1) look at what failed (`_prisma_migrations.logs`); (2) mark it rolled back —
`npx prisma migrate resolve --rolled-back <migration_name>` (the in-VPC migrate job, same image, `--command=npx` args
`prisma,migrate,resolve,--rolled-back,<name>`); (3) **re-dispatch "Deploy — Production" via "Run workflow" on `main`
for the SAME SHA (never "Re-run" an old run), then "Review deployments" → Approve.** Every file is idempotent (IF NOT
EXISTS / guarded DO blocks / VALIDATE is a no-op when valid), so a re-run after a partial apply is safe. Never
`--applied` a file that did not finish.

**Final dual-audit round (2026-11-19).** One shared usability rule (`creditUnusableReason` + `currentRetailerKeys` in
`tds-194r.shared.ts`) now gates the credit, the ledger hand-back call-out, the 194R report and the TDS credits register:
current open FY · DEDUCT · the RETAILER's current key (the payee partner snapshot → its key today, not the outlet's
owner). A hand-back that can't happen is said plainly ("not handed back … stays in FY X's ledger and is flagged as
excess"); only a gross-up reason can still net in the same FY. LEGACY approve (Deoleo path — locking only, identical
outputs) takes `PDLOCK|client|period` before its selection, then the entry rows, then the TDS keys from a re-read under
the row lock. The D1 refusal now says "Reject this reversal request; settle with the retailer off-platform". The V2
modal enables Submit once the entries read answers (LEGACY → amount form) and, if V2 arrives after an amount was typed,
says it was cleared and pre-ticks nothing.

### 8.5 Fix round 3 (dual re-audit, 2026-11-19) — as built on `feat/wre-release`
| # | Finding | As built |
|---|---|---|
| A1 | Unusable credits hid excess | A credit is USABLE only when (a) its FY is the current open FY, (b) the client's current method is DEDUCT, (c) its key = the key the retailer's future payouts use (the payee partner snapshot's key today — final round item 4) — exactly what the payout run draws. **Creation:** an unusable credit is NOT created (choice: nothing could ever draw it; a silent unusable row would only hide excess) — the TDS stays in its FY's ledger; the outcome says why (closed FY / gross-up / PAN changed) and what happens (closed FY → that FY's report flags it; same FY → nets on a later withholding, else flagged). **Report** (`openCredits194RUsability`): only usable credits are subtracted; unusable ones stay excess, row field `unusableTdsCreditPaise` + note "₹X TDS credit can no longer be used (later-year reversal / method changed / PAN changed — here: …) — counted as excess". Tests: later-FY reversal, PAN change (creation); method flip, PAN change, closed FY (report). |
| A2 | D2 REVERSED entries vanished from the report flags | `collect194RBases` also reads REVERSED + `tdsBaseReversedAt` entries (only when a sink is asked for) → sink only, never the base; the row keeps "reversed on", below-threshold, M2 and the engine's priorDue. Test A ₹19,000 · B ₹1,500 (D2) · D ₹600. |
| A3 | LEGACY retry re-read of a now-PAID entry skipped D1 | Re-checked (refuse + roll back). The bank download takes NO `credit_batches` lock → the LEGACY approve now row-locks the chosen entries (ascending id) right AFTER its advisory locks (the download's order: advisory → rows — no deadlock). |
| A4 | Period FY for section-less incentives | `entryBaseFyLabel` always uses the 194R bank-file FY rule (every PAID entry reaching it is 194R in the base). |
| A5 | Gross-up text | Honest: "nets automatically if this programme withholds 194R again in FY X (e.g. back on deduct) — the report says so; otherwise flagged as excess". Report: a reversal row lists "₹X TDS withheld on the reversed payout(s) was kept in FY X's ledger without a credit — nets … / counted as excess …". |
| A6 | `isFullyWithheld` required a frozen section | Dropped — a section-less fully withheld PAID payout follows D2 (test). |
| B1/B6 | Lock scope per migration file | 44 files: ADD COLUMN per table, one index per file, one NOT VALID FK/CHECK per file, one VALIDATE per file. An FK between two live tables (`wallet_transactions` → `credit_reversals` / `points_ledger`) necessarily locks both. Quiet-window line in the runbook. |
| B2 | V2 modal fallback | On a tenant KNOWN V2 (attention read): "Loading payout entries…" with Submit disabled, then the picker or an error with Retry. LEGACY/SHADOW/unknown: the amount form at once (7ba69566). Server messages without field names. |
| B3 | Gross-era backfill | `SHORTFALL_MISMATCH` is BLOCKING: no rows; "approved under the old gross rule — needs a decision". |
| B4 | `GET …/batches/:id/reversals` | Through `omitNullRequestRemarks`; no other route returns CreditReversal rows (grep: backfill / wallet internals only). |
| B5 | LEGACY fully withheld looked "cancelled" | Detected also by the settle reference `TDS-WITHHELD-…` the REVERSED flip keeps → "fully withheld as TDS — reversed · nothing owed". |
| B7 | Release guard tenant | `releaseCreditApplications(…, clientId)` — read and UPDATE restricted to the CALLER's tenant. |
| B8 | New-wallet upsert deadlock | V2/SHADOW confirm: lock existing target wallets (ascending id, B9) FIRST, then create missing wallets in ascending partnerId order (same get-or-create); LEGACY untouched. |

### 8.6 Over-reversal becomes debt + POINTS outcome summary (owner decision 2026-11-19) — branch `fix/wre-overreversal-debt`
**Rule (V2 only).** A POINTS reversal of r on a wallet: p = min(r, O_X) debt X had repaid comes back, c = min(r − p, H)
taken from what the wallet holds (X's own lot first, then FIFO), **s = r − p − c owed** — B −= r, D += p + s, shortfall 0.
Staging example: 10,000 reversed from a wallet holding 7,014 → B −2,986, D 2,986, one passbook row −10,000 (balance
7,014 → −2,986), the credit's lot drawn to 0, position ρ 10,000, allocation `{requested 10000, p 0, c 7014, owed 2986,
overReversalDebt true, shortfall 0}`, `CreditReversal.shortfallPaise` 0 (nothing "Pending" in the reversal report).
WP0 `reverse()` (`api/src/wallet/reversal-model.ts`) carries the rule; `planV2Reversal` / `applyCreditReversal` write it.
**Consumers checked:**
- Credits repay debt first (Q12) — the next +5,000 → B 2,014, D 0, the new credit's position O = 2,986, lot 2,014.
- Redemption: guarded `B ≥ s` (wallet + rewards services) → refused while B ≤ 0; partner rewards screen `canAfford` false.
- Expiry: clamps to H = B + D (0 right after an over-reversal) → nothing expires; a stray lot is clamped (no change).
- FIFO lots: only c is drawn; Σ lots = H holds (p and s touch no lot).
- LEGACY (Deoleo) and SHADOW apply the floor-0 clawback exactly as before (golden snapshot unchanged); on a sequenced wallet
  LEGACY's allocation still records `shortfall = r − c`, `owed 0`. SHADOW's v2 diff now records `owed` + `removed = r`
  (so an over-reversal shows `differs: true`).
- Attention banner (`owedClawbacks`): lists only HISTORICAL clawbacks (`overReversalDebt` false) — V2 debt is the normal
  outcome, said in the approver's summary and the reversal report. Verify V8 names V2 debt separately from historical
  clawbacks. V6b (expected negative balances at backfill time) will see new negatives once V2 over-reversals happen —
  expected; it is a backfill-time check.
- Daily digest: counts negative wallets (these are) — unchanged. Partner wallet card / statement: balance only (Q8 — no
  debt wording; the passbook row carries no SHORTFALL/debt tag on V2).
- Backfill replay of such a history books it as `CLAWBACK_BEYOND_HOLDINGS` with the same D (model-tested).
**Outcome summary (every tenant, display only).** `pointsOutcome` on the PATCH approve/reject response and on every
APPROVED / PARTIAL POINTS reversal in `GET /admin/credits/reversals` (`api/src/credits/points-reversal-outcome.ts`):
V2 "Approved · 10,000 pts reversed · 7,014 taken from the wallet · 2,986 recorded as debt, repaid from future earnings";
LEGACY "… · 2,986 not recovered — already redeemed or expired, written off"; a credit that had repaid debt adds
"N of earlier debt this credit had paid off is owed again"; partial "Partially approved (X pts requested) · …"; reject
"Rejected · nothing was reversed — the wallet is unchanged". The list builds it from the allocation rows when they cover the
approved amount, else approvedPaise / shortfallPaise — so a reversal approved before 2026-11-19 keeps its recorded
write-off. Shown on the payout screen (approve result + "Outcome:" line in the Reversal Report); the status screen's
create-form note and the Payouts help guide describe the V2 rule (LEGACY wording unchanged).

### 8.7 Fix round — dual audit + owner decisions 1–2 (2026-11-19) — branch `fix/wre-overreversal-debt`
**Owner decision 1 — expired points are not recovered twice (V2 only).** A credit's points that already EXPIRED count
as recovered: nothing is taken from other credits' points for them and no debt is booked. WP0 `reverse()` now has
`q = min(r − p, E_X − ε_X)` between p and c (E_X = points of X's own lot that expired from the balance — the lot's
DEBIT_EXPIRY row, `balanceBefore − balanceAfter`, exact on both write paths; ε_X = Σ `alreadyExpired` of X's earlier
allocations); `c = min(r − p − q, H)`, `s = r − p − q − c`; `B −= r − q`, `D += p + s`. Partial reversals count the
expired part FIRST and never twice; p and q are private to X so R3 still holds. Examples (tested in WP0 + service):
X 10,000 fully expired, Y 5,000 → reverse X → nothing taken, no debt; X 10,000 (4,000 redeemed, 6,000 expired), Y 5,000
→ 6,000 expired, 4,000 taken, no debt; X 10,000 (7,000 redeemed, 3,000 expired), Y 2,000 → 3,000 expired, 2,000 taken,
5,000 debt. Stored in `credit_reversal_allocations.alreadyExpired`; parts CHECK is now
`credit_reversal_allocations_parts_v2_chk` (p + c + owed + shortfall + alreadyExpired = requested — migration
`20261119124400` adds it NOT VALID and drops the old one, `20261119124500` VALIDATEs; one table each file, idempotent,
verified on PGlite). Outcome: "… · X already expired — nothing to recover". LEGACY keeps its floor-0 rule (tested).

**Owner decision 2 — the retailer sees the negative balance as it is.** `GET /v1/wallet`, the sales ledger and the admin
outlet summary add `owedPoints` (= −balance) and `owedFromReversal` for a NEGATIVE wallet only (`negative-balance.helper.ts`
— nothing added and no query for a wallet ≥ 0, so every Deoleo summary is byte-identical). Partner card / sales outlet view
(shared `OutletWalletView` → `BalanceCard`): "Available to Redeem −2,986 pts" + "You owe 2,986 pts from a reversed credit —
it's repaid from your next earnings." (generic wording when not from a reversal). Rewards screens (header, cash, voucher,
gift, catalogue tiles) and the sales "redeem for outlet" picker: no ₹ value and no negative "max"/"need N more" — "Not
available while your balance is negative". The V2 passbook row: "Credit reversed (Volume · 2026-10) −10,000 · 2,986 owed,
repaid from future earnings" (credits.service passes `passbookLabel` = field · period; LEGACY description unchanged).
Admin outlet wallet + sales view also show "Reversal ref <id>" under the row; the admin headline shows the negative
balance + note instead of a ₹ value; group page shows a negative child with no ₹.

**Audit items:** (1) liability KPIs (finance, program health, admin home) = Σ POSITIVE balances; "points owed" = Σ
debtPoints reported separately (finance + program-health cards show it only when > 0) — unchanged for a tenant with no
negative wallet. (2) group roll-up: available total = positive balances, `owedPoints` separate. (3) Reversal Report: a
Debt column (owed + debt restored) appears only when a listed reversal booked debt — Reversed = supposed − pending − debt
(LEGACY report unchanged). (4) copy "can't redeem while the balance is below zero". (5) LEGACY outcome "not recovered —
already redeemed or expired, written off". (6) Payouts guide: "On the standard engine … / On the new reversal engine (where
enabled) …" (the guide has no tenant gating). (7) V6b: negatives from V2 over-reversals (`overReversalDebt`) are left out
of the comparison and listed as V6c INFO — V6b still FAILs a changed cutover negative. (8) oracle replay: a V2 allocation
approved before these rules (owed 0, alreadyExpired 0, shortfall > 0) is replayed by the old rule. (9) "Wallets in debt":
`GET /v1/admin/credits/reversal-engine/wallets-in-debt` (tenant-scoped, wallet / outlets / balance / debt / owed / the
reversal(s) behind it with date) + a section on the credits status screen (non-LEGACY tenants) with an Excel download.

### 8.8 Fix round 3 (two audits) + owner decisions D1–D3 (2026-11-19) — branch `fix/wre-overreversal-debt`
**Owner D1 — one definition of "points owed":** how far below zero a balance is (−balance when < 0, else 0), on EVERY
screen: finance / program-health / admin-home dashboards (Σ |negative balances| over the scoped wallets, + how many),
group totals, partner / sales / admin wallet views, wallets-in-debt, outcome summaries. `debtPoints` stays internal
(engine bookkeeping); a wallet at +60 owes nothing even with debtPoints > 0.
**Owner D2 (approved PLATFORM-WIDE, every tenant and engine):** liability = Σ POSITIVE balances; "points owed" shown
apart with "Liability counts positive balances only; N pts owed by M outlets with a negative balance are shown
separately" whenever N > 0 (Bajaj's imported negatives appear here). A tenant with no negative wallet (Deoleo) renders
the same numbers; the extra API fields (`owedPoints`, `owedWallets`, `totalOwedPoints`) are additive.
**Owner D3 — not required.** *Known limitation:* LEGACY write-offs made BEFORE a tenant switches LEGACY → V2 are not
counted against a credit's expired portion (ε_X sums V2 `alreadyExpired` only), so a credit reversed partly before and
partly after the switch could be under-recovered (expired points the LEGACY part already wrote off may be counted again
as "already expired"). Mitigation: switch before any reversal — prod had 0 credit reversals / 0 allocations / 0
write-offs on any tenant at 2026-11-19, and Bajaj switches to V2 with none planned before.
*Known limitation (refunds):* a redemption refund re-credits points as a REVERSE lot that is not the reversed credit's
own lot; if those points later expire they are not counted as that credit's expiry (E_X reads the credit's own lot
only), so a reversal can book them as debt. Rare (refund + expiry + reversal of the same credit); visible in the outcome
and wallets-in-debt; correct by an adjustment if it happens.
**Fixed:**
- **A4** a reversal that takes holdings backing EXISTING debt (B 60 / D 40, reverse 100 → B −40) is recorded:
  `credit_reversal_allocations.debtExposed` (WP0 `Movement.debtExposed`), named in the outcome ("40 owed (balance
  below zero) … — 40 of the points taken were covering earlier debt"), the passbook ("· 40 owed, repaid from future
  earnings") and wallets-in-debt (kind "points taken were covering earlier debt").
- **A5/B5** outcome / passbook / Reversal Report say what the BALANCE did: taken (drop that stayed ≥ 0), already
  expired, owed (how far below zero the reversal took it — measured from the reversal's own wallet rows), written off.
  Debt a credit had paid off restored while the balance stays ≥ 0 is never called "owed". Report columns: Reversed
  (taken) · Already expired (only when any) · Owed (only when any) · Pending — they add up to Supposed.
- **A6** a V2 reversal row stores points = the balance change −(r − q) (wallet row AND ledger row), so ledger sums never
  count expired points twice; a reversal fully covered by the credit's expired points (q = r) writes NO wallet row and
  takes no seq — the allocation (`alreadyExpired = r`) and the approver's outcome carry it. The oracle reads r from the
  allocation and replays row-less expired-only allocations by time.
- **A7/B7** allocations carry `engineSource` ('V2' / 'LEGACY' / 'BACKFILL'; NULL = before the column). The reversal list
  uses allocation rows only when every row is 'V2' — backfilled history never adds an Owed column or shrinks Reversed on a
  LEGACY report. The oracle picks the old floor rule by `engineSource` ('LEGACY'), shape only for NULL. (LEGACY clawbacks
  on sequenced wallets DO set `reversedCreditTxId`, hence the explicit guard.)
- **A8** wallets-in-debt sources carry the outlet CODE from the credit position; `owedFromReversal` = a CREDIT_REVERSAL
  movement after the wallet was last ≥ 0 (current debt only).
- **B1/B2** V6b checks each wallet's balance at the CUTOVER (balance now minus its rows after `backfillCheckedAt`), keyed
  by wallet id (`EXPECTED_NEGATIVE_BALANCES='{"bajaj":{"<walletId>":-840,…}}'`; the list form still works on cutover
  balances); later movement never fails it; wallets that went (further) below zero after the cutover → V6c INFO with
  how many after a reversal.
- **B4** wallets-in-debt lists only wallets below zero (D1), totals from full aggregates, `truncated` flag; the Excel
  asks for up to 5,000 and says on its first line (and on screen) when it is still cut.
- **B6** staff screens (admin outlet wallet, sales outlet view) say "This outlet owes …"; the redeem refusal for a
  negative balance is "Not available while the balance is negative (−2,986 pts) — it's repaid from the next earnings";
  the partner dashboard hero and profile show the negative balance with the note.
- **B-risk** a non-zero balance always shows the points card; wallets-in-debt takes the same `programName` scope as the
  admin dashboards (CLIENT_ADMIN reads are tenant-wide by design — tenant-scope.ts; the attention endpoint is tenant
  operational state, not program-scoped); group totals + negative split are read in ONE transaction.
- **Loud expiry gap** a V2 reversal that books debt on a credit with no lot link (expiry history unknown) writes a
  `REVERSAL_EXPIRY_UNTRACKED` audit row, listed on the attention banner.
- Migration `20261119124400` (unpushed, edited in place) also adds `debtExposed`, `engineSource` and their CHECK terms.

### 8.9 Fix round 4 (re-audit of fix round 3, 2026-11-19/20) — branch `fix/wre-overreversal-debt`
1. ~~A position without `lotId` finds its lot through its credit row~~ — **corrected in round 5:** that fallback is
   harmless but practically unreachable (the WP6 backfill sets `lotId` and `pointsLedgerId` from the same credit↔lot
   pairs, so an unpaired backfilled credit has neither). Unpaired credits are **FLAGGED, not counted**: when the
   credit's own lot can't be determined (no linked credit lot — `points > 0` — of THIS wallet), a reversal that takes or
   owes points for it (recovered + owed > 0) writes ONE `REVERSAL_EXPIRY_UNTRACKED` audit row per reversal (listing
   every affected position; the banner counts reversals). The SHADOW diff records `expiryKnown` per step.
2. "Which reversal caused the current debt" (wallets-in-debt sources, `owedFromReversal`) is decided by the per-wallet
   movement `seq` on sequenced wallets — reversal rows after the last row that left the balance ≥ 0 — never by
   approvedAt / clock ties; one reversal touching two positions lists both (one line per allocation, React key per
   allocation). Never-sequenced wallets fall back to row times.
3. V6b: a wallet sequenced by V2 without a backfill stamp had 0 at the cutover (not compared); V6c lists it.
4. Wallets below zero: programme filter (dashboard catalogue), busy Excel button, the Excel is a clean table (per-source
   points + source outlet code) and a cut / filtered file says so on an "About" sheet.
5. Owner D2: the wallets-below-zero list is shown on EVERY tenant with a negative wallet (LEGACY included), neutral
   wording; nothing renders when none (Deoleo unchanged).
6. Partner hero and profile read the wallet page's own `owedFromReversal`; liability note: "… N pts owed by M wallets with
   a negative balance are not included" (it counts wallets; often the only place the figure appears).
7. Group totals + negative split, and wallets-in-debt count / total / rows, are read in ONE REPEATABLE READ snapshot.
8. SHADOW diff records `debtExposed` and `belowZero`; the Daily Ops Digest names the points owed next to the negative
   wallets ("8 negative wallets (3,549 pts owed)"); stale activity comment fixed.

### 8.10 Fix round 5 (2026-11-20) — branch `fix/wre-overreversal-debt`
- **A1** see §8.9 item 1 (corrected): unpaired credits flagged once per reversal; `expiryKnown` needs a credit lot of this
  wallet; SHADOW diff carries `expiryKnown`.
- **A2** wallets-in-debt: every read in ONE interactive read-only REPEATABLE READ transaction, lists grouped by wallet
  once; group drill-down outlets read in the same snapshot as the totals; the digest's negative-wallet count and points
  owed come from one aggregate.
- **B1** a cheap probe answers "no wallet below zero" first (partial index `wallets_negative_balance_idx`, migration
  `20261119124600` — additive, IF NOT EXISTS, one table; a plain CREATE INDEX like the other WRE index files since Prisma
  runs each file in a transaction, so CONCURRENTLY is impossible; the partial index on a small table builds in moments).
  (Superseded by §8.11 item 2: a failed first load is now a loud alert; quiet only on the server's `anyNegative: false`.)
- **B2–B5** filter errors keep the header + dropdown with an inline Retry; programme changes dim the old numbers
  (aria-busy); the summary names the programme; the export is `aria-disabled` while preparing and announces "Preparing
  file…" / "Downloaded"; a note says wallets whose outlets are all inactive appear only under All programmes.
- **B6** liability note grammar ("… pts owed by 1 wallet with a negative balance are not included").
- **B7** a last row at or above zero without `seq` (pre-sequencing history) falls back to time (list + helper).
- **B8** "Approved on" is a real date cell; deleted outlets are not listed.

### 8.11 Fix round 6 (2026-11-20) — branch `fix/wre-overreversal-debt`
- **1** wallets-in-debt snapshot: explicit transaction `timeout` 30 s / `maxWait` 10 s (Prisma's 5 s / 2 s defaults
  expire under load) and every heavy read capped — the last-row-at-or-above-zero is a `groupBy` (max seq / time) over
  the LISTED wallets only; reversal rows are read only for listed wallets and only AFTER that seq (else time); allocations
  only for those reversals (skipped when there are none).
- **2** the response carries `anyNegative` (the tenant-wide probe answer, programme-independent). The screen is quiet ONLY
  when the server said `anyNegative: false`; any failed first load is a red `role=alert` with Retry (the round-5 quiet
  line is gone — the screen never stays quiet on an unknown answer).
- **3** the summary / programme note name the programme of the numbers SHOWN (`data.program`), also while a new
  programme loads and after a failed load.
- **4** the probe is raw SQL with a LITERAL `< 0` (`WalletService.anyWalletBelowZero`) so the partial index is provable
  by the planner. If migration `20261119124600`'s `lock_timeout` trips, the migration is recorded failed and later deploys
  block with P3009 → `npx prisma migrate resolve --rolled-back 20261119124600_wre_idx_wallets_negative_balance`, then
  re-deploy. (The note lives HERE, not in the migration file: that file is already applied on staging and is kept
  byte-for-byte — never edit an applied migration.)
- **5** an untracked-expiry attention item carries `walletIds` = every wallet in the audit row's `positions`; the banner
  lists them all.
- **6** Excel "Approved on" cells carry an explicit `dd-mmm-yyyy` number format.

### 8.12 WP7 real-Postgres run (2026-11-20) — branch `fix/wre-overreversal-debt`
- **F1 (engine bug, fixed)** two approvals of the same credit at once (200 ∥ 300 on a 500 credit) refused one with
  "reversible 100 pts after 200 pts … never attributed". Cause: `lockReversalTargets` took `unallocatedApproved` from the
  PRE-lock read (`v2PointsReversalCap`, used only to pick which wallets to lock) but re-read the positions AFTER the locks.
  If the sibling committed in between, its 200 was in ρ (post-lock positions) AND still counted as an APPROVED reversal
  with no allocation (pre-lock read) — counted twice. Fix: `unallocatedApproved` is re-read under the position locks
  (READ COMMITTED → the sibling's allocation rows and ρ commit together, so it is counted once). The cap is unchanged:
  300 ∥ 300 on a 500 credit still lets exactly one through.
- **F2 (stale test)** expiry-first vs reversal: the expected B −500 / D 500 contradicted owner decision 1 (a credit's own
  expired points are already recovered, never owed). Now B −100 / D 100 either order; expiry first books
  alreadyExpired 400, recovered 0, owed 0.
- Suite: 29 passed, 2 skipped (local disposable PG 15 only).

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
zero shadow diff** (owner 2026-11-16: Deoleo stays LEGACY with NO backfill until it needs an engine reversal — §9.1). The
flag is set only through `POST /v1/admin/credits/reversal-engine/mode` (fix round A, M2). Until V2 for a tenant: refuse POINTS reversals on wallets with debt/offsets (Q14). 6. Post-backfill
migration: add+VALIDATE holdings CHECK, `seq` NOT NULL. 7. Remove legacy floor code; docs sweep.

**Verification queries (read-only; guard each session with `SELECT current_database()`):**
```sql
-- V0 snapshot before AND after backfill (identical, or every change explained by movement rows committed in between —
-- live earn/redeem is not paused; see §9.1 and api/src/wallet/backfill/verify-checks.ts VERIFY_SQL for the full query)
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
> **Owner decision 2026-11-16 (fix round A, L5): Deoleo stays LEGACY with NO backfill** until it actually needs a
> points reversal on the engine. Every run below is **`TENANTS=bajaj` only** — never `deoleo`. Deoleo's wallets stay
> un-sequenced (movementSeq 0) and take exactly origin/main's write path (proved statement-for-statement by
> `api/src/wallet/legacy-movement-parity.spec.ts`). The V0 "Deoleo zero debt" check (V5) is moot until then.

1. **DRY_RUN** (default; reads only): `EXPECTED_DB=gifsy_staging TENANTS=bajaj` → args `dist/wallet/backfill/backfill.main.js`.
   Prints per tenant: planned/noop/done/BLOCKED counts, rows to sequence, positions by attribution, allocations, every
   debt wallet (`B → D (H)`), every anomaly (BLOCKING = that wallet gets no writes; WARNING = written + flagged). The
   anomaly list goes to the owner. Save the `V0` numbers it is about to print in APPLY.
2. **APPLY**: add `BACKFILL_APPLY=true BACKFILL_CONFIRM="APPLY gifsy_staging"` (exact). Per tenant the job itself:
   (a) turns the tenant's **POINTS reversal approvals paused** switch ON (program_settings `pointsReversalApprovalsPaused`,
   P-A5) and DRAINS in-flight reversal transactions (exclusive advisory lock vs the shared one every POINTS reversal
   create/approve takes) — admins see "Points reversal approvals are paused — wallet maintenance in progress (started
   <time>)"; (b) backfills EVERY clean wallet — BLOCKED wallets never stop the run (P-A2; `ALLOW_BLOCKED` is gone) — and
   marks each BLOCKED wallet `backfillStatus = BLOCKED` + its reason; (c) inserts the WP5 PAYOUT reversal allocation rows
   (planner flags printed; a BLOCKING-flagged reversal gets no rows); (d) turns the pause OFF again (also after a crash)
   unless `KEEP_POINTS_REVERSALS_PAUSED=true` or it was already on before the run. The run ends with an **ATTENTION**
   block (blocked wallets + reasons, payout flags, historical clawbacks "recovered X, owed Y") — send it to the owner.
   Exit 0 even with BLOCKED wallets (they are attention items, not a failure); 3 = a wallet / the payout plan changed
   mid-run (re-run); 4 = V0 ALARM → stop, investigate. **V0 under live traffic** (earn/redeem are NOT paused — only
   POINTS reversal approvals are, Q5): (i) PER WALLET, inside each wallet's backfill transaction, its figures
   (balance + every counter) + a digest of its movement rows' amount/balance columns + a digest of its lots are read
   under the wallet lock right before and right after the backfill's writes — any difference is a backfill defect:
   that transaction rolls back, the run stops writing (no further wallet/tenant/payout step) and exits 4 naming the
   wallet; (ii) TENANT reconciliation: a per-wallet snapshot (one SQL statement) before and after the run — each
   wallet's balance change must equal the net (balanceAfter − balanceBefore) of the movement rows committed in between,
   and figures may only move on a wallet that got new rows; the log prints `live activity during the run: +X earned /
   −Y redeemed (… Σ balance = movements net …) — explained`. Anything unexplained → exit 4 with the amount and the
   wallets. "Committed in between" = difference of the two consistent snapshots (row count / Σ), not createdAt (a
   DB-side now() is the transaction START time). Optional staging: `MAX_WALLETS=n`,
   `RESUME_AFTER_WALLET=<id>`. A crash (or OOM kill) can leave the pause ON → it is shown on the credits screen banner;
   GIFSY lifts it there ("Resume approvals" → `POST /v1/admin/credits/reversal-engine/pause {paused:false}`).
   **Re-run right before flipping a tenant to V2 (P-A5) — cheap and idempotent:** wallets already sequenced
   (movementSeq > 0: done by an earlier run, or tracked by the engine since — rule 1 of movementPath keeps every
   backfilled wallet sequenced even while the tenant is LEGACY) are loaded as COUNTS ONLY (+ their clawback rows) and
   never written again; only wallets that are still un-sequenced (new wallets with legacy history, previously BLOCKED
   ones Gifsy has fixed) are planned and applied. PAYOUT reversals that already have allocation rows are skipped by the
   planner. **Flip sequence (fix round A, M2 — replaces the old "keep paused → flip → lift"):** re-run APPLY (the pause
   lifts itself at the end) → VERIFY → `POST /v1/admin/credits/reversal-engine/mode {"mode":"V2","clientId":"bajaj",
   "reason":"…"}` as a GIFSY_ADMIN. The endpoint is the ONLY way to set the mode (the generic settings upsert refuses
   `reversalEngine` / `pointsReversalApprovalsPaused`); it takes the EXCLUSIVE engine lock (waits for in-flight POINTS
   reversals + POINTS confirms), and **refuses V2 while approvals are paused or while any wallet with history is still
   un-sequenced without being listed BLOCKED-with-reason** (message names the count + sample wallet ids). BLOCKED wallets
   are allowed (P-A1) and their count is returned. Rollback: same endpoint, `"mode":"LEGACY"` — always allowed.
3. **VERIFY** (read-only): args `dist/wallet/backfill/verify.main.js`, env `EXPECTED_DB`, `TENANTS`,
   `V0_BASELINE_JSON='[…the "V0 before" objects APPLY printed…]'`, `NEVER_NEGATIVE_TENANTS=<tenants>` (NO default since 2026-11-21 — owner: Deoleo wallets may go negative; V5 checks only tenants named),
   prod only: `EXPECTED_NEGATIVE_BALANCES='{"bajaj":[-840,-612,-520,-360,-360,-297,-280,-280]}'`. Exit 0 = no FAIL, 5 = a FAIL.
   (`TENANTS=bajaj` only — Deoleo is not backfilled, see the owner decision above.)
   V0 here is the TENANT-level cross-check vs that baseline (which now carries `txCount / txIn / txOut`): PASS when
   identical or "live activity since the APPLY baseline … — explained" (Σ balance change = Σ net of the rows added,
   figures only moved alongside new rows, no rows/wallets lost); otherwise FAIL — also for a baseline printed by an
   older build without the movement totals (re-capture). The per-wallet proof is the APPLY run's guard (i) above.
   Policy round A: BLOCKED wallets are excluded from V1/V2/V3/V7 and listed by **V10** (WARN); **V9b** re-runs the WP5
   payout planner read-only (WARN: an approved PAYOUT reversal still without rows, or a planner flag); V8 prints
   "recovered X, owed Y". WARN never fails the gate but is always printed + counted ("⚠ N check(s) need Gifsy attention").
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
| B1 (2026-11-16) | SHADOW mode for PAYOUT reversals | Behaves exactly like LEGACY; only V2 picks / reserves entries (§8.1) | SHADOW = V2 for payouts (WP5 as built) |
| B2 (2026-11-16) | Reversing a PAID payout whose TDS was DEDUCTED (V2) | Receivable = net received; withheld TDS → TDS credit on the PAN (same tenant), auto-applied to the next TDS due, carried forward, released if that payout fails / is cancelled; GROSS_UP → full receivable, no credit, called out (§8.1) | Q11 (full receivable, TDS corrected off-platform) |
| B3 (2026-11-16) | Approve/reject outcome summary | On every tenant incl. LEGACY/Deoleo — display only, data unchanged (⚠️ platform-wide, owner-approved) | Engine reversals only |
| D1 (2026-11-16) | Reversed PAID payout with no TDS withheld | ALWAYS leaves the PAN's yearly base; report "₹X reversed on <date>" + "PAN below threshold after reversal" (§8.2) | Keep it in the base (O1) |
| D2 (2026-11-16) | TDS credit unused at FY end | Stays in its FY; report/export "₹X unused credit for FY …, not carried forward" | Carry into next FY |
| D3 (2026-11-16) | Reversal drops a PAN below the threshold | Keep the automatic hand-back on the next payout, visible on that payout's TDS line + PAN flagged | Explicit credit for it |
| D4 (2026-11-16) | Credits across clients | By deductor: 194C (Gifsy) across all tenants incl. Deoleo, "(another programme)" line; 194R (client) strictly within the client | Tenant-scoped for both |
| D5 (2026-11-16) | Typed reversal remarks | Sent + saved on create/approve/reject on every tenant incl. Deoleo (⚠️ platform-wide, owner-approved) | — |

### 12.1 Policy round A — owner decisions 2026-11-15/16 (as built on `feat/wre-pol-a`)
Owner rule for all of them: **no silent pass-throughs** — every refusal / skip / blocked wallet / unmapped credit / owed
amount / paused state is called out to whoever can act (call-outs table below).

| # | Situation | Decision (owner) | As built |
|---|---|---|---|
| P-A1 (Q1) | Wallet the backfill can't process (history doesn't add up, opening balance with no row, out-of-order rows, missing expiry rows on a once-negative wallet) on a SHADOW/V2 tenant | Keeps working on TODAY's (LEGACY) rules for earn, redeem and expiry; only REVERSALS on it are refused (clear error with the reason + what to do) | `wallets.backfillStatus` (DONE / BLOCKED / NULL = not processed) + `backfillBlockedReason` + `backfillCheckedAt` (migration `20261117120000`, CHECK: BLOCKED ⇒ reason). `WalletService.movementPath`: movementSeq 0 + SHADOW/V2 + not pristine → **LEGACY** (was 409 "backfill pending" for every movement) + a warn log. V2 reversal of a credit on such a wallet → 409 `WALLET_NEEDS_ATTENTION` "Can't reverse: the wallet that received this credit for outlet X needs Gifsy attention (<reason>). Gifsy must fix that wallet's points history and re-run the wallet backfill — earning and redeeming on it keep working meanwhile." SHADOW keeps LEGACY outcomes (LEGACY decides everything there); the v2 diff records the refusal. A fixed wallet becomes DONE (reason cleared) on the next backfill run. |
| P-A2 (Q2) | Backfill run with some BLOCKED wallets | Process every clean wallet; list problem wallets with reasons in the run report | `ALLOW_BLOCKED` removed (default behaviour); BLOCKED wallets marked with their reason on APPLY (audit row `WALLET_BACKFILL_BLOCKED`); run report `attention.blockedWallets` + ATTENTION log block; exit 0. Verify V10 (WARN) lists them; V1/V2/V3/V7 skip them. |
| P-A3 (Q3) | UNRESOLVED (unmapped) credit in a batch | Refuse ONLY that outlet's line (batch, outlet, field), not the whole batch: "Can't reverse: the original credit for outlet X in this batch couldn't be identified — Gifsy must map it first." | `WalletService.v2PointsReversalCap` (create cap, approve cap, applyCreditReversal, SHADOW diff — one gate): an UNRESOLVED position blocks the line only if it could be that line's credit — its recorded outlet/field don't exclude it AND the line isn't fully identified (Σ resolved positions of the key = Σ the batch's POINTS/OK rows for it) — or it carries exactly this key (backfill downgrade). UNRESOLVED positions are never drawn on (`findPositions`). 409 `CREDIT_UNMAPPED`, owner wording verbatim. A pre-engine credit without per-credit metadata and no position → same refusal. |
| P-A4 (Q4) | Historical clawbacks that took more than the wallet held | Say "recovered X, owed Y" — never count the owed part as recovered | `credit_reversal_allocations.owed` (CHECK `p + c + owed + shortfall = requested`); backfill classification: recovered = WP0 c (capped at holdings), owed = moved − p − c, shortfall = requested − moved (was: recovered = moved − p, i.e. owed counted as recovered). WARNING `CLAWBACK_OWED` + WP0 `CLAWBACK_BEYOND_HOLDINGS` text "recovered H, owed E (booked as debt)"; tenant summary `historicalClawbacks`; verify V8 detail; attention endpoint `owedClawbacks[].label`. Engine (v2) reversals never produce owed (WP0 caps c at H). |
| P-A5 (Q5) | Backfill APPLY window / re-run before a V2 flip | Per-tenant "points reversal approvals paused" switch turned on by the runbook during APPLY; POINTS reversal create/approve refuse with "Points reversal approvals are paused — wallet maintenance in progress (started <time>)"; re-run before the flip must be cheap/idempotent | program_settings `pointsReversalApprovalsPaused` `{paused, since, by, reason}` (absent ⇒ off; unreadable ⇒ paused, fail closed). Gate `assertPointsReversalsNotPaused` runs FIRST in every POINTS create/approve tx for ALL modes (incl. LEGACY): shared advisory lock + read through the tx; 409 `APPROVALS_PAUSED`. Reject and PAYOUT reversals are never paused. The backfill job sets it, drains (exclusive lock), clears it at the end. GIFSY: `POST /v1/admin/credits/reversal-engine/pause` (audited `POINTS_REVERSAL_PAUSE`). Re-run cost: §9.1 step 2. |
| P-A6 | WP7 finding: tenant flag read on a second pool connection while the wallet lock is held | Fix | `getReversalEngineModeUncached(clientId, db = own client)` / `getPointsReversalPauseUncached(clientId, db)`; movementPath, reverseCreditBatchPoints, the PAYOUT-create mode check and the pause gate pass the caller's `tx`. Mode still resolved once per request / per batch (WP4). WP7 pool test is now a regression guard (expected GREEN); the PGlite run uses the real TenantSettingsService. |

**Call-outs (who sees what, where, and what they do):**

| Path | Who sees it | Where | Action |
|---|---|---|---|
| POINTS reversal on a credit whose wallet is BLOCKED / not backfilled (V2) | client admin (create), Gifsy (approve) | API 409 `WALLET_NEEDS_ATTENTION` with reason; audit `REVERSAL_ENGINE_REFUSAL`; banner on Payout Status (credits reversal screen); attention endpoint `wallets[]` | Gifsy fixes the wallet history, re-runs the backfill |
| Unmapped credit on the line | client admin / Gifsy | API 409 `CREDIT_UNMAPPED` (owner wording); audit row; banner + `unmappedCredits[]` | Gifsy maps the credit (→ MANUAL) |
| Approvals paused | client admin / Gifsy | API 409 `APPROVALS_PAUSED` with start time; audit row; banner (GIFSY: "Resume approvals") | wait for maintenance / Gifsy lifts a stuck pause |
| Movement on a BLOCKED wallet of a V2 tenant (legacy path) | Gifsy | attention endpoint / banner `wallets[]` (always); API log warn when the caller knows the mode (batch confirm — fix round A L5 removed the per-movement flag read) | none needed for earn/redeem; fix to re-enable reversals |
| BLOCKED wallets in a backfill run | Gifsy / owner | run log ATTENTION block + JSON report `attention`; `wallets.backfillBlockedReason`; audit `WALLET_BACKFILL_BLOCKED`; verify V10 WARN | fix, re-run |
| PAYOUT reversal backfill flags (AMBIGUOUS / DOUBLE_CONSUMPTION / …) | Gifsy / owner | run log `PAYOUT_<code>` lines + ATTENTION; verify V9b WARN | resolve by hand (no rows written for BLOCKING) |
| Historical clawback beyond holdings | Gifsy / owner | run log (WARNING `CLAWBACK_OWED`, summary line), verify V8, banner + `owedClawbacks[]` "recovered X, owed Y" | recover the owed points off-platform or leave as debt |
| SHADOW v2 refusal | Gifsy | audit `REVERSAL_ENGINE_SHADOW` `v2.refused` (same wording) | review before V2 |
| (fix round B) Reversed PAID base / PAN below threshold / revise return (D1, M2) | Gifsy / client (194R) | 194R/194C liability rows `reversal.notes`; summary `reversalFlags` | revise the TDS return if already filed |
| (fix round B) Credit capped — TDS covers other payouts (H1) | Gifsy | approve outcome line + `tdsNote`; audit APPROVE metadata | none |
| (fix round B) Over-deduction handed back (D3) | Gifsy | approve outcome; download `tdsAdjustments` + JSON summary + audit `TDS_REVERSAL_ADJUSTMENT`; TDS payout row `tdsNote`; 194C row note | none (ledger corrects itself) |
| (fix round B) Credit from another programme used (D4, 194C) | Gifsy | download line "(another programme)"; credits panel application `otherProgramme` (other tenant's payout details hidden in a tenant view) | none |
| (fix round B) Unused credit at FY end / credit on previous PAN (D2, L6) | Gifsy / client | TDS payouts report credits panel + export "TDS Credits" sheet notes | retailer claims in return / settle off-platform |

### 12.2 Fix round A — money-audit findings, points side (2026-11-16, branch `feat/wre-fix-a`)
| # | Finding | Fix (as built) |
|---|---|---|
| M1 | A malformed `reversalEngine` value stopped ALL points activity (movementPath / batch confirm threw) and one bad lot stopped the whole expiry sweep (all tenants) | `TenantSettingsService` throws a typed `InvalidReversalEngineSettingException` (400). `WalletService.movementEngineMode` (used by movementPath, the expiry sweep and confirmBatch) treats it as **LEGACY** + logs "reversalEngine setting is invalid: <value> — treated as LEGACY; fix in settings". POINTS reversal create / approve still read it STRICTLY (fail closed, 400). Attention endpoint: `effectiveMode` + `modeWarning` (shown up front, red, on the banner). Expiry sweep: each lot in its own tx inside try/catch → `{ expiredLots, expiredPoints, failedLots, failures[] }`; each failure → `logger.error` + audit `POINTS_EXPIRY_FAILURE` (entityId = tenant) → attention `expiryFailures[]` (30 days) + banner; the lot stays due (retried next sweep) |
| M2 | `reversalEngine` / `pointsReversalApprovalsPaused` writable through the generic settings upsert (GIFSY_STAFF with tenancy:write_finance) | `AdminCoreService.upsertSetting` refuses both keys (403, no `allowPlatformOnlyKey` bypass). New `POST /v1/admin/credits/reversal-engine/mode {mode, reason?, clientId?}` (GIFSY_ADMIN, `credits:approve_reversal`, `ReversalEngineModeDto` IsIn) → `WalletService.setReversalEngineMode`: exclusive engine advisory lock; → SHADOW/V2 refused while paused; → V2 refused while any wallet with history is un-sequenced and NOT BLOCKED-with-reason (count + 5 sample ids, "run the backfill APPLY first"); → LEGACY always allowed; audit `REVERSAL_ENGINE_MODE` (old → new, reason, BLOCKED count); returns `blockedWalletsListed` + note. Pause only via the existing pause endpoint |
| M3 | LEGACY clawback on a SEQUENCED wallet with no / too little credit position was logged-only (ρ not bumped) → a later V2 reversal could take the same credit back | `clawbackAward` refuses BEFORE any write: 409 `CREDIT_UNMAPPED` (owner wording) when the line has no resolved position on the wallet or Σ(a − ρ) < the clawback (detail: `engine: LEGACY`, reason, coverable, requested); `assertPointsReversalAllowed` refuses at create when a sequenced wallet has no position. Audited by credits (`REVERSAL_ENGINE_REFUSAL`) → attention `refusals[]` (30 days) + banner. V2 caps (`v2PointsReversalCap` → create cap, approve cap, applyCreditReversal, SHADOW diff) subtract `unallocatedApproved` = Σ approved points of APPROVED/PARTIAL POINTS reversals of the line with NO allocation row (the reversal being applied excluded) |
| L1 | Expiry that only repays debt (e = 0, x > 0) left no trace | Audit row `POINTS_EXPIRY_DEBT_REPAID` (entityId = wallet; lot, h, debtRepaid, D before/after, seq) in the same tx. **Chosen over a zero-points movement:** a "Points expired 0" passbook row would show partners debt they are never shown (Q8) and every movement row keeps a non-zero `points` for the backfill / chain checks — no seq consumed |
| L2 | `byCreditOrder` ordered by createdAt first | Same wallet + both seq → seq; else createdAt, then id (seq is per wallet, absent pre-backfill) |
| L3 | V2 approve locked reversal → batch, LEGACY batch → reversal (deadlock across a flip) | V2 approve now locks batch row → reversal row (then cap); `assertV2PointsApproval` no longer re-locks. confirmBatch wallet pre-lock: **documented, not done** (§5 lock order) |
| L4 | Mode read outside the tx (a flip could land mid-request) | POINTS create / approve read the mode through the tx right after the pause gate's SHARED engine lock; POINTS confirm takes the SHARED lock as its first statement (`lockReversalEngineShared`) then reads the mode in the tx; the mode endpoint takes the EXCLUSIVE lock. Still once per request / batch. Residual: a single non-batch movement (refund, points-engine credit) on a brand-new wallet racing a flip can land un-sequenced — visible on the attention list (`NOT_BACKFILLED`), reversals on it refused; a backfill re-run fixes it |
| L5 | Un-backfilled LEGACY wallets paid a row lock + partner read + flag read per movement | `applyMovement` fast path: caller's read shows `movementSeq === 0` and (mode known LEGACY or the wallet visibly has history) → today's write path with NO lock / partner / flag read; its wallet UPDATE carries `AND "movementSeq" = 0` (one atomic statement, verified on Prisma 7 + PGlite: `UPDATE … WHERE id = $1 AND "movementSeq" = $2 RETURNING`) → a wallet sequenced since the read → nothing written, falls to the locked path. Expiry sweep + clawback decide "tracked" from the locked row (no flag read). Proof: `legacy-movement-parity.spec.ts` — a Deoleo-style scenario reproduces origin/main `2eb8271d`'s recording (fixture) statement for statement (69 = 69; pre-fix branch: 106) with identical rows; the only normalised differences are the `movementSeq` guard and two extra selected columns on the reversal gate's wallet read. 2,000-row LEGACY confirm: 24,006 → 16,006 statements. A brand-new (pristine) wallet's FIRST movement without a known mode still reads the flag once (it may need seq 1 on a SHADOW/V2 tenant) |
| L6 | Pause endpoint for an un-assumed Gifsy user silently wrote Gifsy's own tenant | `resolveEngineAdminTenant`: assumed → that tenant (explicit clientId must match, else 400); un-assumed Gifsy → explicit `clientId` REQUIRED (400 "Choose the program…", nothing written) and must exist (404). Same rule for the mode endpoint. Banner sends the attention response's `clientId` |
| M4 | Expiry on Bajaj negative wallets | No code change — Bajaj has no expiry lots (§7 note) |

**Call-outs added:**

| Path | Who sees it | Where | Action |
|---|---|---|---|
| Malformed `reversalEngine` | Gifsy / client admin | banner (red, up front) + attention `modeWarning`; API log warn per read; reversal create/approve 400 | Gifsy sets a valid mode via the mode endpoint |
| Expiry lot failed | Gifsy | attention `expiryFailures[]` + banner; sweep result `failures[]`; audit `POINTS_EXPIRY_FAILURE`; log error | retried automatically; investigate if it repeats |
| LEGACY clawback on a sequenced wallet not attributable | client admin (create) / Gifsy (approve) | 409 `CREDIT_UNMAPPED`; audit `REVERSAL_ENGINE_REFUSAL` (`engine: LEGACY`); attention `refusals[]` + banner | Gifsy maps the credit / re-runs the backfill |
| Expiry repaid debt only | Gifsy (audit) | audit `POINTS_EXPIRY_DEBT_REPAID` | none |
| Mode changed / refused | Gifsy | mode endpoint response + audit `REVERSAL_ENGINE_MODE`; refusal message names the reason | run the backfill / wait for the pause |
| Pause / mode without a target program | Gifsy | 400 "Choose the program…" | assume the tenant or pass `clientId` |

**Tests:** `api/src/wallet/legacy-movement-parity.spec.ts` + fixture `__fixtures__/legacy-movement-parity.origin-main.json`
(L5); `wallet.reversal-engine.spec.ts` "fix round A" (M1 malformed + expiry isolation, L1, L2, L5 no-read + race +
insufficient, M3 refusal/caps; SHADOW-on-sequenced-unmapped now refuses); `reversal-attention.spec.ts` (M1 attention,
M2 mode endpoint, L6); `credits.reversal-engine.spec.ts` (L3 order, L4 confirm lock, M3 via endpoints, M1 confirm on
malformed, counts updated; LEGACY golden unchanged); `admin-core.service.spec.ts` (M2 fence); banner vitest (M1/M3/L6).

## 13. Work packages & resume plan
| WP | Scope | Status | Depends | Est. |
|---|---|---|---|---|
| WP0 | Pure reference model `api/src/wallet/reversal-model.ts` + `reversal-model.spec.ts` — the ORACLE | ✅ `7d64ab55` (30 tests; jest + `tsc -p tsconfig.build.json` pass in the worktree) | — | — |
| WP1 | Prisma schema + migration | ✅ `f5677f1e` | — | — |
| WP2 | `applyMovement` v2 (lock-first, seq, pointsDelta, D/O, ledger link, positions, expiry reclassification) calling WP0 | ✅ `bd131860` — `WalletService.movementPath` rollout guard: movementSeq > 0 → v2 maintenance (any flag); movementSeq = 0 + LEGACY → pre-engine path byte-identical; SHADOW/V2 → v2 only for a pristine wallet, un-backfilled history → 409 (**changed by policy round A P-A1: → LEGACY path, only reversals refused**). Expiry with e = 0 writes no row (D/O only). Tests `wallet.reversal-engine.spec.ts` | WP0, WP1 | — |
| WP3 | Reversal engine `applyCreditReversal` §6; own-lot-first; LEGACY/SHADOW/V2 flag; delete legacy floor helpers | ✅ `bd131860` — `applyCreditReversal`, `v2PointsReversalCap`, `reverseCreditBatchPoints` (flag `program_settings.reversalEngine`, absent → LEGACY, malformed → reversals refused / normal activity on LEGACY since fix round A M1; SHADOW diff → audit_logs `REVERSAL_ENGINE_SHADOW`). Legacy floor helpers kept: LEGACY still needs them (removal = rollout step 7). `patchReversal` still calls the LEGACY pair directly → switch to the dispatcher in WP4 | WP2 | — |
| WP4 | credits.service POINTS: position-based caps at create/approve, wallet from position, allocations, shortfall totals, SHADOW | ✅ branch `feat/wre-wp4` — mode resolved once per request (POINTS create/approve only; reject/PAYOUT never read it). **V2**: create cap Σ(a − ρ) − Σ pending, `originalPaise` = Σ position amounts, approve cap Σ(a − ρ) under the batch lock, then `reverseCreditBatchPoints(mode V2)` (receiving wallet, allocations, Σ shortfall → `shortfallPaise`); no current-partner / debt gate; no position / UNRESOLVED → 400. **SHADOW**: LEGACY decides + applies; v2 create-cap diff (audit `REVERSAL_ENGINE_SHADOW`, action CREATE) + approve diff (dispatcher). **LEGACY**: code path unchanged — golden snapshot generated on `1aa5084e` (`api/src/credits/__fixtures__/legacy-reversal-golden.json`). `confirmBatch` resolves the mode once per batch (`creditEarn` → `movementPath(knownMode)`): 2,000-row confirm 24,004 → 20,005 queries (LEGACY), 28,004 → 24,005 (V2). Tests `credits.reversal-engine.spec.ts` | WP3 | — |
| WP5 | PAYOUT allocations §8: entry-selection DTO + UI, reservation, download/re-bank hold, approve rules, backfill of existing PAYOUT reversals | ✅ `4187cb6d` — LEGACY byte-identical (existing credits spec unchanged but for 3 mock lines). Backfill = pure planner, WP6 wiring pending (§8 "As built"). **Policy round B (`feat/wre-pol-b`, §8.1):** V2 only (SHADOW = LEGACY for payouts); net receivable + tenant-scoped PAN TDS credit (create / apply at download / carry forward / release on FAILED or cancel); outcome summary on every tenant; TDS report + export + payout screen call-outs; its schema now in the split `20261119120000…124300` migrations (§8.5) | WP1 + release branch merged in | — |
| WP6 | Backfill job §9 (pure module using WP0 `replay()` + Cloud Run job script, DRY_RUN default, resumable) + verify job V0–V9 + draft post-backfill migration | ✅ `6fed2005` — `api/src/wallet/backfill/` (planner, runner, Prisma store, `backfill.main.ts`, `verify.main.ts`) + 30 fixture tests; draft `platform/docs/plans/sql/wallet-reversal-post-backfill.DRAFT.sql`. Not yet run on any DB (runbook §9.1) | WP0, WP1 | — |
| WP7 | Postgres e2e concurrency tests (concurrent credits, reversal vs redeem, double approval, reservation vs download) | 🟡 built (`feat/wre-wp7`): `api/test/wallet-reversal-concurrency.e2e-spec.ts` + `api/test/support/` (disposable-DB harness, WP0 oracle replay check). Run: `WRE_PG_ADMIN_URL=<throw-away LOCAL postgres admin URL>` (creates/migrates/drops its own DB; refuses non-localhost) or `WRE_PG_EMBEDDED=pglite` (serialised self-check only). PGlite: 26 green, 5 skipped. **Not yet run on a real server** (no Docker/Postgres on the dev machine). Pending: WP4 credits-path V2 approve race, WP5 reservation vs download (`it.skip` + TODO). Production finding (flag read OUTSIDE the tx → pool starvation) **fixed in policy round A** (§12.1 P-A6) — the pool test is now a regression guard expected GREEN on a real server | WP2–WP5 | ~1 h |
| Pol-A | Owner policy round A (§12.1): Q1 blocked wallets on legacy rules + per-wallet backfill status, Q2 never-stop backfill, Q3 line-scoped unmapped refusal, Q4 owed ≠ recovered, Q5 approvals-paused switch + cheap re-run, WP7 tx-read fix, WP5 planner → WP6 (+ V9b), call-out endpoint `GET /v1/admin/credits/reversal-engine/attention` + `POST …/pause` + banner (`status/_components/ReversalEngineAttentionBanner.tsx`) | ✅ branch `feat/wre-pol-a` — schema additions folded into migration `20261117120000` (never applied). Tests: `credits.reversal-engine.spec.ts` (golden LEGACY unchanged), `wallet.reversal-engine.spec.ts`, `reversal-attention.spec.ts`, `backfill.spec.ts`, banner vitest. PGlite WP7 run: green except the T-pay3 schema test, which fails only because the SHARED generated Prisma client carried policy round B's `payout_reversal_allocations.receivablePaise` column (absent from this branch's migration) | WP0–WP7 | — |
| Fix-A | Money-audit fix round A, points side (§12.2): M1 malformed flag → LEGACY for activity + expiry isolation, M2 settings fence + mode endpoint, M3 no silent LEGACY pass-through on sequenced wallets + caps, L1–L6 | ✅ branch `feat/wre-fix-a` (no schema change). Round B (payout/TDS/UI) in parallel on `feat/wre-fix-b`. ⚠️ WP7 PGlite run currently RED for an environment reason only: the SHARED generated Prisma client carries columns of another branch (`credit_reversals.requestRemarks`, `credit_payout_entries.tdsBaseReversedAt`) absent from this branch's migrations — re-run after the branches are merged + `prisma generate` | all | — |
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
  pointsDelta; debtDelta; offsetDelta; offsetPositionId; lotDraws: {lotId; points}[]; shortfall /* 0 since 2026-11-19 */;
  owed /* s = r − p − c, booked as debt */; debtRestored; recovered }
class ReversalModelError extends Error
emptyModel(); holdings(s); credit(m, {id, amount, reversible}); spend(m, s); expire(m, lotId); legacyDebtDebit(m, d);
reverse(m, creditId, r); reversalFloor(m, creditId) /* −(D+O_X): no-new-debt floor; below it only by `owed` */; legacyReversalDecrement(B, r) /* min(r, max(0,B)) */;
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
| T-a | 0, f1 +500, redeem 500, f2 +300; reverse f1, f2 | B −500, D 500; Σrecovered 300, Σowed 500, sf 0 (2026-11-19; LEGACY: B 0, 500 written off) |
| T-b | −841, f1 +500, f2 +300; reverse both | B −841, shortfall 0 |
| T-c | −100, E +500, redeem 400, X +300; reverse E, X | B −500, D 500; Σrec 400, Σowed 400 (split [100,300] or [0,400] by order, Q2) |
| T-d | −1000, D +1200, E +500, reverse D, X +300; reverse E, X | B −1000, sf 0 (patched code: −700 vs −1000 ✗) |
| T-R2* | −100, X +100, Z +200, redeem 200, Y +200; reverse X & Y | B −100 (Q1); + Z → B −300, Z's 200 owed |
| T-debt | +10,000, redeem 2,986; reverse 10,000 (owner 2026-11-19) | B −2,986, D 2,986, owed 2,986, sf 0; no redeem; next +5,000 → B 2,014, D 0 |
| T-exp1..3 | X 10,000 expired (full / 6,000 after 4,000 redeemed / 3,000 after 7,000 redeemed), Y credit; reverse X (owner decision 1) | nothing taken, no debt / 4,000 taken, no debt / 2,000 taken, 5,000 debt |
| T-g1..3 | partial reversals | cap enforced; B identical across orders |
| T-x1 | expiry with debt | = today's clamp |
| T-e1..3 | concurrent credits / reversal vs redeem / double approval | seq contiguous; never below floor; one allocation (WP7) |
| T-f1/f2 | legacy credit, outlet relinked / unresolved | debit only the receiving wallet / 400 until mapped (WP4) |
| T-h/h2 | unknown credit / historical unresolvable clawback | 400 / classified, balances untouched (WP4/WP6) |
| T-pay1..5 | double consumption, exact subset, reservation vs download, PROCESSING, TDS offset | receivable once; approve OK; skipped; refused; offset once (WP5) |
| DE-1..8 | Deoleo-style positive histories | identical to today when nothing is owed (DE-4: lot fix only); over-reversal → B = LEGACY − owed, D = owed |
| DE-9 | 2,500 random never-negative histories | taken from the wallet == min(r, B); the rest owed; B −= r |
| DE-10 | 2,500 negative starts × all permutations of ≤4 reversals | identical B, D, offsets, ρ, Σowed; invariants hold |
