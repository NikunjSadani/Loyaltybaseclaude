# Employee Rewards — Admin Portal Design (Britannia anchor)

> **Status: DESIGN — authoritative for the admin surface.**
> Created 2026-10. **Companion to [EMPLOYEE-REWARDS-DESIGN.md](./EMPLOYEE-REWARDS-DESIGN.md)**
> (read that first — it establishes the earner model, `loyaltyType`, and the three surfaces).
> **Execution/build plan:** [EMPLOYEE-REWARDS-BUILD-PLAN.md](./EMPLOYEE-REWARDS-BUILD-PLAN.md).
> **Process / rules:** [EMPLOYEE-REWARDS-WAYS-OF-WORKING.md](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md) · acceptance [EMPLOYEE-REWARDS-UAT-CHECKLIST.md](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) · restart [EMPLOYEE-REWARDS-RESUME.md](./EMPLOYEE-REWARDS-RESUME.md).
> **Audience:** an engineer who knows *this* platform (Loyaltybase: NestJS `api/` + Next.js
> `platform/`, multi-tenant trade loyalty, operator Gifsy, live client Deoleo) but was **not**
> part of the design discussion. Self-contained for the admin surface — references the companion
> for anything about the earner model itself.

---

## 0. TL;DR

The employee-rewards **admin portal is a different-shaped cockpit, not a reskin** of today's admin.
Today's admin is built around **channel partners** — external businesses you pay — so its spine is
*onboarding → KYC → GST/PAN → payout → TDS → invoicing*. For Britannia the earners are **internal
employees** who redeem points for **gifts**, so that entire compliance-and-cash apparatus is **out of
scope**. The admin's spine shifts to: **People → Points (bulk upload) → Contests → Gifts/Fulfilment →
Liability → Engagement.**

**The mechanism that keeps it curated (not force-fit):** the admin is **one shell, capability-gated by
`Client.loyaltyType`** (the same switch from the companion doc). A `TRADE_LOYALTY` tenant (Deoleo) sees
the existing partner/KYC/TDS/payout navigation; an `EMPLOYEE_REWARDS` tenant (Britannia) sees the
employee-rewards navigation below. Same admin app, different modules lit up — so a Britannia admin
**never sees an empty GSTIN or TDS tab.**

Most of the *engine* under these screens already exists (points ledger, reward catalogue, gift dispatch
+ vendor portal, notifications, RBAC, settings, dashboards). The work is **new curated surfaces** over a
**reused engine**, plus the **gift-vendor portal** (covered in the companion §6.3; summarised here §5.6).

---

## 1. Why the admin is a different shape

The rep-facing app is ~80% a subset of the existing earner app (companion §1.2). **The admin is where the
two products genuinely diverge**, because the admin encodes the *business model*, and the business models
are different:

| | Trade loyalty (today) | Employee rewards (Britannia) |
|---|---|---|
| Earner | Outlet / dealer (a business) | Sales employee (a person) |
| Identity | KYC + PAN + GSTIN + bank | **Employee Code** (from HRMS) |
| Admin spine | Onboard → KYC → credits → **payout → TDS → invoice** | Roster → **upload points** → gifts |
| Money out | Cash payout (TDS/GST/invoicing) | **Gift fulfilment** (no cash, no tax stack) |
| Structure | Outlets, multi-outlet groups | **Sales hierarchy** (ASM→ASE→rep) — the backbone |
| Compliance | Heavy (statutory) | **None** (a gift to staff is a perk) |

So reusing today's admin as-is would hand a Britannia program owner a partner-compliance tool wearing a
Britannia skin. We instead **assemble the admin from employee-rewards parts only.**

---

## 2. Design principle — one platform, two curated products

Everything below is one of three verbs:

- **KEEP / REUSE** — existing Loyaltybase construct, reskinned/renamed, no model change.
- **RESHAPE** — same idea, different model + noun (partner→employee, scheme→contest, payout→fulfilment).
- **DROP** — trade-only machinery, switched off for `EMPLOYEE_REWARDS`, never shown.

The `loyaltyType` capability gate (companion §5) is what performs the DROP at runtime: the trade-only
admin modules are registered behind `requireLoyaltyType(TRADE_LOYALTY)` (or the capability flags derived
from it), so they do not render for an employee-rewards tenant — no dead tabs, no empty states.

