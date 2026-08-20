# Employee Rewards — Phase 0 / 1 Build Plan (unified `RewardAccount`, additive)

> ✅ **STATUS: DONE + LIVE IN PROD — cutover #35 (`54a84c2`, 2026-08-20).** All of Phase 0 + 1 shipped
> additive + DORMANT (Deoleo byte-identical): loyaltyType + capability resolver, unified RewardAccount +
> dual-write (advisory-locked) + onDelete Restrict, 3 additive migrations. Prod data ops done (backup):
> cleanup (2 test wallets + 5 test batches) + 6-row back-fill → 6/6 linked, balances byte-identical,
> idempotent. Independent 3-lane audit + dual re-audit → ship-safe, all findings fixed. Gates: api jest
> 2497 · nest 0 · FE tsc 0 · FE vitest 2201. **Phase 2 (deferred to conversion): §3 items + the onboarding
> `loyaltyType` selector UX (not built).** Detail: `[[employee-rewards-product]]` · `[[deoleo-go-live-bundle]]` #35.

> Scope: **only the earner-model foundation** — the piece worth doing now while the prod wallet is
> effectively empty. NOT the employee app / admin redesign / vendor portal (those are Phase 2+).
> Supersedes the earner-architecture section of [EMPLOYEE-REWARDS-DESIGN.md](./EMPLOYEE-REWARDS-DESIGN.md)
> with the **additive** decision (keep `partnerId` as the outlet profile; do not rename it away).
> Created 2026-08-19. Money-path → full gate + **dual adversarial audit** + staging runtime-verify.

---

## 0. Decision + evidence (why this shape, why now)

**Decision: ADDITIVE, one model.** Every wallet is owned by a `RewardAccount`. An outlet is an
account of type OUTLET (profile = `ChannelPartner`); an employee is an account of type EMPLOYEE
(profile = `SalesUser`). We KEEP `ChannelPartner`/`Wallet.partnerId` in place so the ~18–20 live
outlet-compliance files (KYC/TDS/invoices/payouts/visibility) are **not** touched and Deoleo's
behaviour stays byte-identical. The "full rename" alternative produces the same model but rewrites
that live compliance stack for no functional gain — rejected.

**Blast-radius evidence (verified in code):**
- 2 owner FKs only: `Wallet.partnerId @unique → ChannelPartner`, `RedemptionOrder.partnerId → ChannelPartner`.
- The engine below the wallet is already owner-agnostic: `WalletTransaction` + `PointsLedger` key only off `walletId`.
- 34 files reference `partnerId`, but only **~8–10 are the true earner path** (wallet, rewards+controller,
  the `resolveActivePartnerId` resolver, credits→wallet bridge, leaderboard, scheme-enroll resolver, partner app).
  The other ~18–20 are outlet-compliance (off for EMPLOYEE) — additive leaves them untouched.

**Prod pre-flight (read on 2026-08-19, `gifsy_prod`):**
- Real production earner data = **1 PAN group**: parent `Food Junction` (login-less, no wallet) + **6 child
  partners "Gawde Sir"** (PAN `AMVPG7194C`, group `cmsipt70l003401s6cfyhe8nr`), each 1 active outlet
  (`FO_DEOL_…`), each 1 wallet, **all 0 balance**.
- Test/disposable (soft-deleted): `niinj` (WHOLESALER, wallet **300 pts** from test batch `CB-2026-06-001`),
  `Payel Ghosh` (0). Plus 5 CONFIRMED **test credit batches** (period 2026-06, all uploaded by the owner
  Nikunj/GIFSY_ADMIN in early July: 1×300-pts + 4× small ₹ payout tests). 0 redemption orders, 0 payouts.
- Net: **no real balances** — the only funded wallet is a deleted test account. The migration is a
  6-row, zero-balance back-fill. Doing it now (before real points credit these 6 live outlets) is the
  cheap window; it is closing (6 real outlets onboarded Aug 11–18).

---

## 1. Phase 0 — Verify + foundation (NON-money; unblocks everything)

**0.1 `Client.loyaltyType`** — new enum `TRADE_LOYALTY | EMPLOYEE_REWARDS` (additive column, default
`TRADE_LOYALTY`). Deoleo = TRADE_LOYALTY → zero behaviour change. Additive migration.

