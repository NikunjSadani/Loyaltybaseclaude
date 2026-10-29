# Bajaj — Customizations & Change Log (living doc)

Single source of truth for every change **exclusive to, or driven by, the Bajaj tenant**
(slug `bajaj`; staging host `uat-bajaj.gifsy.in`; canonical/prod `bajaj.gifsy.in`).
Keep Deoleo + all other tenants byte-identical. Update this doc in the SAME pass as any
Bajaj change. Last updated: 2026-10-29.

> ⚠️ **Architectural caveat (applies to everything below):** several Bajaj behaviors are keyed
> on the literal `slug === 'bajaj'` (e.g. `employee-hierarchy.ts:85`). This is brittle — it
> breaks on any host/slug that isn't exactly `bajaj` (see the ISR/staging anomaly). Prefer
> driving Bajaj behavior from a **tenant config field/flag**, not the slug literal.

---

## 1. Hubble Money — Amazon-voucher auto-issuance (Bajaj-only)
- **What:** on a confirmed GIFT_CARD redemption carrying a Hubble `productId`, auto-issue an
  Amazon Pay voucher via Hubble. Behind per-tenant flag `features.hubbleVoucherEnabled` (default OFF).
- **Amazon Pay productId:** `01HDRPKWFE2SMVM54TWD8S1927` — type **FLEXIBLE**, range **₹500–₹10,000**.
- **Status:** ✅ Built, dual-audited, deployed to staging (`52a0795` + webhook-secret `9b8aaac`).
  Flag ON for `bajaj`. **UAT PASSED** — ₹500 redemption `BAJAJ-26-000004` → voucher delivered
  (`9000001408310396`). A ₹100 attempt correctly FAILED+refunded (below the ₹500 floor).
- **Secrets (staging):** `HUBBLE_CLIENT_ID_STAGING` / `HUBBLE_CLIENT_SECRET_STAGING` /
  `WebhookHubbleStaging`→`HUBBLE_WEBHOOK_SECRET` (all in GCP Secret Manager, project `gifsy-platform`).
  Webhook URL: `https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook` (enforcing X-Verify).
- **Open items:** rotate the Hubble Client Secret (was shared in a screenshot); PROD wiring
  (prod creds + required `HUBBLE_WEBHOOK_SECRET` fail-closed in `deploy.yml` + base URL
  `api.myhubble.money`); static-egress-IP decision (prod min-instances=1 already warm).

## 2. VOUCHER_ISSUED notification — voucher code to the owner (ALL tenants, not Bajaj-only)
- **What:** when a voucher code is issued (Hubble auto-issue OR manual fulfilment), send the
  **outlet owner** their code via in-app bell + WhatsApp template `voucher_code`
  (vars: ownerName, amount `₹N`, program `<tenant> Loyalty`, voucherName, code). Transactional
  (exempt from the WhatsApp master switch, like OTP); disable-able per tenant via the panel.
- **Scope:** owner chose **all tenants, all vouchers** (incl. live Deoleo manual fulfilment).
- **Status:** ✅ Built, independently audited, fixes applied, **gates green. NOT pushed** (UAT hold).
- **Pre-push:** explicit nod that the Deoleo manual-voucher notification is intended; confirm the
  `voucher_code` template is approved on each sending MSG91 number.

## 3. Feature-flag toggles in GIFSY console (shared code, built in this effort)
- Editable per-tenant feature-flag toggles on the GIFSY client page (was read-only).
- **Status:** ✅ Deployed to staging (`3bbe29f`). Platform-wide operator tooling; no tenant
  runtime change until a flag is toggled.

## 4. Partner voucher card — show brand, not aggregator (shared code)
- Partner Orders voucher card shows the reward **brand** (e.g. "Amazon") instead of "HUBBLE".
- **Status:** ✅ Deployed to staging (`43c7b87`).

## 5. RLP / BSC outlet-type relabel (Bajaj-only) — PENDING
- **What:** rename outlet types for Bajaj — **Retailer → RLP** (code `SSS`), **Wholesaler → BSC**
  (code `WHOLESALER`). There is **no `RETAILER` code**; "Retailer" = `SSS`.
