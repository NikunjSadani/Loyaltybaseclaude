# Points Expiry — FIFO "Generalized Spendable Lot" Design

**Status:** DESIGN APPROVED (owner, 2026-11-02). **Build NOT started.** This is a **PLATFORM-WIDE**
change (shared wallet logic + `PointsLedger` schema, reaches every tenant incl. live Deoleo) → it
starts only on the owner's explicit, in-session go, flagged platform-wide before building.

**Owner:** whoever picks this up. **Area:** `api/src/wallet/wallet.service.ts` + `PointsLedger` schema.

---

## 1. Why — the bug (verified)

Point expiry is **LIVE**, not dormant (this was mis-stated once; corrected):
- UI `PUT /v1/admin/settings/points-expiry` → writes `PointExpiryConfig`.
- `creditEarn` → `resolveExpiresAt` reads that config → stamps `expiresAt` on new EARN lots.
- A **daily Cloud Scheduler sweep** runs it: jobs `expire-sweep-prod` + `expire-sweep-staging`
  (`30 0 * * *`) → `POST /v1/wallet/expire-sweep` (gated by `EXPIRE_SWEEP_SECRET`) →
  `WalletService.expireDuePoints()`.

**The defect:** redemption decrements the aggregate `wallet.redeemablePoints` scalar and writes a
`REDEEM` row, but **never touches the earned lots**. The sweep then expires a due `EARN` lot by
`min(lot.points, redeemableBalance)` — using the lot's *original* `points`, blind to what was already
redeemed. So it can expire points that actually belong to a **newer, not-yet-expired lot**.

**Concrete failure:** earn A=100 (expires day 365) + B=50 (expires day 500); redeem 80 → balance 70.
Day 365 sweep expires `min(100,70)=70` → balance 0. True FIFO: redemption consumed A first (A has 20
left), so only A's 20 should expire and B's 50 should survive to day 500. The sweep **silently destroys
50 valid points.** The floor-at-0 guard prevents a negative balance but not this over-expiry.

**Current real-world exposure:** staging has one config (Deoleo, 90d, **`active=false`**) and **zero**
lots carry an `expiresAt` → the daily staging sweep is a no-op today; nobody is exposed; Bajaj is safe
(non-expiring by design). **Prod/Deoleo not yet checked** (read-only prod check is a pending item). So
today this is a latent bug, not actively bleeding on staging — but it is live-capable the moment any
tenant activates expiry on a wallet population with redemptions.

---

## 2. The fix — generalize "spendable lot"

Today only `EARN` rows are treated as spendable/expirable. Generalize: **a spendable lot is ANY
`PointsLedger` row with `points > 0` that represents available balance** — i.e. `EARN`, `REVERSE`
(refund), and `ADJUST`-credit. Each carries a `remainingPoints` and an optional `expiresAt`, and both
FIFO consumption and the expiry sweep treat them uniformly.

### 2.1 Schema (additive, Deoleo-safe)
- Add `PointsLedger.remainingPoints Int @default(0)`; on creating any spendable lot set
  `remainingPoints = points`. `expiresAt` already exists.
- `wallet.redeemablePoints` stays as a **denormalized mirror** = Σ `remainingPoints` of non-expired
  spendable lots (keeps reads/guards fast; lots become the source of truth).
- Migration via the in-VPC `migrate deploy` job (see `migration-model` memory). Existing lots get
  `remainingPoints = 0` by default column value, but the creation code sets `= points`; existing rows
  are **immaterial** (no active expiry anywhere) — see §4, no backfill.

### 2.2 Redeem / debit (FIFO consume)
- `debitRedeem` (and admin **debit**-adjust, and credit clawback): instead of only decrementing the
  scalar, **consume the oldest spendable lots first** — order by `createdAt asc` (true FIFO by earn
  date; tiebreak `id`), decrement each lot's `remainingPoints` until the debit amount is satisfied,
  then mirror the total into `redeemablePoints`.
- Keep the existing atomic-guarded sufficiency check on the scalar (`requireSufficientRedeemable`) so a
  concurrent redemption can't drive the balance negative. Σremaining == scalar makes the two agree.

