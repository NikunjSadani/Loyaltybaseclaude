# Bajaj on PROD: build-it-yourself map (admin UI vs gaps)

Researched 2026-11-10, read-only. Code read at `origin/develop` = `af155bb9` (batch #59, staging). Prod `origin/main` = `e5ab52ce`, which is **32 commits behind develop**. Docs used: `platform/docs/plans/BAJAJ-CUSTOMIZATIONS.md`, `BAJAJ-DATA-MIGRATION.md`, `BAJAJ-ENROLLMENT-IMPORTER.md`, `BAJAJ-HIERARCHY-RENAME.md`, `ENVIRONMENTS.md` and `RESUME.md`. The sales-import screens come from the branch `feat/sales-import` (worktree `.claude/worktrees/sales-import`).

Legend: **UI-OK** = a prod-safe admin screen exists. **UI-OK (after release)** = the screen is built on branch `feat/bajaj-prod-gaps` (2026-11-10) and works on prod once that branch is released. **GAP** = no screen; it needs a screen built or an owner-approved backend/infra step. **PARTIAL** = a screen exists but cannot reproduce what staging has.

Roles. **GIFSY_ADMIN** = the operator console at `app.gifsy.in` (`/gifsy/...`), or a GIFSY_ADMIN who has assumed the Bajaj brand through the brand switcher (`/admin/...`). **CLIENT_ADMIN** = a Bajaj admin on `bajaj.gifsy.in/admin/...`.

**How to copy values from staging.** Open the same screen on staging (`uat-app.gifsy.in` → assume Bajaj, or `uat-bajaj.gifsy.in`). Read the values there, or use that screen's Download/Export button.

---

## ⚠️ Read before starting

1. **The slug must be exactly `bajaj`.** About 17 code paths check the literal string: hierarchy labels ISR/SM/ZH (`api/src/common/hierarchy-labels.ts:27`, `hierarchy-persistence.ts:74`), KYC (`kyc.service.ts:1376`), the sales dashboard, outlets, PWA and others. Any other slug gives you the Deoleo XSR template and loses every Bajaj UI branch.
2. **The prod release must come first.** Prod `main` does not yet have the batch #59 features: offer tiles (`/admin/offers`), UPI manual entry, voucher/Hubble hardening, the parent-lock fixes and others. Sales Import (`feat/sales-import`) is not even on develop. Release #59 to prod before configuring anything that depends on it.
3. **Do not copy staging test data.** Skip the test outlets `BJR*` / `BJW*` / `OUT-2026-*`, the category `LUGGAGELUGGAGE` (a typo), the 4 example offer tiles and any `ZZ TEST` fixtures (see `RESUME.md:18,47`).

---

## Ordered checklist

### A. Tenant, domain and branding

| # | Step | Screen (path) + role | Input / format | Staging source to copy | Status |
|---|---|---|---|---|---|
| A1 | Create the client row | `/gifsy/clients/new`, 4-step wizard (Identity → Branding → Features → Review). GIFSY_ADMIN in platform context. Calls `POST /v1/gifsy/clients` (`tenancy:write`). | Slug `bajaj`; internal name; status (start ONBOARDING, flip to ACTIVE at go-live); display name; primary colour; support email/phone; invoice prefix; feature toggles. | Staging `/gifsy/clients/bajaj` | **UI-OK.** `loyaltyType` defaults to TRADE_LOYALTY (`schema.prisma:507`), so no input is needed. On create the backend automatically adds the domain `bajaj.gifsy.in` and one `outlet_type_client_configs` row for each active OutletType (`gifsy.service.ts:340-360`, `:495-575`). |
| A2 | Domain | Same wizard, optional "Branded domain". Editable later at `/gifsy/clients/bajaj` → **Domains**. | Leave it blank. The canonical `bajaj.gifsy.in` is added automatically. | `client_domains` = bajaj.gifsy.in | **UI-OK.** No infra step: the `*.gifsy.in` wildcard DNS, wildcard cert and Worker route already send every non-`uat-` host to `FRONTEND_PROD` (`cloudflare-worker/worker.js:33`, `ENVIRONMENTS.md` "New tenants are ZERO-TOUCH"). No cert, DNS or worker deploy. Smoke-test `https://bajaj.gifsy.in/auth/login` after creating. |
| A3 | Brand assets | `/gifsy/clients/bajaj` → **Brand Assets** (logo / wordmarkWhite / wordmarkColor / favicon). `POST /v1/gifsy/clients/:slug/branding-asset`. | Image files, 5 MB max | Staging branding | **UI-OK.** Static assets `public/icons/bajaj/*`, `public/brand/bajaj-wordmark-white.png` and `public/Logos/bajaj.png` are already on `main`. |
| A4 | Product brands, partner classes, approval hierarchy | `/gifsy/clients/bajaj` sections | none | none | Product Brands: **UI-OK**. Partner Classes and Approval Hierarchy are **read-only** ("editing coming in Phase 2"). No backend code reads `approvalHierarchy`, so this is cosmetic only. |

### B. Feature flags and settings

| # | Step | Screen + role | Input | Staging source | Status |
|---|---|---|---|---|---|
| B1 | Console feature flags | `/gifsy/clients/bajaj` → **Feature Flags** (per-flag toggle, `PATCH /v1/gifsy/clients/:slug { features }`). GIFSY_ADMIN. | Toggles | 13 of staging's 15 ON flags are console toggles: campaignEnrollmentForm, captureBankAtRedemption, catalogueMrpSlash, hubbleVoucherEnabled, kycApprovalFlow, multiLevelApproval, offerTiles, partnerDashboardV2, rlpBscView, salesTeamApp, selfEnrollmentAllowed, visibilityInvoiceModule, walletModule | **UI-OK** for those 13. `offerTiles` only does something after #59 is on prod. Turn `hubbleVoucherEnabled` on only after D-Hubble (see C-gaps). |
| B2 | Runtime flags `outletMasterGeo` and `soDeclarationKyc` | `/gifsy/clients/bajaj` → **Behaviour flags** (also `/gifsy/clients/new` → Features → "Behaviour flags"). GIFSY_ADMIN (`tenancy:write`). Same `PATCH /v1/gifsy/clients/:slug { features }`; the backend merges one key and every other stored flag survives. | Two switches | Both ON in staging | **UI-OK (after release).** `outletMasterGeo` = Lat/Long columns on the outlet master + the 200 m geo-fence for KYC/visibility; switch it ON **before** the outlet upload. `soDeclarationKyc` = the SO-declaration KYC variant. Both default OFF. |
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
| B14 | Email report recipients | `/gifsy/settings` → Report Recipients (**platform-global** lists `creditsPayouts` and `kycActionables`). Per-tenant credits notify emails: `/admin/settings` → Credits & Payouts. | emails | — | **UI-OK.** The recipient lists are not per tenant, so Bajaj cannot have its own list. Product limitation, not a blocker. |

### C. Hierarchy and users

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| C1 | First CLIENT_ADMINs (staging has 3) | Assume Bajaj → `/admin/users` → Add user, role CLIENT_ADMIN (`POST /v1/admin/users`; `assertRoleAssignable` lets a GIFSY_ADMIN do this). | name, phone, email | staging `/admin/users` | **UI-OK.** The Add button on `/gifsy/users` is disabled, so use the assumed `/admin/users`. |
| C2 | Sales hierarchy levels (6) **and** sales users (1,057) | `/admin/hierarchy` → Upload Employee Hierarchy (Excel). GIFSY_ADMIN or CLIENT_ADMIN (`PUT /v1/admin/hierarchy-config`, `sales_org:manage_hierarchy`). | 18-column chain workbook ("Download template"): `ISR Code / ISR Name / ISR Phone`, `SO HQ / SO Name / SO Phone`, `ASM HQ…`, `SM HQ…`, `ZH HQ…`, `NSM HQ…` (BAJAJ-HIERARCHY-RENAME.md) | Staging `/admin/hierarchy` → **"Download current hierarchy"** (same 18-column format, re-uploadable, `hierarchy/page.tsx:180-182`) | **UI-OK.** The levels are created by the same upload (`hierarchy-persistence.ts:270-281`), with codes XSR/SO/ASM/RSM/ZNM/NSM and Bajaj names ISR/SO/ASM/SM/ZH/NSM. There is no separate levels screen and none is needed. Phone uniqueness is ON. |
| C3 | Optional: Gifsy staff with Bajaj brand grants (RBAC Option-X, currently dormant) | `/gifsy/staff`, `/gifsy/roles` | — | — | **UI-OK** (runbook `runbooks/RBAC-PROD-ENABLE.md`) |

### D. Outlets, KYC and groups

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| D1 | Outlet master (6,515 outlets: SSS + WHOLESALER) and rep assignment | `/admin/users/outlets` → upload. GIFSY_ADMIN or CLIENT_ADMIN (`POST /v1/admin/outlets/upsert`, `partners:manage_outlets`). | Template "outlet-master-template.xlsx". Required: Outlet ID, Outlet Name, Program Name, Sub-Program, Outlet Type (code/label/name, so RLP/BSC work), Distributor ID, Distributor Name, City, State, Zone, **ISR Code**. Optional: Beat, Metro, Payout Method (blank → ANY), Parent ID, Latitude/Longitude (only with `outletMasterGeo`). | Staging "Download Outlet Master" (`/api/admin/reports/outlet-master`; check the columns round-trip into the template), or the owner's `Enrollment dump.xlsx` | **PARTIAL.** It creates **only** Outlet rows and `SalesUserAssignment` (`admin-outlets.service.ts:1155-1191`). It does **not** create owner logins, ChannelPartner, bank/UPI, KYC or wallets. |
| D2 | Owners, bank/UPI and **KYC-APPROVED** for the 6,505 vendor-enrolled outlets, plus 5 doc images each | Normal path: field KYC wizard (`/sales/kyc/new`) → approvals (`/admin/kyc/approvals`, `/admin/kyc`). | — | Staging used a **script**: `scratchpad/bajaj-enrollment-import.job.js` (in-VPC Cloud Run job; synthetic `__import__:<code>` logins; `enrollmentSource=VENDOR_IMPORT`) and `scratchpad/bajaj-docs-migration.job.js` (download → GCS → `KycDocument`) | **GAP.** No UI imports pre-approved KYC, bank/UPI or documents. Choices: (a) an owner-approved run of the importer and docs job against `gifsy_prod` (both are guarded to `gifsy_staging` today, so they need re-pointing plus a dual audit); (b) build an admin "vendor enrollment import" screen; or (c) re-KYC all 6.5k outlets in the field. A follow-on gap from staging: the 6,506 outlets reset to `requiredPaymentType=ANY` via a job. Prod avoids this if Payout Method is left **blank** at D1 (importer default is ANY). |
| D3 | Parent/child groups | `/admin/users/parents` (create, approve, deactivate); "Parent ID" column in D1; ungroup via `POST /admin/outlets/:code/ungroup` | — | staging | **UI-OK** |
| D4 | SO-declaration KYC flow | Sales KYC wizard | — | — | Needs **B2** (`soDeclarationKyc`) ON first (UI-OK after release). |

### E. KPIs, targets and achievements

| # | Step | Screen + role | Input / format | Staging source | Status |
|---|---|---|---|---|---|
| E1 | KPI definitions (5) | `/admin/targets` → KPI table: add, edit, set primary (`POST /v1/admin/kpis`, `targets:manage_config`). GIFSY_ADMIN or CLIENT_ADMIN. **Do not** press "Seed defaults" (it seeds the Deoleo KPIs). | code, label, unit, primary, rollup, order, enabled, **Outlet type** | staging `/admin/targets` (primary `MONTH TARGET` ₹; others per `SALES-IMPORT-PIPELINE-PLAN.md:75`; copy each KPI's Outlet type column) | **UI-OK (after release).** The form now has **Outlet type** ("All outlet types" or one of the tenant's enabled types by display name, e.g. RLP/BSC); the backend rejects a code that is not enabled for the tenant. Existing KPIs stay "All". The release also fixes KPI **edit**, which posted the whole row and was rejected by the API validator. |
| E2 | Targets for current and future months | `/admin/targets/upload` → Download template (pick months) → upload (`POST /v1/admin/targets/upload`) | xlsx: `Outlet ID / Outlet Name / Outlet Type` + one column per enabled KPI per month | staging `GET /admin/targets/export` | **UI-OK.** Current month and later only. |
| E3 | **Historical** targets and achievements (Apr-25 to Sep-26: 110k targets, 104k sales records, 27 batches) | none | — | Staging used a **direct in-VPC write**: `scratchpad/bajaj-targets-backfill.job.js`, manifest `gs://…/migrations/bajaj-targets-manifest-v2.json` | **GAP.** Both uploads skip past months (`isMonthLocked` = month < current, `targets.helpers.ts:162`; `targets.service.ts:534,568,606`). Needs the planned GIFSY-gated `allowLockedMonths` mode or an owner-approved job. |
| E4 | Ongoing achievements | `/admin/targets` achievements upload (`POST /v1/admin/achievements/upload`), or **Sales Import** (`/admin/sales-import`, `/settings` for column mapping + KPI product sets, `/months`) | DMS invoice-line xlsx/csv | — | Manual upload: **UI-OK**. Sales Import: **UI-OK on the branch only.** It is not on develop or prod and needs the `salesImport` flag plus prod worker infra (owner OK required). **⚠️ Prod has NO Sales Import worker yet:** `deploy.yml` sets no `SALES_IMPORT_RUNNER` / `SALES_IMPORT_JOB` / drain secret. Until the owner approves the prod infra at release — prod worker Cloud Run Job (`gifsy-sales-import`), API env `SALES_IMPORT_RUNNER=job,SALES_IMPORT_JOB=…,GCP_PROJECT=…`, Secret Manager `SALES_IMPORT_DRAIN_SECRET` (+ preflight entry), `run.jobsExecutor` binding and the Cloud Scheduler drain — the API **refuses** to switch `salesImport` ON for any tenant (console toggle and new-client create show "Sales Import can't be switched on here yet: the background processor isn't set up in this environment.") and refuses uploads / reprocess for a tenant that already has it on. |

### F. Catalogue

| # | Step | Screen + role | Input | Staging source | Status |
|---|---|---|---|---|---|
| F1 | Reward categories (8) | `/admin/gifts` → Categories (`POST /v1/admin/rewards/categories`, `rewards:manage_inventory`). GIFSY_ADMIN or CLIENT_ADMIN. | name, code (**codes cannot be changed later**) | staging `/admin/gifts` (skip the typo code `LUGGAGELUGGAGE`) | **UI-OK** |
| F2 | Catalogue items (20: Hubble gift cards + physical gifts) | `/admin/gifts` → Add item, one at a time (`POST /v1/admin/rewards/catalog`). Fields: redemption mode (GIFT_CARD/…), MRP ₹, **selling value ₹**, points, min/max redemption points, images, **Hubble productId** (`gifts/page.tsx:483-484`). | Amazon Pay productId `01HDRPKWFE2SMVM54TWD8S1927`, FLEXIBLE ₹500–₹10,000 | staging `/admin/gifts` | **UI-OK.** There is no bulk upload; 20 items by hand is fine. The backend **silently drops** `hubbleProductId` unless `hubbleVoucherEnabled` is already ON (`rewards.service.ts:4301-4307`), so **turn the flag ON before entering items** (or re-edit them afterwards). Set a max on voucher items; Deoleo's null max made its voucher un-redeemable (`RESUME.md:113`). |
| F3 | Hubble credentials (prod) | Code done on `feat/bajaj-prod-gaps`: reads `HUBBLE_CLIENT_ID` / `HUBBLE_CLIENT_SECRET` / `HUBBLE_WEBHOOK_SECRET`, falling back to the `*_STAGING` names; webhook fail-closed; prod `deploy.yml` binds the three secrets + `HUBBLE_BASE_URL=https://api.myhubble.money`. Infra: owner steps in the **F3 runbook** below. | 3 Secret Manager secrets | staging secrets `HUBBLE_CLIENT_ID_STAGING / _SECRET_STAGING / WebhookHubbleStaging` | **UI-OK (after release) once the runbook is done. ⚠️ The three secrets (and the deployer's `secretmanager.viewer` grant) MUST exist before the release's prod deploy: the new PREFLIGHT step then fails the deploy at its very first step, before any migration, and nothing ships.** Credentials are platform-level (one Hubble account); per-tenant enablement is `hubbleVoucherEnabled`. Until configured, a flag-ON tenant falls back to manual fulfilment (`isConfigured()` false). Static egress IP is still an open decision (BAJAJ-CUSTOMIZATIONS §1). |
| F4 | Offer tiles | `/admin/offers` (after #59 is on prod, with `offerTiles` ON) | tiles | do not copy the 4 test tiles | UI-OK after the release |

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
2. `https://bajaj.gifsy.in/auth/login` loads with Bajaj branding. Log in with a real MSG91 OTP: prod has no FIXED_OTP, and an empty B11 field means the global template is used.
3. Log in for real as each role: CLIENT_ADMIN, NSM/ZH/SM/ASM/SO/ISR (headers show ISR/SM/ZH, which proves the slug resolves to `bajaj`), and a partner for one RLP and one BSC outlet.
4. Outlet master shows the RLP/BSC labels. The hierarchy page shows "ISR Code".
5. Redemption: a physical gift, and a gift card (auto-issued via Hubble once the F3 runbook is done; otherwise the manual path).
6. Cross-tenant check: Deoleo is unchanged (flags and settings are per-tenant; no Deoleo row touched).
7. Before go-live, record the prod state in `BAJAJ-CUSTOMIZATIONS.md` and the RESUME doc.

---

## GAP summary (needs a screen built or an owner-approved backend/infra step)

1. ~~B2~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — `/gifsy/clients/bajaj` → Behaviour flags.
2. ~~B3~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — `/gifsy/clients/bajaj` → Partner app tabs.
3. ~~B11~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — assume Bajaj → `/admin/settings` → OTP SMS templates.
4. **D2:** no UI to import **pre-approved KYC + owner logins + bank/UPI + documents** for the 6,505 vendor-enrolled outlets. Staging used `bajaj-enrollment-import.job.js` + `bajaj-docs-migration.job.js`. The outlet upload only creates outlets and rep links.
5. ~~E1~~: closed by `feat/bajaj-prod-gaps` (UI-OK after release) — Outlet type on the `/admin/targets` KPI form.
6. **E3:** historical (past-month) targets and achievements cannot be uploaded (month lock). Staging used `bajaj-targets-backfill.job.js`.
7. **F3:** code + `deploy.yml` done on `feat/bajaj-prod-gaps`; the **owner infra steps** remain (create the 3 secrets BEFORE the prod deploy, grant access, register the webhook, rotate the leaked secret) — see the F3 runbook.
8. **H1:** no opening-balance / historical ledger import. A net balance via the credits upload is possible but lossy (no dates, no negatives, live notifications).
9. **H2 / H3 / H4:** payout history, visibility history and the TDS reconcile were scripts on staging (or are still parked).
10. **Release dependency:** batch #59 (offer tiles, UPI manual entry, voucher hardening and others) must reach prod; Sales Import is not on develop yet.
11. **Sales Import prod worker (owner OK at release):** prod needs the worker job + API env (`SALES_IMPORT_RUNNER=job`, `SALES_IMPORT_JOB`, `GCP_PROJECT`) + `SALES_IMPORT_DRAIN_SECRET` + the `run.jobsExecutor` binding + the Cloud Scheduler drain, all added to `deploy.yml` / infra in the release. Without them the `salesImport` flag cannot be switched on in prod (the API refuses with a clear 400), so nothing can queue forever.

Not gaps (UI-OK, prod-safe): client create, domain, branding, 13 feature flags, wallet settings, all other program settings (including uniqueness, UPI, visibility, TDS policy, points-engine switches, program allow-lists, SLA), outlet-type relabel, CLIENT_ADMINs, hierarchy levels + 1,057 sales users (one Excel upload), the outlet master itself, parent/child groups, KPI defs, current/future targets, achievements, categories, catalogue including the Hubble productId field, credit fields, points rule draft/simulate/publish/compute, holidays, report recipients, MSG91 sender/template IDs. **DNS, certificates and the Worker need nothing for `bajaj.gifsy.in`.**

---

## F3 runbook — Hubble on prod (owner steps)

Hubble credentials are **platform-level**: one Hubble account serves every tenant. A tenant only uses them when its `features.hubbleVoucherEnabled` flag is ON (B1). Deoleo is OFF, so nothing changes for it.

**⚠️ Do steps 0–2 BEFORE the prod deploy that carries `feat/bajaj-prod-gaps`.** Prod `deploy.yml` now binds the three secrets and starts the API job with a **PREFLIGHT** step that checks (metadata only, never the values) that each secret has an ENABLED latest version. If one is missing — or the deployer cannot see it — the deploy stops **at that first step: no image build, no DB migration, no new API revision, and the frontend does not deploy** (`deploy-frontend` now needs `deploy-api`). Without the preflight the failure would have come only at "Deploy API to Cloud Run", i.e. AFTER the prod migrations had already run.

0. **One-time: let the deployer check secret metadata** (needed by the preflight; `roles/secretmanager.viewer` = metadata only, it cannot read any secret value). Owner runs, once:
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
8. Still open, a separate decision: a static egress IP if Hubble requires IP allow-listing (BAJAJ-CUSTOMIZATIONS §1).