- **Phase A (config-only, no deploy):** set `OutletTypeClientConfig.displayName` for `bajaj`:
  `SSS`→"RLP", `WHOLESALER`→"BSC" via GIFSY console → Clients → Bajaj → Outlet Types → Custom name.
  Covers the entire admin outlet master, every export/report, KYC views (all read the config).
  Master-upload already accepts code/label/name (backward-compatible). **Status:** ✅ **DONE** —
  owner set `SSS`→RLP, `WHOLESALER`→BSC in the GIFSY console (2026-10-29). Verify on the admin
  outlet master + an export.
- **Phase B (code):** ✅ **BUILT + audited clean + gates green (held for push).** New JWT-scoped
  `GET /v1/settings/outlet-types` + `useOutletTypeLabels()` hook; 6 surfaces config-driven (KYC
  Partner-Type picker, sales/admin outlet-type filters, admin banners audience). Deoleo
  byte-identical (empty-override fallback). **Left:** `targets.ts` label maps (pure lib, needs
  caller-threaded labels), `partner-session.ts` map (dead code). **Excluded:** sell-out upload
  sheet names (input-parsing — separate careful pass), admin-settings `classLabels` (partner-class,
  not outlet type).
- **Phase B (code, Bajaj-safe, Deoleo-identical):** ~10 hardcoded FE dropdowns/label-maps are
  tenant-blind (KYC Partner-Type picker, sales/admin type filters, targets labels, banners,
  partner-session, sell-out upload sheet names). Refactor them to read the per-tenant config.
  ⚠️ sell-out upload sheet names are also **input-parsing keys** — change generator + parser in
  lockstep, tenant-scoped. **Status:** ⏳ awaiting go.
- Note: a **program** literally named "BSC" already exists (separate field from the type label).

## 6. RLP/BSC toggle dashboard — SALES TEAM app (Bajaj-only, SO+) — BUILT + AUDITED
- **Layout:** Tasks → My Outlets (moved up, shows ALL outlets) → **[RLP | BSC] toggle** →
  Target Achievement → **〈new comparison card〉** → Target-vs-Achievement trend → Visibility.
- **Toggle drives:** Target Achievement, the new card, the trend chart. **Visibility hidden for BSC**
  (already type-scoped: eligible `SSS`/`SSS_TOT`, excludes `WHOLESALER`).
- **New card:** visible **SO and above**; filters **program + team member** (+ toggle). Compares
  **last month / last 3 months / current** on two parameters:
  1. **Monthly sale** = the PRIMARY KPI's ₹ achievement. 3-month = **average** of the 3 months.
  2. **Target-met ratio** = outlets meeting target ÷ KYC-approved outlets with a target — reuse the
     **team-view `aggregate()`** formula (`sales.service.ts:498-525`; already type/program/member-aware).
     3-month = **average of each month's ratio**.
- **KPIs differ by type:** owner chose **(b) genuinely different KPI sets per type** → `KpiDef`
  has no outlet-type dimension today → **net-new schema change + migration**.
- **Net-new backend:** thread `outletType` through `getTargets`/`getTargetTrend`/`subtreeOutletCodes`
  (today only team-view is type-aware); per-type KpiDef dimension; new comparison endpoint;
  SO-and-above gate (compose `hasTeamView(role)` + tightened `@Roles`/level).
- **Gate:** explicit per-tenant feature flag **`rlpBscView`** (default OFF; added to the console
  toggles like `hubbleVoucherEnabled`), read via `useTenantFeatures('/api/sales/me')` (reliable
  authed source, NOT the SSR `useClientConfig`). Decoupled from relabeling. **To enable for Bajaj:
  flip `rlpBscView` ON in the GIFSY console** (labels already set via Phase A).
- **Backend:** additive `KpiDef.outletType` + `/v1/sales/trade-comparison` (reuses team-view ratio)
  + per-type KPI-set filtering in `getTargets`/`getTargetTrend`. **FE:** My-Outlets reorder (Bajaj-only),
  toggle, comparison card (SO+, program+member filters, 3-period, last-3-mo averaged), Visibility hidden on BSC.
