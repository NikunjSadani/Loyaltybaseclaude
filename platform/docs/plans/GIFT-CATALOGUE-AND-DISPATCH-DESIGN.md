# Gift Catalogue & Dispatch — design & build blueprint

Two linked modules on the multi-tenant trade-loyalty platform (operator **Gifsy**; tenants e.g. Deoleo):
**(A) a multi-source gift catalogue** (platform master + per-tenant third-party vendors) and **(B) a gift
dispatch / fulfilment tracking** layer over redemption orders. Design agreed with the owner 2026-08-21 via a
decision dialogue; this doc is the blueprint we build from. **Ideal-first**, with a trade-off/reuse layer.

> Reconcile note: much of Module B already exists — `RewardCatalog`/`RewardCategory` (per-tenant), and
> `RedemptionOrder` with `orderNumber`, an audited status lifecycle + `RedemptionStatusHistory`, `trackingNumber/
> trackingUrl/voucherCode/voucherProvider/dispatchedAt/deliveredAt/cancelledAt`, a **GIFSY-only transition
> endpoint** + **Excel bulk-fulfilment upload** + refund-on-cancel (`api/src/rewards/*`). 194R already cumulates
> each delivered `RedemptionOrder`'s value per PAN. We EXTEND these; we do not rebuild them.

---

## 1. Locked decisions (owner)
1. **Catalogue = platform master + third-party vendors.** Every item is source-tagged `PLATFORM | VENDOR`.
2. **Platform pricing = Gifsy, on behalf of the tenant** (no tenant approval workflow for platform items).
3. **Shared platform category taxonomy** (one tree Gifsy curates; tenants may hide/reorder, not fork).
4. **Pricing input = ₹ selling value → auto-derived pointsCost** (editable override), per tenant.
5. **Selling price (not cost)** is what we track — it is the order value → feeds **194R (outlet-based)** + a
   per-tenant / per-vendor **Gift Disbursal report**. Gifsy tracks no procurement cost.
6. **Vendors** = platform entities granted to specific tenant(s) via a **VendorTenantGrant** (deny-by-default,
   mirrors the RBAC `GifsyStaffTenantGrant` pattern). A vendor uploads items for its granted tenant(s), sets its
   own ₹ price, sees only its own items + redemptions, and uploads fulfilment/tracking.
7. **Moderation** = a per-vendor-grant `approvalPolicy`: v1 implements `AUTO_LIVE` and `GIFSY_APPROVE`; the enum
   also declares `TENANT_APPROVE` / `EITHER` (hybrid) for a later additive follow-up (tenant-side moderation UI).
8. **No vendor settlement / commission / payout** — vendor↔tenant commercials are entirely off-platform; Gifsy
   facilitates no vendor money. (194R on the outlet side + reporting only.)
9. **Vendor onboarding = credentials + grant only.** Name + phone/email login + status + tenant grant(s). **No
   GST/PAN/bank/KYC** collected.
10. **Fulfilment channels:** `FULFILLED_BY_AMAZON | GIFSY_WAREHOUSE | BRAND | DIGITAL_VOUCHER`. Bank/UPI **cash**
    redemptions are NOT gifts — they stay on the existing payout (UTR) rail, out of this module.
11. **v1 breadth beyond the ops console:** member order-status + tracking view, dispatch SLA/aging alerts, and
    auto member notifications (dispatched/delivered) via the notifications module already shipped.
12. **Vendor session = ONE tenant per vendor login (v1).** A vendor login is pinned to a single tenant; a vendor
    serving multiple tenants gets multiple logins. The `VendorTenantGrant` model stays platform/multi-tenant-capable,
    but v1 does NOT build a vendor assume-tenant flow — keeps the one-clientId-per-session isolation model intact.
