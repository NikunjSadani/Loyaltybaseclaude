# Employee Rewards Portal — Product Proposal

> **Status: INITIAL PROPOSAL — not started. No code written.**
> Created 2026-07-18. This is a *separate product line* from the trade-loyalty platform
> (operator Gifsy; live client Deoleo). Kept as its own document deliberately — it shares the
> engine, not the roadmap. Everything below is a first-pass proposal and will change.

---

## 1. What the client wants

A **basic employee rewards portal**. The concept is deliberately simple:

- The client tells us **how many points to credit to each employee** (bulk, periodic).
- Employees **redeem points** for rewards from a **catalog** (gifts / vouchers / merchandise).
- Employees **see their wallet + history**.
- Employees see **special schemes / bonus-point announcements**.
- A **simple ticket / support** system.
- A **celebratory feel** — this is a *rewards* portal, not a loyalty portal: congratulations
  popups, a bit of excitement/notifications when points land or a reward is redeemed.

### Decisions captured from the owner (2026-07-18)
- **Redemption = catalog / vouchers only.** Even if cash is added later, **no KYC, no GST,
  no TDS** — they are the client's own employees. → the entire trade tax/payout/KYC stack is
  **permanently out of scope**. This is the decision that makes reuse clean.
- **This is a real product line**, not a one-off — expect multiple employee-rewards clients.
- **Gifsy operates it.** Plus a marketplace wrinkle: some gifts may be **listed by an external
  vendor**, who gets **scoped admin access** to see *their* orders and upload *their* order/
  fulfilment status.

### Open decisions (pin down before building — see §6)
- **Employee login model:** phone + OTP (reuses everything as-is) vs **email / corporate SSO**
  (additive auth path). *Biggest foundation-shaping question.*
- **Vendor scope:** "see my orders + upload status" only, or also self-list/price their own
  gifts (approval workflow)?

---

## 2. The core insight

Feature-by-feature this is **~80% a subset of the existing platform**. The hard, money-critical,
well-tested parts already exist:

| Requested | Already built |
|---|---|
| Client uploads points per user | Credit-batch upload → wallet (the "no-compute" points path) |
| Redeem points | RewardCatalog + redemption + OTP + wallet debit |
| Wallet history | Wallet transactions / PointsLedger + expiry |
| Special schemes / bonus points | Schemes + banners / popups |
| Simple tickets | Support / tickets module |
| Notifications / congrats popups | Per-tenant branding, banners/popups, PWA push, WhatsApp |

The real challenge is **not the features** — it is **coupling**: the current points/wallet core is
wired to *trade* concepts (`ChannelPartner` → `Outlet` → `outletCode`, KYC, bank payouts, GST/TDS,
sales hierarchy). An **employee has none of that**. Because KYC/payout/GST/TDS are permanently out
of scope, that coupling can simply be **removed and switched off**, not reinvented.

---

## 3. Recommended build approach

**Shared codebase → separate deployment + database → employee-rewards "product mode".**
Not a Deoleo-clone tenant; not a greenfield rebuild.

1. **Reuse the engine.** Greenfield throws away the most valuable and most dangerous code (ledger,
   points expiry, redemption+OTP, catalog, tickets, multi-tenant auth, admin, notifications) and
   re-introduces solved bugs. Reuse wins decisively.
2. **Member abstraction (the one real engineering piece).** Introduce a generic "member" the
   points/wallet/redemption/tickets engine binds to, so an *employee* (just a `User` + `Wallet`,
   no outlet/KYC) and a *channel partner* are two shapes of one thing. This is a real refactor of
   money-path code → careful, audited. It is what makes every future employee client cheap.
3. **Capability-gated product mode.** `Client.productType = EMPLOYEE_REWARDS` + capability flags
   that switch **off** outlets / KYC / sales hierarchy / payouts / TDS / GST / invoicing and **on**
   the celebratory layer. Trade code never runs; no `if (isRewardsMode)` sprawl in the live
   platform.
4. **Separate deployment + separate DB.** Same image, its own Cloud Run services + its own Postgres,
   still multi-tenant *within* it. Deoleo is live money on a shared DB; this is a different product
   with employee/HR PII. Isolation buys: no shared-prod blast radius, PII separation, independent
   deploy cadence. Cost: migrations run twice + a little more ops — cheap insurance.
5. **Vendor / marketplace role (net-new, but ~60% there).** Reward-fulfilment already exists (bulk
   order-status upload + admin fulfilment UI). Extend: give catalog items an owner (`vendorId`), add
   a scoped **VENDOR** role that sees only *their* orders and uploads *their* status.

### Reuse / new / off

| Reuse ~as-is | Build new | Turn OFF |
|---|---|---|
| Wallet + PointsLedger + expiry | Member abstraction (employee = User+Wallet) | Outlets / OutletType |
| Points upload (credit-batch) | Employee-roster import + point-grant upload | KYC (all of it) |
| Reward catalog + redemption + OTP | Vendor role + catalog ownership + vendor-scoped orders | Bank payouts / PayoutTransaction |
| Tickets / support | Celebratory UX skin (congrats popups, richer push) | TDS / GST / invoicing |
| Schemes + banners / popups | `productType` + capability flags | Sales hierarchy (ASM/SO/XSR) |
| Multi-tenant auth, admin, notifications, branding | Separate deploy + DB provisioning | Outlet-scoped everything |

---

## 4. Phased plan

