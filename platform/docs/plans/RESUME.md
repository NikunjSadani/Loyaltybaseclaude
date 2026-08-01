# RESUME — Loyaltybase restart prompt

Multi-tenant FMCG **trade-loyalty** platform (operator Gifsy; live client Deoleo). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin FE `platform/` (Next.js, proxies
`/api/*` → backend `/v1/*`). Work on **`develop`** (auto-deploys to staging). Repo root:
`C:\Users\nikun\Loyaltybaseclaude`.

> Working agreements, gates, and guardrails live in **`CLAUDE.md`** (auto-loaded) — not duplicated here.
> This file is *current state + the traps + what's open*. **Always verify HEADs via `git log`; never trust a hardcoded SHA.**

---

## 🟢 CURRENT STATE
- **✅ CUTOVER #22 LIVE + VERIFIED (`fb996d8`, 2026-07-31) — prod = main = origin/develop = `fb996d8` (develop is NOT ahead of prod).** Verify HEADs via `git log`. **Gate at cutover: api jest 2163 · nest build 0 · FE vitest 2066 · tsc 0.** Migration `20260731170000_outlet_kyc_intent_parked` (`ALTER TYPE "OutletKycIntent" ADD VALUE 'PARKED'`, additive) **APPLIED to BOTH gifsy_staging and gifsy_prod** (guarded reads confirmed: enum `["NOT_INTERESTED","PARKED"]`, migration recorded/not-rolled-back on prod). Prod-verified: both services `fb996d8`, `/health/ready` db:up, `/v1/admin/outlets/park` + `/unpark` 401-wired, public `/v1/schemes/media/view` bad-token 404 (fail-closed), `deoleoloyalty.gifsy.in/auth/login` 200 + send-otp 200. Rollback ref `a83b2f4` (#21). **All 5 parts additive + DORMANT** — the Deoleo live path is unaffected until an admin parks an outlet or a grouped child inherits a doc. The 5-part payload:
  - **(1) Reactivate pending-outlet leak fix** — `admin-outlets.service.reactivate` now requires `deactivatedAt: { not: null }`, so a KYC-pending outlet (deactivatedAt null) can no longer be flipped active, bypassing KYC approval. Staging-verified (a pending outlet → 400 "No deactivated outlets found").
  - **(2) Enrollment Excel report rebuild** — Outlet Name fallback to `prefillValues` name-aliases; media cells are REAL Excel hyperlinks to a NEW PUBLIC tokenized endpoint `GET /v1/schemes/media/view?token=<jwt>` (`typ:'schememedia'` HS256 JWT, mirrors the KYC docview pattern; resolves the object key server-side from the tenant-verified enrollment, cross-tenant-guarded, safe-mime, bare-404) that opens from a downloaded file; columns de-duplicated by field `prefillKey`/`outletField`. `scheme-report.service.exportEnrollments`; `common/xlsx.ts` gained hyperlink-cell support. Supersedes the #21 `e0c254d` report note.
  - **(3) PARKED "remove from KYC queue" outlet state** — new additive `OutletKycIntent` value `PARKED` (distinct from rep-driven `NOT_INTERESTED`). Admin bulk `POST /v1/admin/outlets/park` + `/unpark` (GIFSY/CLIENT_ADMIN + `partners:manage_outlets`, `OutletCodesDto` max 500) + a "Parked / Removed" tab on Admin→Outlets. PARKED is FULLY hidden from reps: excluded (null-safe `OR:[{kycIntent:null},{kycIntent:{not:'PARKED'}}]` / `notIn:['NOT_INTERESTED','PARKED']`) from `sales.service` buildOutlets/buildTeamRollups/getMember, the scheme enrollment reach (`scheme-enrollment.service` getSalesTargets + list), AND the admin coverage/health/ops dashboards + visibility universes. Admin sees a distinct "Parked" status/bucket (`deriveKycStatus`→'PARKED', `buildKycStatusWhere`). KYC approval UN-PARKS (both `approve` and `bulkVerify` share one activation `updateMany` which now clears `kycIntent/By/At`). `park` is idempotent + scoped to `isActive:false, deactivatedAt:null` (true pending only). Staging-verified (park→PARKED bucket→unpark→restored). Owner chose "fully hidden from reps" + a "new distinct state" (not reuse NOT_INTERESTED).
  - **(4) Grouped-child GST-cert/cheque doc carry-forward** — a FIRST-KYC grouped child (`outlet.parentId` set, no partnerId) that keeps the group's UNCHANGED GST number / bank account inherits the APPROVED group source's GST certificate / cancelled cheque instead of re-uploading. Source = `resolveGroupIdentity(...).sourcePartnerId` (approved parent ELSE most-recently-approved sibling — SAME source as the identity prefill) + new `resolveGroupCarryForwardDocs` (partner-group.helper). Backend-authoritative: resolved + validated PRE-transaction and attached from a stash (single resolve → validation & attach can't diverge); a narrowed safety-net REJECTS (before any write) a child that keeps a GST/bank the group has an inheritable doc for but diverged so nothing attaches (closes the FE-waive/backend-attach scope gap + a stale-prefill TOCTOU). Requires the child to assert a PAN (group golden key). FE (`sales/kyc/new`) relaxes the GST-cert/cheque required-gate ONLY for a first-KYC child with unchanged values (`isFreshKyc = !existingKyc`, mirroring the backend `!partnerId` scope) + shows an "Inherited from group (approved)" note. Dual-audited: security CLEAN + correctness HIGH (re-KYC scope mismatch) / MED (TOCTOU) / LOW (PAN) all FIXED.
  - **(5) "Activations / Tasks" label rename** — the sales "Scheme/Activation Enrollment" label → "Activations / Tasks" (dashboard card, Tasks page, enrollment-sheet header).
- **✅ CUTOVER #21 (`a83b2f4`, 2026-07-31) — scheme UAT batches + child-KYC group-identity prefill + Identity/Payout Uniqueness toggle; superseded in prod by #22 above.** prod == main == origin/develop == `a83b2f4` (was current before #22). Payload = 16 commits `8c08af3..a83b2f4`, **ALL additive + DORMANT** (Deoleo live path byte-identical until a Gifsy admin uses these features). **Gate at cutover: api build 0 · jest 2124 · FE tsc 0 · vitest 2052.** Migration `20260730160000_scheme_enrollment_soft_delete` **APPLIED to prod** (guarded read: `done:true`, `rolled:false`, `scheme_enrollments.deletedAt` nullable col + `scheme_enrollments_deletedAt_idx` present; already on gifsy_staging). Prod-verified: both services `a83b2f4`, `/health/ready` db:up, `/v1/schemes` + `/v1/schemes/:id/enrollments/deleted` + `/v1/admin/settings` all 401-wired, `deoleoloyalty.gifsy.in/auth/login` 200. Rollback ref `8c08af3` (#20). *(See ledger row #21.)* The 6-part payload:
  - **BATCH 1 — scheme UAT fixes** (`86c1a99`,`2ae2c6b`,`21bcfdc`,`c510cc0`,`1eb6038`; code-only, audited CLEAN): (1) whole-downline SALES enroll/OTP reach (`assertSalesReachRoster` authorizes when the tagged employee OR matched outlet/partner is in the caller's whole DOWNLINE — kills the false "This outlet is not within your team"); (2) camera-only live capture (in-app getUserMedia, no gallery fallback; DOCUMENT/IMAGE/UPI_QR keep the file picker); (3) roster Outlet ID/Name in prefill (`withRosterIdentity` → a DATA_DISPLAY bound to them resolves); (4) persistent roster view + Download roster .xlsx (`GET :id/roster/export`, GIFSY-only); (5) Data-Display "Excel column" → DROPDOWN of roster columns.
  - **BATCH 2 — edit/delete a filled enrollment** (`c807291`,`369df10`; CARRIES the migration): admin edit → NEW version; enroller edit gated on per-scheme `audienceConfig.allowEnrollerEdit` (**SALES self-edit DISABLED, server-enforced**); soft-delete (`SchemeEnrollment.deletedAt`) + reset-on-reenroll; persistent "Show deleted" restore panel + GIFSY-only `GET :id/enrollments/deleted`. **Consent carry-forward on edit** — `submit()` `consentedEditFrom` REUSES the phone OTP-verified at the ORIGINAL capture (immutable; client phone discarded), never a fresh OTP; fail-closed. Dual-audited + third-pass re-audit CLEAN (HIGH consent-brick + 2 MED + LOW fixed; all 15 read/report/export sites filter `deletedAt`); staging-runtime-verified pre-cutover.
  - **SCHEME SALES-LIST SCOPING** (`7817de6`): `getSalesEligibleSchemes` shows a rep only schemes their reach (self+downline) has ≥1 target for; a no-audience scheme stays visible to all (owner decision). Mirrors `getSalesTargets`.
  - **ENROLLMENT EXCEL REPORT REBUILD** (`e0c254d`): ALL uploaded audience-Excel columns (`SchemeOutlet.prefillValues`, union, de-collided), Outlet Name fallback to matched-outlet name, Tagged + "Submitted By (Employee)" employeeCode, ABSOLUTE media links (from `x-forwarded-host`) that open from the file, grouped columns + a "Columns" legend sheet. Backend `scheme-report.service.exportEnrollments` + controller `@Req`.
  - **CHILD-KYC GROUP-IDENTITY PREFILL** (`6409003` + audit-fix `afb4a2f`): a grouped child's KYC pre-fills the shared owner identity (business/owner name, GST, bank, UPI — EDITABLE) + PAN pre-filled + LOCKED to the group PAN, from the APPROVED parent ELSE the most-recently-APPROVED grouped SIBLING (`resolveGroupIdentity`); photos/address/GPS never inherited (per-store). ⚠️ audit HIGH fix: the "approved child" signal is the sibling's **KYC APPROVED** (`kycSubmissions.some.status='APPROVED'`), NOT `ChannelPartner.onboardedAt` (a parent-only marker → gating on it made the sibling branch DEAD). See [[partner-multi-outlet]] §11.
  - **IDENTITY & PAYOUT UNIQUENESS SETTINGS TOGGLE** (`a83b2f4`): a self-serve Admin → Settings card for the per-tenant `uniquenessPolicy` (PAN/GST always-on+locked; Mobile/Bank/UPI editable OFF/ON), GIFSY_ADMIN-only. **default bank/UPI OFF platform-wide, but PROD deoleo is now `{gst,phone,bank,upi all true}`** — the owner flipped it via this toggle (2026-07-31, guarded prod read verified `{"gst":true,"upi":true,"bank":true,"phone":true}`), so cross-owner bank/UPI sharing is now rejected at KYC submit (same-group siblings still share). Staging also all-on. See [[global-settings-wiring]].
- **✅ CUTOVER #20 (`8c08af3`, 2026-07-30) — Scheme UX-hardening + Parent-ID outlet-master export; superseded in prod by #21 above.** Code-only/no-migration; additive+dormant. Payload = SCHEME UX-HARDENING (dual-source prefill `FormField.outletField` + H1–H6 + must-fixes) + the PARENT ID outlet-master DOWNLOAD export fix (`reports.service.outletMaster`, 57 cols). Dual-audited (BE + FE) + staging-verified 21/21. Rollback ref `daa4f3f` (#19). *(See ledger row #20.)*
- **🚀 LIVE IN PROD — CUTOVER #19 (`daa4f3f`, 2026-07-30).** prod = main = `daa4f3f` (verify via `git log`). No prod-side build work pending; what's left is owner-side UAT of dormant features (superseded in prod by cutover #20 `8c08af3`, see above). **#19 = SCHEME ROSTER-UPLOAD EXCEL REPORT** (Download-report button on the roster upload → Summary + per-row disposition + Duplicates + Unmatched-Employees sheets; code-only, no migration; audited GO + staging-verified; GIFSY-admin-only). **#18 = SCHEME PREFILL EDITABLE/LOCKED** (backend-enforced Excel-variable prefill on the scheme enrollment form — per-field Editable/Locked; code-only, no migration; dual-audited + staging-verified end-to-end; additive + dormant; memory [[scheme-data-collection]] §16). *(Prior #17 payload below.)* The #17 wave shipped, all **additive + DORMANT** (Deoleo live path byte-identical): **VISIBILITY-LED PAYOUTS/194C-TDS** (`500eaf9`, +2 migrations applied+prod-verified) + **GIFSY assume-tenant scoping** (`706efd1`+`12045db`, active) + **PARTNER→MULTI-OUTLET admin grouping FE** (`ab61b63`, no migration). TDS: full build W0–W2 + dual money-audit CLEAN; Deoleo's live incentive/194R path is byte-identical (INCENTIVE→194R, TDS engine never fires). Docs `VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md` + `VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md` (§10) + memories [[visibility-payout-tds-invoicing]] / [[gifsy-assume-tenant-scoping]] / [[partner-multi-outlet]]. **DEFERRED (WAVE0-SCHEMA §10):** DD-1 tenant recovery report exposes the cross-tenant PAN aggregate (`panBase`/`panTdsTotal`) — **owner KEEP-AS-IS** (dormant till a 2nd 194C tenant); **✅ DD-2 + DD-3 EXERCISED + CLOSED** (synthetic 2-tenant staging proof, paise-exact); **DD-4 (gross-up-TDS-invoice GST) CONFIRMED CORRECT AS DESIGNED** (unregistered→no GST/D6, registered→GST/D-i). Money path → dual adversarial audit mandatory on any change.
  Full spec = `platform/docs/plans/VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md` + as-built/fix-log = `VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md`;
  memory [[visibility-payout-tds-invoicing]] — READ ALL THREE FIRST. **Built:** W0 schema+migration `20260728120000_visibility_payout_tds_foundation`
  (ADDITIVE — 4 enums, `payoutStream` on CreditField, frozen-stamp/link cols on CreditPayoutEntry, kind/lock/PAN-FY on AutoInvoice, +3 typed
  tables TdsDeductionEntry/TdsRecoveryEntry/GstReimbursement) → W0.5 shared contracts (`tdsPolicy` in TenantSettingsService — **fail-closed scoped
  to `resolveTdsPolicy`**; freeze-on-confirm; `tds-methodology.helper.ts`; 4 `isSeparatePayout`→`payoutStream` reads) → W1 3 parallel streams
  (A tds-compute · B credits+invoices write-orchestration · C `api/src/tds-invoicing/*` reimbursement+reports+config) → integrated + **DUAL money
  audit (8) → fix → DUAL re-audit (4) → fix cycle 2 (6) → FINAL re-audit CLEAN (0)**. **Gate: api nest 0 / jest 2023 · FE tsc 0.** **Owner decisions
  (this session):** config store = JSON-hardened (not typed table — industry-checked vs Stripe/Fowler; freeze section+methodology onto each payout
  by value); **gross-up = MONTHLY-INCREMENTAL** top-up invoices `TGSL-TDS-<PAN>-<FY>-<seq>` (D-i); **no-PAN = pay full + 20% TENANT recovery + report**
  (D-ii); **default-ON** rollout (D-iii); **D10 recovery = pro-rata by FY-aggregate** (honored). Deoleo live path (incentive/194R) **byte-identical** —
  the TDS engine is a no-op for single-tenant/single-methodology/incentive. ⚠️ **migrations NOT applied to any DB** (local Postgres down → apply +
  runtime-verify on staging at W3): `20260728120000_visibility_payout_tds_foundation` + `20260728130000_credit_code_per_tenant_unique`. **✅ FIXED
  this wave (owner "fold it in"):** the batchCode/downloadCode global-unique collision → now `@@unique([clientId,code])` per-tenant + per-(clientId,period)
  advisory-lock code-gen. **✅ Double-reversal edge (DD-2) + no-PAN-per-(client,outlet)/MIXED (DD-3) now EXERCISED + CLOSED (2026-07-29 synthetic 2-tenant staging run, paise-exact, then deleted); DD-4 (gross-up-TDS-invoice GST) ✅ CONFIRMED CORRECT AS DESIGNED (unregistered→no GST/D6, registered→GST/D-i).** *(historical GAPS now built:)* (1) per-tenant **config** `{visibilityPayoutSection 194R|194C,
  tdsMethodology DEDUCT|GROSS_UP}` **Gifsy-set** + explicit `payoutStream=VISIBILITY|INCENTIVE` on the credit field (replaces
  overloaded `isSeparatePayout`); (2) **DEDUCT** method + per-PAN **carry-forward** ledger (currently gross-up-only); (3)
  **GROSS-UP** = at-threshold **"TDS invoice"** (retailer's name, GST applies, body NOT paid → deposited as TDS, settles the
  invoice) + **pro-rata tenant recovery** ledger ("in lieu of TDS" — dashboard only, never on invoice); (4) invoice trigger →
  **at payout-Excel CONFIRM** (before payout), **lock at UTR-entry** (not PAID); (5) **GST HOLDBACK** — pay base now, hold GST,
  release on retailer's deposit-proof via a **Gifsy-only GST-reimbursement screen**; (6) legend *"This is an automated invoice.
  No Signature is required."* + narration *"Payment for Marketing and support services for the month of <Month, Year>"*; (7)
  reports (GST-reg-type, **unregistered/RCM** invoice list, tenant recovery). **194R = separate later workstream** (config +
  routing built now). Portal split: 194C-engine/config/recovery/GST-reimbursement/RCM = **Gifsy portal**; payout-Excel-upload +
  read-only own invoices/reports/own-recovery-liability = **tenant portal**; invoice view+number-edit = **retailer portal**.
  **▶ NEXT = Wave 2 (frontend): Gifsy config-UI (section+methodology per tenant) + Gifsy dashboards (TDS liability/recovery/attribution, GST-reimbursement
  screen, unregistered/RCM report) + tenant read-only views (invoices, payout report, own recovery liability) + retailer invoice-copy tweaks — consume
  the `isNoPan` boolean, NOT the raw `__NO_PAN__` string. W0/W0.5/W1 backend DONE + dual-audited + gate-green.** Phase plan +
  ETAs (W0/W0.5/W1 done → W2 3-parallel-streams → W3 full-gate+staging-runtime-verify → W4 cutover) in §8 of the
  spec. Money path → **dual adversarial audit mandatory** [[audit-every-build-item]].
- **🚀 VISIBILITY (POSM) — ✅ LIVE IN PROD — cutover #16 `4ebf12c` (2026-07-28), DORMANT + post-cutover infra DONE.**
  Prod migration `20260727120000_visibility_posm_rebuild` applied (0 legacy rows → abort-guard passed), 5 new tables, `/v1/visibility`
  401-wired, Deoleo login 200, 0 captures/forms → zero Deoleo impact until a Gifsy admin sets `visibilityConfig`. Full write
  state-machine + all 6 junk-GPS geo-fence vectors proven LIVE on staging (synthetic, cleaned up). **Post-cutover infra DONE:**
  `VISIBILITY_REMINDER_SECRET`(+_STAGING) bound + durable in `deploy.yml`/`deploy-staging.yml`, weekly Cloud Scheduler
  `visibility-reminder-prod`/`-staging` (Mon 09:00 IST, secret-gated fail-closed — verified prod 201/403, staging 201
  {141 reps}), `visibility-media/` GCS lifecycle 120d→ARCHIVE/2555d→Delete (terraform synced; whole-bucket NEARLINE@90d also
  applies). **ONLY OPEN = owner activates a tenant (`visibilityConfig`) + UATs in prod.** The `0615af2` deploy-workflow infra shipped to prod at cutover #17 (`52fc19f`) — nothing POSM-related is pending on develop anymore.
  The dead "visibility" photo scaffolding reworked into a recurring, per-window, **sales-captured, geo-fenced,
  Gifsy-approved proof of point-of-sale material**, on the Scheme instrument (reward-free). Full contract + decisions
  **D1–D17** + **§16 AS-BUILT** = `platform/docs/plans/VISIBILITY-POSM-DESIGN.md`; memory **[[visibility-posm]]** (read
  BOTH first for any visibility/POSM work). **Owner UATs only once live → I own bug-free** (money-path-grade dual audit
  DONE). POSM feature commits `2e28ac4`+`5ac29ae`+`6e3b897` (shipped to prod at cutover #16 `4ebf12c`; gate at build **api nest 0 / jest 1931 · FE tsc 0 / vitest 2014**). Migration `20260727120000_visibility_posm_rebuild`
  (destructive: drops the 4 dead photo tables + re-columns `visibility_image_hashes`; **abort-guard asserts 0 legacy
  rows**; kept Excel `OutletVisibilityRecord` AMOUNT_UPLOAD path; repointed 4 live consumers). Dual adversarial audit
  → **2 HIGH (geo-fence fail-OPEN→now fail-closed; no sales media-upload route→added `POST sales/media`) + 5 MED + LOWs
  ALL FIXED.** ⚠️ a THIRD (pre-push) audit of the cleanup plan caught `prisma/wipe-tenant-data.ts` still deleting the
  DROPPED old models (gate-invisible, `prisma/` excluded from tsconfig.build) → FIXED `6e3b897`. Config in
  `program_settings.visibilityConfig`; **weekly web-push reminder + Tasks badge (reps only)**; `visibility-media/` retention
  decided (Std-4mo→Archive→del-7y). **✅ STAGING DONE:** guarded cleanup of the 1 legacy `visibility_programs` row
  (backed-up+deleted, guard `gifsy_staging`, children all 0) → push → both services `6e3b897` + `/health/ready` db:up →
  **migration verified** (5 new tables, 4 dead dropped, 3 AMOUNT_UPLOAD kept, image_hashes re-columned, enum). **API-surface
  runtime-verified LIVE** (config/form round-trip, admin outlets-in-scope denom **694**, IST window `2026-07-P2`=[16-31], sales
  eligibility+level-gate, tenant report+export, full RBAC-negative matrix, weekly-reminder fail-closed). **Deoleo left ENABLED
  + configured on staging** (SSS/SSS_TOT · freq 2 · XSR/SO/ASM · geoFence 50m). **⚠️ REMAINING:** (a) the capture→approve DB
  WRITE path NOT exercised live (no staging capture-rep reaches an ACTIVE in-scope outlet; jest-covered + = owner phone smoke)
  → **OFFERED owner a synthetic staging capture to prove it live before the smoke**; (b) **~10-min owner phone smoke**
  (camera/geo/web-push); (c) **owner UAT**; (d) **prod cutover** (merge→main + owner gate; prod pre-check legacy visibility
  tables) + post-cutover infra (Cloud Scheduler + `VISIBILITY_REMINDER_SECRET`; the GCS lifecycle). **NEXT = owner's phone
  smoke / UAT (+ optional synthetic-capture proof) → prod cutover.**
- **✅ SCHEME DATA-COLLECTION — LIVE IN PROD (cutover #15 `bda9bf3`, 2026-07-27):** the dormant "scheme" feature
  reworked into a **temporary, Gifsy-admin-built data-collection instrument** — enrollment/registration +
  fully-custom form capture ONLY (**no reward/points engine**; rewards stay on the target/achievement/credit
  path). Full frozen contract + decisions **D1–D30** + **§11 schema spec** + **§15 as-built** = `platform/docs/plans/SCHEME-DATA-COLLECTION-DESIGN.md`;
  memory **[[scheme-data-collection]]** (read BOTH first for any scheme work). Built W0–W3 + gated GREEN
  (api `nest build` 0 / jest 1826 · FE `tsc` 0 / vitest 1941) + TWICE dual-audited (all fixed) + staging
  runtime-verified. **Migration `20260725120000_scheme_data_collection`** (roster remodel + `OtpPurpose ADD VALUE`;
  abort-guard asserts 0 `scheme_enrollments`). **✅ PROD CUTOVER DONE + VERIFIED:** guarded prod pre-check
  (`scheme_enrollments`=0, `scheme_outlets` absent, partnerId col+unique index present → abort-guard clears) →
  FF-merge `develop`→`main` → owner-approved gate → CI `gifsy-migrate` applied the migration (`--wait`) →
  **PROD VERIFIED:** both services serve `bda9bf3` @100% (api `00032-sgx`, fe `00024-vgp`), `/health/ready` db:up,
  migration `done:true` + all 4 new tables + `partnerId` dropped + `schemeOutletId`/`submittedByUserId`/`SchemeEnrollmentStatus`
  enum + `OtpPurpose.SCHEME_ENROLL_CONSENT` + `schemes.audienceConfig` + `scheme_enrollment_forms.version` present,
  `deoleoloyalty.gifsy.in/auth/login` 200, `GET /v1/schemes` 401 (wired, not 404). **Additive + DORMANT** — no prod
  schemes until a Gifsy admin creates one → zero impact on live Deoleo. **REMAINING = owner UAT + a ~10-min real-phone
  camera/geo + phone-OTP-owner-pin smoke** (the one device path I can't verify). Supersedes P4 tasks #22–29.
  ✅ **CI-hygiene fix DONE (`e46dd51`, 2026-07-27):** `ci.yml`'s api `tsc --noEmit` step was red on a pre-existing
  tsconfig `rootDir`/`include` mismatch (bare `tsc` used `tsconfig.json` rootDir=src + default include=`**/*` →
  TS6059 on out-of-src `prisma.config.ts`/`prisma/*.ts`/`test/*.ts`). Repointed the step to
  `tsc --noEmit -p tsconfig.build.json` (the deployable set `nest build` compiles; excludes prisma/+test/). Was
  never gating (deploy workflows run `npm test` only; prod builds via `nest build`); unit specs still type-checked
  by ts-jest. Verified `tsc --noEmit -p tsconfig.build.json` exit 0 + platform tsc 0 + jest 1826 + vitest 1941.
- **prod SERVES `fb996d8` (cutover #22, 2026-07-31); main == origin/develop == `fb996d8` (develop NOT ahead).** *(history: `a83b2f4` #21, `8c08af3` #20, `daa4f3f` #19, `f193127` #18, `52fc19f` #17.)* Cutover #22 = **reactivate-leak fix + enrollment Excel report rebuild (public tokenized `/v1/schemes/media/view`) + PARKED remove-from-KYC-queue outlet state + grouped-child GST-cert/cheque doc carry-forward + "Activations / Tasks" label rename** (carries the additive `20260731170000_outlet_kyc_intent_parked` enum migration, applied to prod; see 🟢 CURRENT STATE + ledger row #22). Cutover #21 = **scheme UAT batches + child-KYC group-identity prefill + Identity/Payout Uniqueness toggle** (carries the `scheme_enrollment_soft_delete` migration, applied to prod; see ledger row #21). Cutover #20 = **scheme UX-hardening + Parent-ID outlet-master export** (code-only; see ledger row #20). Cutover #19 = **scheme roster-upload Excel report** (Download-report button → Summary + per-row disposition + Duplicates + Unmatched-Employees sheets; code-only, GIFSY-admin-only). Cutover #18 = **scheme prefill Editable/Locked** (backend-enforced Excel-variable prefill; memory [[scheme-data-collection]] §16).
  ✅ **Cutover-#14 SELF-HEAL WATCH CLEARED (2026-07-27):** the prod api rev now serves the merged main SHA `bda9bf3`
  AND `KYC_CLEANUP_SECRET` is confirmed bound on the serving revision (verified during cutover #15) — the flaked
  `51c2461` redeploy has self-healed. — **✅ CUTOVER #14 LIVE (2026-07-24): 🏗️ PARTNER→MULTI-OUTLET
  Waves 1–4 are FULLY IN PROD.** (Prior: #12 `d028566` + #13 `2187498`, LIVE 2026-07-22.) Shipped: uniqueness engine + parent entity +
  admin grouping + re-KYC stage-at-approval + login picker + group overview + child-KYC pre-fill/badge + scheme re-key +
  order-bound OTP + **W4** group-leave-via-re-KYC + Phase-2 roll-ups + scheme-catalog fix. Additive+**opt-in — DORMANT
  until an admin sets a parentId** → zero impact on live Deoleo. Gate at cutover: **api jest 1745 · nest 0 · FE vitest 1984
  · tsc 0**; adversarial-audited (no HIGH; MED-1 orphan-sibling + LOW-3 fixed); staging-verified on the `w3test-*` group.
  **PROD VERIFIED post-deploy:** both services serve `eca351e`, `/health/ready` `{db:up}`, Deoleo login 200, and ALL 4
  migrations applied (`_partner_multi_outlet_foundation`, `_partner_group_uniqueness`, `_otp_reference_id`,
  `_scheme_enrollment_by_partner`) + every DB object confirmed (isParent/groupId/parentId/proposedPartner/otp.referenceId/
  scheme_enrollments.partnerId cols; PAN+GST partial-unique + scheme partnerId unique indexes; `outlet_group_id_sync`
  trigger). Full as-built = `PARTNER-MULTI-OUTLET.md` §9; memory **[[partner-multi-outlet]]**.
  - **Pre-cutover prod cleanup (owner-OK'd guarded write, 2026-07-24):** prod had 4 UNAPPROVED go-live SMOKE-TEST partners
    with 2 dup-PAN pairs that would have FAILED the W2 PAN index → **soft-deleted all 4 partners + outlets + logins
    (reversible via `deletedAt=null`) + purged their 4 test phones** (`User.phone` NOT NULL → sentinel `DEL-<id>`; numbers
    freed). Prod now has **0 active partners** — clean slate for real onboarding.
  - **✅ KYC-cleanup 48h stale-draft sweep — DONE + VERIFIED both envs (2026-07-24).** Secret-Manager secrets
    `KYC_CLEANUP_SECRET` (prod) + `KYC_CLEANUP_SECRET_STAGING` (staging) CREATED + granted to `gifsy-api-sa`; both wired into
    `deploy.yml` / `deploy-staging.yml` `--set-secrets` (**durable** across future deploys — NOT a manual `gcloud run update`,
    which the next deploy's `--set-env-vars` would wipe). Prod got the secret **immediately** via an ADDITIVE
    `gcloud run services update gifsy-api --update-secrets=KYC_CLEANUP_SECRET=…` (rev `00031-w9k`, same `eca351e` image; the
    prod CI redeploy of the deploy.yml wiring FLAKED — left to SELF-HEAL, see the ⚠️ note in the CURRENT-STATE header above).
    Staging got it via its CI deploy. Both Cloud Scheduler jobs CREATED + ENABLED (`kyc-cleanup-prod` / `kyc-cleanup-staging`, daily 01:00 IST
    → `POST /v1/kyc/cleanup-stale-drafts` with `x-cleanup-secret`). **VERIFIED:** prod correct-secret → `{deletedDrafts:2,
    deletedPartners:1}` (reclaimed leftover stale test drafts), prod wrong-secret → 403 fail-closed, staging → `{0,0}`, both
    schedulers ran OK.
  - Also: sweep dup bank/UPI **before** ever flipping a tenant's `uniquenessPolicy.bank`/`upi` to true (no DB index reveals them).
  - **✅ CUTOVER PROCEEDING (2026-07-24) — the prod dup-PAN blocker is RESOLVED.** Prod is pre-Wave-1 so ALL **4 additive
    migrations** apply. Guarded prod read (`gifsy-oneoff-prodcheck`) had found scheme-orphans **0** but **2 dup-PAN pairs among 4
    UNAPPROVED go-live SMOKE-TEST partners** (`AAACT9811F`×2 + placeholder `ABCDE1234F`×2; Deoleo had no real partners). **RESOLVED
    2026-07-24 via a guarded prod write (backup + shown SQL + owner OK): SOFT-DELETED all 4 partners + 4 outlets + 4 login users
    (reversible via `deletedAt=null`) + PURGED the 4 test phones (freed for reuse — `User.phone` NOT NULL → sentinel `DEL-<id>`;
    `ORIG_NUMBERS_STILL_HELD=0`). DUP_PAN now 0; prod has 0 active partners — clean slate.** Backups in this session's transcript
    (partner/outlet/user ids + original phones). **▶ REMAINING cutover steps: merge develop→main + push (I do it) → owner approves
    the GitHub "Deploy — Production" gate → CI applies the 4 migrations → verify prod SHA/`/health/ready`/smoke → post-cutover:
    create Cloud Scheduler → `POST /v1/kyc/cleanup-stale-drafts` daily + set `KYC_CLEANUP_SECRET` on prod.** ⚠️ flaky-CI: re-run
    failed jobs if the prod test job flakes so the gate appears. Also: sweep dup bank/UPI **before** ever flipping a tenant's
    `uniquenessPolicy.bank`/`upi` to true (no DB index reveals them). *(§4.5 PAN-change-to-leave-group is IMPLEMENTED in W4.)*
- **✅ CUTOVER #12 (`d028566`, live 2026-07-22) shipped BOTH develop features + the infra-workflow changes to prod:**
  (1) **PER-OUTLET PAYOUT MANDATE** — `Outlet.requiredPaymentType BANK|UPI|ANY` (migration `..._add_outlet_required_payment_type`),
  **fully LIVE, needs no flag** (defaults BANK); (2) **KYC ADDRESS-PROOF WAIVER** (migration `..._add_kyc_address_name_mismatch`);
  plus `deploy.yml` Direct-VPC-egress + `/health/ready` startup probe + `REDIS_URL` removal (matched the manual prod state).
  Both migrations verified applied on prod (additive, zero-downtime). Smoke: both services `/health/ready` 200 `{db:up}`.
- **✅ CUTOVER #13 (`2187498`, live 2026-07-22, code-only) shipped the WAIVER SEMANTICS-FIX + set the prod flag:** the waiver
  now drops ONLY the self-declaration (Address Proof stays required — owner-corrected before the flag went live). Prod deoleo
  `clients.features.kycAddressProofWaiver=true` SET (guarded write, keycount 10→11, `rbacEnforcement` untouched at false;
  backup captured). **Waiver is now LIVE for Deoleo in prod.** Remaining verify = owner real-OTP prod check of the KYC form
  (Address Proof still required + self-declaration gone) — FE gating is unit-tested + staging-verified + audit-clean.
- **🆕 PER-OUTLET PAYOUT MANDATE (develop `11fe3a8`, gate-green, audit-clean, ✅ STAGING-VERIFIED):** the client can configure
  PER OUTLET (at master-upload) which payout details an outlet must give — new `Outlet.requiredPaymentType` enum `BANK|UPI|ANY`
  (NOT NULL DEFAULT BANK, additive migration). HARD MANDATE: the uploaded value pins the KYC Bank/UPI toggle (rep can't change);
  backend `create()` guard rejects a mismatched `paymentMode` + requires the matching fields; UPI is never allowed when tenant
  `salesApp.upiEnabled` is false (a UPI upload row under a UPI-disabled tenant is REJECTED in the error report). Shared
  `payment-type` helper (api `common/` + FE `lib/` mirror) is the single contract. Independent audit clean (no HIGH; MED-1
  re-KYC-locked-empty deadlock FIXED + all LOWs). Gate: api jest 1557 · nest 0 · FE vitest 1924 · tsc 0. **✅ STAGING-VERIFIED**
  (upload UPI-under-deoleo REJECTED + case-insensitive accept; KYC submit guard 400s a mode-mismatch + missing-fields; migration
  live). **⚠️ needs the same migration cutover; no prod flag/DB write required (the column defaults to BANK).** See memory
  [[deoleo-go-live-bundle]] NEWEST-59.
- **🆕 KYC ADDRESS-PROOF WAIVER (develop `2f21a8e` + semantics-correction, gate-green, ships NEXT cutover):** in `sales/kyc/new`,
  ticking "shop board name & address proof name do not match" DROPS the extra signed self-declaration document — the **Address Proof
  upload itself stays REQUIRED** (owner-corrected 2026-07-22: the original build wrongly made the Address Proof optional too; now the
  waiver only removes the self-declaration). Deoleo-only, gated on new `clients.features.kycAddressProofWaiver` (a runtime behaviour
  flag, EXCLUDED from the gifsy-console `FeatureKey` module set → DB/seed-set only). Gating is a pure helper `lib/kyc-document-gating.ts`
  (unit-tested — address proof never becomes optional). Persisted as new `KycSubmission.addressNameMismatch` (additive migration) + a
  neutral "Names differ" reviewer badge on both `kyc/[id]` pages. Flag-OFF = byte-identical. Staging flag ON (backup was `features={}`).
  **⚠️ GO-LIVE: at the next cutover also `jsonb_set` `kycAddressProofWaiver=true` onto PROD deoleo `clients.features`** (likely `{}`
  today → additive is fine; ~5-min `resolveClient` cache). See memory [[deoleo-go-live-bundle]] NEWEST-58.
- **§A-DOMAIN is FULLY LIVE on prod (verified post-cutover):** DB-driven routing (D-1, resolveClient→`clients`),
  features-from-authenticated-`/me` (P5, registry reduced to fallback), and **S1 edge-secret ENFORCING on production**
  — prod smoke confirmed: legit Deoleo login 200 + secret matches the worker; a forged direct-`.run.app`
  `x-forwarded-host` resolves to `default`, NOT the spoofed tenant (forge rejected). Code-only cutover — **no new
  migrations**. Also live: favicon-from-DB-branding, proxy/worker unit tests, 2nd-tenant DB-routing E2E, the sales-ledger
  payout unification. P3 worker (`44088f8a`) stamps the edge secret for all `*.gifsy.in`.
- **DB tenant-routing LIVE in prod** (`TENANT_ROUTING_SOURCE` default `db`, registry fallback → Deoleo
  unaffected). Kill-switch: `TENANT_ROUTING_SOURCE=registry` on the FE service. **⚠️ `RBAC_ENFORCEMENT` env still OFF.**
- Gate green on `e8de31a`: **api jest 1540 · nest 0 · FE vitest 1917 · tsc 0**. Pre-cutover backup `1784547142461`;
  rollback ref = prior prod `437045a`.
- **✅ E2E HARNESS REVIVED + CLEAN-BASELINED (2026-07-21, `4b0d03f`+`f89697c`): 295 passed / 0 failed / 3 skipped, now REPRODUCIBLE on a fresh gifsy_dev.** See below + the dedicated plan.

## ▶ E2E HARNESS REVIVAL — ✅ DONE (2026-07-21, `4b0d03f`)
**Full pickup/record: `platform/docs/plans/E2E-HARNESS-REVIVAL.md` (§0 = the resolved story + the NEW run-book).**
The go-live Playwright harness (`platform/e2e`), dead since AF-6, is REVIVED and **fully green (294/0/4)**. Key
resolutions: (A) the `requestAs`/401 "mystery" was the RUN TARGET — local `next dev` (Turbopack) does NOT run the
proxy for `/api/*`; a **prod build does**, so the harness now runs against a local **`next build`+`next start`** (NOT
`next dev`). (B) tenant steering via the new **`hostHeader`** strategy (`x-forwarded-host` per role, trusted locally
via the unset EDGE_SECRET path). (C) server-action CSRF handled by a **default-OFF `E2E_LOCAL_ORIGIN`** gate in
`next.config`. (D) ~25 stale specs reconciled; a dedicated **CP004/`partnerApproved`** approved-partner fixture added
(both redeem money-paths gate on KYC-APPROVED); visibility enabled for the test tenants in the seed. (E) two tiny
**prod-source** fixes surfaced by the harness: the `/admin/outlets` client-redirect fix + the gated next.config origin.
Gate: api jest 1540 · nest 0 · FE vitest 1917 · tsc 0. **✅ CLEAN-BASELINE DONE (`f89697c`, 295/0/3 on a FRESH DB):**
`e2e/global-setup.ts` now TRUNCATEs + re-seeds `gifsy_dev` before every run (gated LOCAL-only via `E2E_ENV!==staging`,
skippable with `E2E_SKIP_RESET`; guarded to `current_database()==='gifsy_dev'`) → the suite resets itself, no more
manual re-seed and no residue drift. The seed now OWNS deoleo's canonical branding + module config (previously
residue-only), clientb is ONBOARDING, and the reward-name specs use the seed values. A one-off owner-consented
`prisma migrate reset` reapplied all 11 migrations cleanly (no drift). Only the STAGING run mode remains a separate,
not-yet-exercised path (there, no reset is possible — robust assertions carry it). See the plan doc §"CLEAN BASELINE".

<details><summary>§A-DOMAIN P6 + cutover #11 — ✅ DONE + LIVE (reference, superseded)</summary>

P0–P2 + P4/P4b IN PROD; **P3 + D-1 + P5 ✅ DONE on develop (staging-verified, awaiting cutover #11)**. **P6 ✅ DONE
on develop + staging — S1 edge-secret now ENFORCING on staging (verified); tests + favicon + E2E shipped. The only
§A-DOMAIN item left is prod enablement, which happens automatically at cutover #11.** Plans: `A-DOMAIN-PLAN.md`,
`A-DOMAIN-P0-DESIGN.md`. Status:
- **P3 edge worker — ✅ DEPLOYED + VERIFIED LIVE (2026-07-20).** Owner added the proxied wildcard `*.gifsy.in`
  DNS record (AAAA `*`→`100::`, orange-cloud) + Universal SSL already covers `*.gifsy.in` (cert SAN
  `DNS:gifsy.in, DNS:*.gifsy.in`, GTS, Active; plus ACM Advanced certs for the existing 2-level hosts). Both
  prereqs were runtime-confirmed (a random `<x>.gifsy.in` resolves to CF anycast + presents the valid `*.gifsy.in`
  cert). Then I `npx wrangler deploy`'d `cloudflare-worker/` (tenant-agnostic coarse worker, new version
  `eb56c29b`) → triggers now `*.gifsy.in/*` + `api.gifsy.in/*` + `api.staging.gifsy.in/*`. **The 5 pre-existing
  Worker Custom Domains (deoleoloyalty, uat.deoleoloyalty, api.staging, app, uat.app) were untouched** (config
  has NO `custom_domain` entries, so wrangler doesn't reconcile them). **VERIFIED:** `deoleoloyalty.gifsy.in/auth/login`
  200, `api.gifsy.in/health` 200, `app.gifsy.in` 200, apex `gifsy.in` 200 — all unaffected; and a NEVER-configured
  `newtenant-probe-x9z.gifsy.in` → **404 from the frontend** (routes through worker→frontend→Next fail-closes on
  unknown slug, NOT a CF black-hole) = **zero-touch routing PROVEN**. **Independently pre-audited** (2 agents:
  Cloudflare-docs auditor CONFIRMED all 6 platform claims w/ cited docs; repo-config auditor confirmed
  `wrangler.toml` already declared the `*.gifsy.in/*` route + same prereqs). **Owner-flag (2 reserved hosts now
  502 by worker design — NOT regressions): `mail.gifsy.in` & `status.gifsy.in` return 502 "No backend configured"
  on HTTPS.** `status` had no prior record (only resolves via the new wildcard → nothing was ever there). `mail`
  EMAIL/MX is unaffected (worker only touches HTTP); only a hypothetical webpage at `https://mail.gifsy.in` 502s.
  `www.gifsy.in` is a SEPARATE grey-cloud Firebase record (199.36.158.100) the worker never touches — its TLS-SNI
  mismatch (`SEC_E_WRONG_PRINCIPAL`) is PRE-EXISTING, unrelated. If the owner wants mail/status/www to serve real
  content, drop them from the worker's `RESERVED_HOSTS` or add explicit handling. **Now truly zero-touch:
  onboarding client #2 needs NO Cloudflare edit — just a DB `client_domains` row + console.**
- **D-1 (#159) — ✅ DONE on develop (`9872806`, audited GO, staging-verified).** `resolveClient` (tenant.service)
  now reads the `clients` table (`mapClientRow`) instead of `AdminConfig` `client_config` (prod had **0** such rows
  for deoleo → resolveClient already fail-open-threw; converging onto `clients.features.rbacEnforcement=false` is a
  **byte-identical RBAC posture**, verified). `visibilityCaptureMode` moved onto `clients.features` (writer repointed
  to a fresh-read merge base); gifsy console create/update now bust the 5-min resolveClient cache; `upsertClientConfig`
  deleted. Fail-open RBAC preserved (missing row / absent flag / non-object features → false). Staging-verified: deoleo
  `/admin/settings/config` 200+features, RBAC still off, operator `gifsy` dashboards 200 (resolveClient throws → caught).
  **⚠️ `RBAC_ENFORCEMENT` env master-switch still OFF — before ever flipping it ON, confirm no tenant has an
  unexpected truthy `clients.features.rbacEnforcement`.**
- **P5 (#157) — ✅ DONE on develop (`c4d1cf9`, audited GO, staging-verified).** Branding backfill done earlier (prod+
  staging, live). Registry-code retirement: FE features now served from **authenticated DB-backed /me** (`/partner/me`,
  `/sales/me`, admin `/admin/settings/config`) via `lib/tenant-features.ts` (`useTenantFeatures`/`normalizeFeatures`,
  fail-soft `{}`); admin/partner layouts + partner leaderboard read features from there, NOT `CLIENT_REGISTRY`. Registry
  **REDUCED, not deleted** (it's the kill-switch/cold-start domain→slug fallback): `DEOLEO`/`CLIENT_B` now spread a new
  `DEFAULT_CLIENT_CONFIG` overriding only slug/status/domains/branding; the 2 hard `DEOLEO_CONFIG` imports →
  `DEFAULT_CLIENT_CONFIG`. Deoleo nav provably unchanged; branded-host SSR still resolves. **2 LOW future-tenant notes
  (NOT Deoleo blockers → 2ND-TENANT list):** admin layout doesn't gate on features-loading (flash for a future
  non-default tenant); MIS_USER gets `DEFAULT_FEATURES` (`/admin/settings/config` is GIFSY/CLIENT_ADMIN-only).
- **P6 (#158) — ✅ DONE on develop + staging (S1 ENFORCING + verified). Prod enforces automatically at cutover #11.**
  - **S1 edge-secret — ✅ ACTIVATED + ENFORCING on staging (2026-07-20, verified).** The `*.run.app` origins are public
    (`ingress=all` + IAM `allUsers`, verified) → a direct hit could forge `x-forwarded-host` (bounded: post-login scope
    is JWT-enforced). Fix = an **edge secret**: worker stamps `x-edge-secret`; `lib/platform/edge-trust.ts`
    `resolveTrustedHost` (used by `proxy.ts` + `auth/login/actions.ts`) trusts `x-forwarded-host` ONLY when it matches,
    else falls back to Host (safe). **Env-gated** (`EDGE_SECRET` unset/empty → inert → prior behaviour). **AS-BUILT:** a
    256-bit secret is bound to the `gifsy-proxy` worker (`wrangler secret put`) + worker redeployed (version `44088f8a`)
    so it strips any inbound `x-edge-secret` and stamps the real one; the OWNER added the matching `EDGE_SECRET` GitHub
    Actions repo secret (gh CLI not installed → owner did it in the UI); an empty-commit redeploy (`8f817b9`) baked it into
    the staging frontend env → **staging now ENFORCES.** **RUNTIME-VERIFIED on staging:** (1) legit login via the edge
    worker `uat.deoleoloyalty.gifsy.in/auth/login` → 200 + slug=deoleo (login intact, secret matches); (2) a FORGED direct
    `*.run.app` hit with `x-forwarded-host: clientb.gifsy.in` → 404 + slug=`default` (NOT clientb — forge REJECTED);
    (3) baseline direct hit (no forge) → identical 404 + `default`. (2)==(3) ⇒ the spoofed host had zero effect. **Secret
    value in scratch file `EDGE_SECRET-owner-handoff.txt` (owner can delete it now).** **▶ REMAINING: prod enforces
    automatically at cutover #11** (deploy.yml already injects `EDGE_SECRET` from the same GitHub secret). Ordering safe:
    the worker stamps for prod too, but prod FE has no `EDGE_SECRET` until #11 → inert until then.
  - **Tests + favicon + E2E — ✅ SHIPPED `f578cad` (audited GO, full gate green, staging-verified).**
    `4cab103` **favicon-from-DB-branding**: `layout.tsx` now uses `resolveFaviconIcoHref(branding.faviconUrl, slug)` —
    prefers the DB `faviconUrl` ONLY when it's an absolute http(s) URL (a console-uploaded GCS asset), else the static
    `/icons/<slug>/favicon.ico`. This FIXES a DB-only tenant's broken favicon WITHOUT regressing Deoleo (whose DB
    `faviconUrl=/favicons/deoleo.ico` is a never-committed path → correctly falls back; **runtime-verified on staging:
    emitted `/icons/deoleo/favicon.ico` 200, the DB `/favicons/deoleo.ico` is 404**). `ad2b074` **proxy.ts + worker.js
    unit tests** (43: role-gating incl. the /admin/gifsy-before-/admin ordering; the FULL S1 x-edge-secret boundary).
    `f578cad` **2nd-tenant DB-routing E2E** (deterministic vitest acceptance slice proving a registry-absent tenant routes
    via the DB map + kill-switch DB-dependence + Deoleo no-clobber + resolver isolation; Playwright spec on
    `GET /v1/tenants/routing`; seed adds `client_domains` rows + distinctive clientb DB branding — seed is NEVER auto-run
    on staging/prod).
  - **Two non-blocking findings — ✅ FIXED `58ce1ab`.** (a) `proxy.ts` unreachable `/api/*` 403 branch removed +
    documented that API-route role enforcement is the NestJS backend guards' job (proxy authenticates `/api/*` + gates
    PAGES only) + a test asserting a wrong-role `/api/*` passes through (guards against re-adding a broken gate).
    (b) worker.js `relative Location` comment corrected (a relative Location resolves against the `.run.app` backendBase
    and IS rewritten to the public host — harmless; comment-only change → deployed `44088f8a` behavior identical, no
    redeploy needed).
- **P4b money-path runtime-verify** (owner, OTP-gated): as GIFSY_ADMIN change a tenant's conversion rate
  on the client-detail Wallet card → confirm a redemption uses it + the tenant Settings panel matches.

⚠️ **FLAKY-CI TRAP:** CI + the prod-deploy `test` job can flake (25s fast-fail; the exact command
passes clean locally + in the staging deploy on the same code). `deploy.yml` gates the approval on
`needs: test == success`, so a flaked test job = **NO "Review deployments" gate appears** (reads as
"no approve option"). FIX: on the "Deploy — Production (main)" run, **"Re-run failed jobs"** → tests
pass → gate appears → approve. `deploy.yml` has an emergency `skip_tests` dispatch input.

### §A-DOMAIN — what it is (the current cutover payload)
DB-driven `*.gifsy.in` tenant routing + branding-to-DB, so a new tenant is provisionable from the
console/DB with no code edit. **Backend** (`client_domains` table [global LOWER(domain) unique],
`GET /v1/tenants/routing`, gifsy client CRUD domains + branding-asset upload). **FE resolver** reads
that endpoint (SWR cache, cold-start block-warm, registry fallback, prod fail-closed login,
`TENANT_ROUTING_SOURCE` kill-switch). **P4b** wired the gifsy client-detail Wallet card to the REAL
per-tenant money stores (conversion/expiry/floors via a tenant-targeted GIFSY settings write);
Invoicing/Features made read-only. Every phase: gate + INDEPENDENT adversarial audit (the P1 audit
caught 2 HIGH dead-feature bugs; P2 caught the cold-start branded-host mis-route; P4b money-path clean)
+ staging runtime-verify. Traps (a)/(b) below still apply. **See the two new A-DOMAIN traps at the
bottom of TRAPS.**

</details>

## 🔶 STANDING MODE — orchestrator
Default to orchestrating substantial work: decompose into **parallel sub-agents** (they write code —
background agents are denied shell; YOU run the gates), integrate shared files yourself, and ALWAYS
personally do the **INDEPENDENT adversarial audit + full gate + runtime-verify** before claiming
done. Own doc + memory consistency in the same pass. The 5 working agreements are in `CLAUDE.md`.
[[default-to-orchestration]] [[audit-every-build-item]] [[verify-flows-at-runtime]] [[own-consistency-no-micromanage]]

## GATES (full suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`)
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`. **Latest green (develop `11fe3a8`, incl. waiver + payout-mandate): api jest 1557 · nest 0 · FE vitest 1924 · tsc 0.** (The
`4b0d03f` E2E-harness-revival commit is mostly test-only — e2e specs aren't in the jest/vitest gate; the 2 tiny FE
fixes + next.config are tsc-clean & vitest-green. The E2E harness itself is a SEPARATE runtime gate: 294/0/4 green.)
- **Deploy ≠ pushed** (a docs-only commit re-tags the image) — verify the serving SHA:
  `gcloud run services describe gifsy-api-staging|gifsy-frontend-staging --region asia-south1 --project gifsy-platform --format='value(spec.template.spec.containers[0].image)'`.
- FE tsc gotcha: a stale `.next/types` surfaces a phantom `RejectionModal` error (pre-existing,
  webpack-only) → `rm -rf platform/.next` then re-run tsc.

## REUSABLE TRAPS
- **(a) `CreditPayoutEntry.outletId` == the outlet CODE everywhere** (no FK — join via
  `Outlet.outletCode`; `invoices.service`/`tds.service` confirm). Keying it by the Outlet **PK**
  matches nothing (was the wallet-surfacing HIGH-1, dead since cutover #8).
- **(b) A "completed" `PayoutTransaction` is `status='SUCCESS'`** — the `PayoutStatus` enum has NO
  `PAID`/`COMPLETED`; `payouts.service` writes `SUCCESS` on UTR upload. Any status mapper MUST handle
  it (was the wallet-surfacing HIGH-2).
- **(1)** NEVER use `isActive:true` as an "active outlet" denominator (created `isActive=false` until
  KYC approval — use `deletedAt:null AND deactivatedAt:null`). Conversely `isActive:true` IS the
  denormalised **"approved+active"** predicate (no `kycStatus` column on Outlet).
- **(2)** Prisma `{ not: X }` / `notIn` SILENTLY DROPS NULL rows → OR-wrap `OR:[{col:null},{col:{not:X}}]` (safe on non-nullable enum cols).
- **(3)** a partner's **Wallet row is created ONLY at KYC approval** — any pre-KYC points path must `wallet.upsert`.
- **(4)** tokens are bearer JWTs; the proxy reads the **httpOnly cookie** and injects the backend Bearer (post-AF-6). See SESSION/AUTH MODEL.
- **(5)** Cloud Run **throttles CPU between requests** → NestJS `@Interval`/`@Cron` workers don't tick
  reliably while idle (`min-instances=1` doesn't fix it). Drive via **Cloud Scheduler → internal HTTP
  endpoint** (un-throttles CPU). This is why the push drain runs on a scheduler.
- **(6)** the FE's `outletId` EVERYWHERE = the **Outlet CUID** (`o.id`), NOT `outletCode` — an endpoint
  keyed on `clientId_outletCode` from an FE-sent outletId is WRONG; use `findFirst({id, clientId})`.
  (Note this is the INVERSE of trap (a): FE sends the CUID, but `CreditPayoutEntry.outletId` stores the code.)
- **(7)** the sales `/sales/kyc` LIST is now **ASSIGNMENT-DRIVEN** (`e9b3a21`) — the FE synthesises every
  subtree outlet's derived KYC state from `/api/sales/outlets`; the submitter-scoped `/api/kyc` only
  supplements reassignment-edge outlets. (Raw `kyc.service.list()` is still submitter-scoped by design.)
- **(8)** a **bulk-upload loop of awaited writes in ONE interactive `$transaction` 500s at tenant
  scale** (5s default, ~2,261 Deoleo outlets). Fix = **chunk** into `$transaction([...])` batches of ~100
  for idempotent paths, or **raise `{timeout:180_000, maxWait:20_000}`** for MONEY paths that must stay atomic.
- **(9)/(15)** **re-KYC has TWO entry paths**: in-app admin action flips submission→`RE_KYC_REQUIRED`;
  bulk re-KYC upload sets ONLY `Outlet.reKycFlags` (submission stays APPROVED). `reKycFlags` persist
  until approval clears them → gate DISPLAY/actionability on **`isReKycActionable(flags, latestStatus)`**
  (flags set AND latest NOT in-flight — `common/kyc-rekyc.helper.ts` + `platform/src/lib/rekyc-fields.ts`),
  NOT bare `isReKycPending`. The approver highlight keeps using the RAW flags.
- **(11)** a FE **response-merge must match the service's ACTUAL projection shape** (the Gifsy client
  editor read nested `.branding.x` while the service returns it FLAT → edits silently reverted).
- **(12)** a spec `$transaction` mock typed `(cb) => cb(tx)` makes `.mock.calls[0][1]` a TS error →
  widen to `(cb, _opts?) => cb(tx)` when asserting the timeout option.
- **(13)/(14)** Employee Hierarchy upload keys User by `(clientId, phone)` but SalesUser by
  `(clientId, employeeCode)` → a phone correction orphaned the old User (phone stayed reserved in
  `users @@unique([clientId, phone])`, invisible in the UI). A "number in use" not in sales/outlet
  lists is an orphaned/other-role `users` row → query the `users` table.
- **(16)** guarded staging/prod one-off DB ops run via the **`gifsy-oneoff-staging` Cloud Run Job** —
  override `--args` with `^@^-e@eval(Buffer.from('<b64>','base64').toString())` (custom `@` delimiter so
  the comma inside `Buffer.from` isn't split); the image uses **Prisma 7 driver-adapter so bare
  `new PrismaClient()` fails → use raw `pg` on `DATABASE_URL`**; guard `current_database()==='gifsy_staging'`
  FIRST; reset args to a no-op after. (Staging writes still need a backup + owner OK per guardrails.)
- **(17)** a static asset under a NEW `public/` subdir needs the `platform/src/proxy.ts` auth-middleware
  `config.matcher` exclusion — else a no-token page 307's the asset to `/auth/login` (broken image).
  **Local `npm run dev` does NOT reproduce the edge 307 — curl the REAL staging edge.**
- **(IST)** server-local `Date` getters read **UTC in prod** (no TZ in the image) — user-facing IST
  dates MUST go through `api/src/common/ist-date.ts` (`monthYearIST`/`formatDateIST`), or shift by
  `IST_OFFSET_MIN` then read `getUTC*`.
- **(A-DOMAIN-c)** `client_domains.clientId` is a **bare slug** (= `Client.id`, no FK — matches every
  other model's clientId); `domain` global-uniqueness is a **hand-added `LOWER("domain")` UNIQUE index**
  in the migration (Prisma can't model an expression index) — don't expect Prisma `@@unique` to enforce it,
  and match domains case-insensitively (`{ equals, mode:'insensitive' }`).
- **(A-DOMAIN-d)** the gifsy client-detail **Wallet/Invoicing/Feature cards edited INERT `Client.*` JSON
  blobs the runtime never reads** — the REAL per-tenant config lives in `program_settings` (conversion
  rate/floors, via `TenantSettingsService`/`settings.controller`), `PointExpiryConfig` (expiry), the
  hardcoded `TECH_GIFSY` invoice constant, and `clients.features` (the runtime feature/RBAC store — post-D-1).
  "Make the card persist" ≠ "make it work" — wire the card to the REAL store (P4b did Wallet via a tenant-targeted
  `/gifsy/clients/:slug/wallet-settings`; Invoicing/Features left read-only).
- **(A-DOMAIN-e) D-1 DONE:** `resolveClient` (tenant.service) reads the **`clients` table** now (not `AdminConfig`
  `client_config`, which is RETIRED). It returns the raw `clients.features` blob; RBAC reads `(features as any)
  .rbacEnforcement` dynamically (fail-open: missing row/flag/non-object → false). `visibilityCaptureMode` lives on
  `clients.features`. Console create/update MUST `tenant.invalidateCache(slug)` (5-min cache). `RBAC_ENFORCEMENT`
  env master-switch is OFF — flipping it needs a per-tenant `clients.features.rbacEnforcement` audit first.
- **(A-DOMAIN-f) P5 features seam:** FE feature-gating reads `features` from the **authenticated** role endpoint
  (`/partner/me`, `/sales/me`, admin `/admin/settings/config`) via `lib/tenant-features.ts` (`useTenantFeatures`/
  `normalizeFeatures` — sparse/absent blob → `DEFAULT_FEATURES`, guaranteed nested `partnerApp`), NOT `CLIENT_REGISTRY`.
  The registry is REDUCED to a domain→slug + `DEFAULT_CLIENT_CONFIG` fallback (kill-switch/cold-start) — do NOT delete it.
- **(A-DOMAIN-g) worker route matches across dots:** `*.gifsy.in/*` also matches `api.gifsy.in`/`uat.x.gifsy.in` — safe
  only because they hit the SAME `gifsy-proxy` worker + its explicit API-host check wins. `wrangler deploy` does NOT
  prune Custom Domains absent from `wrangler.toml`, and it ROTATES the local `.wrangler` oauth_token (a cached-token
  CF-API script 401s after — re-read or use wrangler). Reserved `www/mail/status.gifsy.in` 502 by worker design.
- **(A-DOMAIN-h) S1 edge-secret:** the `*.run.app` origins are public (`ingress=all` + IAM `allUsers`) → `x-forwarded-host`
  is forgeable by a direct hit. `lib/platform/edge-trust.ts` `resolveTrustedHost` trusts it only when the worker's
  `x-edge-secret` matches; **env-gated** (`EDGE_SECRET` unset → inert). The CI frontend `--set-env-vars` REPLACES the
  whole env set → `EDGE_SECRET` must live in the workflow (GitHub secret), never a manual `gcloud run update` (wiped next
  deploy). Activation order: worker must send the secret BEFORE the frontend env is set, else legit login breaks.
- **(ASSUME-TENANT-SCOPE) GIFSY operator reads scope to the ASSUMED tenant.** A GIFSY_ADMIN assumed into a tenant
  (JWT `assumed:true`) is READ-scoped to that tenant; un-assumed GIFSY at home stays platform-wide. **Invariant:** any
  new GIFSY-wide read MUST use `api/src/common/tenant-scope.ts` `platformWide(user) = role==='GIFSY_ADMIN' && !assumed`
  (NOT a bare `role==='GIFSY_ADMIN'` check — that ignores assume-tenant and leaks the platform view to the operator's
  scoped context). `compute194C`/`summary194C` stay platform-wide (correctness); write-auth (`isGifsyAdmin`) untouched;
  194C views are un-assumed-GIFSY-only. LIVE develop `706efd1`+`12045db`, runtime-proven. Full detail: memory
  [[gifsy-assume-tenant-scoping]]. (Owner found it onboarding a 2nd staging tenant `uatbajaj`; NOT a tenant leak.)

## META-LESSONS (baked into CLAUDE.md agreements 1 & 2)
1. A fix is DONE only when **EVERY consumer + alternate data path + scale case** is traced (grep all
   consumers; 10-row vs 2,261-row; bulk-upload vs in-app entry produce different DB states).
2. **Clarify before an imperfect build** — if an approach isn't the ideal/complete solution, present
   ideal-vs-shortcut and let the owner choose; do NOT ship a caveated partial and iterate.

## SESSION/AUTH MODEL (post-AF-6 — answer precisely if asked)
Access token = httpOnly `token` cookie, **7-day** JWT (operator assume-tenant = **24h**); refresh =
httpOnly `refresh_token` cookie, **30-day** single-use rotating; the edge proxy reads the cookie +
injects the backend Bearer; `SessionExpiryGuard` does single-flight **refresh-on-401** + retry.
Practical rule: a user stays logged in if they open the app ≥ once every ~7 days; a cold return after
>7 days lands on login (page nav is edge-redirected before the client refresh runs). Phone-change →
logout: sessions tie to the USER row (revocable); at Gifsy approval a re-KYC phone change syncs
`User.phone` + revokes the owner's sessions. All KYC mobiles validated `^[6-9]\d{9}$`.

## CONSTRAINTS (full list in CLAUDE.md guardrails)
Work on `develop`; **NEVER `prisma migrate dev`**; any prod/staging DB op = double-guard
`current_database()` + backup + show SQL + WAIT for owner (staging+prod share the private-IP
`gifsy-db`; reads need only the guard). Never merge to `main` / trigger a cutover without the owner.
Never expose secrets. gcloud/wrangler are authed.

## STAGING (FIXED_OTP=`123456`)
GIFSY admin `9830011252`/clientId `gifsy`; deoleo admin `6289864191`; partner `7795096288`/deoleo
(active, no payouts); sales `9900000041`(ISR) · `9900000002`(SO) · `9900000011`(XSR). Credit-payout
test partner: `9000000007` (deoleo, outlet O003 — reactivated 2026-07-18). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (login: POST `/v1/auth/send-otp` {phone,channel:'SMS'}
then `/v1/auth/verify-otp` {phone,otp:'123456',clientId}; operator cross-tenant = POST
`/v1/auth/assume-tenant` {clientId}).

## OPEN THREADS
- **💸 INFRA COST-REDUCTION — IN PROGRESS. Full detail = memory [[infra-cost-reduction]].** Deoleo go-live MAY postpone to post-Sept →
  cut idle cost (~₹17.5k/mo bill). **✅ DONE: both Redis instances DELETED (owner "turn it off then") + terraform/deploy wiring stripped
  (develop `748fd81`, `terraform validate` Success) → ~₹8,500/mo (52%) removed, permanent, zero runtime impact** (Redis was never wired —
  in-memory throttler, no ioredis/cache-manager imports, scaffold leftover). The `REDIS_URL` Secret Manager secret + the prod env var are
  now **DELETED too** (2026-07-22) — Redis is fully gone everywhere. *(History: the secret was briefly RETAINED because the running prod
  revision read it at startup; the Direct-VPC-egress prod redeploy dropped that dependency, so the secret was then deleted.)*
  The VPC connector was likewise removed: earlier in the session I wrongly called it "vestigial" (owner challenged; `gifsy-db` is
  PRIVATE-IP-ONLY `10.49.0.3` and both live services routed to it THROUGH the connector, so a straight delete = full DB outage — the fix
  was to **migrate to Direct VPC egress**, a tested change, not a delete)
  — **Direct-VPC-egress migration: Phase 1 (staging) ✅ + Phase 3 (PROD) ✅ DONE + runtime-verified 2026-07-22 (owner "go ahead").**
  prod `gifsy-api` on Direct VPC egress (canary rev `00026-hap` + `/health/ready` startup probe → ramp 10→50→100%, DB SELECT 1 over
  direct egress 200 throughout, zero errors; connector rev `00024-7sp` @0% = instant rollback). All 7 jobs off the connector; both
  workflows updated (`ef8d697`, flags + startup probe = R2 fix). Manual `services update` cutover, decoupled from feature cutover #12.
  **✅ Phase 4 DONE (2026-07-22, owner option-b — portal not live → no soak): connector `gifsy-connector` DELETED, ~₹1,445/mo saved,
  MIGRATION COMPLETE.** Post-delete verified prod+staging `/health/ready` 200 `{db:up}`, zero errors; terraform connector resource removed
  (`0b8b5f0`, validate Success). Combined session infra savings (Redis+connector) ≈ **₹10k/mo (~57%)**, zero prod impact. Residual cosmetic
  only (stale `00025-xey` canary rev, empty `gifsy-repo`, old connector revs auto-GC'd). Architecture record: `platform/docs/plans/INFRA-ARCHITECTURE.md` (all 3 changes); migration plan: `platform/docs/plans/DIRECT-VPC-EGRESS-MIGRATION.md`; detail [[infra-cost-reduction]].
  **✅ DONE (2026-07-22): Artifact Registry durable cleanup policy LIVE on `gifsy-images`** (independent-audited SAFE, dry-run-verified,
  enabled live; 4 serving images confirmed intact). Was a KEEP-only `keep-last-10` that deleted nothing (repo ~94GB / 699 imgs, all <40d
  = temporary build churn). New policy per owner steering (design for FUTURE steady-state, not current churn): keep-prod-latest (anchors
  current prod via `latest` tag) + keep-recent-30 + delete-untagged>7d + delete-old>30d (self-adapting retention). Untagged=0 disproved the
  multi-arch outage risk. Immediate reclaim small (~62 old imgs); bulk self-reduces as staging ages out + building slows. Policy JSON in
  session scratchpad. Trivial pending: drop empty `gifsy-repo` (0 bytes) after a ref-check. **REMAINING LEVERS (owner decision open):**
  prod Cloud Run min=1→0 + pause prod schedulers (~₹800/mo — note push-drain pings every minute, so staging isn't truly sleeping either);
  stop `gifsy-db`/`gifsy-db-dev` when fully frozen (needs the staging-UAT?/dev-continuing? answers). (Dead `ioredis`/`cache-manager`
  deps ✅ REMOVED from api/package.json 2026-07-22, gate-green.) All prod/staging infra changes owner-gated; gcloud+wrangler authed; terraform in `terraform/`.
- **✅ E2E HARNESS REVIVAL — DONE (test-only, zero prod impact) — `platform/docs/plans/E2E-HARNESS-REVIVAL.md`.**
  Revived + clean-baselined (`4b0d03f`+`f89697c`, 295/0/3, reproducible on a fresh gifsy_dev; runs against a local
  prod build, auto reset+seeds via `e2e/global-setup.ts`). ALL of (A) requestAs (was the run-target, not a bug),
  (B) the stale specs, (C) operator-switch — resolved. **🆕 STAGING run-mode SPIKE DONE (2026-08-01, owner-requested):
  verdict = LEAVE IT for now (evidence-backed).** Ran `E2E_ENV=staging` against the real deoleo staging host (fixed-OTP,
  subdomain) → **5/5 role logins FAILED** at `waitForURL` (even `gifsy`/9830011252 which exists) → staging mode is NOT
  merely "never run", it's **not wired to run**: a single `E2E_BASE_URL` for all role projects vs each tenant on its own
  subdomain (the local per-role `x-forwarded-host` injection is correctly INERT on staging because EDGE_SECRET is set),
  plus the OTP-fetch hook isn't deployed + seed/data drift. Making it runnable is a BUILD (per-tenant baseURL wiring +
  OTP path + seed strategy), not a flip. **📌 TO-DO (owner-tracked, 2026-08-01): build the staging-E2E CI harness as a
  FAST-FOLLOW to onboarding the 2nd tenant — NOT a prerequisite** (the 2nd tenant's own setup is hand-verified once during
  onboarding; the harness guards the ONGOING multi-tenant surface — cross-tenant isolation + subdomain routing, the exact
  seam local `hostHeader` mode stubs). Wire it **NON-blocking first** (a reporting check, never `needs: test` that can hide
  the deploy button). With 1 tenant it's irrelevant; the 2nd tenant flips it to worth-building.
- **§A-DOMAIN — ✅ COMPLETE + LIVE ON PROD** (cutover #11 `e8de31a`, 2026-07-20): DB routing (D-1) + features-from-`/me`
  (P5) + S1 edge-secret enforcing (verified). Nothing left except the owner's real-OTP prod smoke.
- **Owner-gated Deoleo go-live: ✅ ALL CLEARED** (master data #76 loaded, both KYC WhatsApp templates
  verified on staging, two reward catalog items fixed+active). Only remaining owner step = the **live
  end-to-end prod smoke** (above).
- **Blocked on an owner DECISION:** Notifications-Core go/no-go — the queue drainer is **PUSH-only**, so
  enqueued SMS/EMAIL/WhatsApp never deliver (genuinely dead: credit-batch EMAIL, KYC owner SMS for
  UNDER_REVIEW, redemption-fulfilment SMS). Recipients recorded (nikunj.sadani@ / payel.ghosh@ /
  nikita@gifsy.in). + **email provider** ZeptoMail (~$0.25/1k) vs SES (~$0.10/1k).
- **§A-DOMAIN** — P1/P2/P4/P4b IN PROD (cutover #10); P3 worker DEPLOYED (`eb56c29b`, live); branding-backfill
  live in prod DB. **D-1 ✅ + P5 ✅ DONE on develop (`9872806`/`c4d1cf9`, audited GO, staging-verified)** — the DB
  is now the full runtime source-of-truth (features/RBAC/capture-mode read `clients`; FE features from authenticated
  /me; registry reduced to fallback). **P6 ✅ DONE on develop + staging: proxy/worker unit tests + favicon-from-DB-branding
  (runtime-verified) + 2nd-tenant DB-routing E2E all SHIPPED; S1 edge-secret ENFORCING on staging (owner added the
  `EDGE_SECRET` GitHub secret; redeploy `8f817b9` → runtime-verified: legit edge login 200+deoleo, a forged direct-`.run.app`
  `x-forwarded-host: clientb` → 404+`default` = forge rejected). Prod enforces automatically at cutover #11.** All develop
  work awaits **cutover #11** (owner-gated). **2ND-TENANT list (LOW,
  before client #2): admin features-loading gate · MIS_USER feature fallback · Option-C multi-outlet.**
  See IMMEDIATE NEXT. **Data-hygiene ✅ DONE `b1ece3b`: committed `public/favicons/{deoleo,clientb}.ico` (byte-identical
  copies of the canonical `/icons/<slug>/favicon.ico`) so the stored `branding.faviconUrl=/favicons/<slug>.ico` now resolves
  (no DB write). The layout still emits the canonical `/icons/<slug>/` path via the helper — the copies just make the stored value valid.**
- **#74 residual:** optional secret rotation + real prod MSG91 (monitoring + backups/PITR already ON).
- **POST-GO-LIVE-BACKLOG (later):** multi-tenant SSR branding, configurable RBAC (AF-12 kept OFF),
  WhatsApp per-tenant generalization, OTel O3, DB-RLS, invoice-PDF/email, TDS filing, DPDP, analytics.

## READ FIRST
`GO-LIVE-ISSUE-LIST.md` (⭐ master tracker) · memories **[[deoleo-go-live-bundle]]** (FIRST for any
launch/UAT/staging/cutover work — holds the full NEWEST chronology) · [[employee-rewards-product]] ·
[[admin-dashboard-consolidation]] [[global-settings-wiring]] [[sales-hierarchy-scoping]]
[[migration-model]] [[staging-deploy-gate]] [[audit-every-build-item]]. Full cutover as-run record =
`runbooks/PROD-CUTOVER-RECORD.md`; runbook = `runbooks/CUTOVER-RUNBOOK.md`.

## CUTOVER LEDGER (compact — detail in [[deoleo-go-live-bundle]])
> **✅ CUTOVER #22 DONE + VERIFIED (2026-07-31) — prod = main = origin/develop = `fb996d8` (develop NOT ahead).** 5-part payload, ALL additive + DORMANT: (1) **reactivate pending-outlet leak fix** — `admin-outlets.service.reactivate` now requires `deactivatedAt: { not: null }` so a KYC-pending outlet can't be flipped active to bypass KYC · (2) **enrollment Excel report rebuild** — Outlet Name fallback to `prefillValues` aliases + media cells are REAL hyperlinks to a NEW PUBLIC tokenized `GET /v1/schemes/media/view?token=<jwt>` (`typ:'schememedia'` HS256, mirrors KYC docview, cross-tenant-guarded, bare-404) that opens from a downloaded file + columns de-duped by `prefillKey`/`outletField` (supersedes the #21 `e0c254d` note) · (3) **PARKED remove-from-KYC-queue outlet state** — new additive `OutletKycIntent` value `PARKED` (distinct from rep-driven `NOT_INTERESTED`); admin bulk `POST /v1/admin/outlets/park` + `/unpark` (GIFSY/CLIENT_ADMIN + `partners:manage_outlets`, max 500) + "Parked / Removed" admin tab; FULLY hidden from reps (sales buildOutlets/rollups/getMember + scheme reach + admin dashboards + visibility universes); KYC approval UN-PARKS (shared activation `updateMany` clears `kycIntent`); `park` idempotent + scoped to true-pending `isActive:false, deactivatedAt:null` · (4) **grouped-child GST-cert/cheque doc carry-forward** — a FIRST-KYC grouped child keeping the group's UNCHANGED GST/bank inherits the APPROVED source's cert/cheque (source = `resolveGroupIdentity.sourcePartnerId` + new `resolveGroupCarryForwardDocs`); backend-authoritative pre-tx resolve+validate+attach-from-stash + a divergence-reject safety net; PAN-present required; FE first-KYC-only gate relax + "Inherited from group (approved)" note · (5) **"Activations / Tasks" label rename** (sales dashboard card + Tasks page + enrollment-sheet header). **CARRIES migration `20260731170000_outlet_kyc_intent_parked`** (`ALTER TYPE "OutletKycIntent" ADD VALUE 'PARKED'`, additive) — **APPLIED to BOTH staging + prod** (guarded reads: enum `["NOT_INTERESTED","PARKED"]`, recorded/not-rolled-back). **Gate: api jest 2163 · nest 0 · FE vitest 2066 · tsc 0.** Dual-audited (parts 3+4). Prod-verified: both services `fb996d8`, `/health/ready` db:up, `/v1/admin/outlets/park` + `/unpark` 401-wired, public `/v1/schemes/media/view` bad-token 404 (fail-closed), `deoleoloyalty.gifsy.in/auth/login` 200 + send-otp 200. Rollback ref `a83b2f4` (#21). *(See ledger row #22 + ▶▶ START HERE.)*
>
> **✅ CUTOVER #21 DONE + VERIFIED (2026-07-31) — prod = main = origin/develop = `a83b2f4` (superseded in prod by #22).** 16 commits `8c08af3..a83b2f4`, ALL additive + DORMANT. 6-part payload: **Batch 1** scheme UAT fixes (whole-downline reach, camera-only live capture, roster view/Download .xlsx, DATA_DISPLAY dropdown) · **Batch 2** edit/delete a filled enrollment (admin edit→new version · per-scheme `allowEnrollerEdit` · soft-delete→re-enrollable + GIFSY-only deleted-list/restore · consent carry-forward reuses the ORIGINAL verified phone · SALES self-edit DISABLED, server-enforced) — CARRIES migration `20260730160000_scheme_enrollment_soft_delete` (`SchemeEnrollment.deletedAt` + idx), **APPLIED to prod** (guarded read `done:true`/`rolled:false`; col + idx present) · scheme sales-list scoping (`7817de6`) · enrollment Excel-report rebuild (`e0c254d`) · **child-KYC group-identity prefill** (`6409003`+`afb4a2f`; parent-or-approved-SIBLING, approved = KYC APPROVED not `onboardedAt`; PAN locked, photos/address per-store) · **Identity & Payout Uniqueness Settings toggle** (`a83b2f4`; per-tenant `uniquenessPolicy`, PAN/GST always-on, phone/bank/upi editable, GIFSY-only). **Gate: api build 0 · jest 2124 · FE tsc 0 · vitest 2052.** Dual-audited CLEAN. Prod-verified: both services `a83b2f4`, `/health/ready` db:up, `/v1/schemes` + `/v1/schemes/:id/enrollments/deleted` + `/v1/admin/settings` all 401-wired, `deoleoloyalty.gifsy.in/auth/login` 200. **⚠️ OPEN owner item:** post-#21 real-phone smoke. *(Bank/UPI prod uniqueness flip ✅ DONE 2026-07-31 — deoleo now all-on, guarded-read verified.)* Rollback ref `8c08af3` (#20). *(See ledger row #21 + ▶▶ START HERE.)*
>
> **✅ CUTOVER #20 DONE + VERIFIED (2026-07-30) — `8c08af3` (superseded in prod by #21).** SCHEME UX-HARDENING (dual-source prefill `FormField.outletField` + H1–H6 + must-fixes: DATA_DISPLAY dataDisplayKey, activation gate, immutable REJECTED reject-audit trail, approved-owner phone pre-pin, GPS-accuracy cap, dropped per-field audience, prefill-sources/facet-values endpoints, report/notify scoping-unify, export TOGGLE→Yes/No + media URL, broadcast preview) + the **PARENT ID outlet-master DOWNLOAD** export fix (`reports.service.outletMaster`, 57 cols, round-trips upload). **CODE-ONLY — no migration.** FF merge develop→main (5 commits), owner-approved gate. Dual-audited (BE + FE) + staging-verified 21/21. **Additive + DORMANT** — Deoleo live path byte-identical until a Gifsy admin uses the new scheme features. Rollback ref `daa4f3f` (#19). *(See ledger row #20.)*
>
> **✅ CUTOVER #19 DONE + VERIFIED (2026-07-30) — prod = main = `daa4f3f`.** SCHEME ROSTER-UPLOAD EXCEL REPORT (Download-report button on the roster upload result → Summary + per-row disposition + Duplicates + Unmatched-Employees sheets; skipped-rows accounting; xlsx-safe). **CODE-ONLY — no migration.** FF merge develop→main (4 commits), owner-approved gate. Audited GO (2 polish fixed) + staging-runtime-verified (synthetic dup/unmatched/no-id roster, cleaned up). Prod-verified: both services `daa4f3f`, `/health/ready` db:up, `/v1/schemes` 401-wired, deoleo branded login 200. GIFSY-admin-only, additive. Rollback ref `f193127`. *(See ledger row #19.)*
>
> **✅ CUTOVER #18 (2026-07-30) — `f193127`.** SCHEME PREFILL EDITABLE/LOCKED (backend-enforced Excel-variable prefill; per-field Editable/Locked; locked value fields server-pinned to the roster value + locked PHONE_OTP OTPs the Excel number). **CODE-ONLY — no migration.** FF merge develop→main (7 commits), owner-approved gate. Dual-audited (4 findings fixed) + staging-runtime-verified end-to-end (synthetic LOCKPROOF scheme, cleaned up). Prod-verified: both services `f193127`, `/health/ready` db:up, `/v1/schemes` 401-wired, deoleo + branded login 200, send-otp 200. **Additive + DORMANT** — Deoleo path byte-identical until a Gifsy admin builds a scheme with a locked field. Rollback ref `52fc19f`. *(See ledger row #18 + `SCHEME-DATA-COLLECTION-DESIGN.md` §16.)*
>
> **✅ CUTOVER #17 (2026-07-29) — `52fc19f`.** Shipped together: the VISIBILITY-LED-PAYOUTS/194C-TDS feature (`500eaf9`, +2 additive migrations), the GIFSY assume-tenant scoping fix (`706efd1`+`12045db`), the PARTNER→MULTI-OUTLET admin grouping FE (`ab61b63`, no migration), POSM post-cutover infra (`0615af2`), + TDS-DD docs. **Verified:** both services serve `52fc19f`, `/health/ready` db:up, both migrations `done:true`/`rolled:false`, 3 TDS tables + 4 CreditPayoutEntry frozen-stamp cols + per-tenant composite-unique indexes + `payoutStream` backfill (Deoleo→INCENTIVE = engine no-op) + `Outlet.parentId` all present, Deoleo login 200, `/v1/admin/parents` + `/v1/admin/tds/config` 401-wired, branded login 200. **All additive + DORMANT** — Deoleo live path byte-identical (INCENTIVE→194R, TDS engine never fires); grouping dormant until an admin creates a parent; assume-tenant scoping active. Rollback ref `4ebf12c`.

| # | prod SHA | payload |
|---|---|---|
| 1 | `2fa020c` | first prod (213 commits + 8 migrations) + bootstrap (first GIFSY_ADMIN + 4 OutletTypes) + PWA live |
| 2 | `a2f5929` | onboard-slug fix + per-tenant points-expiry + admin pagination; Deoleo tenant created |
| 3 | `9d366f9`→`eb841e9` | field-level re-KYC batch + hierarchy phone-orphan fix + Deoleo login logo + `/brand/*` matcher fix |
| 4 | `824eac0` | rewards FREE_AMOUNT blank-max fix + Credits/Payouts Config card |
| 5 | `5c2bb65` | sales-KYC UAT (per-doc tag, re-KYC amber badges, approval stepper + reviewer label) |
| 6 | `c36f6c8` | per-tenant per-purpose OTP templates + re-KYC wizard skip + 24h assume TTL |
| 7 | `98ced7a` | targets-404, `isPrimary` blank-outlet sweep, push click-URLs, KYC-SLA wiring, `deoleo_points_credit`/`payout_credit` money WhatsApps + audit fixes |
| 8 | `4b33e4c` | presence-based partner wallet, sales+partner ledger field-name (shared resolver), pre-OTP copy |
| 9 | `ebd474b` | payout UTR "Apply" query-vs-body fix |
| 10 | `437045a` | (2026-07-19) — wallet-surfacing (credit payouts in partner wallet) + §A-DOMAIN P1/P2/P4/P4b + `client_domains` migration; verified live |
| 11 | `e8de31a` | (2026-07-20) — §A-DOMAIN COMPLETE: sales-ledger payout unification + D-1 (resolveClient→clients) + P5 (registry-code retire, features from /me) + P6 (S1 edge-secret NOW ENFORCING on prod + proxy/worker tests + favicon-from-DB-branding + 2nd-tenant E2E + 2 finding-fixes `58ce1ab`). 24 commits, CODE-ONLY (no migrations); verified live. Backup `1784547142461` |
| 12 | `d028566` | (2026-07-22) — per-outlet PAYOUT MANDATE (`Outlet.requiredPaymentType`, live no-flag) + KYC address-proof WAIVER + infra-workflow (Direct-VPC-egress + `/health/ready` startup probe + `REDIS_URL` removal). 33 commits, **2 additive migrations** (`..._add_outlet_required_payment_type`, `..._add_kyc_address_name_mismatch`) verified applied; both services `/health/ready` 200. Rollback ref `e8de31a` |
| 22 | `fb996d8` | **CURRENT PROD** (2026-07-31) — **REACTIVATE-LEAK FIX + ENROLLMENT EXCEL REPORT REBUILD + PARKED REMOVE-FROM-KYC-QUEUE + GROUPED-CHILD DOC CARRY-FORWARD + "ACTIVATIONS / TASKS" RENAME.** 5-part payload, ALL additive + DORMANT. (1) **Reactivate pending-outlet leak fix** — `admin-outlets.service.reactivate` now requires `deactivatedAt: { not: null }`, so a KYC-pending outlet (deactivatedAt null) can no longer be flipped active to bypass KYC approval (staging-verified: pending outlet → 400 "No deactivated outlets found"). (2) **Enrollment Excel report rebuild** — Outlet Name fallback to `prefillValues` name-aliases; media cells are REAL Excel hyperlinks to a NEW PUBLIC tokenized endpoint `GET /v1/schemes/media/view?token=<jwt>` (`typ:'schememedia'` HS256 JWT, mirrors the KYC docview pattern; resolves the object key server-side from the tenant-verified enrollment, cross-tenant-guarded, safe-mime, bare-404) that opens from a downloaded file; columns de-duplicated by field `prefillKey`/`outletField`. `scheme-report.service.exportEnrollments`; `common/xlsx.ts` gained hyperlink-cell support. Supersedes the #21 `e0c254d` report note. (3) **PARKED "remove from KYC queue" outlet state** — new additive `OutletKycIntent` value `PARKED` (distinct from rep-driven `NOT_INTERESTED`); admin bulk `POST /v1/admin/outlets/park` + `/unpark` (GIFSY/CLIENT_ADMIN + `partners:manage_outlets`, `OutletCodesDto` max 500) + a "Parked / Removed" tab on Admin→Outlets; PARKED is FULLY hidden from reps (null-safe excluded from `sales.service` buildOutlets/buildTeamRollups/getMember, the scheme enrollment reach `scheme-enrollment.service` getSalesTargets + list, AND the admin coverage/health/ops dashboards + visibility universes); admin sees a distinct "Parked" status/bucket (`deriveKycStatus`→'PARKED', `buildKycStatusWhere`); KYC approval UN-PARKS (both `approve` + `bulkVerify` share one activation `updateMany` which now clears `kycIntent/By/At`); `park` is idempotent + scoped to `isActive:false, deactivatedAt:null` (true pending only). Owner chose "fully hidden from reps" + "new distinct state" (not reuse NOT_INTERESTED). Staging-verified (park→PARKED bucket→unpark→restored). (4) **Grouped-child GST-cert/cheque doc carry-forward** — a FIRST-KYC grouped child (`outlet.parentId` set, no partnerId) keeping the group's UNCHANGED GST/bank inherits the APPROVED group source's GST certificate / cancelled cheque instead of re-uploading; source = `resolveGroupIdentity(...).sourcePartnerId` (approved parent ELSE most-recently-approved sibling — SAME source as the identity prefill) + new `resolveGroupCarryForwardDocs` (partner-group.helper); backend-authoritative (resolved+validated PRE-transaction, attached from a stash — single resolve so validation & attach can't diverge) + a narrowed safety-net that REJECTS before any write a child keeping a GST/bank the group has an inheritable doc for but diverged so nothing attaches (closes the FE-waive/backend-attach scope gap + a stale-prefill TOCTOU); requires the child to assert a PAN (group golden key); FE (`sales/kyc/new`) relaxes the GST-cert/cheque required-gate ONLY for a first-KYC child with unchanged values (`isFreshKyc = !existingKyc`, mirroring backend `!partnerId`) + an "Inherited from group (approved)" note. Dual-audited: security CLEAN + correctness HIGH (re-KYC scope mismatch) / MED (TOCTOU) / LOW (PAN) all FIXED. (5) **"Activations / Tasks" label rename** — the sales "Scheme/Activation Enrollment" label → "Activations / Tasks" (dashboard card, Tasks page, enrollment-sheet header). FF merge develop→main, owner-approved gate. **CARRIES migration `20260731170000_outlet_kyc_intent_parked`** (`ALTER TYPE "OutletKycIntent" ADD VALUE 'PARKED'`, additive) — **APPLIED to BOTH gifsy_staging + gifsy_prod** (guarded reads: enum `["NOT_INTERESTED","PARKED"]`, recorded/not-rolled-back on prod). **Gate green: api jest 2163 · nest 0 · FE vitest 2066 · tsc 0.** Prod-verified: both services `fb996d8`, `/health/ready` db:up, `/v1/admin/outlets/park` + `/unpark` 401-wired, public `/v1/schemes/media/view` bad-token 404 (fail-closed), `deoleoloyalty.gifsy.in/auth/login` 200 + send-otp 200. **All 5 parts additive + DORMANT** — Deoleo live path unaffected until an admin parks an outlet or a grouped child inherits a doc. **OPEN owner item: post-#22 real-phone smoke.** Rollback ref `a83b2f4` |
| 21 | `a83b2f4` | (2026-07-31, superseded in prod by #22) — **SCHEME UAT BATCHES + CHILD-KYC GROUP-IDENTITY PREFILL + IDENTITY/PAYOUT UNIQUENESS TOGGLE.** 16 commits `8c08af3..a83b2f4`, ALL additive + DORMANT. **Batch 1** scheme UAT fixes (`86c1a99`,`2ae2c6b`,`21bcfdc`,`c510cc0`,`1eb6038` — whole-downline SALES enroll/OTP reach · camera-only live capture (getUserMedia, no gallery) · roster Outlet ID/Name in prefill · persistent roster view + Download roster .xlsx · Data-Display "Excel column" → dropdown; code-only). **Batch 2** edit/delete a filled enrollment (`c807291`,`369df10` — admin edit→NEW version · enroller edit gated on per-scheme `audienceConfig.allowEnrollerEdit`, SALES self-edit DISABLED server-enforced · soft-delete `SchemeEnrollment.deletedAt` + reset-on-reenroll · persistent "Show deleted" restore + GIFSY-only `GET :id/enrollments/deleted` · **consent carry-forward** — `submit()` `consentedEditFrom` reuses the ORIGINAL OTP-verified phone, never a fresh OTP, fail-closed; dual-audited + 3rd-pass re-audit CLEAN, all 15 read/report/export sites filter `deletedAt`; staging-runtime-verified pre-cutover). **CARRIES migration `20260730160000_scheme_enrollment_soft_delete`** (additive nullable `deletedAt` + `scheme_enrollments_deletedAt_idx`) — **APPLIED to prod** (guarded read `done:true`/`rolled:false`, col + idx present; already on gifsy_staging). Plus **scheme sales-list scoping** (`7817de6` — a rep sees only schemes their reach has ≥1 target for; no-audience scheme visible to all), **enrollment Excel report rebuild** (`e0c254d` — all uploaded columns, Outlet Name fallback, Submitted-By employeeCode, absolute media links, legend sheet; `scheme-report.service.exportEnrollments`), **child-KYC group-identity prefill** (`6409003`+`afb4a2f` — parent-or-approved-SIBLING shared owner identity, PAN locked to group PAN, photos/address/GPS per-store never inherited; audit HIGH fix: approved-child = sibling KYC `status='APPROVED'` NOT `onboardedAt`), and the **Identity & Payout Uniqueness Settings toggle** (`a83b2f4` — per-tenant `uniquenessPolicy` card, PAN/GST always-on+locked, Mobile/Bank/UPI editable, GIFSY-only). FF merge develop→main (16 commits), owner-approved gate. **Gate green: api build 0 · jest 2124 · FE tsc 0 · vitest 2052.** Dual-audited CLEAN. Prod-verified: both services `a83b2f4`, `/health/ready` db:up, `/v1/schemes` + `/v1/schemes/:id/enrollments/deleted` + `/v1/admin/settings` all 401-wired, `deoleoloyalty.gifsy.in/auth/login` 200. **Additive + DORMANT** — Deoleo live path byte-identical until used. **OPEN owner item: post-#21 real-phone smoke. Bank/UPI prod uniqueness policy ✅ FLIPPED ON for deoleo 2026-07-31 (guarded read verified `{gst,phone,bank,upi all true}`); staging also all-on.** Rollback ref `8c08af3` |
| 20 | `8c08af3` | (2026-07-30) — **SCHEME UX-HARDENING + PARENT-ID OUTLET-MASTER EXPORT.** Scheme UX-hardening: dual-source prefill (`FormField.outletField` resolves from a matched loyalty outlet's DB record, else `prefillKey` Excel column; server-authoritative pin, outlet-field WINS) + H1–H6 (Excel-col/Outlet-field prefill DROPDOWN · DATA_DISPLAY `dataDisplayKey` no longer stripped · activation requires audience + non-empty PERSISTED form · gate-save · admin drawer nested outlet/geo reads + id→label map · signature-canvas scaling) + must-fixes (immutable REJECTED `SchemeSubmission` reject-trail · approved-owner phone pre-pin · GPS-accuracy cap D15 · removed `FormField.audience` · report/notify `platformWide` scoping-unify · export TOGGLE→Yes/No + app-proxy media URL). New reads `GET :id/prefill-sources` + `:id/facet-values` + `:id/broadcast/preview`. **Plus the PARENT ID outlet-master DOWNLOAD export fix** (backend `reports.service.outletMaster`, 57 cols, emits parent ChannelPartner `partnerCode`, round-trips the upload's Parent ID). FF merge develop→main (5 commits: `c43304e` W0 backend · `0da1859` W0 audit-fixes + FE contract · `ed4a577` Parent ID export · `16358a7` W1 FE · `273a4b2` W1 FE audit-fixes). **CODE-ONLY — no migration.** Gate green (api jest 2104 · nest 0 · FE tsc 0 · vitest 2049). **Dual adversarial audit** (BE tenant-isolation/consent/prefill CLEAN + 4 lower-sev; FE no HIGH + 2 fixes) + **staging runtime-verified 21/21** (synthetic MIXED matched+standalone roster, then soft-deleted; dual-source PIN proven: rep sent f_owner="HACKED-BY-REP" → server stored the DB owner name). Prod-verified: both services `8c08af3`, `/health/ready` db:up, `/v1/schemes/:id/prefill-sources` + `/facet-values` + `/broadcast/preview` + outlet-master export (with Parent ID) all 401-wired, `deoleoloyalty.gifsy.in/auth/login` 200. **Additive + DORMANT** — Deoleo live path byte-identical until a Gifsy admin uses the new scheme features. REMAINING = owner ~5–10 min real-phone smoke (signature canvas, camera/geo, dual-source locked prefill on a live enroll). Rollback ref `daa4f3f` |
| 19 | `daa4f3f` | (2026-07-30) — **SCHEME ROSTER-UPLOAD EXCEL REPORT.** A "Download report" button on the roster upload result → `.xlsx` with Summary (totals + Data-rows-read + skipped-rows), **Rows** (per input row: rowIndex, Outlet ID/Name, Tagged Employee, Saved vs Duplicate-dropped, Matched vs Standalone, Employee-found), Duplicates (all ids, untruncated), Unmatched Employees. Backend `matchRosterRows` emits per-row disposition + `parseRosterUploadBuffer` returns `skippedRows`; FE report via `xlsx-safe` (cellSafe). FF merge develop→main (4 commits: `72545b9` Phase-1 summary + `fee70b2` Phase-2 per-row + `daa4f3f` audit-polish + #18 resume doc). **CODE-ONLY — no migration.** Independent audit GO (2 polish fixed) + **staging runtime-verified** (synthetic dup+unmatched+no-id roster: totalRows 3/upserted 2/dup [RPT-A1]/unmatched [NOSUCH-EMP]/skipped 1/per-row dispositions correct; cleaned up). Prod-verified: both services `daa4f3f`, `/health/ready` db:up, `/v1/schemes` 401-wired, deoleo branded login 200. GIFSY-admin-only, additive. Rollback ref `f193127` |
| 18 | `f193127` | (2026-07-30) — **SCHEME PREFILL EDITABLE/LOCKED** (backend-enforced Excel-variable prefill on the scheme enrollment form: per-field `prefillKey` + Editable/Locked; Locked value fields server-pinned to the roster value on submit [client value discarded], locked PHONE_OTP OTPs the Excel number for standalone rows [rep can't substitute] while KYC-approved-matched keeps the on-file number; `pickBoundPrefill` ships only form-bound columns to the enroller; dead `autoFill*` pair removed). FF merge develop→main (7 commits: `0cbf43d` feat + `6f4358f` audit-fixes + doc sweeps), owner-approved gate. **CODE-ONLY — no migration, no schema change** (uses existing `locked`/`prefillKey`/`prefillValues`). Built 3-parallel-streams + integration → gate green → **dual adversarial audit** (consent/OTP + correctness) → 4 findings fixed (HIGH blank-cell brick, MED-1 column-leak, MED-2 locked-phone-consent, LOW-3 MULTI_SELECT/TOGGLE shape) + unit tests → **STAGING RUNTIME-VERIFIED end-to-end** (synthetic LOCKPROOF scheme: PAN dropped, MED-2 rejected, HACKED→Gold pin, phone OTP'd roster 9812300011 despite rep typing 9999999999, blank→editable; synthetic data deleted). Prod-verified: both services `f193127`, `/health/ready` db:up, `/v1/schemes` 401-wired, deoleo login 200 + branded login 200, send-otp 200. **Additive + DORMANT** — Deoleo path byte-identical until a Gifsy admin builds a scheme with a locked field. REMAINING = owner UAT. Design `SCHEME-DATA-COLLECTION-DESIGN.md` §16; memory [[scheme-data-collection]]. Rollback ref `52fc19f` |
| 17 | `52fc19f` | (2026-07-29) — **VISIBILITY-LED-PAYOUTS / 194C-TDS + assume-tenant scoping + PARTNER→MULTI-OUTLET admin grouping FE + POSM infra.** FF merge develop→main (12 commits), owner-approved gate. **2 additive migrations** `20260728120000_visibility_payout_tds_foundation` + `20260728130000_credit_code_per_tenant_unique` (prod pre-check: clean target — no dup codes, tables absent). Verified: both services `52fc19f`, `/health/ready` db:up, both migrations `done:true`/`rolled:false`, 3 TDS tables + 4 CreditPayoutEntry frozen-stamp cols + per-tenant composite-unique idx + `payoutStream` backfill (Deoleo→INCENTIVE) + `Outlet.parentId` present, Deoleo login 200, `/v1/admin/parents` + `/v1/admin/tds/config` 401-wired, branded login 200. **All additive + DORMANT** (Deoleo live path byte-identical INCENTIVE→194R; grouping dormant till an admin sets a parentId; assume-tenant scoping active). REMAINING = owner UAT of the TDS payout write-path + the `/admin/users/parents` grouping UI in prod (both dormant until configured/used). Rollback ref `4ebf12c` |
| 16 | `4ebf12c` | (2026-07-28) — **VISIBILITY (POSM) LIVE** (dead partner-photo scaffolding rebuilt on the Scheme instrument as a recurring, per-window, sales-captured, geo-fenced, Gifsy-approved proof of point-of-sale material; reward-free; kept Excel AMOUNT_UPLOAD as alt mode). FF merge develop→main, owner-approved gate. **1 destructive-but-guarded migration** `20260727120000_visibility_posm_rebuild` (drops 4 dead photo tables + re-columns image_hashes; abort-guard asserts 0 legacy rows — prod pre-check found 0, no cleanup). Verified: both services `4ebf12c`, `/health/ready` db:up, migration applied+not-rolled-back, 5 new tables + 4 legacy dropped + image_hashes re-columned, `/v1/visibility` 401-wired, Deoleo login 200, 0 captures/forms → **DORMANT** (no prod `visibilityConfig`). Full write state-machine + all 6 junk-GPS geo-fence vectors proven live on staging (synthetic, cleaned). **Post-cutover infra DONE:** `VISIBILITY_REMINDER_SECRET`(+_STAGING) bound+durable + weekly Cloud Scheduler `visibility-reminder-prod`/`-staging` (Mon 09:00 IST, secret-gated — verified) + `visibility-media/` GCS lifecycle 120d→ARCHIVE/2555d→Delete (terraform synced). REMAINING = owner sets `visibilityConfig` for a tenant + UATs in prod. Rollback ref `bda9bf3` |
| 15 | `bda9bf3` | (2026-07-27) — **SCHEME DATA-COLLECTION LIVE** (dormant "scheme" feature rebuilt as a Gifsy-admin data-collection instrument: roster model, immutable versioned submissions, full form-builder incl camera/geo/phone-OTP, audience filter-or-Excel, GIFSY-only create + tenant read-only reports; NO reward engine). 3 commits (`29e44f0` build + `bda9bf3` docs FF), **1 destructive-but-guarded migration** `20260725120000_scheme_data_collection` (roster remodel: `scheme_enrollments` re-anchored partnerId→schemeOutletId + 4 new tables + `OtpPurpose ADD VALUE`). Prod pre-check `scheme_enrollments`=0 → abort-guard cleared. **Additive + DORMANT** (no prod schemes until a Gifsy admin creates one). Verified live: both services `bda9bf3` @100%, `/health/ready` db:up, migration `done:true` + all schema objects, `KYC_CLEANUP_SECRET` bound (#14 self-heal CLEARED), deoleo login 200, `/v1/schemes` 401-wired. REMAINING = owner UAT + ~10-min real-phone smoke. Rollback ref `eca351e` |
| 14 | `eca351e` | (2026-07-24) — **PARTNER→MULTI-OUTLET Waves 1–4 COMPLETE** (uniqueness engine + parent entity + admin grouping + re-KYC stage-at-approval + login picker + group overview + child-KYC pre-fill/badge + scheme re-key + order-bound OTP + group-leave-via-re-KYC + Phase-2 roll-ups + scheme-catalog fix). 9 commits, **4 additive migrations** all verified applied + every DB object confirmed. Pre-cutover: guarded prod cleanup of 4 smoke-test partners (2 dup-PAN pairs) that would have failed the PAN index. Additive+opt-in → DORMANT until an admin sets a parentId. Verified live (SHA, `/health/ready`, Deoleo login 200). ⚠️ post-cutover TODO: `KYC_CLEANUP_SECRET` + Cloud Scheduler. Rollback ref `2187498` |
| 13 | `2187498` | (2026-07-22) — waiver SEMANTICS-FIX (drops ONLY the self-declaration; Address Proof stays required) + prod deoleo `clients.features.kycAddressProofWaiver=true` SET (guarded write, keycount 10→11, rbac untouched). 1 commit, CODE-ONLY (no migrations); verified live (SHA, /health/ready). Waiver now LIVE for Deoleo. Rollback ref `d028566` |

## START THE SESSION
Greet. State current status, then present the open pickups and ask which to take (do NOT hard-lead one — the next move is
the owner's choice among the leftovers below).

**✅ CUTOVER #22 LIVE + VERIFIED (2026-07-31) — prod = main = origin/develop = `fb996d8` (develop is NOT ahead of prod)** (always verify via `git log`, don't trust a hardcoded SHA). Shipped (5-part payload, ALL additive + DORMANT): **(1)** reactivate pending-outlet leak fix (`reactivate` requires `deactivatedAt != null`) · **(2)** enrollment Excel report rebuild (public tokenized `/v1/schemes/media/view` media hyperlinks + Outlet Name fallback + de-duped columns) · **(3)** PARKED "remove from KYC queue" outlet state (new `OutletKycIntent` value, admin bulk park/unpark, fully hidden from reps, KYC approval un-parks) · **(4)** grouped-child GST-cert/cheque doc carry-forward · **(5)** "Activations / Tasks" label rename. Gate: api jest 2163 · nest 0 · FE vitest 2066 · tsc 0. Carries the applied-to-prod additive `20260731170000_outlet_kyc_intent_parked` enum migration. There is NO pending build — develop == main. Recent cutovers: **#22** reactivate-leak/report-rebuild/PARKED/doc-carry-forward/rename · **#21** scheme UAT batches + child-KYC prefill + uniqueness toggle · **#20** scheme UX-hardening + Parent-ID export · **#19** scheme roster-upload Excel report · **#18** scheme prefill Editable/Locked · **#17** TDS/194C + assume-tenant scoping + partner-grouping FE. All additive + DORMANT. **OPEN owner items (their choice among the leftovers): post-#22 real-phone smoke · UAT of the older dormant surfaces (TDS payout write-path, grouping UI, visibility POSM, scheme).** *(Bank/UPI prod uniqueness flip ✅ DONE 2026-07-31 — deoleo all-on, verified.)*

## ▶▶ START HERE (post-compact) — develop is AHEAD of prod: roster-remove built + staging-verified, awaiting cutover
**prod = main = `fb996d8` (cutover #22 LIVE, 2026-07-31). develop = `378f795` — AHEAD of prod by ONE feature.** Verify HEADs via `git log`.
- **🆕 ON develop/staging, NOT yet prod: SCHEME ROSTER-ROW REMOVE (SchemeOutlet soft-delete).** A GIFSY admin can Remove roster rows (per-row + bulk, with a hidden-enrollment warning) and Restore them from a "Show removed" panel; a removed row vanishes from every read; **"removed stays removed"** until an admin restores it or re-uploads a file naming it (no rep/lazy-enroll or filter-resave side-effect resurrect). Built + **triple adversarial-audited** (leak-hunt + correctness + fix-diff; 1 HIGH + 1 MED + 3 LOW all fixed) + **staging runtime-verified 16/16**. Gate: api jest 2174/0 · nest 0 · FE tsc 0 · vitest 2066. **Carries additive migration `20260801120000_scheme_outlet_soft_delete`** (deletedAt nullable + idx) — **applied to gifsy_staging (guarded, verified); NOT on prod (applies at cutover via deploy.yml)**. Additive + DORMANT. Design + as-built = `SCHEME-ROSTER-ROW-REMOVE-PLAN.md`. **▶ NEXT = owner-gated prod cutover #23** (FF-merge develop→main + approve the GitHub gate → CI applies the migration then deploys). Also carries the targets test date-rot fix (test-only) + bank/UPI caveat-closure doc.
- Everything from cutover #22 (5-part payload — reactivate leak fix, enrollment Excel report rebuild w/ public tokenized `/v1/schemes/media/view`, PARKED remove-from-KYC-queue + enum migration, grouped-child doc carry-forward, "Activations / Tasks" rename) is additive + DORMANT and **live in prod**. Full payload = **🟢 CURRENT STATE** at the top of this file.

**The next move is the OWNER'S CHOICE — no build is queued.** Present these OPEN items and let the owner pick (do NOT hard-lead one):
- **Post-#22 real-phone smoke** — the one device path not verifiable without a handset: camera-only live capture (getUserMedia), geo, signature canvas, and a live scheme enroll on a real phone. ~5–10 min.
- **Bank/UPI prod uniqueness-policy flip — ✅ DONE + CAVEAT CLOSED (2026-07-31 flip; 2026-08-01 sweep).** The owner turned deoleo's `uniquenessPolicy` to `{gst,phone,bank,upi all true}` via the new Identity & Payout Uniqueness toggle; guarded prod read verified. Cross-owner bank/UPI sharing is now rejected at KYC submit (same-group siblings still share; PAN/GST always-on regardless). ✅ **The "no-DB-index → pre-existing dup surfaces at next re-KYC" caveat is CLOSED for deoleo:** guarded prod read (`gifsy_prod`, 2026-08-01) — deoleo has **0 ACTIVE partners** (3 total, all soft-deleted #14 smoke-test rows) and **0 cross-group bank/UPI dups**. Clean slate → every partner onboarded from now is enforced at submit; nothing pre-existing can slip through. ⚠️ Same caveat STILL applies to any FUTURE tenant that already has partners: sweep cross-group bank/UPI dups (the `channel_partners` COALESCE(groupId,id) group-key sweep) BEFORE flipping its policy. (Staging was flipped first — dup-sweep found 2 test-data bank dups, 0 UPI.)
- **UAT of the older dormant surfaces (no rush; nothing blocks Deoleo):** TDS payout write-path (#17) · the `/admin/users/parents` grouping UI (#17) · VISIBILITY POSM `visibilityConfig` (#16) · the SCHEME instrument + UX-hardening (#15/#18/#19/#20/#21/#22) · the PARKED remove-from-KYC-queue admin action + grouped-child doc carry-forward (#22) — all covered in the sections below.

**READ FIRST for any scheme/partner work: memory [[scheme-data-collection]] + [[partner-multi-outlet]] + the design docs `SCHEME-DATA-COLLECTION-DESIGN.md` (§16/§17) + `PARTNER-MULTI-OUTLET.md` (§10/§11).** Guardrails unchanged: never merge to main / apply a prod-or-staging DB op without the owner; money/auth/OTP write-paths → mandatory dual audit [[audit-every-build-item]]; surface follow-ups, never unilaterally defer [[no-unilateral-deferral]].

<details><summary>✅ CUTOVER #21 (`a83b2f4`) — SCHEME UAT BATCHES + CHILD-KYC PREFILL + UNIQUENESS TOGGLE — DONE + VERIFIED (reference)</summary>

**✅ LIVE IN PROD — cutover #21 (`a83b2f4`, 2026-07-31), gate api build 0 · jest 2124 · FE tsc 0 · vitest 2052, additive + DORMANT.** Migration `20260730160000_scheme_enrollment_soft_delete` APPLIED to prod (guarded read `done:true`/`rolled:false`). Detail = 🟢 CURRENT STATE (top) + ledger row #21 + `SCHEME-DATA-COLLECTION-DESIGN.md` §17 + `PARTNER-MULTI-OUTLET.md` §11.
- **Batch 2 edit/delete — HIGH audit fix (for future OTP/consent work):** both edit paths originally routed through `submit()`'s PHONE_OTP consent gate demanding a fresh OTP the edit forms can't supply → edit was NON-FUNCTIONAL (403/400) on any consent-gated scheme. FIX = `submit()` `consentedEditFrom` REUSES the phone OTP-verified at the ORIGINAL capture (immutable; client phone discarded), never a fresh OTP; fail-closed (fresh enroll / rejection-resubmit / re-enroll byte-identical). SALES self-edit server-gated on `enrollmentMode === 'SELF'`. All 15 read/report/export sites filter `deletedAt`.
- **child-KYC prefill — HIGH audit fix:** the "approved child" signal is the sibling's **KYC APPROVED** (`kycSubmissions.some.status='APPROVED'`), NOT `ChannelPartner.onboardedAt` (a parent-only marker → gating on it made the sibling branch DEAD).
- **OPEN owner items:** post-#21 real-phone smoke. *(Bank/UPI prod uniqueness flip ✅ DONE 2026-07-31 — deoleo all-on, verified.)* Rollback ref `8c08af3` (#20).

</details>

<details><summary>✅ CUTOVER #20 (`8c08af3`) — SCHEME UX HARDENING + Parent-ID export — DONE + VERIFIED (reference)</summary>

**READ: `platform/docs/plans/SCHEME-UX-HARDENING-PLAN.md`** (carries the ✅ status banner + row/phase annotations) — full 4-slice review of the LIVE scheme feature, built as a concrete, parallelized, **CODE-ONLY (no migration)** change. **✅ LIVE IN PROD — cutover #20 (`8c08af3`, 2026-07-30), dual-audited (BE+FE) + staging-verified 21/21, additive + DORMANT.** Only owner item left = the ~5–10 min real-phone smoke.
- **Owner decisions (locked 2026-07-30):** camera server-watermark (D14) **DROPPED** · per-field audience (D12b) **DROPPED** · **dual prefill SOURCE ADDED** · scope = **EVERYTHING IN ONE PUSH**.
- **Dual prefill source:** the form-builder prefill link is a **DROPDOWN of real values, not blind free-text** — pick from the **actual uploaded roster columns** OR an **Outlet master field**. Contract = `FormField.outletField` resolves from a matched loyalty outlet's DB record; else `prefillKey` Excel column; server-authoritative pin for locked fields (outlet-field WINS over a same-named Excel column). Fixed the integrity bug where a typo in the old free-text `prefillKey` silently *unlocked* a Locked field.
- **🔴 must-fixes — ✅ all done:** free-text prefill → dropdown (H1) · DATA_DISPLAY value no longer stripped (H2) · activation requires audience + non-empty form (H3) · Save gated on builder validation (H4) · admin drawer nested outlet/geo reads + id→label map (H5) · signature-canvas scaling (H6). + ~14 🟡/⚪ (immutable REJECTED reject-trail · broadcast preview+confirm · approved-owner phone pre-pin · facet-values picker · GPS-accuracy cap D15 · export TOGGLE→Yes/No + app-proxy media URL · report/notify `platformWide` scoping-unify · removed `FormField.audience`).
- **New reads:** `GET :id/prefill-sources` · `:id/facet-values` · `:id/broadcast/preview`.
- **Gate:** api jest 2104 · nest 0 · FE tsc 0 · vitest 2049. **Dual audit** (BE CLEAN + 4 lower-sev; FE no HIGH + 2 fixes) + **staging-verified 21/21** (synthetic MIXED roster then soft-deleted; dual-source PIN proven: rep sent f_owner="HACKED-BY-REP" → server stored the DB owner name).
- **Commits:** c43304e · 0da1859 · ed4a577 (Parent ID export) · 16358a7 · 273a4b2 — FF-merged develop→main at #20.
- **NEXT (owner) = ~5–10 min real-phone smoke** (signature canvas, camera/geo, dual-source locked prefill on a live enroll). Not a build task; nothing blocks Deoleo.

</details>

## ▶ ALSO PICK UP — PARENT ID in outlet-master DOWNLOAD — ✅ LIVE IN PROD (cutover #20 `8c08af3`)
The **"Parent ID"** column was added to the outlet-master **UPLOAD** at cutover #17 but was missing from the **DOWNLOAD/export**. **✅ FIXED (commit ed4a577, code-only) + LIVE IN PROD (cutover #20 `8c08af3`, export 401-wired + verified):** the real export is the **backend** path `reports.service.outletMaster` — it now emits a "Parent ID" column (the outlet's parent ChannelPartner `partnerCode`), **57 columns total**, round-tripping the upload's "Parent ID". The FE `platform/src/lib/outlet-master-export.ts` the backlog named is **DEAD/unused demo code** (not the real export). Additive, no migration. Memory [[partner-multi-outlet]].

---

**(Historical context — the cutover #17 dormant surfaces still await owner UAT; no rush, nothing blocks Deoleo. The #17 payload shipped together, all additive + DORMANT, Deoleo live path byte-identical:)**

**1) 🚀 VISIBILITY-LED PAYOUTS: 194C AUTO-INVOICING + CONFIGURABLE TDS — ✅ LIVE IN PROD (`500eaf9` @ cutover #17).** Full build W0–W2 + **dual money-audit (8)→fix→dual re-audit (4)→fix (6)→FINAL re-audit CLEAN (0)**. BOTH migrations (`20260728120000_visibility_payout_tds_foundation` + `20260728130000_credit_code_per_tenant_unique`) applied + prod-verified (`done:true`/`rolled:false`; 3 TDS tables + 4 CreditPayoutEntry frozen-stamp cols + per-tenant composite-unique idx + payoutStream backfill Deoleo→INCENTIVE). Owner decisions: config=JSON-hardened+freeze-on-confirm · gross-up=MONTHLY-INCREMENTAL top-ups · no-PAN=pay-full+20%-tenant-recovery+report · default-ON · D10 pro-rata. **DORMANT — Deoleo's live incentive/194R path byte-identical (INCENTIVE→194R, TDS engine never fires).** Docs `VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md` + `VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md` (§10 DD-1..4) + memory [[visibility-payout-tds-invoicing]] — **READ FIRST for any TDS work.** Money path → **dual adversarial audit mandatory on ANY further money-logic change.** ▶ REMAINING = owner UAT in prod (real payout-Excel → confirm → SERVICE invoice + GST-holdback → DEDUCT/GROSS_UP ledger → UTR-lock; proven end-to-end on staging via the synthetic 2-tenant run).

**2) 🔒 GIFSY ASSUME-TENANT SCOPING — ✅ LIVE IN PROD (`706efd1`+`12045db` @ #17), endpoints 401-wired + verified.** A GIFSY operator assumed into a tenant is READ-scoped to that tenant (was platform-wide → owner saw Deoleo's KYC while "working in" a fresh 2nd tenant `uatbajaj`; **NOT a leak** — real tenant admins always hard-scoped). Invariant `api/src/common/tenant-scope.ts` `platformWide(user)=role==='GIFSY_ADMIN' && !assumed`; 194C platform views un-assumed-GIFSY-only. Memory [[gifsy-assume-tenant-scoping]] + RESUME trap (ASSUME-TENANT-SCOPE).

**3) 🎉 PARTNER→MULTI-OUTLET ADMIN GROUPING FE — ✅ LIVE IN PROD (`ab61b63` @ #17, no migration), 401-wired + verified.** The admin UI that cutover #14 shipped a backend for but never a frontend: **`/admin/users/parents`** page (list/search parents · create · GIFSY-only approve · expand→children · per-child un-group [disabled+reason when blocked] · deactivate) + a **"Parent ID" column** on the outlet-master upload (the sanctioned way to link an outlet to a group) + backend slice (`GET`/`deactivate` `/admin/parents/:id`, outlet-list `parentId`/`parentCode`+`?parentId` filter, shared `common/partner-group.helper.ts`). Adversarial-audited (blank-cell-re-upload-can't-mass-ungroup CONFIRMED SAFE + proven live; 3 findings fixed) + staging-runtime-verified end-to-end. DORMANT until an admin sets a parentId. Memory [[partner-multi-outlet]] §"ADMIN-FE CORRECTION" + PARTNER-MULTI-OUTLET.md §10.

**▶ NEXT — ✅ CUTOVER #17 DONE (`52fc19f`, 2026-07-29). Remaining = owner UAT in prod of the two DORMANT surfaces (no rush; nothing blocks Deoleo):**
- **TDS payout write-path** — assume a tenant → "TDS & Invoicing" nav; exercises once a real VISIBILITY-stream payout flows (proven end-to-end on staging via the synthetic 2-tenant run).
- **Grouping UI** — **/admin/users/parents**: create a parent → put its code in the outlet-master upload's new **Parent ID** column (proven end-to-end on staging).
- *(Both dormant until configured/used; Deoleo live path byte-identical.)* Prior-session offer (b) "synthetic 2nd 194C tenant proof" = ✅ DONE (DD-2/DD-3 closed). Prior offer (c) "prod cutover" = ✅ DONE (#17).
- ⚠️ Loose end: a docs-only prod-deploy gate for `d177cbd` may be pending in GitHub Actions — harmless (prod serves the verified `52fc19f` regardless); approve or reject, either is fine.

**PARKED / CA-review (NOT blockers):** DD-1 tenant recovery report exposes the cross-tenant PAN aggregate (`panBase`/`panTdsTotal`) to a tenant admin — **owner KEEP-AS-IS** (fix = strip those 2 fields when scope.clientId set). **✅ DD-2 (double-reversal) + DD-3 (no-PAN per-(clientId,outletCode) + MIXED cross-tenant methodology) EXERCISED + CLOSED 2026-07-29** via a synthetic 2-tenant staging run (2 tenants GROSS_UP+DEDUCT, shared PAN + no-PAN outlets, full write-path via real API, guarded-read verified, then fully deleted — 0 rows remain; numbers matched hand-calc to the paise: MIXED shared-PAN liability ₹904 = ₹500 deduct + ₹404 gross-up; no-PAN A2 ₹40k recovered ₹10k, B2 ₹20k below-per-outlet-threshold NOT; DD-2 one −₹400 reversal, re-apply added no 2nd row). **DD-4 (gross-up TDS invoice GST) ✅ CONFIRMED CORRECT AS DESIGNED (2026-07-29, owner-confirmed):** GST follows the retailer's registration — unregistered → NO GST on any invoice (D6, verified live gst=0), registered → GST on the TDS invoice (D-i "CA-blessed as additional service consideration", verified live ₹72.72). No code change. All in WAVE0-SCHEMA §10. (batchCode/downloadCode global-unique collision was FIXED this wave. DB-level RLS still backlog Gap #23 — isolation is application-`clientId`-scoped.)

---

**✅ SHIPPED — PARTNER → MULTIPLE OUTLETS (parent-child owner groups) — LIVE IN PROD (cutover #14 `eca351e`, 2026-07-24).**
Full AS-BUILT + cutover record = `platform/docs/plans/PARTNER-MULTI-OUTLET.md` §9; memory [[partner-multi-outlet]]. Owner-driven, multi-wave
orchestrated build. **✅ WAVE 1 + 2 + 3 + 4 ALL DONE + LIVE IN PROD: the BACKEND shipped at cutover #14 (`eca351e`, 2026-07-24); the admin FRONTEND (Parent ID upload column + `/admin/users/parents` page + un-group/deactivate) — which #14 never included — shipped at cutover #17 (`ab61b63`, 2026-07-29). The whole feature is now live + dormant-until-an-admin-sets-a-parentId. The block below is the HISTORICAL pre-#14 cutover record (dup-PAN blocker since RESOLVED).**

> 🛑 **[HISTORICAL — RESOLVED; #14 shipped 2026-07-24] CUTOVER ATTEMPTED 2026-07-23 → BLOCKED on the prod dup-PAN pre-check.** The cutover ships 6
> commits (`origin/main..origin/develop`) + **4 additive migrations** (`_partner_multi_outlet_foundation`, `_partner_group_uniqueness`,
> `20260723130000_otp_reference_id`, `20260723140000_scheme_enrollment_by_partner`) — ALL FOUR apply to prod (prod == `2187498`
> is pre-Wave-1). Guarded prod read (`gifsy-oneoff-prodcheck`, GUARD current_database=gifsy_prod) found: scheme-orphans **0** (W3
> migration safe), but **2 duplicate-PAN pairs among the 4 (unapproved, `onboardedAt=null`) prod partners** → the W2 PAN
> partial-unique index would FAIL to build. All 4 are **go-live SMOKE-TEST entries** (names Payel Ghosh / St hukke / niinj /
> nikunj; PAN `ABCDE1234F` is a placeholder; outlet codes `Testoutlet`/`Test23`/`OUT-2026-001/002`): `AAACT9811F`×2
> (CP-OUT-2026-001, CP-OUT-2026-002) + `ABCDE1234F`×2 (CP-Testoutlet, CP-Test23). Deoleo has **no real partners yet**.
> **▶ RESOLUTION NEEDED (owner): confirm these are test → then a guarded prod write (backup + shown SQL + owner OK) to
> soft-delete all 4 (recommended — cleans prod for real onboarding; reversible via `deletedAt=null`) OR null the dup PANs.**
> Then re-run the prod dup-PAN read → 0 → **merge `develop`→`main` + push (I do the merge-push; owner approves the GitHub
> "Deploy — Production" gate)** → CI applies the 4 migrations → verify prod SHA/`/health/ready`/smoke → **post-cutover: create
> the Cloud Scheduler job → `POST /v1/kyc/cleanup-stale-drafts` daily + set `KYC_CLEANUP_SECRET` on prod.** (⚠️ flaky-CI: if the
> prod `test` job flakes, "Re-run failed jobs" so the approval gate appears.) NOTHING has been merged to main — prod untouched. **W4 (final, additive, NO new migrations):** group-leave
via re-KYC (Option A — a PAN-change-away-from-group is an atomic Gifsy-approval departure: standalone-uniqueness-or-rollback,
clears `parentId` in-tx, `willLeaveGroup` reviewer banner) + Phase-2 group roll-ups (`GET /partner/group/{targets,visibility,
leaderboard}`, own-group-guarded, visibility gated on the tenant flag) + scheme-catalog eligibility fix (opt-in allowlist —
was a dead `id IN ()` hiding ALL schemes from ALL partners; threaded through the picker). **W3 + W4 runtime-verified on the
staging `w3test-*` group (`04008d0`): picker/switch/overview + Phase-2 roll-ups (targets/visibility-flag-gated/leaderboard) +
scheme-catalog `0→2` + own-group-guard all green; group-leave covered by 223 kyc unit tests + audit (owner UAT for the full
re-KYC→approval flow).** W1+W2 as-built (design evolved — §9 authoritative): single-source-of-truth
`Outlet.parentId` + trigger-derived `ChannelPartner.groupId`; PAN+GST hard partial-unique DB indexes, bank/UPI app+advisory-lock;
parent entity + admin Parent-ID upload + dedicated un-group; **re-KYC STAGE-AT-APPROVAL** (proposed identity/payout+address staged
on `KycSubmission.proposedPartner`, applied only at Gifsy approval); reserve-at-submit + 48h cleanup. **W3 as-built:** **login picker**
(outlet identity is NOT in the JWT → re-resolved per request; login-less same-group same-phone siblings reached via httpOnly cookie
`active_partner_id` → proxy header **`x-active-partner-id`** → EVERY partner-self site re-authorizes via `resolveActivePartnerId`;
money/write paths **fail-closed**, shell `/partner/me` **degrades-to-own** + `activeSelectorInvalid`→FE self-heals + logout clears the
cookie — a stale/shared-device cookie never bricks the portal); **read-only group wallet overview** (`GET /v1/partner/group/wallet`,
new GroupService, sum of Int POINTS + per-outlet drill-down + own-group cross-check); **Stream C** child KYC parent pre-fill (PAN
locked to group PAN) + verified-on-parent badge (server booleans, pre-mask, PII-safe); **scheme enrollment RE-KEYED by shop**
(`@@unique[schemeId,partnerId]`, userId nullable) so login-less siblings self-enroll; **order-bound redemption OTP** (`OtpCode.referenceId`).
**4 additive migrations** (all on staging; ALL FOUR apply to prod at cutover — prod is pre-Wave-1). **▶ NEXT = resolve the CUTOVER
BLOCKER (prod dup-PAN test data — see the 🛑 note in CURRENT STATE) → owner UAT on staging (real OTP) → owner-gated cutover.**
**⚠️ CUTOVER CHECKLIST (prod dup-PAN [FOUND: 4 test partners, 2 dup pairs — clean first] + scheme-orphan [0] pre-checks · Cloud
Scheduler + `KYC_CLEANUP_SECRET` post-cutover · bank/UPI dup sweep before flipping policy) — see PARTNER-MULTI-OUTLET.md §9.**
Owner decisions locked this session: Option-A group-leave (built, §4.5 `TODO(wave4)` now RESOLVED); scheme-enrollment re-keyed by
shop (built); `parentPrefill` kept in the sales-outlet list (authorized staff only, not tightened).

**STATE (prior work, all LIVE):** prod == main == `2187498` (CUTOVERS #12 `d028566` + #13 `2187498`, LIVE 2026-07-22). Both develop
features LIVE in prod: PER-OUTLET PAYOUT MANDATE (no flag) + KYC ADDRESS-PROOF WAIVER (semantics-corrected + prod flag SET). Only
remaining verify = the owner's real-OTP prod check of the KYC form. Verify HEADs via `git log`.

**✅ INFRA COST-REDUCTION — FULLY COMPLETE this session (2026-07-22). Canonical doc = `platform/docs/plans/INFRA-ARCHITECTURE.md`
(current topology + the change log + the "Leftover / open infra items" pick-up list); detail in memory [[infra-cost-reduction]].**
Three changes DONE + runtime-verified, **~₹10k/mo (~57% of the bill) saved, zero prod impact:** (1) **Redis DELETED** (both
Memorystore instances + `REDIS_URL` secret + prod env + the dead `ioredis`/`cache-manager` deps — was never wired); (2) **VPC connector
→ Direct VPC egress** (`gifsy-connector` migrated then DELETED — prod cut over via canary→ramp + a `/health/ready` startup probe; both
workflows + terraform updated; all 7 jobs migrated); (3) **Artifact Registry durable cleanup policy LIVE** + stray `gifsy-repo` deleted.
All stale Redis/connector refs swept from code + docs; independent grep-audit clean; gate green; `terraform validate` OK.

**▶ LEFTOVER / NEXT PICKUPS (all owner-DECISION-gated — nothing half-built; see INFRA-ARCHITECTURE.md "Leftover / open infra items"):**
1. **Infra pause levers** — only if Deoleo go-live slips post-Sept: prod Cloud-Run-min-0 + pause prod schedulers (~₹800/mo), stop
   `gifsy-db-dev`/`gifsy-db` in a full freeze (~₹1k/₹2k/mo). **Blocked on two owner answers: is staging-UAT needed during the pause? is
   dev continuing?** Reversible; bring-up < 1hr.
2. ✅ **Cutover #12/#13 DONE** (2026-07-22) — both develop features + the waiver semantics-fix + the prod waiver flag are LIVE.
   Only remaining = the owner's real-OTP prod UAT of the KYC form.
3. **Other open threads** (below): Notifications-Core go/no-go (owner decision), #74 owner-ops (monitoring/backups/cred-rotation), the
   E2E harness STAGING run-mode (optional), the 2ND-TENANT LOW items + POST-GO-LIVE-BACKLOG.

Then ask which to pick up. **REMEMBER: never unilaterally defer follow-up work — surface it, let the owner decide** [[no-unilateral-deferral]];
orchestrate substantial work by default [[default-to-orchestration]].
```