13. **Vendor is the SOLE fulfiller of its own items' orders — Gifsy never re-ships them.** No reassign-to-Gifsy
    fallback. The only intervention for a truly abandoned in-flight vendor order (e.g. vendor suspended) is a
    **Gifsy cancel + refund** (member's points returned) — not reassignment.
14. **Canonical order value = the gift's ₹ selling price × quantity, FROZEN onto the order at redeem** (Option 1).
    This single number is what the disbursal report AND 194R use — decoupled from any later conversion-rate change
    (a rate change never re-values an already-placed gift). `confirmRedeem`/`confirmRedeemForOutlet` set
    `valuePaise = sellingValuePaise × quantity` for gift items (bypassing the points÷rate derivation), so points-spent
    and ₹-value are intentionally decoupled after a rate change.
15. **Vendor PII consent + scope (DPDP).** Redeeming ANY vendor-sourced item (`sourceType=VENDOR`) requires a
    **default-unticked, blocking consent checkbox** at redemption — *"I agree that my name, delivery address, and
    phone number will be shared with the fulfilment partner to deliver this gift."* On redeem the order stores
    `vendorPiiConsentAt` + `consentVersion` (demonstrable, versioned consent). Platform/Gifsy-fulfilled items show
    no checkbox (no third party). **The vendor receives the FULL delivery name + address + phone — NOT masked or
    minimised at the field level** (these are exactly what's needed to ship; owner-confirmed). Minimisation is at
    the **SCOPE** level only: the vendor sees the delivery details + its own orders and NOTHING of the member's
    wider record (profile, wallet/points, other orders, other vendors). Post-delivery PII retention/time-boxing is
    owner-configurable, NOT blocking. (A vendor data-processing agreement acceptance gate + the exact consent
    wording are owner/legal deliverables; the platform records acceptance + consent version.)
16. **Vendor PII retention = 180 days (6 months) after the order reaches a terminal state** (Delivered / Returned /
    Cancelled), to cover refund + warranty claims (a legitimate, documented purpose under DPDP storage-limitation).
    Configurable platform setting `vendorPiiRetentionDays` (default 180; per-tenant override possible). After the
    window, the vendor's order view withholds name/address/phone (the order/status/tracking remain visible to the
    vendor; **Gifsy ops + the member keep full access — nothing is deleted**, PII is withheld from the vendor UI
    only). An OPEN return/warranty/dispute PAUSES the countdown (vendor keeps address visibility until it resolves,
    then the 180-day clock starts).

---

## 2. Personas & scoping matrix
| Persona | Catalogue | Redemptions / orders | Fulfilment | Reports |
|---|---|---|---|---|
| **Gifsy ops** (GIFSY_ADMIN, assume-tenant) | create/curate master + categories; enable+price items per tenant; moderate vendor items | see **all** tenants' orders | update any order (or oversee) | all tenants + all vendors |
| **Vendor** (new VENDOR role, hard-scoped) | upload/edit **own** items for **granted** tenant(s); set own ₹ price | see redemptions of **own** items only (+ shipping-only PII) | update **own** orders (tracking/status) | own disbursals |
| **Tenant admin** (CLIENT_ADMIN) | (read) their live catalogue | (read) their orders | — | **their** gift-disbursal report (by vendor) |
| **Member** (partner/outlet) | browse + redeem their catalogue | own orders | — (track only) | — |

**Isolation invariants (hard):** a vendor never sees another vendor's items/orders, another tenant's data, or member data beyond delivery name/address/phone. Enforced at the **data boundary** (every vendor query scoped by `vendorId` AND the grant's `clientId`), the same discipline as tenant isolation + the RBAC grant model. Every vendor action audited.

---

## 3. Data model (additive)

**`Vendor`** (`@@map vendors`) — platform entity: `id, name, status(ACTIVE|SUSPENDED), createdByUserId, createdAt, updatedAt`. No financial/KYC fields.

**`VendorTenantGrant`** (`@@map vendor_tenant_grants`) — `id, vendorId(FK), clientId, approvalPolicy(AUTO_LIVE|GIFSY_APPROVE|TENANT_APPROVE|EITHER default GIFSY_APPROVE), status(ACTIVE|REVOKED), createdByUserId, createdAt`. `@@unique([vendorId, clientId])`. Deny-by-default: no grant = the vendor can't touch that tenant.

**Vendor login:** reuse the existing `User` model with `role = 'VENDOR'` + a `vendorId` FK (nullable, set only for vendor users) — mirrors how `gifsyRoleId`/`salesUser` attach role-specific context to a User. (No new auth stack.)

**`GiftMaster`** (`@@map gift_masters`) — the platform-source item authored once: `id, categoryId(FK GiftCategory), code, name, description, imageUrls(Json), mrpPaise, redemptionMode(PayoutMode), fulfilmentSource(the default channel), termsAndConditions, status(ACTIVE|ARCHIVED), stockQuantity?(nullable=unlimited), metadata, createdByUserId, timestamps, deletedAt`.

**`GiftCategory`** (`@@map gift_categories`) — **platform-level** shared taxonomy: `id, parentId?, code, name, imageUrl?, sortOrder, isActive`. (Replaces per-tenant categories for gifts; existing per-tenant `RewardCategory` is migrated/mapped — see §7.)

**Catalogue item = the sellable, tenant-priced row.** Two clean options (decide at build — see §8 "open build choice"):
- **Option R (recommended, low-risk): reuse `RewardCatalog` as the per-tenant "live catalogue" row**, adding `sourceType(PLATFORM|VENDOR)`, `giftMasterId?(FK)`, `vendorId?(FK)`, `sellingValuePaise`(the ₹ price that derives pointsCost + IS the order value), `moderationStatus(DRAFT|PENDING|APPROVED|REJECTED)`, `moderationBy/At/Reason`. A platform item published to a tenant = a `RewardCatalog` row (`sourceType=PLATFORM`, `giftMasterId` set). A vendor item for a tenant = a `RewardCatalog` row (`sourceType=VENDOR`, `vendorId` set). **Live orders keep FK'ing `RewardCatalog.id` unchanged → zero migration risk to Deoleo's redemptions.**
- Option M (purer, more work): a separate `TenantGiftOffering` join + project the member catalogue from it; requires re-pointing order FKs. Not recommended given live data.

**`RedemptionOrder` — additive fields** for dispatch: `fulfilmentChannel(enum)`, `logisticsPartner?`, `supplierOrderRef?` (e.g. Amazon order id), `fulfilledByVendorId?(FK, =the item's vendor when sourceType=VENDOR)`, `podUrl?`. **Reuse** existing `orderNumber` (reformat NEW orders to `TENANT-YY-######`; existing untouched), `status`+`statusHistory`, `trackingNumber/trackingUrl/voucherCode/*`, `dispatchedAt/deliveredAt/cancelledAt`, `valuePaise`. Set `valuePaise = the item's sellingValuePaise` at redemption (store explicitly → exact 194R + reporting, no rounding drift).

Enums: `GiftSourceType`, `VendorStatus`, `VendorGrantStatus`, `GiftApprovalPolicy`, `GiftModerationStatus`, `GiftFulfilmentChannel`. Extend `UserRole` with `VENDOR`.

---

## 4. Catalogue flows
- **Platform item:** Gifsy creates a `GiftMaster` → "publish to tenants" (bulk) creates/updates each tenant's `RewardCatalog` row with Gifsy-set `sellingValuePaise` (₹→pointsCost via that tenant's conversion rate, editable). Master content edits propagate to published rows; `sellingValuePaise`/pointsCost never auto-overwritten. Archive master → hide all its rows (in-flight orders continue).
- **Vendor item:** vendor (scoped to a granted tenant) creates a `RewardCatalog` row (`sourceType=VENDOR`) via UI or **Excel bulk upload** (template + validation: required fields, image URL, MRP/price sanity, category, dedup) → `moderationStatus` per the grant's `approvalPolicy` (`AUTO_LIVE`→APPROVED; `GIFSY_APPROVE`→PENDING until Gifsy approves). Vendor sets `sellingValuePaise` (→pointsCost). Only `APPROVED`+`ACTIVE` rows appear to members.
- **Member catalogue** = `RewardCatalog` rows for the member's tenant that are APPROVED + ACTIVE (+ in stock). Source is invisible to the member (optionally a subtle "sold by"). One unified browse/redeem/track UX regardless of source.

## 5. Dispatch / fulfilment flows
- Redeem (physical/voucher) → `RedemptionOrder` created, `valuePaise` = item selling value, `fulfilledByVendorId` set if vendor-sourced, `orderNumber = TENANT-YY-######`.
- **Routing:** vendor-sourced order → visible/actionable in that **vendor's** portal; platform/warehouse order → **Gifsy ops** console. Gifsy ops sees ALL (oversight/override).
- **Fulfilment update** (by the responsible actor): pick `fulfilmentChannel` → enter `logisticsPartner` + `trackingNumber/Url` (or `supplierOrderRef`, or `voucherCode` for DIGITAL) → move status. Reuse the existing guarded transition + Excel bulk-fulfilment upload (extend both to be vendor-scoped).
- **Status lifecycle:** `PLACED → APPROVED/PROCESSING → DISPATCHED → DELIVERED` (+ `CANCELLED/RETURNED/FAILED`); each stamped in `statusHistory`; cancel refunds points (exists). DISPATCHED/DELIVERED **auto-fire member notifications** (ORDER_DISPATCHED/DELIVERED triggers already built).
- **Member view:** "My rewards" order status + tracking in the partner app. **Dispatch SLA/aging** (reuse business-hours/SLA engine): flag orders undispatched beyond N business hours, per fulfiller; alert Gifsy ops + the vendor.

## 6. 194R & reporting (no vendor money)
- **194R stays outlet-based:** a delivered gift's `valuePaise` adds to the receiving outlet/PAN's 194R base — same engine that already cumulates redemption value. Gifts + cash both count.
- **Gift Disbursal report** (tenant-accessible + Gifsy): by tenant and **by vendor** — counts + ₹ value disbursed + status breakdown + date range, xlsx export. Pure reporting; **no** settlement/commission/vendor payout anywhere.

## 7. Migration (Deoleo is live)
- Seed `GiftCategory` (platform) from the existing category set; map each tenant's `RewardCategory` → the shared taxonomy (or keep `RewardCategory` and add a `giftCategoryId` link — decide at build).
- For each existing `RewardCatalog` row: set `sourceType=PLATFORM`, backfill `sellingValuePaise` = **round(pointsCost ÷ conversionRate)** (value = points ÷ rate; rate = points-per-₹ — NOT × rate, which would inflate by rate²), or from `mrpPaise`; create a `GiftMaster` per distinct item and back-link `giftMasterId`. **Order FKs unchanged → live redemptions unaffected.** Verify against a few known Deoleo items before running.
- Categories: **keep `RewardCategory`, add a nullable `giftCategoryId` link** to the shared `GiftCategory` (additive, zero FK churn) — do NOT repoint the live `RewardCatalog.categoryId` FK. GiftMaster de-dup key = (source, a platform-unique code), since per-tenant `code` isn't unique across the master.
- Additive migration only; no existing table dropped/repointed. Verify Deoleo's live catalogue + orders byte-identical after.

## 8. Reuse & effort (trade-off layer)
**Accelerators (reuse):** RBAC `*TenantGrant` (→ vendor grants + deny-by-default) · tenant-isolation discipline (→ vendor scoping) · atomic stock decrement / oversell guard · Excel upload+validation · SLA/business-hours engine · notification triggers (member + vendor) · the existing `RedemptionOrder` lifecycle + GIFSY transition + Excel fulfilment upload + refund-on-cancel · the 194R cumulation of redemption value.
**Genuinely new:** Vendor entity + VENDOR role + scoped **vendor portal** · source-tagged catalogue + GiftMaster/GiftCategory + moderation · platform cross-tenant **fulfilment console** · fulfilment-channel/partner fields + tenant-stamped order # · the **Gift Disbursal report** · the Deoleo migration.
**Open build choice:** §3 Option R (extend `RewardCatalog`) vs Option M (separate offering + re-point FKs) — **recommend Option R** (zero risk to live orders).

## 9. Out of scope (explicit)
Vendor settlement / commission / take-rate / payouts; vendor GST/PAN/bank/KYC; procurement-cost tracking; full returns/RMA workflow + ratings (marketplace maturity — future; but a Gifsy-only `DELIVERED→RETURNED` value-reversal IS in v1, see §12); **Gifsy fulfilment-fallback / reassignment of vendor orders (decided-against — vendor is sole fulfiller; escape = cancel+refund, §12)**; tenant-side / hybrid moderation UI (enum-ready, deferred); partial fulfilment / line-items for qty>1 physical gifts (single-shipment only in v1).

## 10. Assurance (when built)
Full gates + **tri-lane audit** (DUAL money/PII+isolation — vendor cross-scope leak, member-PII minimisation, 194R value exactness, oversell, moderation bypass; + UI/UX for the vendor + ops + member surfaces) + **staging runtime-verify** per role (Gifsy ops, a vendor scoped to one tenant, tenant admin, member) proving the isolation matrix + a redeem→vendor-fulfil→member-tracks→194R/disbursal-report loop. ⚠️ new role + DI wiring → a real BOOT check (staging Ready), not just green gates.

## 11. Recommended sequencing (owner to confirm at build)
- **P1 — Catalogue core:** GiftMaster + GiftCategory + `RewardCatalog` extension + Gifsy publish/price + migration (no vendors yet). Deoleo catalogue unchanged in behaviour.
- **P2 — Dispatch console + member track + notifications + SLA:** extend RedemptionOrder + the platform fulfilment console + member view (mostly reuse).
- **P3 — Vendors:** Vendor entity + VENDOR role + grants + scoped vendor portal (catalogue upload + own-redemptions + own-fulfilment) + moderation + Gift Disbursal report.
Each phase: gated + audited + staging-verified; owner-gated cutover.

## 12. Review hardening (independent best-practices pass — folded in)
An independent marketplace/rewards/multi-tenant review pressure-tested this doc against the real code. Validated as sound: Option R (order FKs untouched), the atomic stock-decrement reuse, rate-snapshot-at-redeem, the deny-by-default grant model, and the 194R integration point. Accepted findings — **all mandatory for the build**:

**Isolation & vendor lifecycle (CRITICAL/HIGH):**
- **Suspend/revoke cascade:** member `listCatalog`/`getCatalogItem`/`redeem`/`redeemForOutlet` MUST require, for `sourceType=VENDOR` rows, `Vendor.status=ACTIVE` **and** `VendorTenantGrant.status=ACTIVE` — plus an explicit sweep to hide a suspended vendor's rows. (A suspended vendor's items must stop being redeemable immediately.)
- **Vendor order-transition is ownership-filtered + refund-safe:** a vendor-facing transition filters `fulfilledByVendorId = vendor` (+ grant clientId) and uses a **restricted edge map (PROCESSING/DISPATCHED/DELIVERED only)**. Every wallet-touching edge (CANCELLED/RETURNED/FAILED → refund) stays **Gifsy-only**. (Vendors can never refund a member's wallet or touch another vendor's order.)
- **Abandoned in-flight order escape** = Gifsy **cancel+refund** only (per decision 13); no reassign-to-ship.
- **Hard vendor scoping** on every vendor read/write (vendorId AND grant.clientId), enforced at the data boundary; every vendor action **audited** (createCatalogItem/updateCatalogItem/transition/moderation write audit rows with actor+vendor+before/after price — the reused catalog CRUD does NOT audit today).