| Phase | Scope | Notes |
|---|---|---|
| **0 — Foundation** | `productType` + capability flags; isolated deployment + DB; CI wiring; decide login model | Infra + scaffolding; unblocks everything |
| **1 — Member abstraction** | Unbind wallet / points / redemption / tickets from outlet/partner; generic member | **The hard part** — money-path, heavy audit |
| **2 — Identity & intake** | Employee login; employee-roster import; point-grant upload (trimmed credit-batch, no outlet resolution) | Effort swings on login model |
| **3 — Employee app** | Wallet, catalog, redeem+OTP, tickets, schemes | Mostly config on the member layer + FE |
| **4 — Vendor role** | Catalog ownership; vendor-scoped orders; vendor fulfilment upload | Extends existing fulfilment |
| **5 — Celebratory skin** | Congrats popups, richer push, per-tenant branding for the client | Polish — last |
| **6 — Hardening & pilot** | Full E2E, cross-tenant isolation, security/audit pass, runtime-verify, first-client onboarding + UAT | Definition-of-done |

---

## 5. Rough timeline (Claude building)

See §7 for the estimate. Summary: **~4–6 weeks of focused build effort** for a UAT-ready v1;
a leaner walking-skeleton pilot demoable sooner. Calendar depends heavily on owner decision/UAT
turnaround and the login model.

---

## 6. Risks & things to pin down

- **Login model** (§1) — shapes the foundation; decide before Phase 0 finishes.
- **Member abstraction touches money paths** — the wallet is keyed to `partnerId` today; the recent
  `CreditPayoutEntry.outletId` bug shows how deep "outlet" runs. Refactor with full audit + gate +
  runtime-verify per the standing discipline.
- **Vendor scope creep** — "view + status" is small; "self-list + pricing + approval" is a bigger
  catalog-management build. Lock scope early.
- **Shared-code regressions** — the member abstraction changes shared engine code that Deoleo (live)
  also runs. Even with a separate deployment, the *code* is shared → every change gate-checked
  against the trade suite too.
- **Two-DB ops** — migrations/seeding run per deployment; fold into CI from Phase 0.

---

## 7. Effort estimate

*Rough, first-pass, will change. "Build-day" = one focused day of build + independent audit + full
gate + runtime-verify, under the existing orchestration model (parallel sub-agents write code; I
audit/gate/verify). Calendar elapsed depends on owner decision + UAT turnaround, which is the real
pacing factor, not raw build speed.*

| Phase | Build-days (low–high) | Main swing factor |
|---|---|---|
| 0 — Foundation | 2 – 4 | infra/CI for a 2nd deployment + DB |
| 1 — Member abstraction | 4 – 6 | money-path refactor + audit depth |
| 2 — Identity & intake | 3 – 5 | **phone-OTP (low) vs email/SSO (high)** |
| 3 — Employee app | 3 – 4 | mostly config once §1 lands |
| 4 — Vendor role | 3 – 4 | view+status (low) vs self-listing (higher) |
| 5 — Celebratory skin | 2 – 3 | polish |
| 6 — Hardening & pilot | 3 – 5 | E2E + first-client UAT loops |
| **Total** | **~20 – 31 build-days** | |

**Translation to calendar:**
- **~4–6 weeks** of focused build effort for a **UAT-ready v1** (all phases), assuming reasonably
  prompt decisions/reviews from your side.
- **~2 weeks** to a **demoable walking skeleton** (phases 0–3 lean: phone-OTP login, one client,
  catalog + wallet + redeem working end-to-end) if we defer vendor + polish.
- Leaner v1 levers if speed matters: phone-OTP login (skip SSO for v1), vendor = view+status only,
  minimal celebratory skin first — these pull the low end.

**What the estimate is NOT:** it is not a fixed-price commitment. Software estimates carry real
uncertainty; treat these as planning ranges, revisited after Phase 0 (once the login model and
vendor scope are locked, the range tightens considerably).

### 7.1 Scope of the estimate — it is full-stack, end-to-end

Each build-day **already includes** backend + frontend + the wiring + infra + quality, per the
standard discipline used across this platform:

| Layer | Counted in the estimate |
|---|---|
| Backend | Prisma schema + migrations, NestJS modules/services/controllers, business logic, DTO/validation, RBAC |
| Frontend | Next.js pages/components, state, auth flow, loading/error states |
| FE↔BE wiring | The Next proxy `/api/*` → backend `/v1/*` integration (known, repeatable pattern — low risk) |
| Infra | The 2nd Cloud Run deployment + Postgres DB + CI/deploy pipeline + seed/bootstrap |
| Quality | jest + vitest + tsc gates, independent adversarial audit (money paths), staging runtime-verify per phase |

**NOT included in the estimate** (can extend calendar; several need the owner/client, not Claude):

- **Bespoke visual/brand design + creative** — Claude builds the *mechanics* of the celebratory UX;
  polished art direction + client-supplied assets (logos, gift images, reward SKUs) come from the
  owner/client.
- **Client data delivery** — employee roster, catalog items, vendor list. Loading is fast but gated
  on the client sending files (this was the last blocker for Deoleo go-live).
- **External integrations** — the estimate assumes **manual / vendor-upload fulfilment** (as today).
  **Automated voucher provisioning** (e.g. an Amazon-voucher API) is extra; **email/SSO login** adds
  to Phase 2 + needs the IdP set up; **email notifications** depend on the open Notifications-Core
  provider decision (ZeptoMail vs SES).
- **GCP provisioning / secrets needing owner hands** (owner-ops).
- **Open-ended client change requests / UAT iteration** beyond the built-in per-phase loops.

Baseline assumption behind the 4–6 week v1: **manual fulfilment + phone-OTP login + prompt owner
decisions**. The excluded items above are the levers that move the number.
