# Bajaj — Customizations & Change Log (living doc)

Single source of truth for every change **exclusive to, or driven by, the Bajaj tenant**
(slug `bajaj`; staging host `uat-bajaj.gifsy.in`; prod hosts `bajajloyalty.gifsy.in` (primary) + `bajaj.gifsy.in`).
Keep Deoleo + all other tenants byte-identical. Update this doc in the SAME pass as any
Bajaj change. Last updated: 2026-11-21.

> **📍 STATE 2026-11-21 (current).** Prod serves **`97332c95`** (`release/2026-11-21`, deployed + verified 2026-11-21; previous prod `4a48dc0d`, release 2026-11-20 night). Bajaj-visible: per-client
> **App name** "Bajaj Loyalty Club" set on prod by the owner and verified live (§15); Visibility Excel redesign +
> client-admin download; capture-form GPS-pending fix; tickets assign/escalate (Bajaj prod "Ticket remarks email":
> **still unset** 2026-11-21 — owner decision pending; per-client To + CC ships in the next release, see
> `SUPPORT-TICKETS.md`). **Bajaj prod flags (read-only probe 2026-11-21, job `bajaj-prod-vis-verify` exec `n9vdj`):**
> `requireLocation` **ON** (explicit `true`; owner switched it ON 2026-11-21 via Gifsy console → Clients → Bajaj →
> **Behaviour flags**, not "Feature Flags"), `outletMasterGeo` ON, `wholesalerPayoutInclActivation` **ON** (display-only
> "Incl. Activation" sub-line under Lifetime Payout for WHOLESALER outlets; no payout math change), `helpVideos` absent
> (OFF). Deoleo prod: all four keys absent. **Bajaj staging flags:** `requireLocation` ON, `helpVideos` ON,
> `wholesalerPayoutInclActivation` ON. Server-side location test on Bajaj staging passed 2026-11-21 (`LOCATION-GATE.md`).
> **Owner decision 2026-11-21 (⚠️ platform-wide, approved):** `requireLocation` DEFAULT ON for every tenant incl. Deoleo
> and new clients (branch `feat/require-location-default`, in the next batch `release/next`, not deployed) — no change
> for Bajaj; see §14. Prod = `main` = **`97332c95`** (`release/2026-11-21`, deployed + verified 2026-11-21; stricter
> visibility capture rule — no capture for outlets not KYC-approved; visibility review-history backfill verified on prod:
> 51,140 Bajaj captures with history, 51,123 imported ones labelled "Imported — old app approval", 0 admin names).
> 2026-11-20 evening the Cloudflare Workers free-plan cap (Error 1027) took all tenants
> down for 7 min — triggered by Bajaj sales-team request volume; see `RESUME.md` §1 / §4 item 10. Current state +
> owner to-dos: `RESUME.md`.
>
> **📍 STATE 2026-11-19 (historical).** Prod and staging serve **`1fa2305c`**. New Bajaj switches in this release (owner flips on prod; staging ON): `features.requireLocation` (location gate), `wholesalerPayoutInclActivation` ("Incl. Activation" under Lifetime Payout), `helpVideos` (Help & videos; content load pending owner OK); notification reminder with iOS/Android steps (Bajaj); reversal engine Bajaj staging = V2, prod = LEGACY until backfill + owner go (switch BEFORE any reversal). KYC fast-track `gifsyRejectFastTrack` ON on prod.
>
> **📍 STATE 2026-11-16 (historical).** Prod and staging both serve **`2eb8271d`** (release 2026-11-15). Bajaj is live on
> prod: branding + logos render on `bajajloyalty.gifsy.in`; Hubble gift cards are LIVE (§1); the v2 partner screens
> carry the "so far" / targeted-outlets rules (§10); payout-credited messages state the net bank amount (§11); November
> 2026 sales applied via Sales Import (month OPEN; points rule pending). Bajaj prod data history:
> `BAJAJ-PROD-OUTLET-IMPORT.md`; current state + owner to-dos: `RESUME.md`. The 2026-11-11 block below is historical.
>
> **📍 STATE 2026-11-11 (historical).** **Prod:** tenant `bajaj` created by the owner 2026-11-10 — status ONBOARDING; domains
> `bajajloyalty.gifsy.in` (primary) + `bajaj.gifsy.in`; invoice prefix `TGSL-BCCL-`; 12 feature flags; logo + white wordmark
> uploaded. Until the next prod release, prod renders the generic "LoyaltyBase" shell on `bajajloyalty.gifsy.in` and the uploaded
> logo URLs return 403 (both fixed in the release). **Staging:** the release (develop `7c85d9fd`, 2026-11-11) carries the Bajaj prod
> config screens (behaviour flags, partner-app tabs, OTP templates card GIFSY_ADMIN-only, `KpiDef.outletType`, KPI edit fix), Hubble
> env-neutral creds + prod deploy preflight, branding/tenant-routing fixes and Sales Import (`salesImport` ON for bajaj on staging;
> real DMS file ingested → READY import `6b681de7-1495-4129-9471-0fdc73a58e3b`, NOT applied until the bajaj importer-owned KPIs
> exist — owner D-8/D-9). Staging-verified: Bajaj + Deoleo login pages render their own branding; OTP templates guards (409 wrong
> brand / 400 bad id / 403 generic PUT); KPI edit 201. Remaining prod steps: `BAJAJ-PROD-GO-LIVE-CHECKLIST.md`. Bajaj TDS import
> still BLOCKED on vendor PANs.

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
- **✅ LIVE ON PROD for Bajaj** — wiring shipped in #59 (`a18cc932`, 2026-11-12); prod secrets created by the owner
  2026-11-11; Hubble whitelisted the prod VPC egress IP `34.96.40.72` (verified 2026-11-13: login → 200 + token).
