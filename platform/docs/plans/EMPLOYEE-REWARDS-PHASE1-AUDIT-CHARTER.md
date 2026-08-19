# Employee Rewards — Phase 1 Independent-Audit Charter (`RewardAccount`, additive)

> Scope: the **money-path** Phase-1 change from
> [EMPLOYEE-REWARDS-PHASE-0-1-PLAN.md](./EMPLOYEE-REWARDS-PHASE-0-1-PLAN.md) — introduce a unified
> `RewardAccount` owner between `Wallet`/`RedemptionOrder` and the existing `ChannelPartner` profile,
> **additively** (keep `partnerId`). This charter defines the **3 parallel independent-audit lanes**
> run AFTER the gate + runtime-verify (standing rule: independent adversarial audit on every build item;
> **DUAL** for money/identity/destructive). Each auditor is a FRESH reviewer whose only job is to prove a
> concrete failure — a green gate proves it compiles, not that it is correct.
>
> **Ground-truth code seams (verified) the auditors must target:**
> - `api/src/common/partner-group.helper.ts` → `resolveActivePartnerId()` (the IDOR boundary being wrapped).
> - `api/src/wallet/wallet.service.ts` → `creditEarn(partnerId, …)`, `debitRedeem(partnerId, …)`,
>   `requireWallet(tx, partnerId)`, `applyMovement()`, the guarded redeemable decrement
>   (`requireSufficientRedeemable`).
> - `api/src/rewards/rewards.service.ts` → redeem / `confirmRedeem` (`$transaction`), the guarded stock claim
>   (`updateMany WHERE stockQuantity >= quantity`).
> - `api/src/credits/credits.service.ts` → credit-batch → wallet bridge (outletCode → partnerId → wallet).
> - `api/src/leaderboard/leaderboard.service.ts`, `api/src/schemes/scheme-enrollment.service.ts`,
>   `api/src/partner/partner.service.ts` (other owner consumers).
> - Schema: `wallets.partnerId @unique`, new `wallets.accountId @unique?`, `RedemptionOrder.accountId?`,
>   `ChannelPartner.accountId @unique?`, `reward_accounts` + `AccountType`.
>
> **Pass bar for the whole charter:** every scenario below is *attempted* and lands on the PASS side,
> with evidence (query output / test / diff), before the change goes near `main`. Any FAIL blocks.

---

## Lane A — Money-correctness (DUAL audit)

**Thesis to disprove:** "after the account layer is inserted, points always land on / leave the SAME
wallet as the pre-change `partnerId` path, and every atomicity + anti-oversell/double-spend guard is
intact." Auditor tries to make points land on the wrong wallet, be created/destroyed, or be
double-spent.

**Concrete failure scenarios to attempt:**
1. **Wrong-wallet credit.** A credit batch for outlet X is processed; assert the EARN lands on X's wallet,
   not a sibling/parent/another-account wallet. Adversarial variants: two outlets in the same PAN group;
   an outlet whose partner has an `accountId` back-filled vs one that (bug) doesn't; a partner id reused as
   an account id (id-space confusion).
2. **Resolution divergence.** For every Deoleo (TRADE) request, `resolveActiveEarner` must resolve the
   `accountId` whose wallet == the wallet `resolveActivePartnerId`'s `partnerId` resolves to. Try to find
   ANY input (own login, sibling switch, parent phone, absent selector) where account-wallet ≠ partner-wallet.
3. **Double-credit / lost-credit on the bridge.** Re-run the same credit batch confirm; assert idempotency
   (no duplicated EARN) and that a mid-flow failure rolls back cleanly (no orphan `wallet_transactions` /
   `points_ledger` without the balance move, and vice-versa).
4. **Redeem atomicity.** Confirm-redeem must debit `redeemablePoints`, write the `DEBIT_REDEMPTION` tx +
   `REDEEM` ledger, and create/claim the order in ONE `$transaction`. Force a throw after the debit
   (ineligible partner / stock fail) and assert FULL rollback — no debit persisted, no order left claimed.
5. **Double-spend race.** Two concurrent confirm-redeems on the same wallet for more than the balance: the
   guarded decrement must let exactly one win; the loser rejects cleanly and the balance never goes negative.
6. **Stock oversell race.** Two concurrent confirms of the last unit(s): the guarded stock claim
   (`updateMany WHERE stockQuantity >= quantity`) must let exactly one succeed; no oversell, no negative stock.
7. **Account/wallet mis-binding.** Attempt to attach two wallets to one account, or one wallet to two
   accounts; assert the `@unique` on `wallets.accountId` (and `wallets.partnerId`) blocks it.