### 2.3 Expiry sweep (expire the REMAINING, not the original)
- Broaden `expireDuePoints`'s `where` from `transactionType = EARN` to **"spendable lot (type in
  EARN/REVERSE/ADJUST-credit) AND `remainingPoints > 0` AND `isExpired = false` AND `expiresAt <= now`"**,
  ordered `expiresAt asc`.
- Expire the lot's **`remainingPoints`** (not `points`): decrement the scalar by `remainingPoints`,
  set `remainingPoints = 0`, `isExpired = true`, bump `expiredPoints`/`lifetimeExpired`. Keep the
  guarded-claim `updateMany(isExpired false→true)` for concurrency-safety.
- Result: an expiring lot can only ever remove points that genuinely still sit in it. Newer lots are
  untouched.

### 2.4 Reverse / refund
- `reverse()` creates a **REVERSE spendable lot**: `remainingPoints = amount`, `expiresAt =
  resolveExpiresAt(...)` (a **fresh** expiry window per the tenant's config), increment the scalar.
- It still does **NOT** bump `earnedPoints`/`lifetimeEarned` (a refund restores spent points, it is not
  new earning — preserves the monotonic lifetime invariant).
- Rationale vs the rejected alternative (track which lots a redemption consumed and restore the
  *original* expiry dates): a refund getting a fresh expiry window is fair and far simpler; the
  consumption-link buys little. **Fresh expirable REVERSE lot is the chosen behavior.**

### 2.5 Admin credit-adjust
- `adjust()` CREDIT creates an **ADJUST spendable lot**: `remainingPoints = amount`, `expiresAt =
  resolveExpiresAt(...)`, and bumps `earnedPoints`/`lifetimeEarned` (as today — a manual credit is
  treated as earning). Now also expirable (previously ADJUST rows were invisible to the sweep).

### 2.6 Invariants (assert in tests)
- `lifetimeEarned` monotonic; bumped only by EARN + credit-adjust, never by reverse or any debit.
- `redeemablePoints == Σ remainingPoints` over non-expired spendable lots — holds exactly on a
  quiescent wallet whose whole history is post-change. **Under concurrency the mirror is only
  eventually-consistent**: a redeem whose guarded per-lot decrement loses a race skips that lot,
  leaving `Σremaining > scalar` transiently (always in the over-statement direction — never a
  double-spend). The **scalar is authoritative** for sufficiency; the drift self-heals as lots
  cycle and the sweep clamps to it (§2.3). Do NOT assert the strict equality under simulated races.
- The wallet scalar is guarded on every debit, so it can never go negative.

### 2.7 Concurrency (audit-hardened)
- **Expiry sweep locks the wallet row FIRST** (`SELECT … FOR UPDATE`) before claiming the lot, so
  it takes locks in the SAME order as a redeem (wallet → lots) — no deadlock — and the scalar is
  pinned for the duration, so the EXPIRE decrement's floor is exact (no negative balance).
- The sweep expires `min(lot.remainingPoints, redeemablePoints)` (the clamp), so a transiently
  drifted lot can never expire more than the scalar backs or write a phantom EXPIRE ledger row.
- Redeem vs sweep on the same lot is fenced by the `isExpired` false→true claim (consume filters
  `isExpired:false`); both commit orders proven safe by the dual audit.

---

## 3. Testing & audit (money path)
- **Unit:** FIFO consume order; the A=100/B=50 over-expiry scenario now expires only A's remaining;
  refund → expirable REVERSE lot + `lifetimeEarned` untouched; credit-adjust → expirable lot; debit-
  adjust/clawback FIFO consume; the `scalar == Σremaining` invariant after each movement type.
- **Full gates:** `api` jest + nest build, `platform` vitest + tsc (a red suite silently skips the
  staging deploy — see `staging-deploy-gate`).
- **DUAL adversarial audit** (independent sub-agents): one correctness (lot math, FIFO, invariants),
  one safety (concurrency on the guarded claim, mirror-vs-lots consistency, no negative/double-expire).
- **Runtime verify:** real redeem through the partner app, then set a short expiry config on a throwaway
  test tenant, trigger `POST /v1/wallet/expire` (manual), and confirm only the genuinely-remaining
  points expire and the passbook/balance read correctly.

## 4. Out of scope (owner-confirmed)
- **No backfill.** No live tenant holds redeemable-and-expiring points, so there is nothing to
  reconstruct. Contingency only: if a tenant later enables expiry on a wallet population that *already*
  has past redemptions, do a small tenant-scoped `remainingPoints` reconcile **at enable-time** (fill
  non-expired lots newest-first up to the current `redeemablePoints`). Not needed now.
- **No consumption-tracking / original-expiry-on-refund** (rejected in §2.4).

## 5. Rollout (platform-wide, Deoleo-safe, owner-gated)
- Additive column; the behavior change only manifests when expiry is **active** (no tenant is, today),
  so Deoleo is effectively byte-identical until it enables expiry. Still treated as a money path:
  dual audit + runtime verify + staged.
- `develop` → staging (verify serving SHA + a live redeem/expire check) → owner-gated `main` → prod
  (code deploy + schema migration via the in-VPC job; usual guard/backup/shown-SQL).
- **Interim lever:** if the pending prod-exposure check finds an **active** Deoleo expiry config with
  exposed (earned-with-expiry + redeemed) wallets, deactivate it (`pointsExpiryDays = null`) until the
  fix ships — stops any bleeding, loses nothing.

## 6. Estimate & orchestration
~**2–2.5 days** wall-clock. The parallel code-writing is **not** the bottleneck; the serial money-path
work (integration + full gates + dual audit + runtime verify + staged rollout) is the long pole — more
agents would not shrink it.
- **Phase 0 (me):** this note; finalize ordering key + lot-type enumeration.
- **Phase 1 (parallel sub-agents; I integrate + run gates + own result):** A schema+migration+lot
  creation; B redeem/debit FIFO consume; C expire-remaining + widened sweep; D reverse + credit-adjust
  lots; E unit tests + invariant.
- **Phase 2 (me):** full gates → DUAL adversarial audit → fixes.
- **Phase 3:** staging deploy → runtime verify (real redeem + forced expiry).
- **Phase 4:** owner-gated prod cutover (deploy + migration).

## 7. Open items before build — ✅ CLOSED (2026-11-04)
1. ✅ **Prod-exposure read DONE** (guarded `gifsy_prod` read): **0** PointExpiryConfig rows, **0**
   EARN lots with `expiresAt`, **0** exposed wallets, 0 points_ledger rows. No active expiry
   anywhere → sweep is a no-op → **no interim lever needed; Deoleo byte-identical.** Staging also
   verified: **0** un-expired lots carry `expiresAt`, so the migration's `DEFAULT 0` disables
   expiry on **zero** pre-existing lots (no regression). The design's load-bearing premise is now
   *verified*, not assumed.
2. ✅ Owner go given (platform-wide approval, in-session).

## 8. Build status (2026-11-04)
BUILT on `develop`. Full gates green (api jest 3833 · nest 0 · FE vitest 2892 · FE tsc 0). DUAL
adversarial audit run; fixes folded: the expiry sweep now locks the wallet row first + clamps the
expired amount to the scalar (closed a latent negative-balance race + a deadlock under active
expiry — audit F1/F2). Consumer fixes shipped alongside (both platform-wide, owner-approved):
program-health "expiring in 30d" now sums `remainingPoints` over spendable lots; the Points-Ledger
report's balance reconstruction was corrected (it summed signed `points` wrong → overstated every
redeemed outlet; e.g. Chakradhar true 20,516 vs report 91,516 — proven + fixed for all 1,979
redeemed staging wallets). Known residual (pre-existing, flagged, out of scope): a clawback with a
redemption shortfall records a ledger debit larger than the scalar moved, so a purely
ledger-reconstructed balance can trail the true scalar for such a wallet — 0 real occurrences
today; the wallet scalar is always authoritative.