- **Status:** ✅ **BUILT + audited + gates green (jest 3663, vitest 2788, build, tsc).** Independent
  audits: backend byte-identical confirmed (getTeamView refactor verbatim), FE Deoleo byte-identical
  confirmed; fixed a Bajaj targets-race + stale-data nit + switched gate to the explicit flag.
  Deploying to staging as its own push (incl. the additive migration).

## 7. Sales-hierarchy nomenclature — ISR/SM/ZH (Bajaj) — ALREADY IN CODE, staging anomaly
- `BAJAJ_HIERARCHY` (`employee-hierarchy.ts:72-77`): leaf **ISR** (`ISR Code`), **SO HQ, ASM HQ,
  SM HQ** (RSM), **ZH HQ** (ZNM), **NSM HQ**. Internal role codes stay XSR/SO/ASM/RSM/ZNM/NSM.
- **Issue:** on staging host `uat-bajaj.gifsy.in` the roster upload validated with the **Deoleo
  defaults (XSR ID…)**, i.e. the resolved slug wasn't `bajaj`. Resolver *should* strip `uat-` →
  `bajaj` (`tenant-resolution.ts`). Root cause not yet pinned (domain→slug map gap or first-render
  empty-slug timing). **Prod (`bajaj.gifsy.in`) should resolve to `bajaj` → ISR correctly.**
- **Root cause (pinned):** admin pages read the tenant from the SSR `useClientConfig().slug`, set by
  `getTenantConfig()` from the `x-tenant-slug` header; absent/unresolved (DB tenant, no live Next
  middleware) → falls back to `DEFAULT_CLIENT_CONFIG` slug `'default'` → Deoleo/XSR template.
- **Fix:** ✅ **BUILT (held for push).** New hook `useAuthClientId()` (`lib/platform/use-auth-tenant.ts`)
  reads the authenticated `clientId` from `/auth/me` (authoritative; correct for assumed operators),
  SSR slug as fallback. Applied to `admin/hierarchy/page.tsx` + `admin/users/outlets/page.tsx`.
  FE-only; Deoleo byte-identical (fallback path unchanged).
  ⚠️ **Audit caught an envelope bug:** the hook first read `j.clientId`, but `/auth/me` returns the
  `{ success, data }` envelope (clientId at `j.data.clientId`) — so it was a silent no-op (always
  null → SSR fallback → XSR). **Fixed** to read `j.data.clientId` + test corrected. Re-verified green.

---

## Deploy snapshot (staging `develop`)
**`ed16d51` serving** (api + frontend) — batch = VOUCHER_ISSUED + RLP/BSC Phase B + ISR fix.
Dashboard backend (schema + migration + sales.service) remains **uncommitted/held** for its own
push after the FE. Prod untouched; the voucher Deoleo-prod nod is still pending prod cutover.

## E2E results (staging `ed16d51`, 2026-10-29) — automated, no manual UAT
- **Phase B labels ✅** — `GET /api/settings/outlet-types` as **Bajaj → SSS="RLP", WHOLESALER="BSC"**
  (SSS_TOT/SUB_STOCKIST unchanged); as **Deoleo → all displayName:null → "SSS"/"Wholesaler"
  (byte-identical)**.
- **ISR fix ✅ (data source)** — `GET /api/auth/me` as Bajaj → `clientId: bajaj` (the value
  `useAuthClientId()` now feeds the hierarchy/outlet-master pages → ISR/SM/ZH via
  hierarchyConfigForTenant). Rendered-header screenshot needs a Bajaj-admin login (not in hand).
- **Voucher ✅** — live ₹500 Amazon redemption `BAJAJ-26-000005` → `DELIVERED`,
  `voucherCode=9000000066652873` (provider Hubble). Owner's in-app bell shows **"Your Amazon
  Voucher code: 9000000066652873"** (owner-only feed). WhatsApp `voucher_code` leg executed with
  no "[DEV] not configured"/no send failure in logs (MSG91 configured); actual handset delivery
  depends on the template being approved for the recipient's WhatsApp number.