**Exact checks / queries the reviewer runs:**
- `cd api && npx jest --no-coverage wallet rewards credits` (money-path suites) — must be green.
- Targeted repro tests for #5/#6 (concurrent `Promise.all` confirms) — assert one success + one clean 4xx.
- Post-op invariant SQL on the verify DB:
  - No negative balances: `SELECT count(*) FROM wallets WHERE "redeemablePoints" < 0 OR "earnedPoints" < 0;` → **0**.
  - Ledger ↔ wallet tie-out per wallet: sum of `points_ledger` EARN/REDEEM/EXPIRE nets to the wallet
    `redeemablePoints` (per the existing balance model) → **0 discrepancies**.
  - Every wallet resolves through exactly one account: `SELECT count(*) FROM wallets WHERE "accountId" IS NULL;`
    after back-fill → **0** (for TRADE outlets in scope); `accountId` unique holds.
- Code read: confirm `requireWallet` (or its account-aware successor) resolves wallet by the account/partner
  passed in, with NO fallback that could pick a different wallet on a miss.

**PASS bar:** all money suites green; #1–#7 each demonstrably blocked/correct with evidence; zero negative
balances; ledger tie-out clean; credit lands on the exact pre-change wallet in every variant.
**FAIL:** any wrong-wallet credit/debit, any non-atomic partial, any successful oversell/double-spend, any
wallet reachable via a second account.

---

## Lane B — Identity / cross-account leak (DUAL audit)

**Thesis to disprove:** "no user can reach an earner account/wallet that isn't theirs; the existing IDOR
invariants in `resolveActivePartnerId` still hold once wrapped by `resolveActiveEarner`." Auditor plays an
authenticated partner trying to touch another earner's wallet/orders.

**Concrete failure scenarios to attempt:**
1. **Sibling-switch escalation.** Using the outlet-switch selector, request a partner id that is NOT a
   login-less, same-group, same-phone, active-outlet sibling (a different group; a different tenant; a
   parent; a login-owning partner). Must return `forbidden` — and the account wrapper must NOT widen this
   (e.g. by resolving an account id directly and skipping the sibling re-authorization).
2. **Account-id substitution (new attack surface).** Any endpoint that now accepts/derives an `accountId`
   must re-authorize it through the earner resolver — never trust a client-supplied `accountId`. Try passing
   another earner's `accountId` directly; must be rejected exactly as a foreign `partnerId` is today.
3. **Cross-tenant reach.** A deoleo login requesting another tenant's partner/account id → forbidden; every
   resolver query stays `clientId`-scoped (the wrapper must not drop the `clientId` filter).
4. **Parent reach.** A parent (`isParent`, login-less, no wallet, NO account per the back-fill) must never
   resolve to a spendable wallet/account; a login must never resolve to a parent (the `isParent:false`
   filter in `resolveActivePartnerId` must survive the wrapping).
5. **Order ownership leak.** With `RedemptionOrder.accountId` added, listing/among orders must still be
   scoped to the caller's own account/partner — try to read another earner's orders by id or by switching.
6. **Empty-earner case.** A parent-only phone (partnerId null today) must resolve to "no operable earner",
   not to some default/first account.

**Exact checks / queries the reviewer runs:**
- Read `resolveActiveEarner` line-by-line against `resolveActivePartnerId` (lines ~780–821 of
  `partner-group.helper.ts`): confirm the switch path STILL requires
  `isParent:false, userId:null, groupId = own.groupId, phone endsWith last10, active outlet`, and that
  account mapping happens AFTER that check on the already-authorized partner — not as an independent lookup.
- Grep every new consumer for a raw `accountId` taken from the request/DTO that reaches a wallet/order read
  or write WITHOUT going through the resolver.
- Runtime (staging, real logins — see the staging-verify plan): as partner P, attempt the switch/`accountId`
  attacks in #1/#2/#5 via the real API; expect 403/empty, never another earner's data.
- Reuse/extend the existing IDOR tests: `partner.service.spec.ts`, `partner-group.helper.spec.ts`,
  `rewards.service.spec.ts` — must stay green and cover the account wrapper.

**PASS bar:** every #1–#6 attempt is forbidden/empty with evidence; no code path reaches a wallet/order via
an unauthorized `accountId` or `partnerId`; all IDOR specs green; `clientId` + `isParent:false` filters proven
intact after wrapping.
**FAIL:** any resolution to a foreign/parent/cross-tenant account or wallet; any endpoint trusting a raw
`accountId`.

---

## Lane C — Data-migration (back-fill correctness)