- **Reconcile hardening (2026-11-15 release, ⚠️ platform-wide rewards/Hubble code, owner-approved, triple-audited):**
  confirm never refunds after a timeout / 5xx / network / unknown error — only a definitive Hubble 400/422 business
  rejection + lookup "not found" + canary; ops "Retry with Hubble" refunds a "no order" only when the order is ≥ 2 hours
  old + canary (a known-delivered order on the same Hubble account fingerprint, any tenant, up to 5 candidates; 2 / 20 s
  at confirm); late webhooks always re-checked and flagged (`HUBBLE_ISSUED_AFTER_REFUND` etc.); Acknowledge rules incl.
  forced ack with a ≥ 20-character note; retailer "taking longer than usual" copy. Staging proof: BAJAJ-26-000032/38/39
  refunded via Retry (+500 ×3). **Ops guide: `HUBBLE-RECONCILE-RUNBOOK.md`.**
- **Prod wiring (`feat/bajaj-prod-gaps`, 2026-11-10; shipped in #59):** the code reads the
  env-neutral `HUBBLE_CLIENT_ID` / `HUBBLE_CLIENT_SECRET` / `HUBBLE_WEBHOOK_SECRET` (falling back to
  the `*_STAGING` names, so staging is unchanged); the webhook is fail-closed everywhere (no dev-bypass);
  prod `deploy.yml` binds the three secrets + `HUBBLE_BASE_URL=https://api.myhubble.money`.
  Prod webhook URL (confirm the Cloud Run URL first): `https://gifsy-api-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook`.
  Owner steps (secrets MUST exist before the prod deploy): `BAJAJ-PROD-GO-LIVE-CHECKLIST.md` § F3 runbook.
- **Open items:** rotate the Hubble Client Secret (was shared in a screenshot). _(Done: prod secrets created + prod
  webhook registered 2026-11-11; egress IP whitelisted 2026-11-13. The prod deploy PREFLIGHT still checks the 3 secrets
  on every deploy.)_

## 2. VOUCHER_ISSUED notification — voucher code to the owner (ALL tenants, not Bajaj-only)
- **What:** when a voucher code is issued (Hubble auto-issue OR manual fulfilment), send the
  **outlet owner** their code via in-app bell + WhatsApp template `voucher_code`
  (vars: ownerName, amount `₹N`, program `<tenant> Loyalty`, voucherName, code). Transactional
  (exempt from the WhatsApp master switch, like OTP); disable-able per tenant via the panel.
- **Scope:** owner chose **all tenants, all vouchers** (incl. live Deoleo manual fulfilment).
- **Status:** ✅ Built, independently audited, fixes applied, gates green — **SHIPPED: on `main`/prod** (`ed16d51d`, then `9b90e82a` defaulted VOUCHER_ISSUED to both channels platform-wide). _(Was "NOT pushed, UAT hold" in 2026-10.)_
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
**`967465a` serving** (api + frontend — verified via gcloud image SHA, 2026-10-29). Serving chain since
`ed16d51`: **`7c07357`** (wishlist + catalogue MRP-slash flag + authoritative outlet-type [hero + root-fix
Phase 1] + PWA/header/notif) → **`e72e91f`/`1c8c2b4`** (root-fix **Phase 2**: dropped the stale `outletType`
column from `outlet_targets`/`outlet_sales_records`) → **`dd54210`** (seed-compile hotfix, see incident
below) → **`36f6a59`** (selling-value → **rate-independent** MRP-slash + cost-basis leak fix, dual-audited
closed) → **`967465a`** (**Bajaj partner dashboard V2** behind `partnerDashboardV2`: chart→this-month-vs-last
card, bigger points/Redeem, to-go banner). Every feature flag defaults OFF → **Deoleo byte-identical**.
Prod untouched; prod cutover still owner-gated.

⚠️ **Deploy incident (2026-10-29, resolved):** Phase-2's column drop broke the api Docker build — `prisma/seed.ts`
still wrote the dropped `outletType`, and seed/bootstrap are compiled ONLY in the Dockerfile (`tsc prisma/seed.ts`),
a step NEITHER `jest` NOR `nest build` covers. The frontend deployed while the api image never built (split deploy);
the migration never ran, so nothing broke (column still present, old api consistent). Fixed in `dd54210` (removed the
seed writes; reproduced all 3 Dockerfile tsc steps green). Lesson in memory — reproduce the Dockerfile compile steps +
sweep seed/bootstrap before any schema change.

**Owner next steps:** enable `partnerDashboardV2` + `catalogueMrpSlash` for Bajaj in the Gifsy console to UAT; the
slash also needs items to have a **selling value** entered on `/admin/gifts` (optional field — `/admin/gifts` is the
live catalogue-entry screen; it captures MRP + points + now selling value). Then the prod cutover (owner-gated).

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

---

## Batch `7c07357` (staging, 2026-10-29) — orchestrated, full-gated, dual-audited, runtime-verified

Six changes shipped together (full gates green: api jest 171 suites/3682 tests, nest build, platform
vitest 302 files, tsc — all exit 0). Independent correctness + security audits run; the findings fixed
before push. `terraform/`, `.claude/`, `CLAUDE.md` deliberately excluded from the commit.

1. **Missing partner "Available points" — root-caused + fixed (platform-wide).** The hero was chosen
   from the **target-upload's denormalized `outletType` snapshot** (`OutletTarget`/`OutletSalesRecord`),
   which goes **stale when an outlet is reclassified between uploads** (OUT-2026-005 reclassified to
   WHOLESALER/BSC but its target row still said "SSS" → RetailerHero → no points zone).
   - **Hero fix:** dashboard reads `outletType` from the authoritative `/partner/me` (`usePartnerIdentity`).
   - **Root-fix Phase 1 (resolve-at-read):** `getTargets`, group rollup, `getPace`, and both target/
     achievement exports resolve `outletType` from `Outlet.outletType.code`, never the snapshot. Sales
     side already authoritative (confirmed). **Phase 2 (drop the `outletType` column from
     `outlet_targets` + `outlet_sales_records`) shipped as `1c8c2b4`** — writes/selects removed,
     clean build proves no dangling reference. ⚠️ PROD cutover of this destructive drop must be
     sequenced (no-write code live before the drop) or run at low traffic (prod keeps an old
     instance during the migrate→deploy gap).
   - Runtime-verified: `/partner/targets` now returns `WHOLESALER` (was "SSS") for OUT-2026-005.
2. **Catalogue MRP-slash** — per-tenant flag **`catalogueMrpSlash` (default OFF → Deoleo byte-identical)**;
   shows MRP-in-points struck above the redeem price, only when MRP is set and strictly > redeem price.
   ⚠️ Rate-based: the struck price uses the *current* tenant rate while `pointsCost` was set at pricing
   time → can overstate if a tenant **changes its rate after pricing** (accept for Bajaj, rate stable).
   **Follow-up (owner-chosen):** capture **selling value** on `/admin/gifts` entry (reuses the existing
   `sellingValuePaise` field, which `/admin/gifts` does NOT capture today — only `mrpPaise`+`pointsCost`)
   → rate-independent slash *and* tightens TDS/valuation (null sellingValue currently falls back to
   points÷rate). Flag is OFF until the owner enables it for Bajaj.
3. **Partner wishlist (ALL tenants, no flag)** — new `PartnerWishlist` table + migration; GET/POST/DELETE
   `/v1/rewards/wishlist` (tenant-scoped, cross-tenant guard, **member-visibility gates** so a wishlisted
   item can't out-live the catalogue's hide rules — security-audit fix; `rewards:read` perm matches the
   redeem precedent). FE: persistent heart (optimistic + revert), "♥ Wishlist" filter chip, "Wishlist (n)"
   header pill. Runtime-verified add→list→delete e2e (proves the migration applied).
4. **PWA/header/notifications** — desktop Chrome no longer mis-detected as iOS Safari (real Install hint);
   partner header shows `Outlet.name` (falls back to businessName); notification "Enable" banner persists
   until acted on (no silent snooze on the default outcome).

**Accepted tradeoffs (owner-confirmed, not silently shipped):** hero falls to RetailerHero on a *transient*
`/partner/me` failure (self-corrects on reload; whole app already depends on `/me`); MRP rate-drift (above).

**Platform-wide approval enforcement (local, not committed):** a `PreToolUse` hook
(`.claude/hooks/platform-wide-gate.js` + `.claude/settings.json`) now gates every `git push` / prod-deploy
with a platform-wide checklist, plus a "🚦 PLATFORM-WIDE CHANGE GATE" block in `CLAUDE.md`. Activates on the
next `claude` session (a fresh settings.json isn't loaded mid-session).

## 8. Credits & Payouts upload — award resolved "NA" for relabelled outlet types (Bajaj) — FIXED (shared code, Deoleo byte-identical)
- **Symptom (2026-10-30):** uploading points for a Bajaj **BSC** outlet (Adhoc field) reported
  *"Field 'Adhoc' is set to Not Applicable (NA) for outlet type 'BSC'"* even though Field
  Configuration showed BSC → Adhoc = POINTS.
- **Root cause:** `eligibleOutlets` (`api/src/credits/credits.service.ts`) returned each outlet's
  `type` as the per-tenant **display label** (`labelFor(...)`), but the award map
  `field.outletTypeAwards` is keyed by **`OutletType.code`** (Field Configuration saves by code).
  Bajaj set `displayName` `WHOLESALER`→"BSC", `SSS`→"RLP" (§5), so the label "BSC" ≠ the code
  `WHOLESALER` → the parser's `outletTypeAwards[outlet.type]` missed → fell to NA. Deoleo sets no
  displayName → `labelFor` returned the code → never hit this (why it slipped through unnoticed).
- **Fix:** `eligibleOutlets` now returns `type: OutletType.code` (the award-match key) + a new
  `typeLabel` (display) used only in the parser's skip/error message. Award logic unchanged. Also
  flipped a backend spec that had *encoded* the bug (asserted `type` === label) + added parser
  regression tests (`credits-payouts-parser.test.ts` E6/E7: code ≠ label).
- **Scope:** shared credits code — **owner-approved platform-wide** (this session). Deoleo
  byte-identical (`type` = code before and after). Sibling `labelFor` sweep clean (every other call
  feeds a display field, not a lookup key). **Dual money-path audit clean**: the server trusts the
  client-computed `awardType` (sole authority — no re-resolution mismatch).
- **Status:** ✅ Built, full gates green, dual-audited + regression tests. Awaiting staging push →
  owner re-upload verify (BSC/Adhoc should now credit) → prod.
- **Separate hardening (owner's call, NOT in this fix):** `createBatch`/`confirmBatch` trust the
  client `awardType` within safety caps; defense-in-depth = re-resolve the award server-side from
  `field.outletTypeAwards[outlet.outletType.code]` instead of trusting the DTO.

## 9. Capture bank/UPI at redemption — per-tenant flag (Bajaj-first) — BUILT + DUAL-AUDITED (2026-11-03)
- **What:** a wholesaler with no payout details captures bank/UPI **in-flow** when redeeming points
  for cash (reusing the KYC validator + `bank-or-upi-section`), stored **UNVERIFIED** and hidden from
  Store Info until a **redemption payout (PayoutTransaction) is PAID** → VERIFIED (FAILED → re-capture).
- **Flag:** `clients.features.captureBankAtRedemption` (default OFF, console-toggleable). Deoleo &
  all others untouched; additive schema `ChannelPartner.paymentDetailsStatus @default(VERIFIED)` +
  `bankVerifiedAt` + `payoutChequeFileKey` (migration `20261103120000_add_payment_details_status`).
- **Uniqueness:** Bajaj `uniquenessPolicy.bank+upi` already ON (verified 2026-11-02, 0 dups); capture
  runs `checkGroupUniqueness`.
- **Status:** ✅ Built, full gates green (api jest 3807 · nest 0 · FE vitest 2874 · tsc 0), dual
  adversarial audit (money + identity) → all confirmed findings fixed. ✅ On prod (in `main` since early
  November 2026, before cutover #57 `ff45f6b`); the per-tenant flag decides where it is ON. Source of truth:
  `platform/docs/plans/PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md`. ⚠️ **PLATFORM-WIDE** (owner-approved).

## Payout rail = FREE CHOICE for Bajaj (bank/UPI toggle), not a per-outlet mandate (2026-11-05)

Bajaj wants partners to choose **bank OR UPI** at KYC/redemption (the toggle + UPI-QR capture), not be
locked to one rail. The bank/UPI toggle is shown only when the outlet's `requiredPaymentType` is **ANY**
AND the tenant `salesApp.upiEnabled` is true; a BANK/UPI mandate pins the mode and HIDES the toggle
(same rule in KYC and the cash-redemption capture — `pinnedPaymentMode`). Bajaj `upiEnabled=true`.

Two changes (owner-approved, Option B):
1. **Importer default → ANY** (platform-wide, Deoleo-neutral): a CREATE with a **blank Payout Method**
   cell now defaults `requiredPaymentType` to **ANY** (was BANK). `api/src/admin-outlets/admin-outlets.service.ts`
   (buildOutletCreate `?? OutletPaymentType.ANY`). Deoleo unaffected — its `upiEnabled=false` still forces
   bank regardless of ANY. So future Bajaj imports are free-choice unless a row explicitly sets BANK/UPI.
2. **Existing Bajaj outlets re-set to ANY** (staging, 2026-11-05): 6,506 outlets that the original import
   had mandated (5,229 BANK + 1,277 UPI) were updated to ANY via a guarded in-VPC job; snapshot kept in
   `_bak_bajaj_req_payment` (reversible: `UPDATE outlets o SET "requiredPaymentType"=b."requiredPaymentType"
   FROM _bak_bajaj_req_payment b WHERE o.id=b.id;`). All ~6,515 Bajaj outlets are now ANY → the toggle
   shows everywhere. (At the time prod had no Bajaj outlets. ⚠️ Bajaj outlets were imported to prod 2026-11-12 — this
   doc does not record whether prod outlets carry ANY; check `requiredPaymentType` on prod before relying on it.)

## 10. Partner screens v2 — "so far" and targeted-outlet rules (2026-11-15 release)
Flag **`partnerDashboardV2`** (Bajaj; Deoleo has it OFF → byte-identical, 27 HTML diffs checked). Commits `1a010a62`,
`5199dec7`, `5100e928`. Applies to the dashboard hero/card/multi-outlet hero, retailer Targets page, sales-rep outlet card
and the Performance trend (`GET /partner/targets/trend`).
- **A KPI with no target** shows a neutral grey **"₹X so far"** (no %, no bar, no red). No sales data at all → "—".
  Why: Bajaj SAMT outlets have NON ADHO sales but no NON ADHO target (it is an eligibility gate) — the old red "— · 0%"
  read as "you did nothing".
- **Multi-outlet partners:** a KPI's target AND achieved are summed **only over outlets that have a target for that KPI**;
  the rest is shown as **"+₹X so far at outlets without this target"**.
- **Primary (headline) KPI** = the first KPI that has a target, on every screen; footer falls back to "No targets set
  this month" instead of claiming a target-less KPI was met. Past months drop "this month" / "so far".
- **Performance "Change vs last month"** compares the primary KPI's **total sales across ALL the partner's outlets**
  (`achievedAll`), so a change in which outlets are targeted can't fake a swing; label reads "Change in total sales vs
  last month" when totals differ from the targeted figures. "This month vs target" and target-met badges stay
  targeted-only.
- **All tenants (owner-approved 2026-11-15, ⚠️ platform-wide):** the Targets-page outlet table's columns are the **union
  of KPI codes**, cells matched by code (fixed misaligned columns); INR ParamCard text **"₹10,414 · ₹10,000"** and
  **"₹X to go"** (whole rupees).

## 11. Payout-credited message and TDS (2026-11-15 release)
- The payout-credited WhatsApp/SMS now states the **amount actually credited to the bank** = Σ(amount − TDS withheld) of
  the entries this UTR apply flipped to PAID, floored once per outlet (same figure as the bank-file line); no message when
  nothing reaches the bank (`a77cbc7c`, ⚠️ platform-wide, owner-approved). Redemption cash-outs never withhold → unchanged.
- **Deoleo unaffected:** every Deoleo entry is GROSS_UP with ₹0 withheld (verified on prod 2026-11-15).
- **Bajaj has NO `tdsPolicy` row** → resolves to the default `{SEC_194C, GROSS_UP}`. ⚠️ **Owner to confirm Bajaj's TDS
  method (GROSS_UP vs DEDUCT) on TDS Treatment before the first live Bajaj credit payout** — with DEDUCT the message and
  bank line show the net amount.

## 12. KYC fast-track after a GIFSY rejection — flag `gifsyRejectFastTrack` (2026-11-17; staging ON, prod pending)
- Gifsy console → Clients → Bajaj → **Behaviour flags** → "Send GIFSY-rejected KYC resubmissions straight to GIFSY"
  (confirm dialog). Default OFF for every tenant; Deoleo OFF.
- At the owner's consent OTP (`KycService.consent()`), a resubmission goes straight to **PENDING_GIFSY** when the
  partner's previous routed KYC was rejected by GIFSY **after** the managers approved it (first entry into the rejected
  chain came from PENDING_GIFSY). Any GIFSY rejection counts (full Reject or Re-upload); whatever the rep changed.
- Always through managers: SO Declaration resubmissions (ASM re-signs), manager rejections, GIFSY rejection before the
  managers approved, re-KYC of an approved outlet, non-sales submitters.
- Only the outlet's currently assigned rep (or a manager above them) gets the shortcut.
- Visible everywhere (no silent skip): history note + `fastTrack` metadata, audit row, admin KYC banner, approvals-queue
  badge "Resubmission · no manager re-approval", sales timeline "Manager Review — Not needed", "Routing" column in the
  GIFSY KYC exports (only for flag-on scopes). Managers get no approval request; the owner gets only KYC_SUBMITTED.
- Code: `api/src/kyc/kyc-fast-track.helper.ts`, `resolveGifsyRejectFastTrack` in `kyc.service.ts`; FE copy
  `platform/src/lib/kyc-fast-track.ts`. Decision log F13.

## 13. Day-level sales + MTD comparisons (Sales Import tenants; 2026-11-17; LIVE on prod `7ba69566` 2026-11-19 — retention rules still OFF)
- Each applied DMS file also stores per-outlet per-day cumulative month-to-date KPI values (`OutletSalesDay`,
  `SalesDaySet`) for programme outlets. Billing card shows "vs last month (to day D)" from Dec 2026 and "vs 3-month
  average" from Feb 2027, plus "outlets billing slower than usual" (below 80% of their own last-month pace).
- Sales history keeps programme outlets only, 4 months; import files 7 days — the deletion rules ship OFF
  (`SALES_RETENTION_V2`) and are switched on via `SALES-IMPORT-PIPELINE-PLAN.md` §17b. Decision log F15.

## 14. Location gate — flag `requireLocation` (2026-11-18; LIVE on prod since `1fa2305c`; Bajaj prod ON since 2026-11-21; DEFAULT ON for every tenant from branch `feat/require-location-default`, in `release/next`, not yet deployed)
- **Owner decision 2026-11-21 (⚠️ platform-wide, approved): DEFAULT ON for every client incl. Deoleo and every new
  client** — ON unless `features.requireLocation` is explicitly `false`. Gifsy console → Clients → tenant → **Behaviour
  flags** (not "Feature Flags") → "Require location for KYC and visibility capture" is now only the **emergency off**
  (switching OFF stores an explicit `false`, no confirm; amber note "Emergency off — KYC and visibility photos can then be submitted without a phone location (no location check for them)").
  Claude does not write the flag.
- Prod data (read-only probe 2026-11-21, exec `n9vdj`): **Bajaj prod = explicit `true`** (switched ON by the owner
  2026-11-21; `outletMasterGeo` also ON) → no change for Bajaj. **Deoleo = key absent** (and no `outletMasterGeo`) →
  Deoleo goes ON at the deploy of this branch with no data change — no heads-up needed (owner 2026-11-21). Bajaj
  staging: ON. Server-side staging test passed 2026-11-21; real-phone run not recorded.
- ON: a sales rep can't start or submit a KYC / visibility capture until location is allowed for the site AND the phone
  gets a fix (phone-specific guide + Test again); the API refuses fix-less submissions; "outside the 200 m fence"
  refusals are recorded for the Location Report. Independent of `outletMasterGeo` (the 200 m fence).
- Location Report `/admin/reports/location` + Daily Ops Digest "Location" line — for every tenant (emergency off → a
  "switched off" banner / note; history is never hidden). Detail:
  `LOCATION-GATE.md`.

## 15. App name — `branding.appName` (per client; LIVE on prod `4a48dc0d`, 2026-11-20)
- Per-client setting (shared code, per-tenant value): the name used for the **installed app**, the **browser tab
  title**, the **sign-in** screen and the **headers**. The company `displayName` stays on consent text, PDFs and emails.
- Bajaj prod: **"Bajaj Loyalty Club"** — set by the owner 2026-11-21, verified live: manifests "Bajaj Loyalty Club"
  / "Bajaj Loyalty Club Sales", sign-in title "Sign In | Bajaj Loyalty Club"; the change took ~2 min to
  propagate. Bajaj staging: "Bajaj Loyalty Club" since 2026-11-20 (`PATCH /v1/gifsy/clients/bajaj`). Deoleo: **no
  appName** (prod manifest "Deoleo" — current naming kept).
- Note: phones that already installed the app may keep the old name until the app is reinstalled — TODO verify.