---

## 3. Glossary delta

Core terms (channel partner, sales hierarchy, `loyaltyType`, `SalesUser`, `RewardAccount`) are defined in
companion §3. Admin-specific additions:

- **Program admin:** a Britannia-side (or Gifsy-operated) user who runs the employee-rewards program for a
  tenant. Maps to an RBAC role, not a new model.
- **Regional admin:** a program admin **scoped to a geography / slice of the sales hierarchy** — sees and
  acts only on their region's employees, contests, performance and orders.
- **Points liability:** the ₹ value of unredeemed, unexpired points outstanding — the program's balance-
  sheet obligation (replaces "amount payable" in the trade finance view).
- **Fulfilment:** the gift order lifecycle (`processing → dispatched → delivered → returned`) — replaces
  "payout" as the thing an admin operationally drives.
- **Beneficiary (of a contest):** who a contest rewards — "you & your team" in the rep app; in admin, the
  **eligible slice of the hierarchy / region** a contest is scoped to.

---

## 4. The admin surface map (information architecture)

Navigation is grouped around the employee-rewards journey, not the partner-compliance funnel. Proposed
left-nav for an `EMPLOYEE_REWARDS` tenant (routes illustrative, under the existing `platform/` admin):

```
People            /admin/people           roster, hierarchy, regional access
Points            /admin/points           bulk credit upload (+ optional targets)
Contests          /admin/contests         create / schedule / validate
Rewards           /admin/rewards          gift catalogue + Dream Reward curation
Fulfilment        /admin/fulfilment       redemption order queue + tracking
Vendors           /admin/vendors          gift-vendor management + moderation   (owner-gated)
Finance           /admin/liability        points liability, reward cost, budgets
Communications    /admin/comms            triggers, templates, broadcasts
Insights          /admin/insights         engagement analytics + leaderboards
Content           /admin/content          T&C / Privacy / help / FAQ
Settings          /admin/settings         program rules + admin roles
```

The **trade tenant's** nav (KYC, Credits, Payouts, TDS, Invoicing, Outlets, Schemes) is unchanged and
simply the other branch of the same gate.

---

## 5. Module-by-module spec

Each module: **Purpose · Key screens/actions · Data · Reuse/New · Curation note.**

### 5.1 People & Org (the roster) — *REUSE* (already built)
- **Purpose:** the employee master and the sales hierarchy that powers every team rollup.
- **Screens/actions:** the existing **"Employee Hierarchy" bulk Excel upload** (with dry-run diff) + the
  existing **single-employee edit** (fetch/patch by `employeeCode`) already cover
  create/maintain/reassign/deactivate. Reused as-is; only the link to the `EMPLOYEE` `RewardAccount` is
  wired on top.
- **Data:** `SalesUser` (`employeeCode`, `reportingToId`, `SalesHierarchyLevel`) + its `RewardAccount`
  (`accountType = EMPLOYEE`). No `ChannelPartner`, no KYC/PAN/GSTIN fields.
- **Reuse/New:** **~fully reuses** the existing employee-hierarchy upload + per-employee edit
  (`api/src/admin-core` sales-users + the hierarchy-config upload) and the admin-user edit/deactivate +
  phone-uniqueness lifecycle; reuses `descendantSalesUserIds` / `firstActiveApproverId` for subtree math.
  **New** only the `EMPLOYEE`-account linkage. A Britannia HRMS/API feed is an optional later integration.
- **Curation note:** this replaces partner onboarding + KYC **entirely**. Identity = Employee Code. The
  hierarchy is promoted from an add-on to the **backbone** (contests, performance, analytics, scoping all
  hang off it).

### 5.2 Points & contest crediting (the earn side) — *REUSE* (bulk upload, no compute)
- **Purpose:** get pre-decided point credits onto employee wallets. The business decides the points
  **externally**; the platform **does not compute** them — consistent with the platform's own no-compute
  model (points are uploaded, never calculated here).
- **Screens/actions:** **bulk-upload point credits** (one row per employee, keyed by Employee Code) with a
  dry-run diff → posts credits to the ledger; the same upload credits **contest bonuses** (§5.3); an
  **optional target-points column** (per employee/period) to drive the display-only achievement /
  "Potential" view; **adjustments/corrections** with an audit trail and reason codes.