**Thesis to disprove:** "the back-fill creates exactly one OUTLET `RewardAccount` per non-parent,
non-deleted `ChannelPartner`, links wallet + partner (+ 0 orders), leaves the parent and the group model
untouched, keeps all balances byte-identical, and is idempotent (re-run = no-op)." Auditor tries to make it
create duplicates, skip a wallet, give the parent an account, or change a balance.

**Concrete failure scenarios to attempt:**
1. **Duplicate accounts.** Re-run the back-fill; assert it creates ZERO new rows the second time (idempotent
   — skips partners that already have `accountId`). Assert no partner ends with two accounts and no account
   has two wallets.
2. **Missed wallet.** After back-fill, assert every in-scope wallet (the 6 real Gawde Sir wallets) has a
   non-null `accountId` pointing at an OUTLET account whose `ChannelPartner.accountId` points back (the
   round-trip is consistent).
3. **Parent gets an account (must NOT).** `Food Junction` (`isParent=true`, login-less, no wallet) must have
   NO `RewardAccount` and NO `accountId` — it is a grouping construct, not an earner.
4. **Soft-deleted partner gets an account (must NOT).** The disposable `niinj` / `Payel Ghosh`
   (`deletedAt IS NOT NULL`) must be excluded (and are removed by the cleanup SQL first — confirm ordering:
   cleanup BEFORE back-fill, or back-fill filters `deletedAt IS NULL`).
5. **Balance drift.** Snapshot every wallet's balance columns before and after; assert byte-identical (all 0
   here, but the check must be a real diff, not an assumption).
6. **Group model touched.** Assert `groupId` / PAN / `Outlet.parentId` are unchanged for all 6 partners +
   the parent (the account layer must not write these).
7. **Wrong `accountType`.** Every created account is `OUTLET` (no EMPLOYEE created in Phase 1); `clientId`
   on the account matches the partner's `clientId`.

**Exact checks / queries the reviewer runs (against a snapshot / staging clone — NOT prod without owner):**
- Count invariants after back-fill (deoleo, `deletedAt IS NULL`, `isParent=false`):
  - `SELECT count(*) FROM channel_partners WHERE "clientId"='deoleo' AND "deletedAt" IS NULL AND "isParent"=false;`
    == `SELECT count(*) FROM reward_accounts WHERE "clientId"='deoleo' AND "accountType"='OUTLET';` (expect 6 == 6).
  - Every such partner has `accountId` set; `SELECT count(*) ... WHERE "accountId" IS NULL` → **0**.
  - Round-trip: `wallets.accountId` → `reward_accounts.id` → back to the same partner via
    `channel_partners.accountId` → **0 mismatches**.
- Parent exclusion: `SELECT "accountId" FROM channel_partners WHERE "clientId"='deoleo' AND "isParent"=true;`
  → all NULL; no `reward_accounts` row references it.
- Idempotency: run the back-fill twice on the clone; second run `INSERT`s 0 rows (capture rowcounts).
- Balance diff: `SELECT id,"earnedPoints","lockedPoints","redeemablePoints","redeemedPoints","expiredPoints"`
  before vs after → identical for all 6.
- Group untouched: diff `groupId`, `panNumber` on `channel_partners` and `parentId` on `outlets` before/after.
- Read the back-fill script for a `WHERE "accountId" IS NULL` (skip-if-present) guard and a `deletedAt IS NULL`
  / `isParent=false` filter; confirm it is chunked/transactional and re-runnable.

**PASS bar:** 6==6 accounts; every real wallet linked with a consistent round-trip; parent + soft-deleted
excluded; second run is a no-op; all balances + group fields byte-identical.
**FAIL:** any duplicate/missing account, any parent/deleted account, any balance or group-field drift, any
non-idempotent re-run.

---

## Cross-cutting reviewer notes
- **Deoleo-unchanged is the overriding proof.** For TRADE, account is 1:1 with partner → every existing flow
  must be behaviour-identical. Any lane finding "different for Deoleo" is a blocker regardless of severity.
- **Grep ALL owner consumers before sign-off** (standing rule #2): the ~8–10 earner files, not just the one
  path exercised. The other ~18–20 compliance files read the `ChannelPartner` profile directly and must be
  confirmed UNTOUCHED (additive tactic).
- **Evidence, not claims** (standing rule #4/#5): each PASS carries query output / test result / diff.
- **Open question for the auditors to resolve, not assume:** confirm the intended ordering of Phase-0.3
  cleanup vs the Phase-1 back-fill (cleanup first is cleaner; if reversed, the back-fill MUST filter
  `deletedAt IS NULL` so it never creates accounts for the disposable partners).
