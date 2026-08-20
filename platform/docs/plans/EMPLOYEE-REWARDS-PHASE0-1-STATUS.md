# Employee Rewards — Phase 0/1 (Earner-Model Foundation): Status Note

**Consultant-shareable.** Updated 2026-08-20. **Status: ✅ COMPLETE + LIVE IN PROD** (cutover #35, `54a84c2`).

## 1. Objective
Add a **second product line** to the existing trade-loyalty platform: an **employee-rewards** program (first client: Britannia), where a brand rewards its **own sales employees** (points → catalogue redemption) rather than its outlets/dealers. Phase 0/1 delivered only the **earner-model foundation** — done now, while the production wallet was effectively empty, so it never becomes a live-balance migration later. The employee app, admin redesign, and vendor portal are **Phase 2** (not in this scope).

## 2. Architectural decision — one unified model, additive
- A points **wallet** now belongs to a unified **`RewardAccount`**, which is either type **OUTLET** (profile = `ChannelPartner`, with KYC/GST/tax) or **EMPLOYEE** (profile = `SalesUser`; compliance stack off). **One model — outlets go through accounts too;** the profiles below are the type-specific detail, not a separate path.
- **Additive, not a rename:** `partnerId` was kept on wallets/orders as the outlet profile link, so the outlet-compliance code paths (KYC/GST/TDS/payouts/invoicing) are **untouched** and outlet behaviour is byte-identical. A capability set (`Client.loyaltyType` → KYC/GST/TDS/payouts/vendor/celebratory flags) selects each client's world; unknown values fail safe to the trade defaults.

## 3. Production reality (the data that shaped it)
Read-only prod check confirmed **no real loyalty balances**: the only real earner data was one PAN group — parent "Food Junction" + **6 "Gawde Sir" outlets, all zero-balance** — plus one funded **test** wallet (300 pts, since removed) and 5 test credit batches. So the migration was a **6-row, zero-balance back-fill** — the cheapest possible time to do it.

## 4. What was delivered & shipped (LIVE in prod, cutover #35)
- **Phase 0:** `LoyaltyType` (TRADE_LOYALTY | EMPLOYEE_REWARDS, default trade → all clients unchanged) + a pure capability-set resolver + additive migration.
- **Phase 1.1:** `RewardAccount` schema + `AccountType`; nullable `accountId` on wallet/order/partner (`partnerId` kept); additive migration.
- **Phase 1.2:** dual-write — every wallet/order create links its account (idempotent `ensureOutletAccount`, serialized by a per-partner advisory lock), so the model stays populated going forward. **Reads stay on `partnerId`** (Phase 1 is outlet-only; account-keyed reads are Phase 2, when employees — who have no `partnerId` — arrive).
- **Hardening (from the audits):** the advisory lock closing an ownership-split race; `onDelete: Restrict` on the money FKs; guarded, idempotent, `deoleo`-scoped, zero-balance back-fill + a guarded test-data cleanup.
- **Prod data ops (fresh backup first):** cleanup removed the 2 test wallets + 5 test batches (an in-transaction CONTROL held the 6 real wallets); the 6-row back-fill linked the 6 real wallets → **6/6 linked, balances byte-identical, 0 unlinked, idempotent, test data gone.**

## 5. Assurance
- **Gates:** api 2497 tests · nest build 0 · FE tsc 0 · FE 2201 tests — green.
- **Independent audit — 3 lanes** (money-correctness · identity/cross-account-leak · data-migration): verdict **ship-safe** (money correct — `accountId` write-only, no misroute; no cross-account/tenant leak; back-fill + cleanup sound). All actionable findings fixed.
- **Independent RE-audit — 2 lanes** on the fixes (code + the destructive SQL): fixes **sound**; found + fixed one HIGH (the destructive cleanup's DB guard now sits inside the transaction → fails-closed even without a psql safety flag). Cleanup proven to **never** touch the 6 real wallets; FK/delete order correct; blast radius bounded.
- **Staging pre-verify:** back-fill ran on staging first — 24/24 linked, balances byte-identical, idempotent; partner wallet reads normal.

## 6. Remaining & deferred (Phase 2 — at conversion)
There is **no open Phase-1 work.** Deferred to when an employee client (Britannia) is onboarded/converted — all **pure additive** frontend/wiring, no live-money risk, so no penalty for doing them then:
- **Onboarding `loyaltyType` selector UX** (choose Trade vs Employee when creating a client) — not built; every client currently defaults to `TRADE_LOYALTY`.
- **The EMPLOYEE earner** — `SalesUser` accounts, account-first wallets, and switching the relevant reads to `accountId`.
- **The three surfaces** — employee mobile app, redesigned admin, vendor portal.
- **Tax posture** ("no KYC/GST/TDS for employees") should be **client-confirmed** and is modelled as a capability flag (off), not hard-coded out.

## 7. Key design answers
- **One model?** Yes — wallet → account → (outlet | employee); outlets are accounts too.
- **Why additive vs a full rename?** Same end-model, but additive avoids rewriting live tax/payout code for a change it doesn't need → far lower risk to the live tenant.
- **Risk to Deoleo?** None — reads unchanged, balances byte-identical, verified on staging and in prod.
- **Effort:** the foundation is done + live; Phase 2 (the three surfaces + employee earner + onboarding UX) is the larger, additive build on top.

_Detail / references: `EMPLOYEE-REWARDS-PHASE-0-1-PLAN.md`, `EMPLOYEE-REWARDS-PHASE1-AUDIT-CHARTER.md`, `EMPLOYEE-REWARDS-PHASE1-STAGING-VERIFY.md`, `sql/employee-rewards-*.sql`; cutover ledger #35 in `RESUME.md`._