- **Data:** reuses the points ledger (`Wallet` / `WalletTransaction` / `PointsLedger`) and the existing
  **no-compute credit-batch upload**, pointed at the `EMPLOYEE` `RewardAccount` instead of an outlet. Any
  target reuses the existing target/achievement scaffolding — as uploaded data, not computed.
- **Reuse/New:** **~fully reuses** the credit-batch upload + ledger writes; **new** only the Employee-Code
  keying and the optional target column. **No KPI / conversion / compute engine.** Never touches cash.
- **Curation note:** the *earner* changes (outlet → employee), the *mechanism* does not — points are
  uploaded, full stop. "Potential / Earned / Redeemed" in the app are display math over uploaded + ledger
  data, not a calculation the platform performs.

### 5.3 Contests — *RESHAPE*
- **Purpose:** create and schedule the region-curated contests exactly as the rep sees them.
- **Screens/actions:** create contest (**banner, name, duration, beneficiary = eligible hierarchy/region**,
  optional bonus, goal + validation rule); schedule (start/end); **live "as the rep sees it" preview**;
  validate outcomes (auto from performance data, or manual) → credits bonus points.
- **Data:** a `Contest` config per tenant (reframes the existing scheme/campaign model — region scoping,
  beneficiary, duration, banner asset). Bonus credit goes through the same ledger.
- **Reuse/New:** reuses scheme scheduling + banner/media handling + ledger credit; **new** the contest
  builder UI and region/beneficiary scoping.
- **Curation note:** a first-class module with its own noun ("Contest"), **not** a repurposed "scheme." The
  four elements the client specified (banner/name/duration/beneficiary) are the contest's identity.

### 5.4 Rewards catalogue & Dream Reward — *KEEP/RESHAPE*
- **Purpose:** curate the gift catalogue the rep redeems from, and the Dream-Reward goals.
- **Screens/actions:** CRUD gifts (category, points price, image, stock, **visibility by region/role**);
  flag **Dream-eligible / featured**; set redemption rules (min floor, caps, the 6-month expiry); map the
  PLATFORM gift taxonomy to this tenant's categories.
- **Data:** reuses `RewardCatalog` + the Gift Catalogue module's **PLATFORM `GiftCategory`** vs per-tenant
  **`RewardCategory`** split (`/admin/gifts`).
- **Reuse/New:** **~fully reuses** the existing Gift Catalogue & Dispatch admin; **new** only the
  Dream-Reward/featured flag and role/region visibility defaults.
- **Curation note:** "Gifts" and "Dream Reward," not "reward catalogue for redemption-to-payout." The catalogue
  is the destination, not a step toward a cash payout.

### 5.5 Redemption & Fulfilment / Orders — *KEEP*
- **Purpose:** the operational workhorse behind the rep's "Track my order."
- **Screens/actions:** order queue; lifecycle `processing → dispatched → delivered → returned`; enter
  courier + tracking ID; SLA view; returns/re-dispatch; value-frozen-at-redemption handling.
