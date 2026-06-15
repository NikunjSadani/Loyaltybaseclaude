# Phase 1 — §4 Capability / Module Catalog (Bounded Contexts)

17 bounded contexts grouped into four clusters. Each entry: **Purpose · Key entities ·
Surface · Current state · Target/gaps.** "Current" = what the code does; "Target" =
intended design. Gap refs point to [gap-register.md](gap-register.md).

> **Deep-dive flag** 🔍 = high-ambiguity context flagged for a dedicated Q&A round.

> **Core value model (canonical).** The platform does **not** compute incentives. Tenants
> compute points/INR **externally** and **upload final amounts** per outlet per parameter
> (**header** = parameter/field, plus a **narration**). Uploads are *intended* to reflect in the
> **Wallet** (⚠️ not yet wired — Gap #16) and drive payouts (parameters **club into one UTR,
> except Visibility** which is always separate).
> Therefore: **Awards & Credits (#12a) is the single award path**; **Targets & Achievements
> (#8) is tracking/display only**; the **Scheme rule-engine (#7) is aspirational/unused**.

---

## Cluster A — Identity, Tenancy & Org

### 1 · Identity & Access 🔍 (RBAC)
- **Purpose.** Authenticate users and authorize actions across four portals.
- **Key entities.** `User`, `UserSession`, `OtpCode`, `AuditLog`, `LoginLog`, `UserRole` enum.
- **Surface.** `api/auth/{send-otp,verify-otp,me}`, `admin/users`, `api/admin/users*`.
- **Current (P1 done).** OTP via **MSG91** + JWT (`userId, role, partnerId, clientId, sid`).
  **Persisted `UserSession`** is now the source of truth: `getAuthUser` validates it per request
  (revocable; 365-day sliding idle) and **enforces subdomain == session-tenant for non-Gifsy**
  (GIFSY_ADMIN exempt), binding token↔tenant in-app (gap #20 resolved, #23 header-swap closed).
  Lifecycle: logout, logout-all-devices, Gifsy platform-wide force-logout, admin edit-phone→auto-logout.
- **Target/gaps.** Three access models: **Admin** = tenant-configurable roles built on the
  `lib/rbac` permission catalog (71 perms / 17 groups) + a pure `can()` engine with a default
  role→permission map (Gap #2/#3, 1.5/1.6a). **Default map (operating model, user-confirmed):**
  - **GIFSY_ADMIN = every permission** — Gifsy is *over and above* every role (invariant: every role ⊆ Gifsy).
  - **CLIENT_ADMIN = all EXCEPT the Gifsy-operated set** (`GIFSY_OPERATED_PERMISSIONS`): tenancy config
    (`tenancy:write/manage_flags`), **visibility self-billing invoices** (hidden entirely), **money
    settlement** (bank file, UTR/mark-paid, reversals, fund, batch, reconcile, TDS), and **activation
    create/delete** (`schemes:write/delete`). Client Admin DOES keep: reward/award upload + payout-status
    view, activation *view* + enrollments + reports, KYC, users, partners, catalog, targets, wallet,
    rewards, visibility capture/approval, support, engagement, and *viewing* tenant config.
  - **MIS_USER = read-only** (all `:read` + `reports:export`). **Sales/Partner roles = []** by default
    (access via portal routing + hierarchy/identity data-scoping, not admin permission keys).
  Per-tenant overrides (full-replacement) supported. Enforcement wiring across admin routes = **1.6b**
  (flag-gated, off by default). **Gifsy internal sub-roles** (finer Gifsy access division) = deferred.
  **Sales** = data scoped by hierarchy + team rollup; **Partner** = own data only. (Dead `ROLES` removed, 0.4b.)

### 2 · Tenancy & Platform Configuration
- **Purpose.** Onboard/configure tenants; per-tenant features, branding, structure.
- **Key entities.** `ClientConfig` (code registry), `OutletType`, `OutletTypeClientConfig`,
  `ProgramSetting`, `AdminConfig`, `PartnerClassConfig`.
- **Surface.** `gifsy/clients*`, `gifsy/outlet-types`, `gifsy/settings`,
  `api/gifsy/clients/[slug]/outlet-type-configs*`, `api/admin/settings`.
- **Current.** Tenant config lives in code (`CLIENT_REGISTRY`); per-tenant blobs stored in
  `ProgramSetting` (banner/gift/hierarchy/target/kpi JSON). Subdomain → `x-tenant-slug` →
  `clientId`.
- **Target/gaps.** No DB `Client`/`Tenant` model — feature flags have no DB home (registry
  says "in production these live in the database"). Domain refs now `gifsy.in` (Gap #1 closed, 0.4a).

### 3 · Sales Organization
- **Purpose.** Model the field-sales reporting tree and outlet assignments.
- **Key entities.** `SalesHierarchyLevel`, `SalesUser` (self-referential `reportingToId`),
  `SalesUserAssignment`, sales tasks (`task-config`).
- **Surface.** `admin/hierarchy`, `sales/team/[memberId]*`, `sales/tasks`,
  `api/sales/team*`, `api/admin/hierarchy-config`, `api/admin/task-config`.
- **Current.** Configurable levels per tenant; managers see subordinate + team performance;
  ISR leaf is outlet-facing. Hierarchy persisted as JSON in `ProgramSetting`.
- **Reference ladder** (tenant-driven names/count): ISR < SO < ASM < RSM < ZNM < NSM.
- **Target/gaps.** Derive level/role from relational `SalesHierarchyLevel`, not the fixed
  enum (Gap #11). Hierarchy stored as JSON blob vs relational `SalesUser` rows in some admin
  flows — verify source of truth. `task-config` scope to confirm.

### 4 · Partners & Outlets
- **Purpose.** The trade partners and their physical stores.
- **Key entities.** `ChannelPartner`, `PartnerClassConfig`, `TierConfig`,
  `PartnerTierHistory`, `Outlet`, `OutletGeoHistory`.
- **Surface.** `admin/users/outlets`, `admin/outlets`, `partner/profile`,
  `api/admin/outlets*`, `api/admin/channel-partners*`.
- **Current.** Partner = login (1:1 `User`); has Partner Class + Tier; owns Outlets.
  Outlet master upload/upsert, deactivate/reactivate, geo capture.
- **Onboarding sequence.** **Admin adds the outlet** in the portal → it then goes for
  enrollment/KYC performed by the client-defined **sales hierarchy** → approval chain →
  credentials issued (see #5). Credentials exist only *after* approval.
- **Target/gaps.** Partner/Outlet 1:many but operated 1:1; feature-to-level binding to
  formalize (Gap #4).

---

## Cluster B — Enrollment & Catalog

### 5 · KYC & Enrollment 🔍
- **Purpose.** Onboard partners: collect docs → validate → multi-level approve → credential.
- **Key entities.** `KycSubmission`, `KycDocument`, `KycStatusHistory`, `ConsentRecord`,
  `DataRequest`, `KycStatus` enum (15 states incl. penny-drop, agreement, SO/ASM/RSM/Gifsy
  approvals), `OutletKycIntent`.
- **Surface.** `sales/kyc/{new,[id],[id]/edit,[id]/ledger}`, `admin/kyc*`, `admin/approvals`,
  `api/kyc/[id]/{first-approve,approve,reject,ledger}`, `api/kyc/{consent,not-interested,sla-metrics}`.
- **Sequence.** Admin adds outlet first → **sales hierarchy (ISR) performs enrollment/KYC**
  on that outlet → reporting-manager approval chain (escalate on inactive) → Gifsy final →
  credentials.
- **Current.** Sales-initiated (ISR), document upload (S3), multi-level approval chain with
  per-tenant approver config (`approvalHierarchy`), penny-drop + agreement gates, Gifsy final
  approval, consent capture, SLA metrics.
- **Target/gaps.** Routing = direct reporting manager via tree, escalate up on inactive
  (resigned⇒blank phone), then Gifsy final (Gap #9). Retire flat `ROLE_PHONES`. Gifsy
  sub-steps + re-KYC trigger → §02 Workflows. Status alias `RESUBMISSION_REQUIRED`→`RE_UPLOAD_REQUIRED`.

### 6 · Product Catalog
- **Purpose.** SKUs and categories underpinning schemes/targets/achievements.
- **Key entities.** `Category` (self-referential), `Sku`, `SkuCategoryMapping`.
- **Surface.** `api/admin/skus`.
- **Current.** Category tree + SKUs per tenant; mapping to categories.
- **Target/gaps.** Light admin UI surface — verify management UX exists vs API-only.

---

## Cluster C — Programs & Value

### 7 · Schemes & Activations 🔍
- **Purpose.** Configurable, time-bound incentive programs (= "activations").
- **Key entities.** `Scheme`, `SchemeRule`, `SchemeEligibility`, `SchemeEnrollment`,
  `SchemeTarget`, `SchemeType`/`SchemeStatus`/`RuleType`/`RewardType` enums.
- **Surface.** `admin/schemes/[id]{,/enrollments}`, `api/schemes*`,
  `api/admin/schemes/[id]/enrollments{,/export}`, `api/schemes/calculate`.
- **Current.** Rich model — scheme types, generic rule engine (`SchemeRule`), segment/geo
  eligibility (incl. exclusions), enrollment, per-user `SchemeTarget`, budget tracking,
  `calculate` endpoint. **But the rule-engine/calculate path is not the operating award
  model** (awards come via Credits upload — see Core value model).
- **Operational scope.** Define activations (time-bound, audience, eligibility) + enroll
  outlets. Awards flow through Awards & Credits, not the scheme engine.
- **Target/gaps.** 🔍 Configurable **per-activation** enrollment forms (variable fields,
  self-vs-sales mode, conditional pre-fill for loyalty outlets) — Gap #6; enrollment mode is
  only tenant-level today. Loyalty (top/KYC, ongoing) vs Activation (all outlets, time-bound)
  split. Rule-engine/`calculate`/auto-`SchemeTarget` = aspirational vs upload reality (Gap #10).

### 8 · Targets & Achievements
- **Purpose.** Period goals per outlet and measured achievement.
- **Key entities.** `Target`, `TargetAchievement`, `SalesUpload`, `SalesUploadBatch`,
  `OutletSalesRecord`, `TargetPeriod`/`TargetStatus`/`SalesUploadStatus` enums.
- **Surface.** `admin/targets{,/upload}`, `admin/sales`, `partner/targets`,
  `api/admin/target-config*`, `api/admin/sales/*`, `api/partner/targets`, `lib/pace`.
- **Current.** Admin configures targets (wizard + Excel), uploads achievements (bulk batches),
  partner views target vs achievement with pace. Target configs + KPI defs in `ProgramSetting`.
  **Tracking/display only — not a money path** (see Core value model).
- **Target/gaps.** KPI def storage moved to `kpi-config`/`target-config` APIs (recent). Pace
  calc rules to document. Two separate uploads to disambiguate: *achievement* (tracking, here)
  vs *award amount* (money, #12a).

### 9 · Wallet & Points 🔍
- **Purpose.** Partner store of value (points + INR) and its ledger.
- **Key entities.** `Wallet`, `WalletTransaction`, `PointsLedger`, `PointExpiryConfig`,
  `WalletTransactionType`/`PointsLedgerType` enums.
- **Surface.** `partner/wallet`, `api/wallet/{transactions,adjust}`.
- **Current.** Per-partner wallet (`earnedPoints`/`redeemablePoints`…) + `WalletTransaction`;
  expiry config; admin adjustments. ⚠️ **Credits do NOT write the wallet today** (Gap #16) and
  nothing writes `PointsLedger` (Gap #28) — only redemption *debits* points. Earn is *intended*
  to come from Credits upload.
- **Target/gaps.** Points lifecycle is **tenant-configurable**: expiry (`PointExpiryConfig`),
  holding/lock period (`TierConfig.holdingPeriodDays`), and whether points convert to INR
  (→ payout engine via `redemptionOrderId`) vs gifts-only. → feeds Phase 3 Configurability
  Matrix. `TierConfig.pointsMultiplier` likely **dead** (amounts computed externally). 🔍 resolved.

### 10 · Rewards & Redemption
- **Purpose.** Catalog of gifts and the redemption pipeline (points → gift or INR).
- **Key entities.** `RewardCategory`, `RewardCatalog`, `RewardInventory`, `RedemptionOrder`,
  `RedemptionStatusHistory`, `RedemptionStatus`/`RewardCatalogStatus` enums.
- **Surface.** `partner/rewards{,/orders}`, `admin/gifts`, `api/rewards/{catalog,orders,
  redeem,redeem/confirm}`, `api/admin/gift-config`.
- **Current.** Gifsy-managed catalogue; inventory; OTP-confirmed redemption; order lifecycle.
  INR redemption ties into Redemption Payouts (#12b via `PayoutTransaction.redemptionOrderId`).
- **Target/gaps.** Sales redeeming on behalf of outlet — verify flow + audit.

---

## Cluster D — Finance, Engagement & Ops

### 11 · Visibility
- **Purpose.** In-store branding programs: capture → approve → (payout + invoice).
- **Key entities.** `VisibilityProgram`, `VisibilitySubmission`, `VisibilityApproval`,
  `VisibilityFraudLog`, `VisibilityImageHash`, `OutletVisibilityUploadBatch`,
  `OutletVisibilityRecord`, `OutletVisibilityAuditLog`.
- **Surface.** `sales/visibility`, `admin/visibility`, `api/visibility/*`.
- **Current.** Photo submissions, approval, **image-hash dedupe / fraud log**, outlet
  visibility status batches.
- **Target/gaps.** Payout is via Awards & Credits (separate UTR); invoice via #12c. Link
  submission→credit→invoice chain explicitly.

### 12a · Awards & Credits  *(Finance — push)*
- **Purpose.** Admin-pushed achievement awards (points or INR) per outlet per period.
- **Key entities.** `CreditField` (`isSeparatePayout`, `outletTypeAwards`), `CreditBatch`,
  `CreditPayoutEntry` (UTR), `CreditPayoutDownload` (bank file), `CreditReversal`.
- **Surface.** `admin/credits-payouts/{,fields,payout,status,upload}`, `api/admin/credits/*`.
- **Current.** **The single award path.** Tenant-computed amounts uploaded per outlet per
  parameter (`CreditField` = **header**, plus per-entry **narration**); confirm → bank-download →
  mark-paid w/ UTR; Gifsy-approved reversals. Parameters **club into one UTR except Visibility**
  (`isSeparatePayout`). Points or INR (`CreditAwardType`). ⚠️ POINTS rows *should* credit the
  wallet but don't yet (Gap #16).
- **Target/gaps.** Enforce no-clubbing for `isSeparatePayout` (Gap #7); "payout" naming overload (Gap #5).

### 12b · Redemption Payouts & Fund  *(Finance — pull)*
- **Purpose.** Partner redemption → INR via provider from the client's prepaid float.
- **Key entities.** `PayoutBatch`, `PayoutTransaction` (`redemptionOrderId`, provider fields),
  `FundLedger`, `FundReceipt`, `TdsRecord`.
- **Surface.** `admin/payouts{,/fund}`, `api/payouts/{batches,fund,reconciliation,transactions}`.
- **Current.** Fund top-up/receipts; payout batches; provider refs; TDS records + certificates;
  reconciliation.
- **Target/gaps.** Provider integration real vs stub; TDS section differences (incentive vs service).

### 12c · Visibility Self-Billing Invoicing  *(Finance — invoicing)*
- **Purpose.** Auto-generate outlet→Gifsy GST invoices for visibility services.
- **Key entities.** `AutoInvoice` (`invoiceNumber`, `lineItems`, `gstPaise`, `pdfUrl`).
- **Surface.** `admin/invoices{,/upload}`, `partner/invoices/[id]`, `api/partner/invoices/[id]`,
  `api/admin/invoices*`, `api/sales/invoices*`.
- **Current.** Gifsy self-bills on outlet's behalf; outlet views + **edits invoice number**;
  GST logic from outlet registration. Gifsy→Client billing off-platform (Gap #8, by design).
- **Target/gaps.** Validate partner-edited invoice number (uniqueness/format/lock).

### 13 · Engagement (Banners, Notifications, Leaderboard)
- **Purpose.** Partner-app merchandising, messaging, and rankings.
- **Key entities.** `BannerManagement`, `NotificationTemplate`, `NotificationQueue`,
  `NotificationDeliveryLog`, `LeaderboardConfig`, `LeaderboardSnapshot`, `LeaderboardEntry`.
- **Surface.** `admin/banners`, `partner/leaderboard`, `sales/leaderboard`,
  `api/partner/banners`, `api/leaderboard`, `api/admin/banner-config`, `lib/msg91`.
- **Current.** Banner config per tenant; templated notifications (SMS/WhatsApp via MSG91);
  leaderboard snapshots (per-tenant toggle, e.g. Deoleo hides partner leaderboard).
- **Target/gaps.** HO notification authoring flow; notification channel coverage (push/FCM).

### 14 · Reporting & Analytics
- **Purpose.** Dashboards and scheduled/exported reports across parameters.
- **Key entities.** `ScheduledReport`, `ReportDeliveryLog`, `ReportFormat`/`ReportFrequency` enums.
- **Surface.** `admin/dashboards/{engagement,kyc,payments,redemptions}`, `admin/reports`,
  `api/reports/{billing-trends,engagement,kyc-status,payout-liability,scheme-performance,tds,
  visibility-status}`, `api/admin/dashboard/kpis`.
- **Current.** Role-scoped dashboards; report endpoints across KYC/payout/visibility/TDS/
  engagement; scheduled report delivery.
- **Target/gaps.** Report access control ties to configurable RBAC (Gap #2). Export formats.

### 15 · Support (Tickets)
- **Purpose.** Support requests by/for partners and sales.
- **Key entities.** `Ticket`, `TicketMessage`, `TicketStatusHistory`,
  `TicketStatus`/`TicketPriority`/`TicketCategory` enums.
- **Surface.** `admin/tickets`, `partner/support`, `sales/support`,
  `api/tickets/[id]/{messages,escalate}`.
- **Current.** Create (self or on-behalf), threaded messages, status lifecycle, escalation,
  Gifsy/admin management.
- **Target/gaps.** SLA/assignment rules; category→queue routing.
