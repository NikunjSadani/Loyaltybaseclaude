# Bajaj on PROD: build-it-yourself map (admin UI vs gaps)

> **📍 2026-11-16:** Bajaj is LIVE on prod (`2eb8271d`, release 2026-11-15). Every release dependency below is done; remaining owner items (TDS method, November points rule, Metro for 71 outlets, October rewards/cases files) are tracked in `RESUME.md` §4. The dated blocks below are historical records.

Researched 2026-11-10, read-only. Code read at `origin/develop` = `af155bb9` (batch #59, staging). Prod `origin/main` = `e5ab52ce`, which is **32 commits behind develop**. Docs used: `platform/docs/plans/BAJAJ-CUSTOMIZATIONS.md`, `BAJAJ-DATA-MIGRATION.md`, `BAJAJ-ENROLLMENT-IMPORTER.md`, `BAJAJ-HIERARCHY-RENAME.md`, `ENVIRONMENTS.md` and `RESUME.md`. The sales-import screens come from the branch `feat/sales-import` (worktree `.claude/worktrees/sales-import`).

> **📍 Prod readiness audit 2026-11-13 (direct DB reads; prod serving `ad01ace5`).**
> **READY:** 6,491 outlets, all active (SSS 4,112 · WHOLESALER 2,340 · SSS_TOT 39) · 1,049 sales users (XSR 781 · SO 215 ·
> ASM 38 · RSM 10 · ZNM 4 · NSM 1) + 2 CLIENT_ADMIN + 1 SALES_HO · 6,486 partner logins · 6 KpiDefs, all enabled · credit
> field "Target Achievement" (INCENTIVE) active · **OutletTargets 2026-11 = 6,417 — November targets are ALREADY uploaded**
> (2026-10 = 6,387 · 2026-09 = 6,312) · reward_catalog 21 ACTIVE (6 GIFT_CARD · 14 PHYSICAL_GIFT · 1 BANK_TRANSFER) ·
> 51,123 visibility captures · 48,086 PAID payout entries.
> **Bajaj ProgramSettings:** conversionRate 1 · minBankTransferAmount 250 · minVoucherFreeAmount 100 · redemptionChannels
> all true · pointsEngine `{enabled:true, directCreditEnabled:false}` · visibilityEnabled true · visibilityConfig
> `{geoFence 200 m, frequencyPerMonth 1, outletScope [SSS, SSS_TOT], allowedSalesLevels [XSR, SO]}` · uniquenessPolicy all
> true · salesApp `{upiEnabled, upiManualEntry, ledgerLabel "Wallet"}` · creditsPayouts `{safetyCapInr 100000,
> safetyCapPoints 50000, monthCutoffDay 31, fourEyesEnabled false}`.
> **`clients.features` for bajaj:** salesImport TRUE · hubbleVoucherEnabled TRUE · allowPayoutWithoutPan TRUE ·
> soDeclarationKyc · kycApprovalFlow · multiLevelApproval · outletMasterGeo · captureBankAtRedemption ·
> visibilityInvoiceModule · offerTiles · rlpBscView · salesTeamApp · walletModule · partnerDashboardV2 ·
> selfEnrollmentAllowed · campaignEnrollmentForm all true; rbacEnforcement, referralModule, nonKycOutletCampaigns false.
> **GAPS (the real blockers):**
> 1. **`points_rules` is EMPTY for EVERY tenant on prod** (0 rows). `pointsEngine.enabled` is true for Bajaj, so November
>    achievements cannot convert to points until a rule exists. Owner has the KPI codes / rule content and will do this
>    before end-November; a test run with the main session is planned. (G2)
> 2. **`sales_import_profiles` is EMPTY on prod** — no column mapping saved for Bajaj. (E4)
> 3. **`sales_kpi_definitions` is EMPTY on prod** — no per-KPI product filters for Bajaj. (E4)
>
> **FALSE ALARM — RESOLVED, do not re-raise:** Bajaj's `employee_hierarchy` ProgramSetting (1,049 rows) carries
> `tenantId:"deoleo"` on every row, but **all 1,049 ids match live Bajaj `sales_users` employeeCodes** (0 are Deoleo-only;
> 1 code also exists in Deoleo). The `tenantId` field is a cosmetic leftover written by the FE; `getHierarchyConfig`
> overlays live name/mobile/role from `SalesUser`. Not a bug, no action.
>
> **📍 Prod state 2026-11-12:** release #59 live (`a18cc932`); A1–A3, B1–B5 (flags incl. TOT program/sub-program), C1 (2 client admins), C2 (hierarchy 1,049), D1–D3 (script import, 19 groups), E1 (KPIs), B7 (visibility) DONE; owner continuing with G1 (credit fields), G2, sales-import mapping, catalogue (after Hubble whitelist), offers. Earlier note follows.
>
> **📍 Prod state 2026-11-11.** **A1–A3 DONE on prod by the owner (2026-11-10):** tenant `bajaj` created (status **ONBOARDING**); domains `bajajloyalty.gifsy.in` (**primary**) + `bajaj.gifsy.in`; invoice prefix `TGSL-BCCL-`; 12 feature flags set at create; logo + white wordmark uploaded. **Known until the release ships:** prod renders the generic "LoyaltyBase" shell on `bajajloyalty.gifsy.in` (render-side tenant-cache bug) and the uploaded logo URLs return 403 (no public branding-asset route) — both fixed in the release now LIVE on staging (develop `7c85d9fd`, 2026-11-11: batch #59 + Sales Import + the `feat/bajaj-prod-gaps` screens + branding/routing fixes + rate limits + OTP hardening). Everything marked **UI-OK (after release)** below becomes usable on prod only after that release. **Remaining, in order:** owner staging UAT → owner creates the 3 prod Hubble secrets (F3 runbook steps 1–2; step 0 viewer grant is DONE) → decide prod Sales Import infra → "prepare main" + manual prod deploy (`runbooks/PROD-CUTOVER-RECORD.md`) → confirm Bajaj branding + logos on `bajajloyalty.gifsy.in` → B2–B14 → C → D (D2 gap) → E (E3 gap) → F → G → H (gaps) → I.

Legend: **UI-OK** = a prod-safe admin screen exists. **UI-OK (after release)** = the screen is built on branch `feat/bajaj-prod-gaps` (2026-11-10) and works on prod once that branch is released. **GAP** = no screen; it needs a screen built or an owner-approved backend/infra step. **PARTIAL** = a screen exists but cannot reproduce what staging has.

Roles. **GIFSY_ADMIN** = the operator console at `app.gifsy.in` (`/gifsy/...`), or a GIFSY_ADMIN who has assumed the Bajaj brand through the brand switcher (`/admin/...`). **CLIENT_ADMIN** = a Bajaj admin on `bajaj.gifsy.in/admin/...`.

**How to copy values from staging.** Open the same screen on staging (`uat-app.gifsy.in` → assume Bajaj, or `uat-bajaj.gifsy.in`). Read the values there, or use that screen's Download/Export button.

---

## ⚠️ Read before starting

1. **The slug must be exactly `bajaj`.** About 17 code paths check the literal string: hierarchy labels ISR/SM/ZH (`api/src/common/hierarchy-labels.ts:27`, `hierarchy-persistence.ts:74`), KYC (`kyc.service.ts:1376`), the sales dashboard, outlets, PWA and others. Any other slug gives you the Deoleo XSR template and loses every Bajaj UI branch.
2. ✅ **DONE — the prod release came first.** Batch #59 + Sales Import + the `feat/bajaj-prod-gaps` screens reached prod in #59 (`a18cc932`, 2026-11-12); prod now serves `2eb8271d` (2026-11-15). _(Original note: prod `main` lacked offer tiles, UPI manual entry, voucher/Hubble hardening, parent-lock fixes; release before configuring.)_
3. **Do not copy staging test data.** Skip the test outlets `BJR*` / `BJW*` / `OUT-2026-*`, the category `LUGGAGELUGGAGE` (a typo), the 4 example offer tiles and any `ZZ TEST` fixtures (see `RESUME.md:18,47`).

---

## Ordered checklist

### A. Tenant, domain and branding

| # | Step | Screen (path) + role | Input / format | Staging source to copy | Status |
|---|---|---|---|---|---|
| A1 | ✅ **DONE on prod 2026-11-10 (owner)** — Create the client row | `/gifsy/clients/new`, 4-step wizard (Identity → Branding → Features → Review). GIFSY_ADMIN in platform context. Calls `POST /v1/gifsy/clients` (`tenancy:write`). | Slug `bajaj`; internal name; status (start ONBOARDING, flip to ACTIVE at go-live); display name; primary colour; support email/phone; invoice prefix; feature toggles. | Staging `/gifsy/clients/bajaj` | **UI-OK.** `loyaltyType` defaults to TRADE_LOYALTY (`schema.prisma:507`), so no input is needed. On create the backend automatically adds the domain `bajaj.gifsy.in` and one `outlet_type_client_configs` row for each active OutletType (`gifsy.service.ts:340-360`, `:495-575`). |
| A2 | ✅ **DONE on prod 2026-11-10 (owner)**: `bajajloyalty.gifsy.in` primary + `bajaj.gifsy.in` — Domain | Same wizard, optional "Branded domain". Editable later at `/gifsy/clients/bajaj` → **Domains**. | Leave it blank. The canonical `bajaj.gifsy.in` is added automatically. | `client_domains` = bajaj.gifsy.in | **UI-OK.** No infra step: the `*.gifsy.in` wildcard DNS, wildcard cert and Worker route already send every non-`uat-` host to `FRONTEND_PROD` (`cloudflare-worker/worker.js:33`, `ENVIRONMENTS.md` "New tenants are ZERO-TOUCH"). No cert, DNS or worker deploy. Smoke-test `https://bajaj.gifsy.in/auth/login` after creating. |
| A3 | ✅ **DONE on prod 2026-11-10 (owner)**: logo + white wordmark uploaded (URLs 403 until the release) — Brand assets | `/gifsy/clients/bajaj` → **Brand Assets** (logo / wordmarkWhite / wordmarkColor / favicon). `POST /v1/gifsy/clients/:slug/branding-asset`. | Image files, 5 MB max | Staging branding | **UI-OK.** Static assets `public/icons/bajaj/*`, `public/brand/bajaj-wordmark-white.png` and `public/Logos/bajaj.png` are already on `main`. |
| A4 | Product brands, partner classes, approval hierarchy | `/gifsy/clients/bajaj` sections | none | none | Product Brands: **UI-OK**. Partner Classes and Approval Hierarchy are **read-only** ("editing coming in Phase 2"). No backend code reads `approvalHierarchy`, so this is cosmetic only. |

### B. Feature flags and settings

| # | Step | Screen + role | Input | Staging source | Status |
|---|---|---|---|---|---|
| B1 | Console feature flags (12 set by the owner at A1, 2026-11-10 — re-check against this list) | `/gifsy/clients/bajaj` → **Feature Flags** (per-flag toggle, `PATCH /v1/gifsy/clients/:slug { features }`). GIFSY_ADMIN. | Toggles | 13 of staging's 15 ON flags are console toggles: campaignEnrollmentForm, captureBankAtRedemption, catalogueMrpSlash, hubbleVoucherEnabled, kycApprovalFlow, multiLevelApproval, offerTiles, partnerDashboardV2, rlpBscView, salesTeamApp, selfEnrollmentAllowed, visibilityInvoiceModule, walletModule | **UI-OK** for those 13. `offerTiles` only does something after #59 is on prod. Turn `hubbleVoucherEnabled` on only after D-Hubble (see C-gaps). |
| B2 | Runtime flags `outletMasterGeo`, `soDeclarationKyc` and `allowPayoutWithoutPan` | `/gifsy/clients/bajaj` → **Behaviour flags** (also `/gifsy/clients/new` → Features → "Behaviour flags"). GIFSY_ADMIN (`tenancy:write`). Same `PATCH /v1/gifsy/clients/:slug { features }`; the backend merges one key and every other stored flag survives. | Three switches | `outletMasterGeo` + `soDeclarationKyc` ON in staging; `allowPayoutWithoutPan` not yet on staging (branch `feat/payout-without-pan`) | **UI-OK (after release).** `outletMasterGeo` = Lat/Long columns on the outlet master + the 200 m geo-fence for KYC/visibility; switch it ON **before** the outlet upload. `soDeclarationKyc` = the SO-declaration KYC variant. `allowPayoutWithoutPan` (branch `feat/payout-without-pan`, not yet on staging) = no-PAN partners are no longer excluded from a Redemption Payouts batch — paid in full; the no-PAN-rate TDS is company-borne, reported per no-PAN deductee as "NO PAN ON FILE". Switching it ON (client page or new-client wizard) asks for confirmation (pending no-PAN payments in batches not yet paid — draft, submitted or failed — are included on the next Process); every features change is audit-logged. Needed for SO-declaration / imported no-PAN retailers. All three default OFF. |
| B3 | `partnerApp` tab visibility | `/gifsy/clients/bajaj` → **Partner app tabs**. GIFSY_ADMIN. Same PATCH, `features.partnerApp` (nested deep-merge; only the changed key is sent). | Switch | staging `/gifsy/clients/bajaj` → Partner app tabs | **UI-OK (after release).** Shows the EFFECTIVE value of all five keys (defaults when never set). Only **Leaderboard / Ranking** is a switch, because it is the only key the partner app reads; Schemes / Invoices / Wallet / Team are stored-only (no partner screen reads them) and are shown read-only. |
| B4 | Wallet money settings: conversion rate, points expiry, ₹ floors | `/gifsy/clients/bajaj` → **Wallet Settings**, or `/admin/settings` (assumed). GIFSY_ADMIN with `tenancy:write_finance`. | numbers | staging Wallet Settings | **UI-OK** |
| B5 | Program settings (the `program_settings` rows) | `/admin/settings` with the brand assumed, GIFSY_ADMIN. `PUT /v1/admin/settings {key,value}`. Cards: Visibility master switch, Require GSTIN, Visibility capture mode, UPI collection (`salesApp.upiEnabled`), UPI manual entry (#59), Identity & payout uniqueness, Pace threshold, Points expiry, Conversion rate, Credits & Payouts config (cut-off day, safety caps, notify emails), **Outlet Programs & Sub-Programs allow-lists**, KYC SLA hours (Field 24h / Gifsy 96h), Sales Task config. | values | staging `/admin/settings` (Bajaj): uniqueness = **all ON** (gst/phone/bank/upi), `upiEnabled=true`, `visibilityEnabled=true`, capture mode PHOTO_APPROVAL | **UI-OK.** Set **Outlet Programs** (Unnati, BSC, SAMT, TOT) and **Sub-Programs** (Unnati, BSC, Privilege, Unnati Lite, Elite, TOT) **before** the outlet upload, because the FE validator rejects values not on the list (`outlet-upload.ts:398-411`) and the default list is "Trade Loyalty / Gold Programme". If Bajaj outlets are not GST-registered, turn **Require GSTIN** OFF before field KYC (`RESUME.md:87`). |
| B6 | Redemption channels (physical gifts / vouchers / bank transfer) | `/admin/gifts` → settings panel (`redemptionChannels`, floors). | toggles | staging | **UI-OK** |
| B7 | Visibility (POSM) config: form, frequency, geo-fence | `/admin/visibility` (`VisibilityConfigEditor`), GIFSY_ADMIN. Per outlet type: `/gifsy/clients/bajaj` → Outlet Type Configuration → Visibility. | config | staging `visibilityConfig` (frequencyPerMonth=1, form v3, photo fields) | **UI-OK** |
| B8 | TDS policy (194R / 194C, DEDUCT or GROSS_UP) | `/admin/tds-config` (`tdsPolicy`) | config | staging `/admin/tds-config` | **UI-OK.** `tdsStatutory` is platform-wide at `/gifsy/tds-statutory` and is already set for prod. |
| B9 | Points-engine switches (`enabled`, `directCreditEnabled`) | `/admin/points-engine/settings`. `PUT` is GIFSY_ADMIN-only (`points-engine-settings.controller.ts:53`). | toggles | staging | **UI-OK** |
| B10 | Outlet types: enable, plus display names SSS → "RLP", WHOLESALER → "BSC" | `/gifsy/clients/bajaj` → **Outlet Type Configuration** → Custom name. `PUT /v1/gifsy/clients/:slug/outlet-type-configs/:code`. | text | 4 configs; `SSS`=RLP, `WHOLESALER`=BSC (BAJAJ-CUSTOMIZATIONS §5) | **UI-OK.** Rows are created automatically at A1. Global OutletTypes come from `api/prisma/bootstrap.ts:50-53` (SSS, WHOLESALER, SUB_STOCKIST, SSS_TOT). There is no global CRUD (`/gifsy/outlet-types` is read-only), so check that all four exist on prod. |
| B11 | OTP SMS templates per purpose (`otpTemplates`: login / redemptionSelf / kycConsent / redemptionSales) | Assume Bajaj → `/admin/settings` → **OTP SMS templates** card (shown only to a GIFSY_ADMIN assumed into a tenant). Dedicated `GET/PUT /v1/admin/settings/otp-templates`, **GIFSY_ADMIN only** (GIFSY_STAFF cannot reach it; the generic settings PUT refuses this key). Audited as `PROGRAM_SETTINGS`. | MSG91 template IDs: 24 hex characters, or empty | staging (FIXED_OTP there, so probably unset) | **UI-OK (after release).** Empty = the global `MSG91_OTP_TEMPLATE_ID`. The card reads the **stored** row (a read error shows Retry, never an empty form), sends **only the purposes you changed** (merged onto the stored row server-side, so untouched purposes are never blanked), and is bound to the brand it loaded (a brand switch in another tab → 409, reload). Deoleo's existing row displays as-is and is only rewritten if someone edits and saves it. |
| B12 | MSG91 WhatsApp/SMS sender IDs and notification template IDs | `/gifsy/clients/bajaj` → **Notifications (MSG91)** (`PATCH { notifications }`). The tenant WhatsApp template library is at `/admin/whatsapp-broadcasts/templates`, and the platform notification templates at `/gifsy/notification-templates`. | IDs | staging client Notifications | **UI-OK for config.** Delivery stays dormant until the prod `WHATSAPP_*` env and approved templates exist (for example `voucher_code`). That is env/MSG91-side, not UI. |
| B13 | Holidays and KYC SLA | Holidays: `/gifsy/settings` (**platform-global**, `PUT /v1/admin/settings/holidays`). SLA hours: `/admin/settings`, per tenant. | dates / hours | — | **UI-OK.** Holidays are shared by all tenants, so there is nothing Bajaj-specific to add. |
| B14 | Email report recipients | `/gifsy/settings` → Report Recipients (**platform-global** single list `dailyDigest` for the Daily Operations Digest; falls back to the union of the legacy `creditsPayouts` + `kycActionables` lists until saved; internal addresses only — `REPORTS_RECIPIENT_DOMAINS`, default `gifsy.in`). Per-tenant credits notify emails: `/admin/settings` → Credits & Payouts. | emails | — | **UI-OK.** The recipient lists are not per tenant, so Bajaj cannot have its own list. Product limitation, not a blocker. |

### C. Hierarchy and users

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| C1 | First CLIENT_ADMINs (staging has 3) | Assume Bajaj → `/admin/users` → Add user, role CLIENT_ADMIN (`POST /v1/admin/users`; `assertRoleAssignable` lets a GIFSY_ADMIN do this). | name, phone, email | staging `/admin/users` | **UI-OK.** The Add button on `/gifsy/users` is disabled, so use the assumed `/admin/users`. |
| C2 | Sales hierarchy levels (6) **and** sales users (1,057) | `/admin/hierarchy` → Upload Employee Hierarchy (Excel). GIFSY_ADMIN or CLIENT_ADMIN (`PUT /v1/admin/hierarchy-config`, `sales_org:manage_hierarchy`). | 18-column chain workbook ("Download template"): `ISR Code / ISR Name / ISR Phone`, `SO HQ / SO Name / SO Phone`, `ASM HQ…`, `SM HQ…`, `ZH HQ…`, `NSM HQ…` (BAJAJ-HIERARCHY-RENAME.md) | Staging `/admin/hierarchy` → **"Download current hierarchy"** (same 18-column format, re-uploadable, `hierarchy/page.tsx:180-182`) | **UI-OK.** The levels are created by the same upload (`hierarchy-persistence.ts:270-281`), with codes XSR/SO/ASM/RSM/ZNM/NSM and Bajaj names ISR/SO/ASM/SM/ZH/NSM. There is no separate levels screen and none is needed. Phone uniqueness is ON. |
| C3 | Optional: Gifsy staff with Bajaj brand grants (RBAC Option-X, currently dormant) | `/gifsy/staff`, `/gifsy/roles` | — | — | **UI-OK** (runbook `runbooks/RBAC-PROD-ENABLE.md`) |

### D. Outlets, KYC and groups

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| D1 | ✅ **DONE on prod 2026-11-12 by script** (6,491 CISPL-approved outlets; see `BAJAJ-PROD-OUTLET-IMPORT.md`) — Outlet master and rep assignment | `/admin/users/outlets` → upload. GIFSY_ADMIN or CLIENT_ADMIN (`POST /v1/admin/outlets/upsert`, `partners:manage_outlets`). | Template "outlet-master-template.xlsx". Required: Outlet ID, Outlet Name, Program Name, Sub-Program, Outlet Type (code/label/name, so RLP/BSC work), Distributor ID, Distributor Name, City, State, Zone, **ISR Code**. Optional: Beat, Metro, Payout Method (blank → ANY), Parent ID, Latitude/Longitude (only with `outletMasterGeo`). | Staging "Download Outlet Master" (`/api/admin/reports/outlet-master`; check the columns round-trip into the template), or the owner's `Enrollment dump.xlsx` | **PARTIAL.** It creates **only** Outlet rows and `SalesUserAssignment` (`admin-outlets.service.ts:1155-1191`). It does **not** create owner logins, ChannelPartner, bank/UPI, KYC or wallets. |
| D2 | ✅ **DONE on prod 2026-11-12 by script** (owners/logins, bank/UPI, KYC-APPROVED, 22,621 docs copied to our storage, 19 owner groups; `BAJAJ-PROD-OUTLET-IMPORT.md`) — Owners, bank/UPI and **KYC-APPROVED** for the 6,505 vendor-enrolled outlets, plus 5 doc images each | Normal path: field KYC wizard (`/sales/kyc/new`) → approvals (`/admin/kyc/approvals`, `/admin/kyc`). | — | Staging used a **script**: `scratchpad/bajaj-enrollment-import.job.js` (in-VPC Cloud Run job; synthetic `__import__:<code>` logins; `enrollmentSource=VENDOR_IMPORT`) and `scratchpad/bajaj-docs-migration.job.js` (download → GCS → `KycDocument`) | **GAP.** No UI imports pre-approved KYC, bank/UPI or documents. Choices: (a) an owner-approved run of the importer and docs job against `gifsy_prod` (both are guarded to `gifsy_staging` today, so they need re-pointing plus a dual audit); (b) build an admin "vendor enrollment import" screen; or (c) re-KYC all 6.5k outlets in the field. A follow-on gap from staging: the 6,506 outlets reset to `requiredPaymentType=ANY` via a job. Prod avoids this if Payout Method is left **blank** at D1 (importer default is ANY). |
| D3 | Parent/child groups | `/admin/users/parents` (create, approve, deactivate); "Parent ID" column in D1; ungroup via `POST /admin/outlets/:code/ungroup` | — | staging | **UI-OK** |
| D4 | SO-declaration KYC flow | Sales KYC wizard | — | — | Needs **B2** (`soDeclarationKyc`) ON first (UI-OK after release). |

### E. KPIs, targets and achievements

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| E1 | ✅ **DONE on prod by owner 2026-11-12** with codes TOTAL (primary) / ADHO / NON ADHO / FOCUS BRAND / FOCUS BRAND 2 / LINES (≠ staging codes — points rule, sales-import KPIs and offers must use these) — KPI definitions | `/admin/targets` → KPI table: add, edit, set primary (`POST /v1/admin/kpis`, `targets:manage_config`). GIFSY_ADMIN or CLIENT_ADMIN. **Do not** press "Seed defaults" (it seeds the Deoleo KPIs). | code, label, unit, primary, rollup, order, enabled, **Outlet type** | staging `/admin/targets` (primary `MONTH TARGET` ₹; others per `SALES-IMPORT-PIPELINE-PLAN.md:75`; copy each KPI's Outlet type column) | **UI-OK (after release).** The form now has **Outlet type** ("All outlet types" or one of the tenant's enabled types by display name, e.g. RLP/BSC); the backend rejects a code that is not enabled for the tenant. Existing KPIs stay "All". The release also fixes KPI **edit**, which posted the whole row and was rejected by the API validator. |
| E2 | Targets for current and future months | `/admin/targets/upload` → Download template (pick months) → pick file = **preview** (`POST /v1/admin/targets/upload?preview=1`, nothing written) → tick the "I understand…" boxes → **Confirm & apply** (`?confirmToken=…&ack=…`) — since 2026-11-25 | xlsx: `Outlet ID / Outlet Name / Outlet Type` + one column per enabled KPI per month | staging `GET /admin/targets/export` | **UI-OK.** Current month and later only. |
| E3 | **Historical** targets and achievements (Apr-25 to Sep-26: 110k targets, 104k sales records, 27 batches) | none | — | Staging used a **direct in-VPC write**: `scratchpad/bajaj-targets-backfill.job.js`, manifest `gs://…/migrations/bajaj-targets-manifest-v2.json` | **GAP.** Both uploads skip past months (`isMonthLocked` = month < current, `targets.helpers.ts:162`; `targets.service.ts:534,568,606`). Needs the planned GIFSY-gated `allowLockedMonths` mode or an owner-approved job. |
| E4 | Ongoing achievements | `/admin/targets` achievements upload (`POST /v1/admin/achievements/upload`), or **Sales Import** (`/admin/sales-import`, `/settings` for column mapping + KPI product sets, `/months`) | DMS invoice-line xlsx/csv | — | Manual upload: **UI-OK**. Sales Import: **UI-OK on prod.** ✅ **Corrected 2026-11-13 — the prod infra EXISTS** (verified): Secret Manager `SALES_IMPORT_DRAIN_SECRET`, Cloud Run job `gifsy-sales-import`, Cloud Scheduler `sales-import-drain` **ENABLED** (`*/10 * * * *`), and `deploy.yml` sets `SALES_IMPORT_RUNNER=job` / `SALES_IMPORT_JOB=gifsy-sales-import` + binds the drain secret. `features.salesImport` is already TRUE for bajaj. **What remains is per-tenant config: `sales_import_profiles` (column mapping) and `sales_kpi_definitions` are both EMPTY on prod.** Upload + aggregation do NOT need the KPI definitions (they are consumed at preview/apply — `sales-apply.service.ts` checks `expectedDefinitionsHash`), so the November file can be uploaded and aggregated first; preview/apply waits for the config. November file received 2026-11-13 — `BAJAJ-PROD-OUTLET-IMPORT.md` §12. _(Historical: until this infra existed the API refused to switch `salesImport` ON with "Sales Import can't be switched on here yet: the background processor isn't set up in this environment.")_ |

### F. Catalogue

| # | Step | Screen + role | Input | Staging source | Status |
|---|---|---|---|---|---|
| F1 | Reward categories (8) | `/admin/gifts` → Categories (`POST /v1/admin/rewards/categories`, `rewards:manage_inventory`). GIFSY_ADMIN or CLIENT_ADMIN. | name, code (**codes cannot be changed later**) | staging `/admin/gifts` (skip the typo code `LUGGAGELUGGAGE`) | **UI-OK** |
| F2 | Catalogue items (20: Hubble gift cards + physical gifts) | `/admin/gifts` → Add item, one at a time (`POST /v1/admin/rewards/catalog`). Fields: redemption mode (GIFT_CARD/…), MRP ₹, **selling value ₹**, points, min/max redemption points, images, **Hubble productId** + **Load from Hubble** amounts (`gifts/page.tsx` ItemModal; see the F2 sub-section below). | Amazon Pay productId `01HDRPKWFE2SMVM54TWD8S1927`, FLEXIBLE ₹500–₹10,000 | staging `/admin/gifts` | **UI-OK.** There is no bulk upload; 20 items by hand is fine. The backend **silently drops** `hubbleProductId` unless `hubbleVoucherEnabled` is already ON (`rewards.service.ts` createCatalogItem/updateCatalogItem), so **turn the flag ON before entering items** (or re-edit them afterwards). Set a max on voucher items; Deoleo's null max made its voucher un-redeemable (`RESUME.md:113`). |
| F3 | Hubble credentials (prod) | ✅ LIVE on prod since #59 (`a18cc932`); secrets created 2026-11-11; prod egress IP `34.96.40.72` whitelisted by Hubble 2026-11-13. Code (`feat/bajaj-prod-gaps`): reads `HUBBLE_CLIENT_ID` / `HUBBLE_CLIENT_SECRET` / `HUBBLE_WEBHOOK_SECRET`, falling back to the `*_STAGING` names; webhook fail-closed; prod `deploy.yml` binds the three secrets + `HUBBLE_BASE_URL=https://api.myhubble.money`. Infra: owner steps in the **F3 runbook** below. | 3 Secret Manager secrets | staging secrets `HUBBLE_CLIENT_ID_STAGING / _SECRET_STAGING / WebhookHubbleStaging` | **UI-OK (after release) once the runbook is done. ⚠️ The three secrets MUST exist before the release's prod deploy (the deployer's `secretmanager.viewer` grant is DONE, 2026-11-10/11): the new PREFLIGHT step then fails the deploy at its very first step, before any migration, and nothing ships.** Credentials are platform-level (one Hubble account); per-tenant enablement is `hubbleVoucherEnabled` (TRUE for bajaj). Until configured, a flag-ON tenant falls back to manual fulfilment (`isConfigured()` false). ✅ **Hubble prod IP whitelisting DONE (vendor, 2026-11-13) and VERIFIED** — prod login from the prod VPC egress IP **34.96.40.72** returned HTTP 200 + a token (previously 401 "not whitelisted"), so **F1/F2 catalogue entry on prod is unblocked**; no static-egress-IP decision is needed. |
| F4 | Offer tiles | `/admin/offers` (after #59 is on prod, with `offerTiles` ON) | tiles | do not copy the 4 test tiles | UI-OK after the release |

#### F2 — setting up Hubble brands: fixed vs flexible amounts (branch `feat/hubble-denominations`)

Each Hubble brand is either **FIXED** (Hubble issues only certain face values) or **FLEXIBLE** (any whole-rupee amount within a min–max). If a brand is set up the wrong way, members can pick an amount Hubble won't issue, and the order fails and is refunded. The catalogue editor now checks this against Hubble.

1. In `/admin/gifts` → Add/Edit reward → mode **Gift card**, paste the **Hubble product ID**, then click **Load from Hubble**. It shows the brand name, **Fixed amounts** / **Flexible amount**, and what Hubble allows (`GET /v1/admin/rewards/hubble-products/:id`, `rewards:manage_inventory`, Hubble-enabled tenants only). If loading fails, the editor says why: product not found or inactive, Hubble not configured in this environment, or Hubble unreachable.
2. **FIXED brand:** tick the amounts members may choose. Points for each = amount × conversion rate, shown next to it. Amounts below the program's minimum voucher amount are greyed out. A free typed range is refused for a FIXED brand. Members then see one button per amount, with no typing. If Hubble returns a FIXED brand **without** its amounts, the editor says "Hubble didn't return its amounts — enter the amounts Hubble shows for this brand" and lets you add them by hand (whole rupees, at or above the program minimum). Hubble still validates every order.
3. **FLEXIBLE brand:** either click **Use Hubble's range**, so members type any whole-rupee amount inside Hubble's min–max (the points band is filled in for you), or add specific amounts with **Add amount**, so members get buttons as in step 2.
4. **On save** the backend fetches the product again and refuses any mismatch: an amount not in a FIXED brand's list, a range or amount outside a FLEXIBLE brand's min–max, a fixed price Hubble can't issue, or an amount below the program minimum. At redemption (self and sales-assisted), the amount must be one of the listed amounts **and** issuable by the live brand (cached lookup: a FIXED brand's current face values, a FLEXIBLE brand's rupee min–max). Otherwise it is a 400 before points move, and the quantity must be 1. A lookup failure never blocks a redemption: the redeem-time lookup waits at most 2.5 s, merges concurrent lookups, and skips the check for 60 s after a slow or failed lookup. Just before calling Hubble, the issuer checks the order's own frozen amount again (never the item's current list). If it isn't issuable, nothing is sent to Hubble and the points are **refunded immediately**: the order is FAILED, and the member is told "could not issue your voucher, points refunded".
5. **Staging facts (confirmed 2026-11-11 via the Hubble product API):** Flipkart `01GMMNJECTDZAG2YS61K58HVG8` is **FLEXIBLE ₹10–₹10,000** on staging. Amazon Pay `01HDRPKWFE2SMVM54TWD8S1927` is **FLEXIBLE ₹500–₹10,000**. ⚠️ Prod listings can differ (Flipkart is reported FIXED on prod: ₹150/175/300/1,250/2,500/5,000/7,500/10,000). Always **Load from Hubble on prod** when entering the prod items, and never copy staging's amounts.
6. **All tenants:** every typed redemption amount (vouchers and cash payouts) is **whole rupees only**. While typing, only digits, `,` and `.` are accepted. A `,` is valid only as a thousands separator ("1,250", "12,500") or in Indian grouping ("1,25,000"); grouped numbers must start with 1–9. Anything else — a typed decimal ("750.5"), another comma ("750,5", "1,2", "1,", "0,500") or a pasted decimal ("₹1,250.50") — is **never guessed or silently changed**: the text stays as typed, and on leaving the field or tapping Redeem / Send OTP it shows "Check the amount — whole rupees only" and nothing is submitted. A pasted currency prefix/suffix ("Rs. 1,250", "₹ 1,250", "INR 1250", "₹1,250.00", "1,250/-") is accepted as the whole amount. Once the OTP is sent, the amount is locked. "Change amount" starts a fresh redeem. The API refuses decimals with "Enter a whole-rupee amount".
7. **Gift cards with a PIN (all tenants, owner-approved 2026-11-11):** when a card comes with a card number **and** a PIN (Hubble `CARD_AND_PIN…` cards, or typed by ops), the PIN is saved on the order (`voucherPin`). Number-only cards (e.g. Amazon) and PIN-only cards are unchanged.
   - **Who sees it:** the outlet partner (My Orders: "Card no." + "PIN", each with Copy) and Gifsy operators who can see full codes (masked behind **Show PIN**). Read-only Gifsy staff and client admins see only "Voucher issued". **Sales reps never see the card number or the PIN.** Vendors see it for orders assigned to them.
   - **Messages:** WhatsApp keeps the approved `voucher_code` template; for a PIN card, `{{5}}` = `<card no> | PIN: <pin>`. The bell/push says "card no. and PIN are in My Orders" (the PIN is never stored in notification rows). SMS (dormant) carries the card number only — when its DLT template is written, its fixed text should say the PIN (if any) is in My Orders.
   - **Ops:** a PIN can be added **once** to an order that already has a card number but no PIN (Gifsy console, bulk sheet "Voucher PIN" column, vendor portal before delivery); the member is re-sent the voucher message. Changing a saved PIN needs "Voucher cancelled with vendor". Bulk sheet: Voucher Code and Voucher PIN cells must be **Text** (a number cell is refused — Excel corrupts 16-digit numbers and drops leading zeros).

### G. Earn rules and credits

| # | Step | Screen + role | Input | Staging source | Status |
|---|---|---|---|---|---|
| G1 | Credit fields with per-outlet-type award (RLP → PAYOUT, BSC → POINTS, for example "Adhoc") | `/admin/credits-payouts/fields` (`/api/admin/credits/fields`) | field + `outletTypeAwards` keyed by **type code** | staging `/admin/credits-payouts/fields` | **UI-OK** |
| G2 | Points rule (1): draft → simulate/preview → publish | `/admin/points-engine/rules/new` → `/rules/[id]` (`POST /v1/admin/points-rules`, `/:id/publish`, `points_rules:write`; preview/simulate via `/v1/admin/points-compute/*`). GIFSY_ADMIN or CLIENT_ADMIN. Compute/export/commit: `/admin/points-engine/compute` (commit needs `credits:upload`; direct credit needs B9 `directCreditEnabled`). | rule JSON via the builder | staging `/admin/points-engine/rules` (copy the definition) | **UI-OK.** Needs the E1 KPIs to exist first, because publish reconciles KPI codes. |

### H. Opening balances and history (staging used scripts)

| # | Step | Screen | Staging method | Status |
|---|---|---|---|---|
| H1 | **Earn & Burn wallets** (2,317 wallets; 29,438 dated events; 23 credit batches; `VENDOR_IMPORT`; 9 negative balances) | No import screen. Closest screens: `/admin/credits-payouts/upload` (live credit batch → wallet, with notifications, dated today, positive amounts, award/TDS path), and `/admin/outlet-wallet` (`POST /api/wallet/adjust`, GIFSY-only, one outlet at a time). | `bajaj-earnburn-timeline-import.job.js` (+ parser/manifest `bajaj-earnburn-timeline-manifest-v2.json`) | **GAP.** The UI can put a **net opening balance** on each outlet (credits upload), but it cannot reproduce a dated timeline, gross/redeemed/expired counters, negative balances or the `VENDOR_IMPORT` tag, and it would send live notifications. Owner decision: net-opening-balance via credits upload, an owner-approved job run on prod (dual audit, money path), or a new "opening balance import" screen. |
| H2 | Retailer payout history (48,408 PAID entries, ₹2.91 cr, with UTRs) | none (no payout upload can set PAID/UTR/date) | `bajaj-payout-backfill.job.js` | **GAP** (not in your inventory, but it exists on staging) |
| H3 | Visibility history (49,948 approved captures + 68,274 re-hosted photos) | none | `bajaj-visibility-rehost.job.js` + `bajaj-visibility-captures.job.js` | **GAP** (not in your inventory, but it exists on staging) |
| H4 | TDS already-deposited / FY27 reconcile | none | parked (blocked on vendor PANs) | **GAP / not started** |

### I. Go-live checks

1. On `/gifsy/clients/bajaj`, switch status ONBOARDING → **ACTIVE**.
2. `https://bajajloyalty.gifsy.in/auth/login` (primary) and `https://bajaj.gifsy.in/auth/login` load with Bajaj branding and the uploaded logos (both broken on prod until the release). Log in with a real MSG91 OTP: prod has no FIXED_OTP, and an empty B11 field means the global template is used.
3. Log in for real as each role: CLIENT_ADMIN, NSM/ZH/SM/ASM/SO/ISR (headers show ISR/SM/ZH, which proves the slug resolves to `bajaj`), and a partner for one RLP and one BSC outlet.
4. Outlet master shows the RLP/BSC labels. The hierarchy page shows "ISR Code".
5. Redemption: a physical gift, and a gift card (auto-issued via Hubble once the F3 runbook is done; otherwise the manual path).
6. Cross-tenant check: Deoleo is unchanged (flags and settings are per-tenant; no Deoleo row touched).
7. Before go-live, record the prod state in `BAJAJ-CUSTOMIZATIONS.md` and the RESUME doc.
8. **Client training deck** ✅ done (owner, 2026-11-13); 7 slides added as slides 8–14 (install the app on Android /
   iPhone; allow location on Android / iPhone), saved as
   `C:\Users\nikun\Downloads\Bajaj Loyalty training deck - with install and location.pptx`. The phone screens on those
   slides are illustrations, not real screenshots.

### J. After the combined release reached prod (`7ba69566`, 2026-11-19 ~00:30 IST — verified; steps below still to do)

1. **Owner** (Claude does not log into prod): `app.gifsy.in` → Clients → Bajaj Consumer Care → Behaviour flags → switch
   on **"Send GIFSY-rejected KYC resubmissions straight to GIFSY"** → confirm. Claude then verifies the flag read-only.
2. Overview → Monthly billing progress shows Bajaj November against the **Total** target (prod primary KPI = TOTAL,
   6,417 outlets targeted on 2026-11-17).
3. Sales history trim + new retention (`SALES-IMPORT-PIPELINE-PLAN.md` §17b): backup → `rebuild-days` only if no daily
   import ran since deploy → trim dry-run → owner OK → apply → `SALES_RETENTION_V2=on`.
4. Daily Ops Digest recipients on prod (Gifsy settings, `@gifsy.in` only) — set before the first scheduled run.
5. Prod DB disk alert at 50%.

---

## GAP summary (needs a screen built or an owner-approved backend/infra step)

1. ~~B2~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — `/gifsy/clients/bajaj` → Behaviour flags.
2. ~~B3~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — `/gifsy/clients/bajaj` → Partner app tabs.
3. ~~B11~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — assume Bajaj → `/admin/settings` → OTP SMS templates.
4. **D2:** no UI to import **pre-approved KYC + owner logins + bank/UPI + documents** for the 6,505 vendor-enrolled outlets. Staging used `bajaj-enrollment-import.job.js` + `bajaj-docs-migration.job.js`. The outlet upload only creates outlets and rep links.
5. ~~E1~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — Outlet type on the `/admin/targets` KPI form.
6. **E3:** historical (past-month) targets and achievements cannot be uploaded (month lock). Staging used `bajaj-targets-backfill.job.js`.
7. ✅ **F3:** done — code on prod since #59; the 3 prod secrets created + webhook registered (2026-11-11); Hubble whitelisted the prod egress IP (2026-11-13). Still open: rotate the leaked client secret.
8. **H1:** no opening-balance / historical ledger import. A net balance via the credits upload is possible but lossy (no dates, no negatives, live notifications).
9. **H2 / H3 / H4:** payout history, visibility history and the TDS reconcile were scripts on staging (or are still parked).
10. ✅ **Release dependency:** done — #59 (`a18cc932`, 2026-11-12); current prod: see `RESUME.md` §1.
11. ~~**Sales Import prod worker (owner OK at release)**~~ — ✅ **CLOSED, verified 2026-11-13.** The prod infra is in place: `SALES_IMPORT_DRAIN_SECRET`, Cloud Run job `gifsy-sales-import`, Cloud Scheduler `sales-import-drain` ENABLED (`*/10 * * * *`), `deploy.yml` env `SALES_IMPORT_RUNNER=job` + `SALES_IMPORT_JOB=gifsy-sales-import` + the drain secret binding. **Remaining (config, not infra):** Bajaj's column mapping (`sales_import_profiles` empty) and sales KPI definitions (`sales_kpi_definitions` empty).
12. **Bajaj points rule:** still open (2026-11-16) — no Bajaj rule in `points_rules` at the last check while `pointsEngine.enabled` is true for Bajaj. November 2026 achievements are applied (Sales Import, 2026-11-15, month OPEN); the November rule (SAMT gate NON ADHO ≥ ₹200 Elite / ≥ ₹400 Privilege …) needs a dedicated rule-engine session (G2). Never compute Apr 2025 – Oct 2026.

Not gaps (UI-OK, prod-safe): client create, domain, branding, 13 feature flags, wallet settings, all other program settings (including uniqueness, UPI, visibility, TDS policy, points-engine switches, program allow-lists, SLA), outlet-type relabel, CLIENT_ADMINs, hierarchy levels + 1,057 sales users (one Excel upload), the outlet master itself, parent/child groups, KPI defs, current/future targets, achievements, categories, catalogue including the Hubble productId field, credit fields, points rule draft/simulate/publish/compute, holidays, report recipients, MSG91 sender/template IDs. **DNS, certificates and the Worker need nothing for `bajaj.gifsy.in`.**

---

## F3 runbook — Hubble on prod (owner steps)

Hubble credentials are **platform-level**: one Hubble account serves every tenant. A tenant only uses them when its `features.hubbleVoucherEnabled` flag is ON (B1). Deoleo is OFF, so nothing changes for it.

**⚠️ Do steps 0–2 BEFORE the prod deploy that carries `feat/bajaj-prod-gaps` (✅ all done — steps 0–2 completed 2026-11-10/11; kept as the reference for a secret rotation).** Prod `deploy.yml` now binds the three secrets and starts the API job with a **PREFLIGHT** step that checks (metadata only, never the values) that each secret has an ENABLED latest version. If one is missing — or the deployer cannot see it — the deploy stops **at that first step: no image build, no DB migration, no new API revision, and the frontend does not deploy** (`deploy-frontend` now needs `deploy-api`). Without the preflight the failure would have come only at "Deploy API to Cloud Run", i.e. AFTER the prod migrations had already run.

0. ✅ **DONE 2026-11-10/11 (owner-approved).** **One-time: let the deployer check secret metadata** (needed by the preflight; `roles/secretmanager.viewer` = metadata only, it cannot read any secret value). Owner runs, once:
   ```
   gcloud projects add-iam-policy-binding gifsy-platform \
     --member="serviceAccount:gifsy-deployer@gifsy-platform.iam.gserviceaccount.com" \
     --role="roles/secretmanager.viewer"
   ```
   (Codified as `deployer_secret_viewer` in `terraform/iam.tf`. If the deploy key `GCP_SA_KEY` belongs to a different service account, grant that one instead.) **Every** later prod deploy needs this grant, not only Bajaj's.
1. **Create three secrets yourself** in GCP Secret Manager, project `gifsy-platform` (console → Security → Secret Manager → Create secret). Paste the values only into the console — never into chat, a commit or a ticket. On Windows, make sure no trailing newline / `\r` is pasted.
   - `HUBBLE_CLIENT_ID` — the **prod** Hubble client id.
   - `HUBBLE_CLIENT_SECRET` — the **prod** Hubble client secret, freshly **rotated** in the Hubble portal (the old one was shared in a screenshot; see step 4).
   - `HUBBLE_WEBHOOK_SECRET` — the prod Webhook Signature secret from the Hubble portal (the key Hubble uses for the `X-Verify` HMAC).
2. **Grant access:** on each of the three secrets, add principal `gifsy-api-sa@gifsy-platform.iam.gserviceaccount.com` with role **Secret Manager Secret Accessor** (`roles/secretmanager.secretAccessor`).
3. **Register the prod webhook with Hubble** (prod portal): `https://<prod gifsy-api Cloud Run URL>/v1/hubble/webhook`. Following the staging URL's pattern (`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook`, BAJAJ-CUSTOMIZATIONS §1), prod should be `https://gifsy-api-4d4n5mc6yq-el.a.run.app/v1/hubble/webhook` — **confirm** it in Cloud Run → `gifsy-api` → URL before registering. The webhook is **fail-closed**: it returns 403 unless `HUBBLE_WEBHOOK_SECRET` is set and the `X-Verify` signature matches. (An accepted webhook only triggers a re-fetch of the order's true state from Hubble.)
4. **Rotate the leaked client secret** in the Hubble portal (prod and staging). After rotating staging, add a new version of `HUBBLE_CLIENT_SECRET_STAGING` (staging keeps reading the `*_STAGING` names).
5. **Base URL:** prod uses `HUBBLE_BASE_URL=https://api.myhubble.money` (set in `deploy.yml` `--set-env-vars`; nothing to create).
6. If the preflight fails, fix the named secret and re-run the workflow; nothing on prod was touched. If the later "Deploy API to Cloud Run" step still fails (e.g. a secret deleted mid-run, or `gifsy-api-sa` lacks `secretAccessor`), the migrations HAVE already run: the old API revision keeps serving on the migrated schema and the frontend is not deployed — fix and re-run promptly.
7. **After the deploy:** with `hubbleVoucherEnabled` ON for Bajaj and a catalogue item carrying the Hubble productId (F2), redeem one ₹500 gift card and confirm it is auto-issued. If a secret is missing at runtime, `isConfigured()` is false and orders fall back to manual fulfilment instead of failing.
8. ~~Still open, a separate decision: a static egress IP if Hubble requires IP allow-listing (BAJAJ-CUSTOMIZATIONS §1).~~
   ✅ **CLOSED 2026-11-13:** Hubble whitelisted the prod VPC egress IP **34.96.40.72**; a prod login from it returned 200 +
   a token (previously 401 "not whitelisted"). No static egress IP needed.

⚠️ **gcloud trap (2026-11-13):** gcloud on the owner's machine currently defaults to account `nikunj.sadani28@gmail.com`
and project `gifsy-posm` (changed by another session). Every platform command must pass
the account + project explicitly. Since 2026-11-20 `gifsy-deployer` is CI-only (least-privilege); laptop commands use
the keyless ops identity — current flags in `RESUME.md` §8 (Platform / infra).
