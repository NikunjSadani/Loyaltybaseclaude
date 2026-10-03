# Employee Rewards — Architecture & Build Plan (Britannia anchor)

> **Status: DESIGN (architecture) — created 2026-08.** The ARCHITECTURE here stands. But for
> **DECISIONS and CURRENT STATE this doc is SUPERSEDED**: all scope decisions were LOCKED on
> 2026-10-02 (**[BUILD-PLAN §11](./EMPLOYEE-REWARDS-BUILD-PLAN.md) / [ADMIN-DESIGN §12](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md)**),
> and the live build state is in **[EMPLOYEE-REWARDS-RESUME.md](./EMPLOYEE-REWARDS-RESUME.md)** —
> read RESUME first. ⚠️ **Locked since this was drafted:** earning = **BULK UPLOAD, NO compute engine**
> (the "performance-compute" option in §8/§10/§12 is DROPPED); pilot est **~8–10 wks**; the Phase 0/1
> foundation (`loyaltyType` + `RewardAccount`) is **already SHIPPED & LIVE** (cutover #35, dormant) —
> §9/§11 describe it as upcoming only because they predate the ship. Where this doc and the locked docs
> disagree, the locked docs win.
> **Audience:** an engineer who knows *this* platform (Loyaltybase: NestJS `api/` + Next.js `platform/`,
> multi-tenant trade loyalty, operator Gifsy, live client Deoleo) but was **not** part of the design
> discussion.
> **Execution order, branching, safety gates & go-live:** [EMPLOYEE-REWARDS-BUILD-PLAN.md](./EMPLOYEE-REWARDS-BUILD-PLAN.md).
> **Process / rules (inherit/adapt/exclude), acceptance & restart brief:** [EMPLOYEE-REWARDS-WAYS-OF-WORKING.md](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md) · [EMPLOYEE-REWARDS-UAT-CHECKLIST.md](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) · [EMPLOYEE-REWARDS-RESUME.md](./EMPLOYEE-REWARDS-RESUME.md).

---

## 0. TL;DR

We are adding a **second product line to this platform: an employee rewards app**, with **Britannia**
(a large FMCG company) as the first client. Instead of rewarding *outlets/dealers* (what the platform
does today), it rewards **Britannia's own sales employees** for their performance — they earn points,
chase rewards, and redeem from a gift catalogue.

The platform's points **engine already does ~80% of this**. The core change is one architectural seam:
today the reward-earner is hard-wired to be a **business outlet** (`ChannelPartner`, with GST/PAN/KYC/
tax); we generalise it so the earner can also be an **individual employee** (reusing the existing
`SalesUser`). One switch at client onboarding — **`Client.loyaltyType`** — decides which world a client
lives in and turns the trade-only machinery (KYC/GST/TDS/payouts) off for employee clients.

There are **three surfaces** to build: the **employee mobile app**, a **new-shaped admin portal**, and
a **vendor portal** (external gift vendors upload products and fulfil their own orders). Everything runs
on the **same DB** (it's a multi-tenant platform). Because **Deoleo's production wallet is empty**, we
converge Deoleo and Britannia onto **one unified earner model now**, with no risky live-money migration.

---

## 1. Context — what we're building and why

### 1.1 The two products
- **Trade loyalty (today, live for Deoleo):** an FMCG brand rewards its **distribution channel** —
  *outlets* (dealers, retailers, wholesalers). An outlet buys/sells product, earns points, redeems
  rewards. Because outlets are businesses receiving something of value, the platform carries **KYC, GST,
  PAN, bank details, TDS, invoicing, payouts** — the whole tax/compliance stack.
- **Employee rewards (new, for Britannia):** an FMCG brand rewards its **own field sales force** — the
  *people* (a sales hierarchy, see §3 glossary). An employee hits sales targets, earns points, redeems
  gifts. They are the company's own staff, so **there is no KYC/GST/TDS/payouts** — a gift to an employee
  is a perk, not a vendor payout. That entire compliance stack is **out of scope, permanently.**

### 1.2 Why reuse this platform (not build fresh)
Feature-for-feature, an employee rewards app is a **subset** of what already exists here: a wallet/points
ledger with expiry, a reward catalogue with OTP-gated redemption, order fulfilment, schemes, tickets,
notifications, phone-OTP auth, multi-tenant admin, per-tenant branding. Rebuilding those would throw away
the most valuable and most dangerous (money-path) code and re-introduce solved bugs. **We reuse the engine
and switch off the trade-only parts.**

### 1.3 The anchor: Britannia
Britannia is the first employee-rewards client and the anchor use case. A **front-end-only clickable demo**
of the Britannia employee app already exists (separate throwaway repo — see §2); it is the **UX/visual
target**, on mock data, no backend. This platform build makes it real. The design also generalises: once
built, onboarding a *second* employee-rewards client is mostly configuration.

---

## 2. The design reference (the demo)

A polished, mobile-first, **front-end-only** demo of the Britannia **employee app** was built to win the
pitch. It is the visual + interaction target for the employee-app surface (§6.1).

- **Repo:** `britannia-rewards-demo` (separate, disposable; GitHub `NikunjSadani/Sales-team-reward`).
  Mock data only — no backend, no real auth (OTP is a hardcoded `123456`).
- **What it demonstrates** (all rep-facing): OTP login → a home screen with a **"Dream Reward"** goal +
  forecast, points balance, monthly target achievement, and a live-campaigns carousel → a **rewards**
  catalogue with filters → **redeem** (OTP + celebratory confetti) → **My Orders** with dispatch tracking
  → a **wallet** statement with a 6-month earnings chart + Excel export → **campaigns** (bonus-point
  drives) → a **Team** manager view that drills down the sales hierarchy with rolled-up numbers → a
  **profile** + notifications inbox.
- **The demo does NOT include** the admin portal or the vendor portal — those are new here (§6.2, §6.3).

Treat the demo as "the employee app should look and feel like this." The *mechanics* are what we build on
the platform.

---

## 3. Glossary (so the FMCG terms are unambiguous)

- **Trade loyalty / channel:** rewarding *outlets* (the businesses that stock/sell product).
- **Employee rewards:** rewarding the brand's *own sales staff*.
- **Channel partner / outlet:** the business earner in the trade product (`ChannelPartner` model). Carries
  GST/PAN/bank/KYC.
- **Sales hierarchy (Britannia's, top→bottom):** VP-Sales / NSM / SDM › RSM › BDM/SOM/UDM/RDM › **ASM**
  (Area Sales Manager) › **ASE** (Area Sales Executive) › front-line **AWSM / PSM / RSA** (various field/
  in-store rep titles). For the demo/first cut the relevant slice is **ASM → ASE → front-line rep**. In
  this platform the employee hierarchy is the existing **`SalesUser`** model (`reportingToId` self-relation,
  `SalesHierarchyLevel`, `employeeCode`).
- **`loyaltyType`:** the new per-client switch (`TRADE_LOYALTY` | `EMPLOYEE_REWARDS`) that selects the earner
  model + capability set at onboarding.
- **`RewardAccount`:** the new unified "reward-holder" the wallet attaches to. It has a **type** (OUTLET or
  EMPLOYEE); the type-specific detail lives in a **profile** (`ChannelPartner` for OUTLET, `SalesUser` for
  EMPLOYEE).
- **Capability set:** the resolved on/off flags (KYC, GST, TDS, payouts, vendor marketplace, celebratory UX,
  …) that `loyaltyType` maps to; overridable per client via `Client.features`.
- **Dream Reward:** an employee-app feature — the employee picks one catalogue reward as their goal; the app
  shows progress and a forecast ETA. (New — see §6.1.)

---

## 4. The core problem, precisely

- Today `Wallet.partnerId String @unique → ChannelPartner` (and `RedemptionOrder.partnerId → ChannelPartner`)
  hard-bind the earner to a business outlet. A `SalesUser` (an employee) has **no wallet**.
- **But the layers below the wallet are already owner-agnostic:** `WalletTransaction` and `PointsLedger` key
  off `walletId`, never the partner. `RewardCatalog` is `clientId`-scoped, not partner-bound. The
  redemption + OTP + debit flow only needs *a wallet*.
- So the coupling is small and concentrated: **the two owner FKs + the `resolveActivePartnerId` helper and
  its consumers.** ⚠️ `resolveActivePartnerId` (`partner-group.helper.ts`) is used across **~7 services**
  (wallet, rewards, partner, schemes, scheme-enrollment, invoices, leaderboard) — grep ALL of them before
  landing, not just `wallet.service`. That is the entire surface to generalise; the well-tested money engine
  underneath does not move.

## 5. Architecture

### 5.1 The spine: `Client.loyaltyType`
```
Client.loyaltyType ∈ { TRADE_LOYALTY , EMPLOYEE_REWARDS }   (extensible)
```
Set at onboarding, it resolves a **capability set** (composable; per-capability overridable via the existing
`Client.features` JSON + `common/tenant-features.helper.ts` `resolveTenantFeatures()`):

| Capability | TRADE_LOYALTY | EMPLOYEE_REWARDS |
|---|---|---|
| KYC / GST / TDS / payouts / invoicing | on | **off** (permanently out of scope) |
| Earner model | OUTLET (`ChannelPartner`) | EMPLOYEE (`SalesUser`) |
| Sales hierarchy | outlet-scoping/approvals | employee reporting tree (drill-down) |
| Celebratory UX (congrats, richer push) | off | on |
| Vendor marketplace | (n/a) | on |

**Code reads the resolved capability set, never `loyaltyType` directly** (except to select the earner model).
A future employee client that wants a deviation (say, a light TDS on a cash reward) is a one-flag override,
not a new type or an `if (isEmployeeRewards)` fork.

### 5.2 The earner: a unified `RewardAccount` — ONE ownership model

**Every wallet is owned by a `RewardAccount`. There is no bypass — outlets go through accounts too.**
An outlet is an account of type OUTLET; an employee is an account of type EMPLOYEE. `Wallet → Account`
is the single ownership path for *everyone*.

```
RewardAccount { id, clientId, accountType (OUTLET | EMPLOYEE | …), userId, status, … }
Wallet.accountId          → RewardAccount   // the one owner path, for everyone
RedemptionOrder.accountId → RewardAccount

              ┌─ Account (OUTLET)   → ChannelPartner profile   (Deoleo dealers: KYC/GST/bank/tax)
Wallet ─ Account ─┤
              └─ Account (EMPLOYEE) → SalesUser profile        (Britannia staff: no tax)
```

**Profiles are type-specific *attributes*, not an alternate *ownership* path.** The `ChannelPartner`
(outlet KYC/GST/bank record) and `SalesUser` (employee record) hang off the account as detail:
- **OUTLET** profile = existing `ChannelPartner`.
- **EMPLOYEE** profile = existing **`SalesUser`** (`reportingToId` tree; **reuse it — do not invent an
  employee model**). Both `ChannelPartner.userId` and `SalesUser.userId` already point at `User`.
- Future types (`ConsumerProfile`, …) = a new profile table + an `accountType` value. **This is the
  extension point** — a new earner type never touches the engine (the scalability win). A new program
  = a `loyaltyType` preset + (maybe) a profile table + branding = config, not engine changes.

**The boundary that keeps this safe (and is *why* compliance is never touched):**
- The **Account is the owner for the money engine ONLY** (wallet + redemption). `resolveActivePartnerId`
  becomes `resolveActiveEarner`, returning the account for the current user + client.
- **Compliance and hierarchy code keeps reading the *profile* directly** — outlet tax/payout/KYC via
  `ChannelPartner`, employee reporting via `SalesUser` — **and those reads do not change.** Two clean,
  non-overlapping paths: **engine → Account; everything else → profile.**

**`RedemptionOrder`** takes the same account owner as the wallet (otherwise an employee can't redeem).
Outlet orders keep their existing `partnerId` link for the compliance/fulfilment code; employee orders
own via the account. (This is the one other place besides the wallet the account-owner reaches — call it
out in Phase 1 so it isn't found late.)

**Integrity to enforce (money-path):** one wallet per account; every account has **exactly one profile
matching its `accountType`** (OUTLET ⇒ a `ChannelPartner`, EMPLOYEE ⇒ a `SalesUser`). A DB constraint /
validation here prevents "account with no profile" and "wrong profile for type" bugs.

### 5.3 Same DB (not a separate DB)
The platform is `clientId`-multitenant by design; a new tenant is a `Client` row + `ClientDomain` + config.
A separate DB was originally proposed to protect Deoleo's live money + PII, but the money-path **code is
shared regardless** (a code bug hits Deoleo either way → handled by the gate + dual audit, not by splitting
the DB), and a separate DB throws away cross-tenant admin/config tooling and doubles the migration/ops
pipeline. **Decision: same DB, isolated by `clientId` + `loyaltyType`.** A separate *deployment* (a second
Cloud Run service on the same DB) is optional later for release cadence. Revisit a separate DB only for a
hard contractual/regulatory data-isolation requirement.

### 5.4 Converge Deoleo now — one model, via an *additive migration tactic*
Normally we'd leave Deoleo on the old FK and converge later ("strangler"), to avoid migrating **live
balances**. **But Deoleo's production wallet is empty** (confirm via §11 before Phase 1), so we build the
**one unified model for everyone now** — before Deoleo's points ever go live — and the future ~2–4-week
migration project **disappears**.

**"Additive" here is a migration *tactic*, NOT a second model.** It means: **keep the existing
`ChannelPartner` record as the OUTLET profile** so the live tax/payout/KYC code reads it exactly as before
— rather than deleting or renaming it. The **ownership model is fully unified** (`Wallet → Account` for
outlets and employees alike, §5.2); "additive" refers only to **not rewriting the ~18–20 live compliance
files** for an identical end-state. The alternative — a "full rename" that also swaps outlet→account
*through* the compliance stack — produces the **same model** with more risk and **no functional gain**.
Don't do it.

**The back-fill (safe because the wallet is empty):** create one OUTLET account per existing
`ChannelPartner`, link the profile, and re-point its (empty) wallet + orders to the account. No live
balances ⇒ no reconciliation.

> This still changes **money-path code** that Deoleo will run once its points go live → it gets the **full
> gate + dual adversarial audit + runtime-verify**; Deoleo's behaviour must be verified unchanged. Empty
> data lowers *data* risk, not *code-correctness* rigor.

## 6. What to build — the three surfaces (screen by screen, with reuse)

> "Reuse" = the existing module/page to build on. "New" = net-new. Anything not marked reuse should assume
> a design pass to the demo's premium bar for the employee app.

### 6.1 Employee mobile app (the Britannia rep app — matches the demo)
Mirror of the demo (§2). Rep-facing PWA.

| Screen | What it does | Reuse / New |
|---|---|---|
| **Login** | Phone → 6-digit OTP → session | **Reuse** `api/src/auth` send-otp/verify-otp wholesale |
| **Home** | Points balance; monthly target achievement (cases/target %, pace); live campaigns; **Dream Reward** hero | Points from `wallet`; targets from `partner.getTargets`/`getTargetTrend`; campaigns from `schemes`. **Dream Reward = NEW** (persist a chosen `RewardCatalog` item as the employee's goal + a forecast/ETA from their avg monthly earn rate) |
| **Rewards** | Catalogue with filters (category, budget band, "redeemable now", sort); reward detail | **Reuse** `api/src/rewards` `listCatalog` (band filter exists server-side, wire it up) |
| **Redeem** | Affordability check → redeem → OTP confirm → wallet debit → order created → confetti | **Reuse** `rewards` `redeem`/`confirmRedeem` (atomic debit + order, already hardened) |
| **My Orders** | Order list + status + dispatch tracking (courier/tracking/ETA/delivered) | **Reuse** `rewards` `listOrders` + `transitionOrder` state machine + tracking fields (add `courierName`/`estimatedDelivery` if wanted) |
| **Wallet** | Points statement (earn/redeem), date-range filter, Excel export, **6-month earnings chart** | **Reuse** `wallet.service` transactions + export; **chart = NEW** (monthly aggregation + a bar chart) |
| **Campaigns** | Bonus-point drives: progress toward a target, days remaining, bonus on completion | `schemes` gives enrollment + deadline. **Progress→target + completion-bonus engine = NEW** (points-writing → dual audit) |
| **Team (manager)** | A manager sees their direct reports **with rolled-up numbers** (points earned/redeemed this period, target %, trend); **drills down** the hierarchy; taps a front-line rep for individual detail | **Reuse** `api/src/sales` `getTeam` + `descendantSalesUserIds` (whole-downline rollup engine already exists; one-level drill UI exists at `platform/src/app/sales/team`). **New:** per-rep **points** rollup (points aren't month-bucketed today) + recursive multi-level drill |
| **Profile** | Identity (name, employee code, designation, territory); notification prefs; logout | **Reuse** `auth/me`, `logout-all`, push subscribe |
| **Notifications inbox** | List of alerts + unread indicator | **New** (backend `notifications`/`push` exist, but there is **no in-app inbox endpoint** today — the current partner bell is hardcoded) |

### 6.2 Admin portal (NEW shape — the current trade admin is wrong for this)
> **Full admin spec: [EMPLOYEE-REWARDS-ADMIN-DESIGN.md](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md)** — the
> authoritative, module-by-module design for this surface (IA, reuse map, RBAC/regional scoping, phased
> build). The summary below is the overview; that doc is the build reference.

The existing admin (`platform/src/app/admin/*`) is trade-shaped (KYC, outlets, credits/payouts, TDS, GST,
invoices, visibility). For employee rewards, **drop all of that** and build a slimmer, redesigned admin:

| Screen | What it does | Reuse / New |
|---|---|---|
| **Employee roster + hierarchy** | Import/manage employees + the ASM→ASE→rep tree | **Reuse** `SalesUser` model + admin data-table; import flow **new** |
| **Points intake** | Grant/upload points per employee (the earning path, if upload model) | **Reuse** the credit-batch upload pattern (trimmed — no outlet resolution) |
| **Gift catalogue** | Manage rewards; now with vendor-contributed items | **Reuse** `admin/gifts` + `RewardCatalog`; add `vendorId` ownership + approval |
| **Campaigns / announcements** | Create/schedule campaigns + bonus configs | **Reuse** `schemes` admin + the new bonus engine |
| **Orders oversight** | All orders, statuses, fulfilment | **Reuse** order state machine + admin views |
| **Reports** | Redemption, points liability, engagement | **Reuse** reports framework |
| **Tickets** | Support oversight | **Reuse** `tickets` admin (production-complete) |
| **Notifications** | Push announcements / celebratory blasts | **Reuse** `push` + notifications |
| **Shell / RBAC / nav** | New employee-rewards navigation + **a design refresh** | **Reuse** admin shell + RBAC; **new** nav + redesign |

Turned OFF here: KYC, GST, TDS, payouts, invoices, outlets, visibility.

### 6.3 Vendor portal (NEW — the gift marketplace)
External gift vendors contribute products and fulfil their own orders. **Security-critical:** a vendor must
see **only their own** products and orders (IDOR boundary → security-audited).

| Screen | What it does | Reuse / New |
|---|---|---|
| **Vendor login** | Phone → OTP → vendor session (a new `VENDOR` role) | **Reuse** auth; **new** role + scoping |
| **My products** | Upload/manage gift products (Britannia-scoped), submit for **admin approval** | **Reuse** `RewardCatalog`; **new** `vendorId` ownership + upload/approval flow |
| **My orders** | Only orders for the vendor's own products; pending queue | **Reuse** order model, **scoped** to `vendorId` (hard boundary) |
| **Update tracking** | Enter/update courier + tracking + status for their orders | **Reuse** `transitionOrder` + the existing bulk fulfilment upload, scoped |

## 7. Reuse / build-new / turn-off (summary)

| Reuse ~as-is | Build new | Turn OFF (EMPLOYEE_REWARDS) |
|---|---|---|
| `Wallet` + `WalletTransaction` + `PointsLedger` + expiry | `RewardAccount` + typed profiles; generalise wallet/redemption owner + resolver | KYC (all) |
| Points upload (credit-batch → wallet) | `loyaltyType` + capability-set resolution | GST / TDS / invoicing |
| `RewardCatalog` + redemption + OTP + order state machine | Employee roster/hierarchy import + points intake | Bank payouts / `PayoutTransaction` |
| `sales` hierarchy rollup (`getTeam`, `descendantSalesUserIds`) | Per-rep points rollup + recursive drill; Dream Reward; contest bonus (uploaded); notifications inbox | `OutletTarget`/outlet-scoping; KPI/conversion/compute |
| Tickets, schemes, notifications, push, phone-OTP auth, admin shell, branding | Three surfaces (employee app / admin redesign / vendor portal); celebratory skin | Outlet / OutletType concepts |

## 8. Earning model — LOCKED (2026-10-02): BULK UPLOAD, no compute
- **The client uploads points per employee** (bulk, periodic) — reuses the no-compute credit-batch upload
  path, keyed by `employeeCode` → the `EMPLOYEE` `RewardAccount`. Points are **uploaded, never computed on
  the platform** (consistent with the platform's no-compute model). An **optional uploaded target-points
  column** powers the display-only achievement / "Potential" view.
- ~~Optional per-employee performance compute~~ — **DROPPED** (owner, 2026-10-02). There is **no employee
  points-compute engine**; do not confuse with the **trade** "Points Compute Engine" (a separate TRADE
  build on `develop`). See [BUILD-PLAN §11](./EMPLOYEE-REWARDS-BUILD-PLAN.md) / [WAYS-OF-WORKING §5–§7](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md).

## 9. Phased plan

> ⚠️ **Phases 0 & 1 are DONE — SHIPPED & LIVE (cutover #35, dormant).** `loyaltyType` + capability
> resolver + the unified `RewardAccount` (OUTLET profile) + the OUTLET back-fill + dual-write are in prod,
> Deoleo byte-identical. Do **not** re-run them. The remaining work is **Phase 2+** (the EMPLOYEE owner-
> generalisation + the three surfaces). The authoritative phase/lane plan is now
> **[BUILD-PLAN §5](./EMPLOYEE-REWARDS-BUILD-PLAN.md)**; the table below is the original architecture framing.

| Phase | Scope | Notes |
|---|---|---|
| **0 — Verify + foundation** ✅ DONE #35 | Prod money-path confirmed empty (§11); `loyaltyType` + capability-set resolution; branch/CI | Shipped, dormant |
| **1 — Unified account** ✅ DONE #35 | `RewardAccount` + OUTLET profile; `Wallet`/`RedemptionOrder` owner generalised; OUTLET back-fill per `ChannelPartner`; dual-write. **Additive tactic: `ChannelPartner` kept as the OUTLET profile → compliance/tax/payout code untouched** (§5.2/§5.4) | Shipped, Deoleo unchanged. ⚠️ EMPLOYEE profile link (`RewardAccount→SalesUser`) + Employee-Code keying are **still NET-NEW** (Phase 2) — the helper is OUTLET-only today |
| **2 — Identity + intake** (NEXT) | EMPLOYEE account keying + `SalesUser` profile link + the "one profile per accountType" DB constraint; phone-OTP login (reuse); **roster = REUSE the existing employee-hierarchy upload** (§5.1 ADMIN); points intake = bulk upload | Money-path → **dual audit**; grep all ~7 `resolveActivePartnerId` consumers |
| **3 — Employee app** | The employee PWA, all screens (§6.1) | Parallelisable FE |
| **4 — Admin + Vendor portals** | Redesigned admin (§6.2) + vendor marketplace (§6.3) | Parallelisable |
| **5 — Richness** | Team points rollup + recursive drill, Dream Reward, campaign bonus engine, notifications inbox | Additive |
| **6 — Hardening + UAT + pilot** | Full E2E, cross-tenant + vendor-IDOR isolation, money-path dual audit, staged onboarding + UAT | Definition of done |

## 10. Timeline — see [BUILD-PLAN §6](./EMPLOYEE-REWARDS-BUILD-PLAN.md) (authoritative)
- **Pilot go-live: ~8–10 weeks** (bulk upload, no compute; foundation already shipped). ~6–7 aggressive if
  the external deps are pre-staged from day 0. The ~5–8/7–11-week ranges here were pre-lock and are superseded.
- Calendar is paced by the serial money-path work + UAT turnaround + external deps (DLT templates, Britannia
  data, vendors) — **not** by agent coding speed. See BUILD-PLAN §6 for the lane/critical-path breakdown.

## 11. Pre-flight verification — ✅ DONE (before #35; historical)
> This check was run before the Phase 0/1 ship (#35): the prod money-path was confirmed effectively empty and
> the OUTLET back-fill reconciled (6/6 wallets byte-identical; see [[employee-rewards-product]]). Kept here as
> the record of *how* it was validated — **do not re-run it as upcoming work.**

Confirm the production earning/redeeming path is genuinely unused (not just that balances read zero). Safe to
converge now if the money-path counts are ~0. `ChannelPartner` may be non-zero — it only sizes the account
back-fill.
```ts
// api/, pointed at prod via a safe read path
console.table({
  walletTx:       await prisma.walletTransaction.count(),
  ledger:         await prisma.pointsLedger.count(),
  orders:         await prisma.redemptionOrder.count(),
  statusHist:     await prisma.redemptionStatusHistory.count(),
  creditBatches:  await prisma.creditBatch.count(),
  payouts:        await prisma.payoutTransaction.count(),
  fundedWallets:  await prisma.wallet.count({ where: { OR: [{ earnedPoints:{gt:0} }, { redeemablePoints:{gt:0} }, { redeemedPoints:{gt:0} }] } }),
  partners:       await prisma.channelPartner.count(),  // sizes the back-fill; may be > 0
});
```
- All money-path counts **0** → converge safely now (Phase 1 = schema+code change + partner→account back-fill,
  no live-balance migration).
- Any **> 0** → some earning/redeeming happened; not a blocker, but migrate + reconcile that data — flag before Phase 1.

## 12. Decisions — LOCKED (owner, 2026-10-02)
> Full locked set + rationale: [BUILD-PLAN §11](./EMPLOYEE-REWARDS-BUILD-PLAN.md) · [ADMIN-DESIGN §12](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md).
1. **Earning = BULK UPLOAD, no compute** (performance-compute DROPPED).
2. **Target column = INCLUDE** (uploaded, display-only).
3. **Roster = REUSE** the existing employee-hierarchy upload + maintenance.
4. **Admin operator = BOTH** (Gifsy central + Britannia scoped self-serve).
5. **Regional admin = REUSE** the existing `/sales/**` hierarchy scoping (no separate region model).
6. **Field execution (POSM) = OUT** of pilot (opt-in later).
7. **Same DB, shared deploy, feature-flag (`loyaltyType`) gated**; build in a **dedicated git worktree**
   isolated from the active trade work.
8. **Vendor product flow = self-upload WITH owner moderation** (reuse the existing hard-scoped vendor portal).

## 13. Guardrails (this platform's standing rules)
- Work on **`develop`**; run the FULL gates before every push (`cd api && npx jest --no-coverage` · `cd api &&
  npx nest build` · `cd platform && npx vitest run` · `cd platform && npx tsc --noEmit`).
- The unified-account change is **money-path** → **dual adversarial audit + runtime-verify** before it goes
  near `main`; Deoleo's behaviour must be verified unchanged.
- **No prod/staging DB op, no `main` merge, no cutover without the owner** (staging+prod share a private-IP DB —
  reads need a `current_database()` guard; writes need backup + shown SQL + wait).
- Vendor scoping (a vendor sees only their own products/orders) is an **IDOR-critical, security-audited** boundary.
