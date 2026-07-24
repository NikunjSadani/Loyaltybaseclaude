# Partner → Multiple Outlets (Parent-Child Owner Groups)

> **Status (2026-07-23):** ✅ **Wave 1 + 2 + 3 + 4 ALL DONE — the FULL feature is complete on develop, gate
> green, adversarial-audited.** (W3 flows runtime-verified on staging; W4 staging-verify runs on the develop push.) W1+W2 migrations verified on STAGING; W3 added two
> additive migrations (OTP order-binding + scheme-enrollment-by-shop, now applied on staging); W4 adds NO
> migrations. **NOT in prod (owner-gated cutover pending).** W3 = login picker + group overview + child KYC
> pre-fill/badge + scheme-enrollment re-key. W4 = group-leave via re-KYC (Option A) + Phase-2 roll-ups
> (targets/visibility/leaderboard) + scheme-catalog eligibility fix. Next = owner UAT on staging → owner-gated cutover.
>
> ⚠️ **§9 "BUILD STATUS" is the AUTHORITATIVE AS-BUILT record.** The design EVOLVED substantially
> during Wave 2 (owner decisions on DB-vs-app enforcement, single-source-of-truth, re-KYC
> stage-at-approval, reserve-at-form-submit). Where §2–§8 below (the original locked intent) differ
> from §9, **§9 wins** — the most material changes are flagged inline with **⟪Wave-2 as-built⟫**.
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
- **⟪Wave-2 as-built⟫** PAN is enforced by a **hard partial-unique DB index** `(clientId,panNumber)
  WHERE groupId IS NULL` (always-on; unique for ungrouped owners, grouped siblings share) + the app
  check. ⟪Wave-4 as-built⟫ **Changing PAN via re-KYC now LEAVES the group** (Option A — atomic at Gifsy
  approval; see §4.5). The old `TODO(wave4)` is resolved.

### 2.5 The other identity fields
- **GST, phone, bank, UPI:** **unique-except-within-group** — may repeat or differ among a group's
  members, but must be distinct from every outlet *outside* the group.
- **Net-new work:** today only **GST and phone** are enforced unique; **PAN, bank, UPI are not checked
  at all**. This feature **adds** uniqueness enforcement for PAN/bank/UPI.
- **Tenant-configurable:** a per-tenant policy decides **which** of {GST, phone, bank, UPI} are
  enforced unique (PAN identical-within-group is always on). Default for Deoleo: **all enforced**.
- **⟪Wave-2 as-built — supersedes the "all tenant-configurable" intent⟫** GST **also** became an
  **always-on hard DB rule** (partial-unique index like PAN) — the app check MUST agree with a DB
  index, so `policy.gst` is now **informational only** (a legal tax ID is never legitimately
  duplicated). **bank/UPI** stay tenant-configurable and are **app-enforced** (no DB index) made
  race-proof by a per-value **transaction advisory lock** (`acquireIdentityLocks`). **phone** stays in
  the group-aware `assertPhoneAvailable`. All values are normalized (trim; upper-case PAN/GST) so the
  check, the DB index, and the persisted value agree.