**Catalogue & moderation:**
- **Moderation filter on reads:** add `moderationStatus='APPROVED'` to list/get/redeem (existing methods filter only `status='ACTIVE'` / not at all → a PENDING/REJECTED item is otherwise redeemable via stale cart/deep link).
- **Price bounds even under AUTO_LIVE:** server-side floor + max (e.g. % of `mrpPaise` or absolute cap); require `mrpPaise` on vendor items. (A mispriced gift inflates the *outlet's* 194R base — a tax-integrity vector, not just commercial.)
- **Re-moderation on edit:** a material edit (sellingValue/name/images/category) of an APPROVED vendor item under a non-AUTO policy resets `moderationStatus=PENDING` and drops it from the member catalogue until re-approved.

**Money/tax exactness:**
- **Canonical value** per decision 14 (freeze `sellingValuePaise × quantity` at redeem) applied in confirm + report + 194R; tests for rate-change-between-pricing-and-redeem and qty>1.
- **Return reversal:** a Gifsy-only `DELIVERED→RETURNED` edge that zeroes `valuePaise` (+ refunds points per policy) so 194R (Source-2 sums DELIVERED value) and the disbursal report don't permanently over-count.
- **Disbursal report status basis = DELIVERED (match 194R)** — CANCELLED orders retain `valuePaise` (refund zeroes only points), so any value sum must filter DELIVERED. Add a test asserting report total == 194R Source-2 total for a tenant.

**PII / DPDP (India):**
- Vendors receive member delivery name/address/phone. Add: a vendor **data-processing-agreement gate** at onboarding, **member consent** for sharing shipping details with third-party fulfillers, **phone masking** where the channel allows, and **time-boxed** PII visibility (hide address N days after DELIVERED). **DIGITAL_VOUCHER exposes no shipping PII.**

**Operational:**
- **Order number:** atomic per-(tenant,year) sequence (DB sequence / `SELECT … FOR UPDATE` counter) — the new `TENANT-YY-######` isn't collision-free like the old `RDM-timestamp-random`; reports/filters tolerate both formats during the mixed period.
- **Idempotent status + bulk fulfilment upload:** skip if already in target state; de-dupe the member DISPATCHED/DELIVERED notification; batch-id on the Excel upload.
- **Channel-aware SLA:** per-channel definitions — `FULFILLED_BY_AMAZON` has no "undispatched" concept, `DIGITAL_VOUCHER` is instant; don't false-alarm.
- **Address quality:** validate pincode format/serviceability at redeem for physical gifts.
- **Internal "fulfilled by"** always visible to ops + tenant on order detail (even if source is hidden on the member browse tile) — for support/disputes.
- **Voucher hygiene:** mask `voucherCode` after issue; record member-viewed timestamp as delivery proof.
- **Tenant-scope predicate:** align the reused write paths (`transitionOrder`/`updateOrder`/fulfilment upload) onto `partner.clientId` (not `partner.user.clientId`, which misses login-less sibling outlets) before extending them.

The build's tri-lane audit (§10) is pointed squarely at this list; staging runtime-verify must exercise the suspend-cascade, the vendor refund-block, the moderation filter, and the value-exactness (rate-change + qty + return) end-to-end.