- **Data:** reuses the Gift Catalogue & Dispatch fulfilment model (`gift-order`, dispatch states).
- **Reuse/New:** **~fully reuses** dispatch/fulfilment; **new** only employee-shipping-address sourcing
  (ship to the rep's beat/office vs an outlet address).
- **Curation note:** "Fulfilment," not "Payout." This is the thing an admin drives daily where a trade admin
  would drive bank transfers.

### 5.6 Gift-Vendor portal (separate, hard-scoped surface) — *KEEP* (companion §6.3)
- **Purpose:** external gift vendors upload/manage **their** products and fulfil **their** orders.
- **Screens/actions:** vendor login → **only their** pending orders → enter dispatch/tracking; upload/edit
  **their** products (owner-**moderated** before they go live); consent/retention/suspend-cascade.
- **Data + reuse:** this already exists as Wave 2 of the Gift Catalogue & Dispatch module (owner-only admin
  + hard-scoped portal + moderation + disbursal report). **Reuse as-is.**
- **Curation note:** stays a **deliberately separate, minimal app** — not a tab in the Britannia admin. A
  vendor must never see the program surface. Vendor management (approve/suspend/moderate) is the only piece
  that lives in the main admin, under `/admin/vendors` (owner-gated).

### 5.7 Points liability & reconciliation (finance, reframed) — *RESHAPE*
- **Purpose:** the finance view an **employee** program owner actually needs.
- **Screens/actions:** outstanding **points liability** (₹ value of unredeemed, unexpired points); accrual
  vs burn over time; **expiry forecast** (what lapses in the next N months under the 6-month rule); cost of
  rewards fulfilled; **budget per region / per contest** with actual-vs-budget.
- **Data:** derived from the ledger + reward-cost data; **new** liability/budget rollups.
- **Reuse/New:** reuses the ledger + the finance dashboard framework; **new** the liability/forecast/budget
  views. **Drops** invoicing/TDS/payout entirely.
- **Curation note:** this is the single most important "don't force-fit" swap. **No** GST, **no** TDS
  (194R/194C), **no** self-bill invoice, **no** payout bridge — those are DROP (§6). Finance here = points
  liability + reward cost + budget.

### 5.8 Communications — *KEEP*
- **Purpose:** program messaging.
- **Screens/actions:** notification **triggers** (the client-mandated **locked-on "Contest Alert"** that
  can't be disabled in-app, points-earned, redemption status, **expiry reminders**); per-trigger channel
  config (Off/SMS/WhatsApp/Both/Push); **broadcasts** to segments (region / role / achievement band) with
  Excel audience + delivery report.
- **Data + reuse:** reuses `notification_queue` + drainer, `/gifsy/notification-templates`, the WhatsApp
  broadcast console (`/admin/whatsapp-broadcasts`), and delivery-status reporting
  (`/admin/notification-delivery`). **Reuse as-is**, add the employee-rewards trigger set.
- **Curation note:** the "Contest Alert cannot be disabled" requirement is a **trigger-level policy flag**
  (user can't opt out), configured here.

### 5.9 Engagement analytics / dashboards — *RESHAPE*
- **Purpose:** program-health lens tuned to sales-rep engagement.
- **Screens/actions:** active reps / participation rate; **earn→redeem funnel**; contest uptake; Dream-Reward
  adoption; region **leaderboards**; top/bottom performers; points liability snapshot.
- **Data + reuse:** reuses the admin-dashboard framework (the 4 existing dashboards) but with **new, curated
  metrics**. ⚠️ Carry over the dashboard denominator traps (never `isActive:true` for active denom; OR-wrap
  Prisma `{not}` to keep NULLs) noted in the existing dashboard work.
- **Reuse/New:** framework reused; **new** metric set.
- **Curation note:** **not** a KYC funnel. The headline numbers are participation, earn/redeem, and contest
  uptake — engagement, not compliance.

### 5.10 Support & content — *KEEP/RESHAPE*
- **Purpose:** handle rep queries and own program content.
- **Screens/actions:** support/ticket queue **keyed by Employee Code** (the rep app references it in every
  query); manage **T&C / Privacy / help / FAQ** content shown in the rep app footer.
- **Data + reuse:** reuses the ticketing + operator-docs (Help & Guides) scaffolding; **new** the content
  surfaces for T&C/Privacy.
- **Curation note:** Employee Code is the reference key across all communication (client requirement).

### 5.11 Settings & access (RBAC + regional scoping) — *KEEP/RESHAPE*
- **Purpose:** program rules + who can administer what.
- **Screens/actions:** conversion rate, **6-month points expiry window**, redemption min/caps, visibility
  defaults, contest regions; **admin roles** — program admin, **regional admin (scoped to a hierarchy
  slice)**, read-only finance, vendor manager.
- **Data + reuse:** reuses the `program_settings` store (per-tenant key/value, backend-enforced) and the
  RBAC Option-X staff-role model (feature perms × per-staff tenant grant, deny-by-default). Regional scoping
  reuses the sales-hierarchy scoping helpers.
- **Curation note:** the regional-admin scoping (§9) is the one genuinely new access pattern; everything else
  is the existing settings + RBAC frameworks with an employee-rewards key set.

---

## 6. How it differs from the current Loyaltybase admin — keep / reshape / drop

**DROP permanently for `EMPLOYEE_REWARDS`** (gated off; never rendered):
- Two-stage KYC, document capture, partner classification
- GSTIN / PAN capture, entity-type classification
- TDS engine (194R / 194C), gross-up config
- Self-bill GST invoicing
- Payout / bank-transfer bridge
- Outlet master + parent/child multi-outlet groups
- POSM visibility + scheme data-collection instrument *(unless field execution is wanted later — then a
  separate opt-in capability, not default)*

**RESHAPE** (same idea, new model + noun):
- Partner onboarding → **Employee roster** (Employee Code, HRMS import) — §5.1
- Schemes / campaigns → **Contests** (region, beneficiary, duration) — §5.3
- Credits upload → **employee points upload** (reuse the no-compute credit-batch, Employee-Code-keyed; no compute) — §5.2
- Finance (invoicing / TDS / payout) → **Points liability + reward cost + budget** — §5.7
- Sales-hierarchy scoping → same helpers, promoted to the backbone — §9

**KEEP / REUSE** (reskin, don't rebuild):
- Points **ledger / wallet** engine (`Wallet` / `WalletTransaction` / `PointsLedger`)
- **Reward catalogue + redemption + gift dispatch/fulfilment + vendor portal** (Gift Catalogue & Dispatch —
  the single most reusable asset)
- Notification fabric + templates + broadcasts + delivery reporting
- RBAC Option-X framework, `program_settings` framework, admin-dashboard framework, operator Help & Guides

---

## 7. Reuse map (existing construct → admin module)

| Existing Loyaltybase construct | Reused by admin module |
|---|---|
| `SalesUser` + hierarchy (`reportingToId`, `SalesHierarchyLevel`, `employeeCode`) | §5.1 People, §9 scoping |
| `RewardAccount` (`accountType=EMPLOYEE`) + `Wallet`/`PointsLedger` | §5.2 Points, §5.7 Liability |
| No-compute credit-batch upload + target scaffolding | §5.2 Points crediting, §5.3 Contests |
| `RewardCatalog` + Gift Catalogue (`GiftCategory`/`RewardCategory`, `/admin/gifts`) | §5.4 Rewards |
| Gift dispatch/fulfilment + 3P vendor portal (Wave 2) | §5.5 Fulfilment, §5.6 Vendors |
| `notification_queue`/drainer, templates, broadcasts, delivery reporting | §5.8 Communications |
| Admin-dashboard framework (KYC/Program-Health/Ops/Finance) | §5.9 Insights, §5.7 Liability |
| `program_settings` + RBAC Option-X + sales-hierarchy scoping | §5.11 Settings, §9 scoping |
| Admin-user edit/deactivate + phone lifecycle | §5.1 roster lifecycle |

---

## 8. Data model touchpoints

Mostly reuse; the genuinely new/extended pieces:
- **Optional target column** (§5.2) — uploaded target points per employee/period for the display-only achievement / "Potential" view. No KPI / conversion / compute config.
- **Contest config** (§5.3) — banner asset, region/beneficiary scoping, duration, validation rule.
- **Liability/budget rollups** (§5.7) — derived views over the ledger + reward cost (no new money model).
- **Employee shipping address** (§5.5) — source gift delivery from beat/office, not an outlet record.
- **Trigger policy flag** (§5.8) — "cannot be disabled in-app" on the Contest-Alert trigger.

No change to the money engine below the wallet (companion §5 — it is already owner-agnostic). The admin
reads/writes through the same ledger APIs.

---

## 9. RBAC & regional scoping

- **Roles** sit on the existing RBAC Option-X model (feature permissions × per-staff tenant grant,
  deny-by-default, assume-to-work). New named roles: **Program Admin**, **Regional Admin**, **Finance
  (read-only)**, **Vendor Manager**.
- **Regional scoping (REUSE the existing hierarchy scoping — locked):** a Regional Admin is pinned to a
  node in the sales hierarchy; every list/query (people, points, contests, orders, insights) is filtered
  through `descendantSalesUserIds(node)` so they see **only their subtree**. This **reuses the existing
  `/sales/**` scoping** — the same mechanism a manager already uses to see their downline — so there is
  **no separate/arbitrary "region" model**: region == a hierarchy slice.
- **Operator = BOTH (locked):** Gifsy operates centrally (platform-wide per the `platformWide()` invariant
  / RBAC P5) **and** Britannia gets scoped self-serve — a Program Admin (tenant-wide) + Regional Admins
  (subtree-scoped via the reuse above).

---

## 10. The "feel" — curation guardrails (enforce these)

1. **Capability-gated nav:** modules register behind `loyaltyType` capability flags. An `EMPLOYEE_REWARDS`
   admin must **never** see a trade-only tab (empty or otherwise). This is the single rule that makes it
   feel purpose-built.
2. **One dialect, app + admin:** use the rep app's nouns — **Dream Reward, Contest, Employee Code,
   Beat/Region, Gifts, Potential/Earned/Redeemed** — in the admin too.
3. **No empty states from the other product:** no GSTIN field, no TDS column, no "payout" verb anywhere in
   the employee-rewards admin.
4. **Vendor portal stays separate & minimal** — its own hard-scoped app, never a tab in the program admin.
5. **Hierarchy-first IA:** People/Points/Contests/Insights all read top-down through the sales tree,
   because that's how a Britannia sales org actually thinks.

---

## 11. Phased build plan

Sequenced so each phase is demoable and reuses maximally before building new.

- **Phase A — Capability-gated shell + People.** `loyaltyType`-driven admin nav; People roster
  (`SalesUser` CRUD + HRMS import + hierarchy editor) on the reused earner model. *Outcome: a Britannia
  admin can log in and see only employee-rewards nav + manage the roster.*
- **Phase B — Rewards + Fulfilment + Vendors (max reuse).** Reskin the Gift Catalogue & Dispatch admin +
  vendor portal for the employee context (Dream-eligible flag, employee shipping). *Outcome: gifts can be
  curated, redeemed, fulfilled — mostly wiring existing modules.*
- **Phase C — Points crediting + Contests.** Bulk points upload (reuse the no-compute credit-batch) +
  optional target column; contest builder with region/beneficiary, bonuses credited via the same upload.
  *Outcome: the earn side is real — mostly wiring an existing upload, not a new engine.*
- **Phase D — Communications + Insights + Liability.** Employee-rewards trigger set (incl. locked Contest
  Alert) over the existing notification fabric; curated engagement dashboards; points-liability/budget
  finance views. *Outcome: the program is run-able end to end.*
- **Phase E — Content + regional RBAC polish.** T&C/Privacy/help content surfaces; Regional Admin scoping.

Each phase: gate (`api` jest + nest build; `platform` vitest + tsc) → runtime-verify per role → independent
adversarial audit (dual for any money/liability path), per the standing agreements.

---

## 12. Decisions — LOCKED (owner, 2026-10-02)

1. **Points crediting = bulk upload, no compute.** Points (and contest bonuses) are **uploaded** via the
   existing no-compute credit-batch, keyed by Employee Code → `EMPLOYEE` RewardAccount. No KPI/conversion/
   compute engine, no DMS/SFA feed.
2. **Target column = INCLUDE.** Upload an (optional per-row) target-points column per employee/period to
   power the display-only achievement / "Potential" view (as in the demo). Display math only, not computed.
3. **Roster = REUSE the existing employee-hierarchy upload + maintenance** (§5.1). The platform already has
   the "Employee Hierarchy" bulk Excel upload + single-employee edit, keyed by `employeeCode` — reused
   as-is. A Britannia HRMS/API feed is an optional later integration, not a pilot dependency.
4. **Admin operator = BOTH.** Gifsy operates centrally **and** Britannia gets scoped self-serve
   (Program Admin tenant-wide + Regional Admins subtree-scoped) — see §9.
5. **Regional admin = REUSE the existing sales-hierarchy scoping** (§9). An admin's reach = their hierarchy
   node's subtree (`descendantSalesUserIds`), the same mechanism a manager already uses for their downline.
   No separate/arbitrary "region" model.
6. **Field execution (POSM) = OUT of pilot**, available later as an opt-in capability, not default (§6).

## 13. Out of scope (permanently, for `EMPLOYEE_REWARDS`)

KYC, GST/PAN/GSTIN, TDS (194R/194C), self-bill invoicing, cash payouts, outlet/multi-outlet groups. A gift
to an employee is a perk, not a vendor payout — the entire statutory/cash stack does not apply, and the
`loyaltyType` gate keeps it off.

---

*Companion: [EMPLOYEE-REWARDS-DESIGN.md](./EMPLOYEE-REWARDS-DESIGN.md) (earner model, three surfaces).
Rep-app visual target: `britannia-rewards-demo` (front-end-only demo). This doc owns the **admin** surface.*