### 2.5b Re-KYC = STAGE-AT-APPROVAL  ⟪Wave-2 as-built — NEW, not in the original design⟫
An approved partner must **never** carry unverified re-KYC values, even briefly. So a re-KYC does **not**
overwrite the live ChannelPartner/Outlet at draft time — it **stages** the proposed identity/payout **+
outlet address** on `KycSubmission.proposedPartner` and applies them to the live records **only at Gifsy
approval** (atomically, with the uniqueness check + lock + phone re-validation + login-sync at that
point; a violation rolls the whole approval back — never a half-apply). Every reviewer surface (detail
pages + bulk/queue/Excel) overlays the **proposed** values so the approver sees what they're approving.
Brand-new KYC is unchanged (still creates the partner at draft). **Reserve-at-form-submit + 48h
stale-draft cleanup** (`POST /v1/kyc/cleanup-stale-drafts`, secret-gated; reclaims an abandoned
brand-new draft's throwaway partner + reuses its orphan owner-User on retry).

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

**⟪Wave-2 as-built — the actual schema⟫** (`Outlet.parentId` = the single source of truth, set pre-KYC):
- **`ChannelPartner.groupId String?`** — a **DERIVED** mirror of the owner's `Outlet.parentId`, written
  by KYC-create and kept in lockstep by a **DB trigger** on `outlets` (`sync_channel_partner_group_id`,
  fires on parentId/partnerId change). It exists ONLY to host the partial-unique DB indexes on
  `channel_partners` (which can't reference `outlets.parentId`). This is a source→derived relationship
  (never edited independently), NOT the dual-column drift the note below warned about — the trigger is
  the drift guard. (An outlet can be grouped BEFORE it has an owner, so the link MUST live on the outlet;
  `groupId` on the owner is the DB-index's copy of it.)
- **Partial-unique indexes** `(clientId,gstNumber)` and `(clientId,panNumber)` `WHERE groupId IS NULL AND
  … IS NOT NULL AND deletedAt IS NULL` (the hard rule for ungrouped owners). The old full
  `@@unique([clientId,gstNumber])` is **dropped**.
- **`KycSubmission.proposedPartner Json?`** — the staged re-KYC patch (§2.5b).
- Migration `20260723120000_partner_group_uniqueness` (groupId + backfill + 2 partial uniques + trigger +
  proposedPartner + a scoped demo-data fix). Prisma can't model partial indexes/triggers → hand-authored.

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

### 4.5 Un-group / leave a group  ⟪Wave-4 as-built — Option A, owner-approved⟫
Two ways a shop leaves:
- **Dedicated admin un-group** (`POST /admin/outlets/:outletCode/ungroup`) is **blocked** while the child
  still shares **any** enforced detail with the group — for a shop that just needs detaching but whose
  details are already distinct.
- **Leave via re-KYC (the real "different owner now" path) — ✅ IMPLEMENTED (Wave 4, Option A).** A re-KYC
  whose **proposed PAN differs from the group's canonical PAN** is treated as an explicit **group-departure
  request** — because a group is defined by one shared PAN, a PAN moving away from it *necessarily* means
  leaving. It is applied **atomically at Gifsy approval**: the proposed identity is validated as a
  **STANDALONE** shop (`effectiveParentId = null` → must not collide with any outlet outside; a collision
  throws `ConflictException` → the whole approval rolls back, never a half-apply), the new identity/payout/
  address is applied, and the outlet's `parentId` is cleared **in the same transaction** (the
  `outlet_group_id_sync` trigger clears the derived `groupId`; the `WHERE groupId IS NULL` partial-unique
  index then subjects the departed shop to full standalone PAN/GST uniqueness). Gifsy-gated (only the
  second-stage Gifsy approval reaches this apply). Every reviewer surface shows an explicit **"approving this
  removes the shop from its group"** banner (`willLeaveGroup` on getOne — a boolean; the group PAN is never
  shipped). A departing shop that also changes its phone is re-validated standalone too. If the last child
  leaves, the parent simply becomes a **dormant childless parent** (not deleted). A non-departure re-KYC is
  byte-identical to before.

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
- **Phase 1 (Waves 1–3):** §2.1–2.8 + wallet roll-up. The full owner-group capability. ✅ DONE.
- **Phase 2 (Wave 4):** ✅ DONE — parent roll-ups for targets / visibility / leaderboard (§2.9) + group-leave
  via re-KYC (§4.5). The feature is now complete end-to-end.

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

### ✅ Wave 2 — DONE (2026-07-23, develop `1e2e4eb`, gate green: api jest 1650 · nest 0 · FE vitest 1940 · tsc 0)
Wave 2 (uniqueness enforcement + parent entity + admin grouping) built via parallel streams, then a
full audit-driven fix pass (3 adversarial auditors on the delta, all findings reconciled). Additive +
opt-in — the grouping/parent machinery is DORMANT until an admin sets a `parentId` (zero impact on live
Deoleo). **Pushed to develop; migration applied on staging (after a guarded staging PAN-dedup, below).**

**Design evolutions this wave (all owner-decided — supersede the earlier §3/§4 sketch where they differ):**
- **Single source of truth for the group link** = `Outlet.parentId` (an outlet can be grouped PRE-KYC,
  before an owner exists — so the link MUST live on the outlet). A **derived** `ChannelPartner.groupId`
  mirrors it, maintained by a **DB trigger** on `outlets` (`sync_channel_partner_group_id`, fires on
  parentId/partnerId change) + set inline at KYC partner-create. `groupId` exists ONLY to host the DB index.
- **PAN + GST = hard DB rule (always-on):** partial-unique indexes `(clientId, {pan,gst}) WHERE groupId
  IS NULL AND … IS NOT NULL AND deletedAt IS NULL` — unique for ungrouped owners, grouped siblings share.
  `isFieldEnforced` returns true for PAN AND GST regardless of policy (the app check MUST agree with the
  DB index). The old full `@@unique([clientId,gstNumber])` is DROPPED. `policy.gst` is now informational.
- **bank/UPI = tenant-configurable, app-enforced** (no DB index) + a per-value transaction advisory lock
  (`acquireIdentityLocks`, `pg_advisory_xact_lock`) that serializes concurrent same-value writers →
  race-proof without a constraint. The lock also belts-and-suspenders PAN/GST.
- **`normalizeIdentityValue`** (trim; upper-case PAN/GST) is applied consistently across the check, the
  DB index key, and the persisted value — so no whitespace/case variant slips a duplicate.
- **`checkGroupUniqueness` INCLUDES parents** (a parent anchors its own group = `[cand.id]`) — else a
  parent could share a tenant-enforced bank/UPI with an unrelated outlet (bank/UPI have no DB index).
- **Reserve-at-form-submit + 48h stale-draft cleanup:** identity is reserved when the rep submits the
  form (create writes the DRAFT partner). An abandoned brand-new draft is reclaimed after 48h (scheduler
  endpoint `POST /v1/kyc/cleanup-stale-drafts`, secret-gated) — deletes the throwaway partner (+ reuses
  the orphan owner-User on retry). ⚠️ **Needs a Cloud Scheduler job + `KYC_CLEANUP_SECRET` env per env.**
- **Re-KYC = STAGE-AT-APPROVAL** (an approved partner NEVER carries unverified values, even briefly): a
  re-KYC stages its proposed identity/payout **+ outlet ADDRESS** on `KycSubmission.proposedPartner` and
  applies them to the live ChannelPartner/Outlet ONLY at Gifsy approval — atomically, with the uniqueness
  check + lock + phone re-validation + login-sync at that point. `overlayProposedIdentity` shows the
  proposed values (incl. address) on every reviewer surface (detail pages + bulk/queue/Excel). Cleanup of
  a re-KYC draft just deletes the draft (the live partner was never touched).
- **Un-group = a DEDICATED admin action** (`POST /admin/outlets/:outletCode/ungroup`), NOT a blank upload
  cell; blocks while the child still shares PAN/GST/bank/UPI/**phone** with the group (§4.5). Re-link A→B
  via upload is blocked (un-group first).

**As-built files:** `partner-group.helper.ts` (+normalize/lock/parent-inclusion); `kyc.service.ts`
(uniqueness gate + stage-at-approval + cleanup + orphan-reuse); `admin-outlets/{parents.service,
parents.controller,admin-outlets.service}` + DTO; leak filters (channel-partners/admin-core/tds/payouts);
FE `admin|sales/kyc/[id]/page.tsx` (proposed-vs-current diff). Migration `20260723120000_partner_group_uniqueness`.

### ✅ Wave 3 — DONE (2026-07-23, on develop; gate green: api jest 1718 · nest 0 · FE vitest 1971 · tsc 0)
Streams C/D built via parallel sub-agents, then a **3-lens independent adversarial audit** (auth boundary /
money path / regression) + a full audit-fix pass. Additive + opt-in — dormant until an admin groups an
outlet. **On develop; migrations applied on staging via CI; NOT in prod (owner-gated cutover pending).**

**As-built:**
- **Login picker + active-partner selector.** Outlet/partner identity is NOT in the JWT — it is re-resolved
  per request. A phone → one login → its own partner + **login-less same-group same-phone siblings**
  (`userId=null`) reached via a picker. The selected outlet rides an httpOnly cookie `active_partner_id` →
  the proxy injects header **`x-active-partner-id`** → EVERY partner-self-resolution site
  (`partner`/`wallet`/`rewards`/`visibility`/`schemes`/`invoices`/`leaderboard`) re-authorizes it via
  `resolveActivePartnerId` (the shared **access boundary**: absent/own → own; a valid operable sibling →
  that sibling; anything else → forbidden). The money/write paths **fail closed** (403); the **shell endpoint
  `/partner/me` degrades to own** on an invalid selector (+ `activeSelectorInvalid` → the FE self-heals by
  clearing the cookie; logout also clears it) so a stale/shared-device cookie never bricks the portal.
- **Read-only group overview** (`GET /v1/partner/group/wallet`, new `GroupService`) — a consolidated wallet
  roll-up (sum of **Int POINTS**, not paise) + per-outlet drill-down, unlocked when the login's phone owns a
  parent (+ own-group cross-check so an admin phone-typo can't expose an unrelated group). FE `/partner/group`
  page + `/partner/select` picker + a header outlet-switcher (hidden for single-outlet logins).
- **Stream C — child KYC pre-fill + "verified on parent" badge.** A grouped-before-KYC child pre-fills owner
  identity from its APPROVED parent (PAN locked to the group PAN); both KYC detail pages show a per-field
  "verified on parent" badge (server-computed booleans, pre-mask → PII-safe). *(Owner decision: `parentPrefill`
  stays in the `/api/sales/outlets` list payload — reaches only authorized sales staff; not tightened.)*
- **Scheme enrollment RE-KEYED by SHOP** (owner decision): `SchemeEnrollment` moved from the login (`userId`)
  to the **partner/shop** (`@@unique[schemeId, partnerId]`; `userId` now nullable audit-only) so a login-less
  sibling can self-enroll via the picker. Migration `20260723140000_scheme_enrollment_by_partner` backfills
  `partnerId` from each enrollment's login and deletes un-backfillable orphans.
- **Redemption OTP is now order-bound** (`OtpCode.referenceId`, migration `20260723130000_otp_reference_id`) —
  a login can hold concurrent PENDING orders across outlets, so the confirm OTP is scoped to its order.

**(Wave-3 scheme-list gap — ✅ RESOLVED in Wave 4:** the eligibility filter was a dead `id IN ()` that hid ALL
schemes from ALL partners; it is now an opt-in allowlist threaded through the picker — see the Wave 4 section.)

**Migrations this feature adds (all additive / forward-only):** `20260722100000_partner_multi_outlet_foundation`
(W1) · `20260723120000_partner_group_uniqueness` (W2) · `20260723130000_otp_reference_id` (W3) ·
`20260723140000_scheme_enrollment_by_partner` (W3). W1+W2 already applied on staging; W3's two apply on the
next develop push.

### ⚠️ CUTOVER CHECKLIST (owner-gated; the migrations are NOT yet in prod)
1. **PROD dup-PAN pre-check BEFORE `migrate deploy`** — the PAN partial-unique index FAILS to build if two
   ungrouped active partners already share a PAN. Guarded read (same as staging):
   `SELECT "panNumber", count(*) FROM channel_partners WHERE "deletedAt" IS NULL AND "panNumber" IS NOT NULL AND "isParent"=false GROUP BY "clientId","panNumber" HAVING count(*)>1`.
   If non-empty → GROUP those real multi-outlet owners (or clear) first. (Deoleo prod is likely clean — no
   outlets onboarded yet — but VERIFY. Staging had 9 UAT-junk dups; nulled under guarded write 2026-07-23.)
2. **PROD scheme-enrollment orphan pre-check** — the W3 `scheme_enrollment_by_partner` migration **self-aborts**
   (RAISE EXCEPTION, no silent delete) if any enrollment's `userId` maps to no ChannelPartner. Run the pre-check
   so the deploy doesn't abort:
   `SELECT count(*) FROM scheme_enrollments e WHERE NOT EXISTS (SELECT 1 FROM channel_partners cp WHERE cp."userId"=e."userId")`.
   Expect 0 on prod (real enrollments always came from a partner login). If >0, inspect + resolve before migrating.
3. **Cloud Scheduler job** hitting `POST /v1/kyc/cleanup-stale-drafts` daily + the `KYC_CLEANUP_SECRET`
   env/secret set on prod (and staging) — else the 48h cleanup never runs (endpoint fail-closes).
4. **Before ever flipping a tenant's `uniquenessPolicy.bank`/`upi` to true on prod:** sweep for existing
   duplicate bank/UPI among ungrouped active partners (no DB index to reveal them) and group them first.
5. *(Resolved in Wave 4 — group-leave via re-KYC is implemented, Option A. No pre-check needed.)*

### ✅ Wave 4 — DONE (2026-07-23, on develop; gate green: api jest 1745 · nest 0 · FE vitest 1984 · tsc 0)
The final wave — three additive workstreams, then a full independent adversarial audit (money/identity focus on
group-leave). Additive/opt-in; NO new migrations. **Staging runtime-verify pending the develop push** (the Wave-3
picker/switch/overview/sibling-enroll flows are already verified on the live `w3test-*` staging group).
- **Group-leave via re-KYC (Option A):** §4.5 — a re-KYC PAN-change-away-from-group is an atomic Gifsy-approval
  departure (standalone-uniqueness or rollback; clears `parentId` in-tx; `willLeaveGroup` reviewer banner on both
  KYC detail pages). Resolves the old `TODO(wave4)`.
- **Phase-2 group roll-ups:** the read-only group overview now also rolls up **targets** (`GET /partner/group/
  targets`), **visibility** (`/visibility`, gated on the tenant `visibilityEnabled` flag — fail-closed), and
  **leaderboard** (`/leaderboard`, the group's shops' tenant-wide ranks). Same own-group guard + `outlet.parentId`
  source-of-truth scoping as the wallet roll-up. FE: three new sections on `/partner/group`.
- **Scheme-catalog eligibility fix:** `SchemeEligibility` is now an **OPT-IN allowlist** — with no rows configured
  (the default; nothing writes it today) a partner sees every ACTIVE tenant scheme (was a dead `id IN ()` that hid
  ALL schemes from ALL partners — a pre-existing bug). Threaded through the login picker (matches on active partner
  id AND user id) so a switched login-less sibling sees its catalog too. ACTIVE-only default preserved.

### ▶ REMAINING — owner UAT on staging (real OTP) then the owner-gated cutover
Owner exercises the full flow on staging: multi-outlet login → picker → switch → wallet/redeem per outlet →
group overview; grouped-child KYC pre-fill + verified-on-parent; login-less sibling scheme self-enroll; the
re-KYC stage-at-approval. Then the owner-gated prod cutover per the checklist above.
