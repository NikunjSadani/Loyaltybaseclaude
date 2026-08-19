# Employee Rewards — Phase 1 Staging Baseline + Verify Harness Plan

> Goal: **prove Deoleo behaviour is byte-identical** after the additive `RewardAccount` layer lands.
> This is the runtime-verify gate from
> [EMPLOYEE-REWARDS-PHASE-0-1-PLAN.md](./EMPLOYEE-REWARDS-PHASE-0-1-PLAN.md) §2.4 — a flow is DONE only
> when exercised end-to-end through the real interface (real login per role), not on tsc/tests.
>
> **Method:** snapshot a fixed set of read-only signals on staging BEFORE the change, apply the change to
> staging (develop auto-deploys), re-capture the SAME signals AFTER, and DIFF. Every diff must be empty
> (or explained by the additive `accountId` columns only). This document is a **read-only description** —
> do NOT run it here; the owner drives the real OTP logins.
>
> **Environment (verified facts):**
> - Staging DB `gifsy_staging`; `develop` auto-deploys to staging. `FIXED_OTP = 123456` on staging.
> - Staging deoleo ADMIN login: phone `6289864191`. A deoleo PARTNER login exists (outlet owner).
> - Reads against staging need the `current_database()` guard convention (staging + prod share a
>   private-IP DB); all snapshot SQL below is SELECT-only.
> - Harness: `platform/e2e` (`npm run e2e`) is the real-login-per-role Playwright harness, env-parameterised
>   for local + staging — use it to script the walk; the OTP steps are completed by the owner.

---

## Part 1 — What to snapshot (BEFORE), then re-capture + diff (AFTER)

Capture each signal on staging on the PRE-change deploy, save to a timestamped file, then re-capture on the
POST-change deploy and diff. Pass = identical (modulo the new nullable `accountId` columns being populated).

### 1.1 Wallet balances per partner (the core money invariant)
```sql
-- BEFORE and AFTER — must be row-for-row identical.
SELECT cp."partnerCode", cp."businessName",
       w."earnedPoints", w."lockedPoints", w."redeemablePoints",
       w."redeemedPoints", w."expiredPoints",
       w."lifetimeEarned", w."lifetimeRedeemed", w."lifetimeExpired"
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo'
ORDER BY cp."partnerCode";
```
Diff must be empty. (AFTER may additionally show a non-null `w."accountId"` — that is the only allowed delta;
capture it separately, below.)

### 1.2 Wallet transactions + points ledger (statement integrity)
```sql
-- Per-wallet counts + a checksum of the movement stream. BEFORE == AFTER.
SELECT w.id AS wallet_id,
       count(wt.*)                              AS tx_count,
       coalesce(sum(wt.points),0)               AS tx_points_sum,
       count(pl.*)                              AS ledger_count,
       coalesce(sum(pl.points),0)               AS ledger_points_sum
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
LEFT JOIN wallet_transactions wt ON wt."walletId" = w.id
LEFT JOIN points_ledger      pl ON pl."walletId" = w.id
WHERE cp."clientId" = 'deoleo'
GROUP BY w.id
ORDER BY w.id;
```
Also capture the full ordered statement for one partner via the real API (below) and diff the rendered rows.

### 1.3 The account layer resolves the SAME wallet the partnerId path used to (the crux)
```sql
-- AFTER only: prove the round-trip. Every deoleo wallet must map partner -> account -> back to the
-- same partner, and the wallet's accountId must belong to that partner's account.
SELECT cp."partnerCode",
       w."partnerId",
       w."accountId",
       ra."accountType",
       cp."accountId" AS partner_account_id,
       (w."accountId" = cp."accountId") AS wallet_partner_account_match  -- must all be TRUE
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
LEFT JOIN reward_accounts ra ON ra.id = w."accountId"
WHERE cp."clientId" = 'deoleo'
ORDER BY cp."partnerCode";
```
Pass: every `wallet_partner_account_match` is TRUE, every `accountType` is `OUTLET`, and the set of
wallets is exactly the pre-change set (no wallet gained/lost).

### 1.4 Redemption orders + catalogue (redeem path inputs unchanged)
```sql
-- Order ownership + catalogue stock — BEFORE == AFTER (aside from any order created by the test walk,
-- which must appear under the SAME partner AND carry a matching accountId).
SELECT "orderNumber", "partnerId", "accountId", status, "pointsDeducted", "totalPointsCost"
FROM redemption_orders ro
WHERE ro."partnerId" IN (SELECT id FROM channel_partners WHERE "clientId"='deoleo')
ORDER BY "orderNumber";

SELECT code, "pointsCost", status, "stockQuantity"
FROM reward_catalog WHERE "clientId"='deoleo' AND "deletedAt" IS NULL ORDER BY code;
```