**0.2 Capability-set resolution** — extend the existing `clients.features` / `resolveTenantFeatures`
path so code reads resolved capability flags (KYC/GST/TDS/payouts/vendor/celebratory), never
`loyaltyType` directly (except the earner-model switch). No consumers wired yet — just the resolver +
a spec. Non-money.

**0.3 Test-data cleanup (owner-gated; backup + shown SQL first)** — clean the 2 soft-deleted test
wallets (`niinj` 300pts + its 1 walletTx + 1 ledger row; `Payel Ghosh` 0) and, if the owner agrees, the
5 test credit batches. Goal: Phase 1 starts from a true zero-balance slate of ONLY the 6 real Gawde Sir
wallets. *(Kept separate from the back-fill so it's an explicit, reviewed delete.)*

**Gate/CI:** branch off `develop`; full gates green. Nothing reaches `main`.

---

## 2. Phase 1 — Unified account (additive; MONEY-PATH → dual audit)

### 2.1 Schema (one additive migration — no drops, no destructive change)
```
model RewardAccount {
  id          String   @id @default(cuid())
  clientId    String
  accountType AccountType            // OUTLET | EMPLOYEE (extensible)
  status      String   @default("ACTIVE")
  createdAt   DateTime @default(now())
  wallet      Wallet?
  orders      RedemptionOrder[]
  @@index([clientId])
}
enum AccountType { OUTLET EMPLOYEE }

// additive, nullable during transition — DO NOT drop partnerId
Wallet.accountId           String?  @unique  → RewardAccount
RedemptionOrder.accountId  String?           → RewardAccount
ChannelPartner.accountId   String?  @unique  → RewardAccount   // links the OUTLET profile to its account
```
`Wallet.partnerId` / `RedemptionOrder.partnerId` **stay** (outlet profile link for the compliance stack).
`ALTER TYPE`/enum add in its own migration step (platform rule). Hand-authored SQL — never `migrate dev`.

### 2.2 Back-fill (prod data op — backup + shown SQL + WAIT for owner)
- One `RewardAccount { accountType: OUTLET }` per **non-parent, non-deleted** `ChannelPartner` (the 6
  Gawde Sir children). Set `ChannelPartner.accountId`, `Wallet.accountId`, and (0 rows) `RedemptionOrder.accountId`.
- Parent `Food Junction` (login-less, no wallet) = grouping construct → **no account** (not an earner).
  The group model (`groupId`/PAN) stays entirely on `ChannelPartner`, untouched by `RewardAccount`.
- Chunked pattern (trivial at 6 rows). Idempotent (skip partners that already have `accountId`).
- Verify: every live wallet has exactly one account; balances byte-identical (all 0); group intact.

### 2.3 Code (the ~8–10 earner files only)
- New `resolveActiveEarner(db, {clientId, userSub, phone, loyaltyType, requestedId})` → returns the wallet
  owner as `{ accountId, partnerId? }`:
  - **TRADE:** wraps the existing `resolveActivePartnerId` (unchanged group/sibling-switch logic) and maps
    partner → `accountId` (also returns `partnerId` for compat).
  - **EMPLOYEE:** (stub now, wired in Phase 2) resolves `SalesUser` → its account.
- `wallet.service` + `rewards.service`/controller + credits→wallet bridge + leaderboard + scheme-enroll:
  operate wallet/redemption on the **account** (via `accountId`), while continuing to populate/read
  `partnerId` so every untouched compliance consumer keeps working. For Deoleo the account is 1:1 with the
  partner, so **every existing flow is behaviour-identical**.
- Guard: a partner/outlet must never resolve to another account (reuse the existing IDOR invariants in
  `resolveActivePartnerId`).

### 2.4 Definition of done (money-path)
- Full gates: `api jest` + `nest build` + FE `tsc` + `vitest`.
- **Dual adversarial audit** (money/identity): no cross-account leak; credit→wallet still lands on the
  right wallet; redeem debit + double-spend/oversell guards intact; back-fill idempotent + once-only.
- **Staging runtime-verify** (real logins): Deoleo credit-batch → wallet credit lands; a redeem→OTP→debit
  works; balances + statements identical to pre-change; the Gawde Sir group's 6 wallets resolve correctly.
- **Prod:** apply the additive migration via the in-VPC job; run the 6-row back-fill with a pre-op backup
  and the exact SQL shown to + approved by the owner; verify serving SHA + `/health/ready` + a spot-check
  read that all 6 wallets carry an `accountId` and balances are unchanged.

---

## 3. Explicitly OUT of Phase 0/1 (later, additive, on the owner's schedule)
Employee app (§6.1 of the design doc), admin redesign (§6.2), vendor portal (§6.3), Dream Reward,
campaign bonus engine, per-rep points rollup, notifications inbox, the EMPLOYEE earner wiring +
`SalesUser` accounts. None of these block, and all become pure additions once the account layer exists.

## 4. Orchestration — agents per lane + timing

| Stage | Lanes (parallel ∥) | Sub-agents | Who | Elapsed (as run here) |
|---|---|---|---|---|
| **P0** foundation | A `loyaltyType`+migration · B capability-set · C quality-prep (baseline snapshot + audit charter + cleanup-SQL draft + verify harness) | **2** (B, C); A = me | A/integration me | ~2–3 hrs |
| **P1.1** schema+migration (RewardAccount + additive FKs) | serial, 1 artifact | **0** | **me** | ~1–2 hrs |
| **P1.2** earner CORE (`wallet.service` + `resolveActiveEarner`) | serial, foundation | **0** | **me** | ~2–4 hrs |
| **P1.3** consumer fan-out | 3a rewards · 3b credits+leaderboard · 3c scheme-enroll+partner | **3** ∥ | agents write, me integrate | ~2–3 hrs |
| **gates+integration** | — | 0 | me | ~1 hr |
| **P1.4** independent audit fan-out | money-correctness · identity/cross-account-leak · data-migration+SQL | **3** ∥ | independent agents | audit ~30 min; **fix cycle ~½ session** |
| **P1.5** staging runtime-verify (Deoleo byte-identical) | — | 0 | me | ~1–2 hrs (incl. ~8-min deploy + real-login walk) |
| **P1.6** prod (backup → migration → 6-row back-fill → verify) | — | 0 | me, owner-gated | ~1 hr |

- **Total distinct sub-agents: ~8** (2 P0-build + 3 P1-build + 3 P1-audit); **peak concurrency capped at 3** (session-limit safety — if a lane's agent stalls I run it directly, same output).
- **The money core (P1.1/P1.2), the gates, the audit-triage, staging-verify, and every prod step are mine — never delegated.**

### Timeline (two framings, honestly)
- **As orchestrated here:** the *code* lands fast (agents run in minutes; the serial parts are hours). Realistic **elapsed = ~2 focused working sessions (~a day of active work), spread over 1–3 calendar days** depending on the audit→fix cycle and your availability at the prod gate.
- **Traditional-team calendar (for reference): ~1–1.5 weeks.**
- **The pacers are serial by nature — more agents don't shrink them:** the schema→core→audit→staging-verify→prod spine, each staging deploy (~5–8 min), the audit-fix loop, and the owner-gated prod moment. Parallelism compresses the *consumer edits and the audits*, not the money spine.

## 5. Effort + guardrails
- ~1–1.5 weeks traditional-team (see §4 for the as-run estimate): schema + ~8–10 earner files + resolver +
  6-row back-fill + dual audit + staging verify. vs the full 5–8-week product.
- Standing rules: work on `develop`; full gates before every push; **no `main` merge / prod DB op / cutover
  without the owner** (backup + shown SQL + wait for the back-fill); dual audit + Deoleo-unchanged proof
  before it goes near prod. Britannia's tax posture ("no KYC/GST/TDS, ever") should be **client-confirmed**
  and modelled as a capability flag OFF, not architected out.

## 5. Open confirmations before Phase 1
1. Additive shape approved (keep `partnerId` as the outlet profile)? *(recommended)*
2. Test-data cleanup: delete the 2 soft-deleted test wallets (`niinj`+300pts, `Payel Ghosh`) and the 5
   test credit batches? (backup + SQL shown first)
3. Britannia earning model — points-upload (default) vs performance-compute — only affects Phase 2, not this.
