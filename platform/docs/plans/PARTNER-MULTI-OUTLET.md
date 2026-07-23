# Partner → Multiple Outlets (Parent-Child Owner Groups)

> **Status:** DESIGN LOCKED (2026-07-22, owner Q&A this session). Not yet built. This doc is the
> single source of truth — the earlier discussion was lost because it was never written down, so
> everything agreed is captured here before any code.
>
> **Applies to:** Loyaltybase (`api/` + `platform/`). Deoleo is LIVE in prod, so this is an
> **additive, opt-in** change — no existing outlet is affected until an admin explicitly groups it.

---

## 1. The problem
Today the platform operates **one outlet = one owner (`ChannelPartner`) = one login = one wallet**
(gap #4: the schema is 1:many-capable but *operated* 1:1 by convention). A real owner who runs
multiple shops cannot be represented: the KYC flow blocks a second outlet under the same GST/phone,
and there is no consolidated view.

We want: **an owner (parent) can hold multiple outlets (children)**, each child keeps its own login /
wallet / KYC unchanged, and the parent gets a consolidated read-only view — while tightening
uniqueness so unrelated outlets can never share identity details.

---

## 2. Locked decisions

### 2.1 Architecture — Option B (grouping layer)
Each child outlet keeps its **own** `ChannelPartner` / login / wallet / KYC, **exactly as today**.
A **parent** is an *additional*, non-operating owner entity that groups several children and provides
the consolidated view + the uniqueness relaxation. Nothing about a child's own experience changes.

### 2.2 The parent entity
- The parent is a **non-operating owner** — it **cannot be an operating shop** (has no outlet, no
  visibility/targets/leaderboard participation, no spendable wallet).
- Created by the **admin**. Minimum = **just an ID** (no details/docs required — details are optional).
- **May** carry its own GST/PAN/bank/details + documents. If it does, it gets its **own Gifsy KYC
  approval** (admin upload → straight to Gifsy approval, same approval dashboard as outlets — it
  **skips** the sales/first-approver stage). A bare ID-only parent has nothing to approve.
- May have its **own login phone** (optional).

### 2.3 The link is established ONE way — by the admin
The **only** way a parent-child relationship is formed is the **admin** setting a **Parent ID** column
on the **outlet-master upload**. Sales never creates the relationship. Two temporal cases:
- **(a) Grouped-before-KYC:** the outlet already has a Parent ID when sales KYCs it → parent details
  **pre-fill** the child form (editable, except PAN — see §4).
- **(b) Grouped-after-approval:** an already-approved normal outlet is later given a Parent ID by an
  admin re-upload → **validate on add** (§4.4); if it conflicts, **block + require re-KYC first**.

The mapping can change later (re-upload). **Un-grouping is blocked** while the child still shares any
detail with the group — the admin must re-KYC the child to make its details distinct first (§4.5).

### 2.4 PAN is the group's golden key
- **One group = one PAN.** All members (parent + children) share an **identical** PAN.
- Rationale: a legal entity has **one PAN** for life; **GST can vary state-to-state** under the same
  PAN. So GST/phone/bank/UPI may differ within a group, but **PAN must be identical**.
- PAN is therefore **unique-across-groups AND identical-within-group** → one PAN can belong to **at
  most one group**. You cannot KYC a second outlet on an existing PAN unless it's in that PAN's group.
- **PAN is locked** everywhere except the **re-KYC flow**. Changing PAN = a different legal entity =
  the outlet **leaves the group**. PAN can pre-fill from the parent **or** a sibling child.

### 2.5 The other identity fields
- **GST, phone, bank, UPI:** **unique-except-within-group** — may repeat or differ among a group's
  members, but must be distinct from every outlet *outside* the group.
- **Net-new work:** today only **GST and phone** are enforced unique; **PAN, bank, UPI are not checked
  at all**. This feature **adds** uniqueness enforcement for PAN/bank/UPI.
- **Tenant-configurable:** a per-tenant policy decides **which** of {GST, phone, bank, UPI} are
  enforced unique (PAN identical-within-group is always on). Default for Deoleo: **all enforced**.

### 2.6 Wallet
- Each child keeps its **own wallet + ledger + redemption**, paid out to its **own bank** (per the
  per-outlet payout mandate already shipped).
- The parent view is a **read-only consolidated roll-up** (sum of children's balances + per-outlet
  ledger drill-down). **No spend from the consolidated view** — all redemption/payout stays per-child.

### 2.7 Pre-fill + "verified on parent" badge
- When a child is grouped-before-KYC and the parent has details, the child form **pre-fills** owner
  details (editable; **PAN locked**).
- **Per-field badge:** a field shows **"verified on parent"** on the Gifsy/sales KYC detail pages only
  when the child's value is **unchanged** from the parent's **approved** value → Gifsy does **not**
  re-verify it. The moment sales edits a field, it becomes the child's own and is verified normally.

### 2.8 Login + picker (the parent-phone / child-phone resolution)
A login resolves a phone to **everything it can touch**, shown as a picker:
- **Operable outlets** = the outlet(s) carrying this phone → **full functionality, unchanged** (redeem,
  visibility, wallet, KYC actions).
- **Plus, if this phone is a parent phone** → an extra **"Group Overview"** entry = the **read-only**
  consolidated roll-up across **all** children (including siblings on other phones).

Cases:
| Phone situation | What the login shows |
|---|---|
| On exactly 1 child, not a parent | Straight into that outlet (today's behavior, unchanged) |
| On 2+ children | Picker of those operable outlets |
| Is a parent phone | Picker of its operable outlet(s) **+** "Group Overview" (read-only) |
| Parent phone with no child under it | Only "Group Overview" (read-only) |

The **parent entity stays non-operating** — it's the *person's phone* that operates their own shop and
*also* unlocks the group view. No functionality is ever stripped from a child.

### 2.9 Roll-ups beyond wallet — phased
- **Phase 1 (this build):** consolidated **wallet** roll-up only.
- **Phase 2 (later, optional):** parent roll-ups for **targets / visibility / leaderboard** (read-only
  aggregations; the sales-hierarchy subtree-rollup pattern already exists to reuse).

---

## 3. Entity model + schema changes (proposed)
Reuse the existing owner model (`ChannelPartner`) for the parent — inherits KYC / approval / login /
document machinery instead of a brand-new table.

- **`ChannelPartner.isParent Boolean @default(false)`** — a parent is a non-operating owner (no outlet,
  no spendable wallet).
- **`ChannelPartner.userId` → nullable** — a bare ID-only parent has no login. (Additive; today it's
  `@unique` non-null; the unique stays, nullability handled by a Postgres partial index.)
- **`Outlet.parentId String?` → `ChannelPartner` (the parent)** — the **single authoritative** group
  link, set by the admin outlet-master upload. `onDelete: SetNull`. Indexed.
  - Group membership of an outlet = its `parentId`. Two outlets are in the same group iff they share a
    `parentId`. Roll-up = outlets where `parentId = <parent>`.
- **Per-tenant uniqueness policy** — stored on the tenant settings blob
  (`clients`/`program_settings`, via `TenantSettingsService`): which of {GST, phone, bank, UPI} are
  enforced unique. Default Deoleo = all.
- **Migrations are additive / zero-downtime** (new nullable columns + a flag defaulting false). No
  existing outlet is grouped until an admin uploads Parent IDs.

*(Exact column placement finalized in Wave 1 — the parent could alternatively carry a self-`parentId`;
the outlet-level `parentId` is preferred as the single source of truth because the admin uploads at
outlet level and it avoids dual-column drift.)*

---

## 4. Uniqueness engine (the core, highest-risk)
A single shared helper enforces the rules on **every** write path — the one contract everything calls.

### 4.1 The rule set
- `assertPanRule(clientId, pan, group)`: PAN must be **identical within the group** and **absent from
  every outlet outside the group**.
- `assertDetailUnique(clientId, field, value, group, policy)`: for each of {GST, phone, bank, UPI}
  that the tenant policy enforces → **unique except within the same group**.

### 4.2 Every write path that must call it (trace-all-consumers)
1. **Sales KYC create** (`kyc.service.create`) — the grouped-before-KYC path.
2. **Sales KYC edit / re-KYC** — including PAN unlock in re-KYC (§2.4).
3. **Admin outlet-master bulk upload** (`admin-outlets.service`) — sets `Outlet.parentId`; must
   validate the whole file (within-file + against DB, group-aware).
4. **Admin "add to parent"** (re-upload sets a Parent ID on an approved outlet) — §4.4.
5. **Parent create / parent KYC** — the parent's own details subject to cross-group uniqueness.

### 4.3 Grouped-before-KYC (case a)
Child inherits the group's PAN (locked) + pre-filled editable GST/phone/bank/UPI. Uniqueness checks
run group-aware, so sharing a value with a sibling is allowed; colliding with an outside outlet blocks.

### 4.4 Add-approved-outlet-to-parent (case b) — validate on add
When an admin re-upload sets a Parent ID on an already-approved outlet:
- The child's **PAN must equal the group's PAN** → else **block** ("re-KYC to align PAN before adding").
- No enforced field may collide with a **different** group / outside outlet.
- On pass → link; on fail → error, no link.

### 4.5 Un-group / leave a group
- Removing a child from a parent (re-upload with Parent ID blank) is **blocked** while the child still
  shares **any** detail with the group → error: "make shared details distinct via re-KYC first."
- To truly leave: **re-KYC** the child to a **new unique PAN** (+ distinct GST/phone/bank/UPI as
  needed) → it becomes an independent entity → then the un-map succeeds.

---

## 5. Rollout & safety
- **Additive + opt-in:** no outlet is grouped until an admin uploads Parent IDs → **zero impact on the
  ~2,900 live Deoleo outlets** until deliberately grouped. Existing GST/phone uniqueness is preserved
  by default (the new PAN/bank/UPI enforcement + tenant policy default to the strict, current-behavior
  superset).
- **Money/identity/auth-sensitive:** touches KYC, uniqueness, login. Each wave gets an **independent
  adversarial audit** + full gate + **staging runtime-verify** before the next.
- **Retro-grouping existing outlets** = a normal admin re-upload with Parent IDs filled (no special
  migration).
- **Cutover:** ships to prod as an **owner-gated cutover** (has migrations), separate + after full
  staging verification. Kept behind the tenant uniqueness-policy + the opt-in grouping, so it can land
  dark and be exercised per-tenant.

---

## 6. Build orchestration (waves & streams)
Orchestrated: sub-agents build in parallel; the orchestrator (me) writes the shared contract, runs the
gates, does the independent adversarial audit, and staging-runtime-verifies each wave.

- **Wave 1 — Foundation (orchestrator, sequential — the shared contract):** schema + additive
  migration; the group-resolution + uniqueness helper (§4.1) + the tenant uniqueness-policy settings;
  seed a parent + 2-child group in `gifsy_dev` for tests/E2E.
- **Wave 2 — Backend core (parallel):**
  - **Stream A — Uniqueness enforcement + tenant policy:** wire the helper into all 5 write paths
    (§4.2); add PAN/bank/UPI enforcement; the per-tenant policy read. *Highest-risk (money/identity).*
  - **Stream B — Parent entity + admin upload/CRUD + parent KYC:** parent create (ID-min), the
    outlet-master Parent-ID column (parse/validate/link + add-to-parent + un-group guard), parent
    details/docs + straight-to-Gifsy approval.
- **Wave 3 — FE + experience (parallel):**
  - **Stream C — Child KYC pre-fill + per-field badge:** sales form pre-fill (PAN locked) + the
    "verified on parent" badge on both KYC detail pages + the backend parent-details endpoint.
  - **Stream D — Login picker + parent portal + wallet roll-up:** auth phone→group resolution + the
    picker + the read-only parent portal + the consolidated wallet roll-up (with per-outlet drill-down).
    *Auth-sensitive → rigorous audit.*
- **Wave 4 — Integration & hardening (orchestrator):** integrate shared files; full gate (api jest ·
  nest · FE vitest · tsc); **independent adversarial audit** (money/identity/auth → multi-verifier);
  E2E harness coverage (grouping, uniqueness block, picker, roll-up); staging runtime-verify; doc +
  memory sweep. Then an owner-gated cutover.

---

## 7. Phasing
- **Phase 1 (this plan):** §2.1–2.8 + wallet roll-up. The full owner-group capability.
- **Phase 2 (later, optional):** parent roll-ups for targets / visibility / leaderboard (§2.9).

---

## 8. Open items / risks
- **Conditional uniqueness across 4 fields + tenant policy** is the single most complex, error-prone
  piece — enforced in app code on every write path (Postgres can't express "unique except within a
  group" natively). Mitigation: one shared helper (§4.1), traced across all consumers, adversarially
  audited, with regression tests per path.
- **Auth/login picker** changes the session/resolution path (sensitive). Mitigation: rigorous audit,
  no change to the single-outlet path, staging-verify the multi-outlet + parent-phone matrix.
- **Nullable `userId` on `ChannelPartner`** — verify no code assumes it's non-null (grep all consumers).
- **PAN pre-fill from a sibling** when the parent is bare — the group's PAN source is the first member
  that has one; enforce identity thereafter.

---

## 9. BUILD STATUS

### ✅ Wave 1 — FOUNDATION DONE (2026-07-22, develop `18275ac`, gate green, migration applied on staging)
Additive + opt-in; zero impact on live Deoleo. Gate: api jest 1572 · nest 0 · FE vitest 1931 · tsc 0.

**As-built — the FROZEN CONTRACT Streams A/B/C/D build against:**
- **Schema** (`api/prisma/schema.prisma`): `ChannelPartner.isParent Boolean @default(false)`; `ChannelPartner.userId`/`phone` now **nullable** (a bare parent may be login-less); `Outlet.parentId String?` → parent `ChannelPartner` via named relations `OutletOwner` (existing partner) / `OutletParent` (new) + `@@index([parentId])`. Migration `20260722100000_partner_multi_outlet_foundation` (additive DDL, applied on staging).
- **Group link = `Outlet.parentId`** (single source of truth, set by admin upload). A group = all outlets sharing a `parentId`.
- **Uniqueness helper** `api/src/common/partner-group.helper.ts` (+ `.spec.ts`, 15 tests). Nest-free — returns a `UniquenessViolation | null`; the caller throws `BadRequestException(violation.message)`. Exports:
  - `checkGroupUniqueness(db, { clientId, ourParentId, details: {gstNumber,panNumber,bankAccountNumber,upiId}, policy, exceptPartnerId }) → UniquenessViolation | null` — **the main entry** (PAN identical-in-group + absent-outside; GST/bank/UPI unique-except-in-group per policy).
  - `resolveOutletParentId(db, clientId, outletId) → string | null`
  - `checkPanMatchesGroup`, `resolveGroupPan`, pure `isFieldEnforced`, `clashIsOutsideGroup` (unit-tested).
  - `db` = a PrismaService or `$transaction` client (typed `Pick<Prisma.TransactionClient,'channelPartner'|'outlet'>`).
- **Tenant policy**: `settings.uniquenessPolicy: { gst, phone, bank, upi }` via `TenantSettingsService.getEffectiveSettings(clientId)` (mirrors `redemptionChannels`; NESTED_KEYS → replace-whole). Typed default = `{gst:true,phone:true,bank:false,upi:false}` (today's behaviour). **Deoleo seeded all-on.**
- **Seed** (`api/prisma/seed.ts`, gifsy_dev only): parent `seed-parent-1`/`CPP01` (isParent, PAN `ZXCVB1234Z`, login-less, no outlet/wallet) + children `seed-cp-5`/`seed-o-5`/`CP005`/`O005` (phone `9000000021`, GST `27ZXCVB1234Z1Z1`, bank `111122223333`) and `seed-cp-6`/`seed-o-6`/`CP006`/`O006` (phone `9000000022`, GST `29ZXCVB1234Z1Z9`, bank `444455556666`) — grouped under the parent, **shared PAN, distinct GST/phone/bank** + deoleo `uniquenessPolicy` all-on. *(Not yet DB-run locally — the dev-DB proxy was down; validates on the next E2E reset / local DB up.)*

**TWO CONTRACT NOTES for the streams (critical):**
1. **PHONE is NOT in the helper.** It stays in `kyc.service.assertPhoneAvailable` (needs last-10-digit normalisation) — **Stream A** makes THAT group-aware. Also `User @@unique([clientId,phone])` means a group's shared phone maps to **ONE** login User; siblings sharing it are **login-less** (`ChannelPartner.userId=null`) and reached via that login's picker → **Stream A must NOT create a duplicate User** for a shared phone; **Stream D** resolves "operable outlets" by phone-match, not by User→ChannelPartner.
2. **Parent-leak sites** (exclude parents with `isParent:false`) — 3 REAL: `admin-programs/channel-partners.service.ts:46` (findMany) + `:57` (count); `admin-core/admin-core.service.ts:888` (count). Defensive (add too): `tds.service.ts:191/380/751/854`, `payouts.service.ts:829`. Wallet-at-approval `kyc.service.ts:2946` — guard `!isParent` if group-create ever reuses the KYC approval path. (Full map was produced by a sub-agent this session.)

### ▶ Wave 2 — NEXT (Streams A ‖ B in parallel, on the frozen contract)
- **Stream A** — wire `checkGroupUniqueness` into the write paths (`kyc.service.create` both branches + re-KYC; make `assertPhoneAvailable` group-aware; the add-to-parent + un-group validation) + PAN/bank/UPI enforcement + read `uniquenessPolicy`.
- **Stream B** — parent entity + admin outlet-master `parentId` column (parse/validate/link + add-to-parent + un-group guard) + parent create (ID-min) + parent details/docs → straight-to-Gifsy approval + the 3 parent-leak `isParent:false` filters.
- **File-partition to avoid contention**: A owns `kyc.service.ts` write paths; B owns `admin-outlets.service.ts` + the parent CRUD + the leak-filter edits. Route any shared-file overlap through the orchestrator at integration.
- Then **Wave 3** (C ‖ D: pre-fill/badge + login picker/parent-portal/wallet-rollup), **Wave 4** (integrate + adversarial audit + E2E + staging-verify), then owner-gated cutover.