---

## Part 2 — The real-login-per-role walk (the runtime proof)

Drive each lane through the REAL staging UI/API (OTP `123456`). Run the walk on the PRE-change deploy to
record expected outputs, then re-run identically on the POST-change deploy — same result = pass.

### Role A — Deoleo ADMIN (phone `6289864191`)
1. **Log in** (OTP 123456) as the admin.
2. **Credit-batch → wallet credit lands.** Upload a small test credit batch for one deoleo outlet (or
   confirm a staged pending batch). Assert: the target partner's wallet `earnedPoints`/`redeemablePoints`
   increase by exactly the batch amount, a `CREDIT_POINTS_EARNED` wallet transaction + an `EARN` ledger row
   appear, and (POST) the credit landed on the wallet whose `accountId` maps back to that same partner
   (§1.3). Re-run pre/post — identical deltas onto the identical wallet.
3. **Admin reads** — open the partner's wallet statement + orders in the admin views; capture the rendered
   rows for diffing against Role B's view and against the pre-change capture.

### Role B — Deoleo PARTNER (the existing outlet-owner login)
1. **Log in** (OTP 123456) as the partner.
2. **Balance + statement** — open the wallet: balance and the statement rows must match §1.1/§1.2 and the
   admin's view of the same wallet.
3. **Redeem → OTP → debit (atomic).** Redeem a catalogue reward the wallet can afford:
   - affordability check reflects the real `redeemablePoints`;
   - confirm with OTP `123456`;
   - assert an atomic result: `redeemablePoints` drops by exactly the cost, a `DEBIT_REDEMPTION` tx + a
     `REDEEM` ledger row are written, an order is created, and (POST) the order carries an `accountId`
     matching the partner's account (§1.4). No partial state on either the happy path or a forced unhappy
     path (e.g. redeeming just over balance must cleanly reject with no debit).
4. **Statement after redeem** — the new debit appears; export/statement renders identically pre/post.
5. **IDOR spot-check (ties to Audit Lane B).** Attempt an outlet-switch / `accountId` to a partner that is
   NOT an authorized same-group same-phone sibling → must be forbidden/empty, pre and post identically.

### Role C — The Gawde Sir group (parent + 6 children) — the real prod-shaped case
1. As the group's login, confirm the **operable-context picker** lists exactly the authorized sibling
   outlets (no more, no fewer) pre and post.
2. Switch to a sibling and confirm its wallet resolves to that sibling's account (§1.3), never another's.
3. Confirm the **parent** (`Food Junction`, login-less, no wallet) surfaces only as the read-only group
   overview and never resolves to a spendable wallet/account.

---

## Part 3 — Pass/Fail bar
- **PASS:** every BEFORE/AFTER diff in Part 1 is empty except the additive `accountId` population; the
  account→wallet round-trip (§1.3) is TRUE for all deoleo wallets; both role walks produce identical
  balances, statements, deltas, order ownership, and IDOR rejections pre and post; the credit lands on and
  the redeem debits the exact same wallet a partner sees.
- **FAIL (blocks `main`):** any balance/statement/order diff not explained by `accountId`; any credit/debit
  landing on a different wallet; any non-atomic redeem; any operable-context/IDOR result that changes; any
  Gawde Sir sibling or the parent resolving to the wrong (or a spendable, for the parent) wallet/account.

## Part 4 — Sequencing + guardrails
- Run the whole plan on **staging** first; only after PASS + the Phase-1 audit charter is green does anything
  go near `main`/prod (owner-gated: backup + shown SQL + wait, per the standing guardrails).
- All Part-1 SQL is SELECT-only and must carry the `current_database()` guard convention (staging/prod share
  a private-IP DB).
- Prod repeats a **read-only** spot-check of §1.1 + §1.3 after the owner-approved back-fill (all 6 wallets
  carry an `accountId`, balances unchanged) — no write walk on prod.

## Open questions
1. Does staging currently hold Deoleo wallets with any non-zero balance to exercise a real redeem, or does
   the walk need a seeded credit first (Role A step 2 covers this, but confirm the staging seed state)?
2. Confirm the exact staging deoleo PARTNER phone to script Role B (the admin `6289864191` is known; the
   partner login is referenced but its number should be pinned before the walk).
3. Confirm whether staging mirrors the prod Gawde Sir group (Role C) or needs it seeded to exercise the
   group/sibling-switch case on staging.
