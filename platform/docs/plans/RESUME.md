# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs are the source of truth.

```
You're the orchestrator for the Loyaltybase build — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy).
Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/` (thin Next.js 16).
Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic). Last verified state: 2026-06-23.

═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
✅ STATE (2026-06-22): GO-LIVE FIX WAVE COMPLETE (historical — all GLB-1..6 + GLM-1..5 closed, audited, pushed `a4b5a35..6003522`; do NOT re-run it). **NOW IN: OWNER-DRIVEN UAT on STAGING — fix-as-you-find loop** (each bug: diagnose→executor→INDEPENDENT audit→gate→runtime-verify→commit→push). The planned 5-agent **runtime** UAT sweep is **BLOCKED** (background subagents are DENIED shell → can't drive Playwright); pivoted to a HYBRID — orchestrator drives runtime, 4 background agents ran SOURCE audits → findings **AF-1..AF-11 recorded in `GO-LIVE-ISSUE-LIST.md`** ("UAT AUDIT FINDINGS", OPEN). **UAT FIXES — PRE-COMPACT half (all pushed):**
  • `2205101` UAT-CHECKLIST §12–§19 (security/scale/concurrency/compliance/ops/real-data-load/device — tiered 🔴/🟠/🟡 + owners).
  • `5601ba8` HIERARCHY upload prod-bundle xlsx read: `XLSX.read(ArrayBuffer,{type:'array'})` needs a **Uint8Array** — dev-build tolerant, **prod build (`next build`) throws** "not a valid xlsx"; fixed + Playwright download→re-upload round-trip test + un-swallowed the real error in the catch. (Also: seed payout-fixture `seed-pt-1` repointed to the APPROVED distributor so GLB-1 flags it; playwright `retries:1` for next-dev cold-compile flakes.)
  • `be9d685` HIERARCHY numeric-cell `.trim` crash: SheetJS returns NUMBERS for numeric cells; `(v ?? '').trim()` → coerce `String(v ?? '').trim()` in both parse paths + numeric-cell vitest.
  • `089270d` TARGET/ACHIEVEMENT upload KPI **column mis-mapping** (DATA-INTEGRITY): parser mapped KPI cols POSITIONALLY off the row-1 merged month header → header drift mis-assigns values to the wrong KpiDef; rewrote to **name-keyed absolute-column** mapping + integrity guard (rejects mismatched template). One fix covers both uploads (shared `targets.helpers.ts`).
  • `a811fe2` Downloadable **.xlsx error reports** (shared `lib/error-report.ts` + `DownloadErrorReportButton`) wired to Outlet Master (the owner's complaint) + Targets + Payout-UTR + KYC bulk-verify.
  • `c17887c` **Single-primary KPI (4-layer, long-term)** — UI checkbox→**radio** ("set primary" MOVES it) · backend `setPrimary` + `P2002→409` · **DB partial unique index** migration `20260622120000` (SELF-HEALING: demotes historical dups then creates index) · retired the 2 **dead** KPI blob stores (`kpi_defs`/`target_configs` ProgramSetting + their controllers). PLAN + IMPL both independently audited. **Layer 4b (partner surface honoring `isPrimary`) DEFERRED** (today the partner dash reads localStorage demo data — separate, higher-risk).
  • `4de8794` **Unified CASH PAYOUT (UPI/Bank)** — ✅ pushed. Partner = one free-amount ₹ redeem reading **real KYC beneficiary** (removed fabricated "HDFC ****3210") + a "complete KYC" empty-state; admin can make cash items **free-amount with a minimum** (un-gated from Gift-Card-only); settlement export = **one file** with all beneficiary cols (bank acct/IFSC/holder/name + UPI, blank where missing); **upstream beneficiary guard BEFORE debit** (block redeem if no payable rail). Reconciled to the existing 2-rail model (Option-1: keep modes under the hood, unify experience — no batch refactor). Independently audited SAFE. `/auth/me` now serves the partner's own beneficiary + `conversionRate`.
**UAT FIXES — POST-COMPACT half (this session, all gate-green + PUSHED):**
  • `771276f` HIERARCHY snapshot "N→0 after refresh" (regular template): global ValidationPipe (`whitelist+transform+enableImplicitConversion`) mangled untyped `employees:any[]` → snapshot stored `[[],[]]`. PUT now reads RAW `@Req().body` (passthrough) + 400-guards malformed elems. **Lesson: method `@UsePipes` does NOT override the global pipe — pipes STACK; raw req.body is the bypass.**
  • `0fa9d92` KPI **name-override** wired end-to-end (was a dead setting): template name column per override-KPI + parser stores per-outlet names in reserved `targetValues.__names` + partner Targets shows custom-else-label. No schema change. Runtime round-trip proven + audit SOUND.
  • `141c385` HIERARCHY **CHAIN** upload "11→0" — THE real recurring bug: staging logs = `salesHierarchyLevel.upsert` **P2002 on `(clientId,level)`** → whole `$transaction` rolled back → snapshot lost; FE hid the 500 (fire-and-forget PUT + swallowed `.catch()`). Fix: free the level space before re-assign (collision-proof; `level>=0`-scoped so orphans don't underflow) + tx `{timeout:20s}` + **FE awaits PUT & surfaces errors** + reload-round-trip E2E. **A/B-proven** (same deoleo tenant: 500→200+GET 11). Audit SOUND.
  • `3b4209b` PACE-VIEW target shift on blank cell: backend CORRECT (by-code); FE sales pace table rendered each row's `kpis` POSITIONALLY vs `outlets[0]` headers → blank KPI shifts left. Fix: union-of-codes columns + by-code lookup.
**UAT FIXES — 2026-06-23 (all gate-green + PUSHED; full detail = `GO-LIVE-ISSUE-LIST.md` U11–U22):**
  • `5153bcb` U11 CHAIN upload STILL 500 after U9 — a DIFFERENT P2002 (`salesUser.upsert` on `userId`): a phone already on a sales-user under another code → clean **400 guard** (within-file dup, existing-owner conflict, blank/dup id) + blank-mobile→synthetic; FE `BLANK_CONFLICT` (same-id blank-in-some-rows). · `1bd58e4` U12 Outlet Master "shows added but didn't" — Deoleo had **0 enabled OutletTypeClientConfig** → backend 200/created:0; FE `onConfirm` ignored the result + hardcoded type list. Fix: backend serves enabled type codes; validator/template/guide source from it; surface real result. (Enabled deoleo's 4 types on staging via guarded job.) · `c54b6a6` U13 "Download Current" hierarchy export (inverse parser + completeness safety net). · `c0623c5` U14 **FIXED_OTP re-enabled on staging** behind a 3-layer gate (`isFixedOtpAllowed`: deny gifsy_prod DB; allow non-prod NODE_ENV; on prod-NODE_ENV require `ALLOW_FIXED_OTP=true` AND gifsy_staging DB) — wired into `deploy-staging.yml`; security-audited prod-safe; **revert = unset `ALLOW_FIXED_OTP`**. · `ebc6379` U15 **sales/all-tenant login bounce** = `resolveSlugFromHostname` didn't strip the staging `uat.` prefix → `clientId='uat'` → "no account". Fixed (strip after operator-host check). · `a4852a5` U16 **outlet-type `SSS`-vs-`RETAILER` drift** → canonical **`SSS`** (seed + one-time guarded staging DB rename, keeps row id) + `/gifsy/outlet-types` made **read-only** (Add/Rename/Toggle were fake; no global CRUD by design). **Long-term fix, not a patch.**
  • `6c8b4a2` U17 sales-login STILL bounced post-U15 — the **Next-16 edge proxy** (`platform/src/proxy.ts`) `ROLE_ROUTES['/sales']` held STALE legacy codes (no `UserRole` match) → authenticated sales **307'd to /auth/login** (admin/partner lists were canonical → only sales bounced). Fixed to canonical `SALES_*` + a lock-every-list-to-the-enum regression test. · `57c8843` U18 proxy `x-user-id`→`payload.sub` + `sales-role.ts getRole()` now derives the FE persona from the real JWT role (was defaulting everyone to 'SO'). · **dev RETAILER cleanup DONE** (gifsy_dev → canonical `[SSS,SSS_TOT,SUB_STOCKIST,WHOLESALER]`). · `356c135` U19/AF-1 **partner dashboard hero FABRICATED data FIXED** — real `/partner/targets` primary KPI (summed across outlets) + real `/auth/me` wallet; backend `getTargets` now returns isPrimary+unit (KpiDef cols, no migration); dropped usePartnerSession/DEMO_SESSIONS/resolveConfig. · `c836a11` U22 partner targets PAGE real isPrimary (was `idx===0`). · `ea47509` U20 + `b0145d3` getMember — sales rep AND manager-member-detail now include partner-less (un-KYC'd) outlets (both filtered them out; rep saw an empty list). · `c836a11` U21 **ticket Resolve/Close/Reopen built end-to-end** (`POST /v1/tickets/:id/status`, support-admin 3-layer gate, tenant-scoped, partner-visible system msg, reopen-on-creator-reply; admin drawer controls + banner-overlap fix). · **AF-12 DEFERRED (owner "deal with later"):** `@RequirePermission` permission-guard is fail-open (`RBAC_ENFORCEMENT` off) but **SAFE** — `@Roles` + in-service checks are the real gates (every privileged controller has a class/method `@Roles`); keep RBAC OFF for go-live; pre-enable, re-run the gap-#2 route-coverage audit; writeup = `RBAC-ENABLEMENT.md`. **All U17–U22 gate-green + INDEPENDENTLY AUDITED + RUNTIME-VERIFIED on staging.**
**Migrations applied to dev:** `20260622120000_kpi_one_primary_per_client` (pre-compact; U7–U22 are schema-free). **Gate (2026-06-23 latest):** api jest **976/976**, FE vitest **1490**, tsc clean both sides; serving SHAs verified (`c836a11`). **Env facts changed this session:** staging OTP now `123456` (was real MSG91); staging deoleo admin phone `6289864191` (GIFSY admin `9830011252`/clientId gifsy; partner `7795096288`; sales `9900000041`=ISR/`9900000002`=SO; the old `9875436349` was parked off its user).
**🔴 OPEN UAT AUDIT FINDINGS (AF-1..AF-12 in `GO-LIVE-ISSUE-LIST.md` → "UAT AUDIT FINDINGS"):** AF-1 fabricated data — **PARTNER dashboard ✅ DONE (U19/U22)**, **SALES dashboard still mock** (`OUTLET_ACHIEVEMENTS` + `sales-role.ts` personas + DEMO switcher) = AF-2/3 next; 🔴 AF-5 CSV-formula injection on non-finance exports; 🔴 AF-6 JWT mirrored to localStorage; 🟠 GSTIN 12-char/no-checksum; 🟠 invoice-numbering skip-on-collision; 🟡 hardening cluster; 🟡 **AF-12 (DEFERRED, owner) RBAC fail-open guard — SAFE, keep OFF**. Money·finance·RBAC/tenant/IDOR cores CONFIRMED SOUND.
**NEXT (owner-ordered, updated 2026-06-23 late):** ✅ DONE this session — sales login fixed+verified (U17/U18), dev RETAILER cleanup, **AF-1 PARTNER fabricated data (U19/U22)**, sales outlets visibility (U20/getMember), ticket Resolve loop (U21). **REMAINING:** (1) ⭐ **AF-2/AF-3 SALES fabricated data — AUDIT-FIRST** (U18 fixed the persona/designation via `getRole`→real JWT role, but the sales **dashboard** likely still reads `OUTLET_ACHIEVEMENTS` mock + `lib/sales-role.ts` ROLE_NAMES/EMP_IDS + the DEMO role switcher — re-derive what's real vs mock before fixing); (2) rest of AF (AF-5 CSV-injection 🔴 → `cellSafe`, AF-6 JWT-localStorage 🔴, AF-7/8 GSTIN/invoice 🟠); (3) gap-#57(a) sub-dashboards hide-vs-wire; (4) #76 prod data load (MUST route through tenant provisioning so outlet-types/configs exist) → #74 owner ops → go-live. **DEFERRED (owner):** AF-12 RBAC `RBAC_ENFORCEMENT` flip (keep OFF; `RBAC-ENABLEMENT.md`).
═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
The P0–P6 + P0.6 platform is built and serving in prod (`gifsy-api`+`gifsy-frontend`, `https://deoleoloyalty.gifsy.in`; prod DB
intentionally EMPTY). The **S0–S6 UAT-hardening wave is DONE + pushed** (S0 migration; S5 Excel round-trips `c9bf80e`; S1
redemption UTR-ingest + BUG-1 close `0aa6490`; S2 auth + S3 KYC + S4 TDS + S6 FE-mock `ad4fbe2`; small FIXED_OTP/DEMO_MODE
prod-gates uncommitted-as-of-this-write) — each executor→independent-audit→gate→runtime-verify; money (S1/S5) + auth (S2)
runtime-PROVEN. **THEN a 4-angle comprehensive adversarial audit (money · auth/isolation · core-loop · data/config) found the
platform is NOT go-live ready — 6 BLOCKERS + 4 majors** (full detail + file:line in `gap-register.md` "GO-LIVE AUDIT" block +
`GO-LIVE-READINESS.md` status):
  • **GLB-1** eligibility (KYC-APPROVED + isActive) gate MISSING on BOTH money rails (credit bank-file hardcodes kycStatus:APPROVED; redemption has no KYC check) → revoked/inactive partners get paid.
  • **GLB-2** zero-value redemption (`conversionRate=0`) debits points for ₹0.
  • **GLB-3** stale coarse TDS unique indexes in the baseline drop all-but-first row of every multi-row TDS upload (regression from S4 + my skipped S4 real-DB runtime check).
  • **GLB-4** CLIENT_ADMIN can create/promote a user to GIFSY_ADMIN → full cross-tenant breach (`admin-core` createUser/updateUser, no role allow-list).
  • **GLB-5** scheme enrollment writes localStorage-only, never `POST /v1/schemes/:id/enroll` (the real route exists).
  • **GLB-6** payout settlement has NO working operator UI (`admin/payouts` Process = setTimeout+alert; S1 settle endpoints have no FE driver).
  Majors: credit PAYOUT-reversal clawback, FAILED-credit retry, beneficiary-field validation, PayoutTransaction.redemptionOrderId unique, /admin/kyc fake bulk-approve.
  **What the audit CONFIRMED SOUND (don't re-audit):** money atomic-claims + reversal idempotency, tenant data-isolation (no unscoped query / 33 services), schema↔migration parity, BigInt/secrets, the S0–S6 hardening.
**Next phases:** (1) ✅ FIX WAVE done+pushed → (2) **RUN THE FULL UAT (incl. UI/UX) as parallel multi-agent workstreams — THE POST-COMPACT WORK below** → (3) owner real-OTP confirmation on staging → (4) load real Deoleo data into empty prod (#76) → (5) owner ops (#74).
**UAT creds (staging, real SMS OTP):** GIFSY `uat.app.gifsy.in`/**9830011252** · deoleo admin `uat.deoleoloyalty.gifsy.in`/**6289864191** · partner `7795096288` · sales `9875436349`.
**Read FIRST:** `GO-LIVE-ISSUE-LIST.md` (⭐ the authoritative master tracker — every issue + file:line + E2E status) · `gap-register.md` (GO-LIVE AUDIT block) · `GO-LIVE-READINESS.md` (status) · `DEOLEO-GO-LIVE-BUNDLE.md` · `MIGRATIONS.md` · `ENVIRONMENTS.md` · [[staging-deploy-gate]] · [[audit-every-build-item]] · [[verify-flows-at-runtime]].
**E2E runtime audit of S0–S6 (2026-06-21):** harness 292/0/7 + targeted drives → S1/S2/S3/S5 runtime-CONFIRMED good; **S4/S0 TDS runtime-CONFIRMED BROKEN (GLB-3: 2-row upload stored 1, reported succeeded:2)**; S6 harness-green. Details in `GO-LIVE-ISSUE-LIST.md`.

## ✅ What is LIVE / DONE
- **The platform** — P0–P6 (onboarding/KYC, programs/targets/enrollment, wallet/points/rewards, finance/credits/
  invoicing/TDS) + **P0.6 A–D** (Gifsy cross-tenant oversight + operator switcher, payouts money-path, enforcement
  coverage audit, sales-assisted redemption, invoices+Excel, gifsy console real data, P0.7 cleanup, platform-Prisma
  retirement). All built + independently audited + runtime-verified; **all LIVE in prod now**. Records: `reconcile/*`
  + the memories ([[p3-kyc-complete]] [[p4-complete]] [[p5-complete]] [[p6-finance-decisions]]).
- **🚀 PROD CUTOVER DONE (2026-06-20)** — recreate `gifsy_prod` empty (double-guarded) → apply the squashed baseline
  (72 tables, World-A gone) → `develop`→`main` deploy (GitHub prod gate) → removed the temporary worker host-alias
  (native resolution). Verified: login 200, FE→backend routing 400 (`NEXT_PUBLIC_API_URL`=api.gifsy.in), health 200.
  Full as-run log: `runbooks/PROD-CUTOVER-RECORD.md`.
- **🗄️ MIGRATION MODEL FIXED** — ONE squashed baseline (`api/prisma/migrations/00000000000000_baseline/`; old 6 →
  `migrations-archive/`; `migrations-manual/` is now LEGACY) applied via `prisma migrate deploy` run as an **in-VPC
  Cloud Run Job** (the staging/prod instance is private-IP). Staging auto-migrates on `develop` push, prod on `main`.
  Full model: `MIGRATIONS.md` / [[migration-model]].
- **STAGING login WORKS with REAL MSG91 OTP** (owner logged in end-to-end). The earlier login bugs (empty staging DB,
  empty-host secret, Next-16 Server-Action CSRF abort behind the worker, BOM'd MSG91 key) are all fixed. Redemption-UAT
  phones set on staging: deoleo admin `9830011252`, partner+outlet `7795096288`, sales `9875436349`.

## ✅ E2E ROLE×PAGE MATRIX — DONE (Waves 0–4, 291 passed / 0 failed / 11 skipped; committed `961d5fa`/`7b3828a`/`5119c1d`, PUSHED)
The full matrix (admin writes+reads, partner, sales + salesManager team roll-up, MIS read-only incl. write-denied, gifsy)
is machine-enforced. It caught + we FIXED real prod bugs: the **money-path #42** (`payouts.processBatch` had no test → added
a GIFSY assume-tenant spec + payout-pipeline seed), **`/api/auth/me` thin → profile pages showed MOCK data** (enriched `me`
with nested channelPartner+wallet+salesUser; backend rebuilt), **`OutletTypeClientConfig` unseeded → outlet-upsert broken**
(seeded), seed-hygiene (canonical names), the `login.ts` OTP-fill race, and admin demo-identity (#55). **To run E2E:** DB
proxy `:5433`→gifsy_dev + backend `:4000` (`node dist/main.js`; ⚠️ **rebuild `dist` after the /api/auth/me change**) + FE
`:3000`; re-seed `gifsy_dev` to re-arm money/KYC write specs; `cd platform && npm run e2e`. Staging-run still needs the OTP
read-back endpoint OR temp `FIXED_OTP`.

## 🔴 The GO-LIVE critical path — what's LEFT

**⭐ THE POST-COMPACT WORK (do FIRST, 2026-06-22): RUN THE FULL UAT END-TO-END — including UI/UX — as PARALLEL MULTI-AGENT
WORKSTREAMS.** The fix wave is DONE + pushed; now exhaustively exercise every flow in `UAT-CHECKLIST.md` (auth · KYC ·
schemes/enrollment · wallet/rewards · money eligibility+settlement · finance/TDS · RBAC/isolation · integrity + the unhappy-path
matrix) **plus a real UI/UX pass** (layout, copy, empty/loading/error states, dead buttons/links, console errors, responsive/
mobile, NO fabricated data). **EXHAUSTIVE means: every Excel download→fill→upload AND RE-upload (UAT §10 matrix — targets,
achievements, fulfilment, credit bank-file+UTR, redemption UTR, TDS off-platform+deposits, KYC bulk-verify, invoices, enrollments,
bulk users/outlets — incl. malformed/wrong-template/dup files); every navigation link · route · button (UAT §11 — no dead links,
404s, infinite spinners, or console errors); and every EDGE CASE (boundary values, empty states, double-submit, back/forward,
deep-link, cross-shell URL).** Agents run this AUTOMATED on the LOCAL stack (`FIXED_OTP=123456`) — **so OTP-gated flows ARE tested
locally; only the real-SMS OTP is deferred to the owner's short STAGING confirmation afterward** (they cannot receive real SMS). Definition of done = [[verify-flows-at-runtime]]: a real user
per role completes each flow end-to-end, a 2nd session sees the persisted write, unhappy paths are honest. `tsc`/unit/E2E-green are
necessary, never sufficient.

**🆕 ROBUSTNESS EXPANSION (2026-06-22 independent platform audit — now folded into `UAT-CHECKLIST.md` §12–§19, tiered 🔴/🟠/🟡).**
§1–§11 = functional correctness; §12–§19 add the missing axes: **§12 security authz-depth & abuse** (IDOR/horizontal auth,
OTP send-throttle, token/session, FE headers, mass-assignment), **§13 injection & file-upload** (stored XSS, CSV-formula across
ALL exports, oversized/spoofed uploads), **§14 performance & scale** (volume pages, large export/upload vs Cloud Run timeout),
**§15 concurrency & resilience** (parallel wallet drain, MSG91/DB/backend-down, tx-rollback proof, retry-idempotency),
**§16 regulatory** (DLT, TDS/GST correctness + 26Q + invoice-sequence, audit-trail coverage), **§17 ops** (prod-backdoor sweep,
backups/PITR + restore drill, scheduled-job execution, observability), **§18 real-data-load acceptance (#76)**, **§19 device/
browser/network/localization**. The agents drive §12/§13/§15(parts) automatically on local; **`[operator]`-tagged rows (§14 scale,
§16.1 DLT, §17 all, §18 load, §15.4 MSG91-down) are STAGING/PROD checks the owner+orchestrator run OUTSIDE the local harness** —
assign them, don't expect a local agent to prove them.

**STEP 0 (orchestrator):** bring up + re-seed the LOCAL stack CLEAN — DB proxy `127.0.0.1:5433/gifsy_dev` (assert
`current_database='gifsy_dev'`), rebuild backend (`rm tsconfig.build.tsbuildinfo dist && npx tsc -p tsconfig.build.json
--incremental false && node dist/main.js` on :4000), FE :3000 (`next dev`), `npx prisma db seed`. **DECIDE gap #57(a) FIRST**
(recommended: HIDE the `/admin/dashboards/{payments,engagement,redemptions,kyc}` nav group + stub the 4 routes — they are 100%
mock, ~1.8k lines, 0 API calls — so testers never hit fake data; alt = wire 4 real aggregations = a mini-phase). Then launch the
streams as `general-purpose` agents (`run_in_background`). Each agent DRIVES the real browser via the existing Playwright harness
(`platform/e2e` — login helper + per-role `storageState`, isolated browser contexts) + captures SCREENSHOTS for the UI/UX review,
and returns a structured defect list (section · role · steps · expected vs actual · severity · screenshot path).

⚠️ **COLLISION RULE (single shared gifsy_dev DB — streams MUST mutate DISJOINT entities):** Partner partition — **B owns seed-cp-2**
(its RE_KYC target), **D owns seed-cp-1** (stays APPROVED, for redemptions), **E owns the distributor partner** (credit rail);
A/C/F are read-mostly. Disjoint rails: **D = redemption rail** (RedemptionOrder/PayoutTransaction/PayoutBatch/wallet) vs
**E = credit rail** (CreditPayoutEntry/Download/Reversal) + TDS + invoices — they do NOT collide. **F is READ-ONLY** → safe
alongside all. Each agent uses its own browser context (never a shared session).

**PARALLEL WORKSTREAMS (each = one agent; each covers happy + unhappy + UI/UX + its assigned security/non-functional rows):**
  - **UAT-A — Auth + RBAC + tenant isolation + security-authz** (UAT §1, §7, **§12, §13.4, §16.7**): login every role, route guards,
    logout/session-revoke, **GLB-4 privilege-escalation blocked** (CLIENT_ADMIN cannot create/promote a GIFSY_ADMIN), cross-tenant
    isolation, KYC-export GIFSY-only, ticket-escalation tenant check; **§12 IDOR/horizontal-auth on finance/KYC ids, OTP send-throttle,
    token-after-logout, mass-assignment over-post; §13.4 content-type-spoof upload; §16.7 audit-trail coverage spot-check.**
  - **UAT-B — KYC & onboarding + injection** (§2, on seed-cp-2, **§13.1, §16.4**): submit → field-level approve → **approval activates
    the outlet** → RE_KYC → re-upload (no 500); **§13.1 stored-XSS via businessName; §16.4 GSTIN-checksum reject on input.**
  - **UAT-C — Schemes & enrollment + upload-scale** (§3, **§14.3**): catalog shows REAL schemes (no demo IDs), **SELF enroll persists +
    does NOT re-show on reload**, **SALES enroll keys ChannelPartner.id**, targets/achievement Excel round-trips; **§14.3 max-size
    targets/achievements upload vs Cloud Run timeout.**
  - **UAT-D — Wallet/Rewards/Redemption + Money settlement + concurrency** (§4, §5, on seed-cp-1, **§12.1, §15.1/15.3/15.6/15.7**):
    redeem→OTP→debit, insufficient-balance, double-submit guard, lifecycle/refund; **GLB-1 cash eligibility (RE_KYC/inactive blocked
    BEFORE debit)**, **GLB-2 zero-value**, manual-cancel refused; **GLB-6 settlement lifecycle** (create→assign→process→UTR template→
    SUCCESS/FAILED upload→idempotent re-upload); **§12.1 IDOR redemption rail; §15 parallel wallet-drain, concurrent batch-process,
    tx-rollback proof, retry-idempotency.**
  - **UAT-E — Finance: credits / invoicing / TDS + injection/compliance** (§6, on the distributor partner, **§13.2/13.5, §14.2, §16.2/16.3/16.5/16.6**):
    credit bank-file **held vs payable (GLB-1)**, **FAILED→re-bank (GLM-2)**, **multi-entry REVERSED reversal (GLM-1)**, **beneficiary
    validation (GLM-3)**, **TDS multi-row stores ALL rows (GLB-3)** + dup-skip, liability/export, invoicing; **§13.2 CSV-formula
    injection across all finance exports + §13.5 re-export safety; §14.2 large finance export vs timeout; §16 TDS rate/threshold/grossing
    correctness, 26Q format, gap-free invoice numbering, PAN masking.**
  - **UAT-F — UI/UX + navigation + concurrency/resilience(FE) + device/locale** (§8 + §11, **§12.6, §15.2/15.5, §19**, READ-ONLY where
    possible, runs alongside all): every page × role — screenshots, layout, empty/loading/error states; **click EVERY nav item · link ·
    button · tab (no dead link, 404, infinite spinner, or console error)**; deep-link every route; back/forward; bad-route 404 grace;
    responsive/mobile; copy; flag the #57(a) sub-dashboards as KNOWN-mock (not new defects unless un-hidden); **§12.6 JWT-storage check;
    §15.2 concurrent-edit clobber, §15.5 backend-down honest-error; §19 cross-browser/mobile/3G/₹-format.**
  - **UAT-OPS — operator-run staging/prod checks** (NOT a local agent — owner+orchestrator): **§14.1 volume-seeded perf, §15.4 MSG91-down,
    §16.1 DLT delivery, §17 prod-backdoor sweep + backups/PITR + restore drill + scheduled-job + observability, §18 real-data-load
    acceptance (#76), §12.4/12.7 multi-instance throttle + FE security headers, §19.5 IST.** These prove what the local stack can't.

**Excel ownership (every UAT §10 row round-tripped AND RE-uploaded by its stream, incl. malformed/wrong-template/dup files):**
C = targets · achievements · enrollments-export; D = fulfilment · redemption-UTR · reconciliation; E = credit bank-file+UTR ·
TDS off-platform+deposits · 194R/194C export · invoices; A = KYC review-dump+bulk-verify · bulk users/outlets.

**AFTER the streams report:** orchestrator triages → fixes real defects via disjoint-file sub-executors (executor → INDEPENDENT
audit → gate → runtime-verify, same discipline) → re-runs the affected stream → records ✅/❌ per row in `UAT-CHECKLIST.md` and any
defects in `GO-LIVE-ISSUE-LIST.md`. THEN: hand the owner the short real-OTP STAGING confirmation pass → #76 prod data load →
owner ops (#74) → go-live. Present the workstream plan + the #57(a) hide/wire call for owner go-ahead, then execute.

1. **✅ DONE (2026-06-21, task #77) — gap-#57 (b/c/e) wired; (a) sub-dashboards DEFERRED.** (b) orphan `/admin/outlets` mock
   removed → redirect to the already-real `/admin/users/outlets`, + real per-outlet KYC-status join (derived from the owning
   **partner's** `KycSubmission` — KYC is partner-keyed, not outlet-keyed); (c) hierarchy read stays snapshot-fed **by P2.1
   design** — the empty page was a SEED-FIXTURE gap, fixed by seeding the `employee_hierarchy` snapshot (NOT a new relational
   read); (e) notification bells hidden in both shells until P7. **⚠️ (a) `/admin/dashboards/{payments,engagement,redemptions,kyc}`
   STILL render mock ("4,821"/"Kumar General Store")** — owner deferred wiring 2026-06-21; **open pre-UAT call: hide that nav
   sub-group OR wire the aggregations** before UAT (else a tester sees fake data there). (d) tenant-settings write + (f) MIS
   KPI-read RBAC = lower, still open. 2 independent audits + E2E 290/0/9. Detail: `gap-register.md` #57.
2. **✅ DONE (2026-06-21, task #78) — `OutletTypeClientConfig` auto-provisioned on tenant creation.** `GifsyService.createClient`
   + a `provisionOutletTypeConfigs(tx, clientId)` chokepoint create one enabled config per active `OutletType` inside the
   client-create `$transaction`; `POST /v1/gifsy/clients` (GIFSY_ADMIN) + the `/gifsy/clients/new` wizard wired; `seed.ts`
   routed through the same helper (§3.2b band-aid retired). Race-safe (P2002→409). Runtime-verified: fresh tenant → 5 enabled
   configs; dup → 409. **#76 is no longer gated on this.** Detail: `gap-register.md` #58.
3. **LOAD REAL DEOLEO MASTER DATA into the empty prod** — prod is migrated but has 0 users/0 clients; no real user can
   log in until the real client + admins + sales team + partners/outlets + reward catalog + schemes are loaded (owner
   provides the file; I author+audit the load). ✅ **#78 done — no longer gated** (a fresh tenant self-provisions outlet-type
   configs; load the real Client via `POST /v1/gifsy/clients` or seed-style script so provisioning runs). THE data blocker. Task #76.
4. **Owner UAT** of the core loop on staging with real OTP (login done; KYC/earn/redeem pending) — first resolve the #57(a)
   sub-dashboards (hide-or-wire) so UAT doesn't surface mock data there.
5. **Owner ops** (owner-only; I prepare exact steps): Cloud Monitoring alert email · automated backups + PITR on
   `gifsy-db` (a one-off backup was taken at cutover; ongoing is OFF) · rotate prod-only secrets. Task #74.
- **Deferred fast-follows (NOT blockers):** sales-team leaderboard (nav hidden), rest of P7 (notification worker,
  banners, ticket lifecycle), P8 (RLS, DPDP, trend analytics, the staging real-OTP endpoint), multi-tenant SSR
  branding (before client #2). Full list: `POST-GO-LIVE-BACKLOG.md`.

## Known gaps to watch (staging + prod)
- **Staging E2E can run there now** — `FIXED_OTP=123456` is re-enabled on staging (2026-06-22), gated to the `gifsy_staging` DB only (`isFixedOtpAllowed`).
- **Staging shares the prod `gifsy-db` Cloud SQL instance** (different DB names) — any DB op must double-guard the DB name.
- **Prod is empty** (the data-load blocker) · **no backups/PITR, no monitoring alerts, creds not rotated** (owner ops).
- **Prod deploy health-check is advisory** (doesn't fail the deploy) — the migrate `--wait` step is the real gate.
- **Redis:** `REDIS_URL` is bound but OTP is stored in the DB; the throttler is in-memory (per-instance, not global) —
  verify whether Redis is actually used / needed; minor hardening, not a blocker.

## Infra realities (these bite — all confirmed)
- **Edge = Cloudflare Worker** (`cloudflare-worker/worker.js` + `wrangler.toml`), **NOT a GCP load balancer** (archived
  2026-06-13). Add a domain / change routing = edit the worker + `wrangler deploy` (machine is Cloudflare-authed).
- **Staging + prod SHARE the private-IP `gifsy-db` instance**; dev is a separate PUBLIC instance `gifsy-db-dev`. You
  CANNOT reach staging/prod DB from a laptop or a GH runner — run migrations/seeds/one-off SQL as **in-VPC Cloud Run
  Jobs** (for one-off SQL: a `node -e eval(Buffer.from('<base64>','base64'))` job with the prod/staging `DATABASE_URL`
  secret + `--vpc-connector=gifsy-connector` + `--set-cloudsql-instances=gifsy-platform:asia-south1:gifsy-db` +
  `--service-account=gifsy-api-sa@…`; the `^@^` gcloud arg-delimiter avoids comma-splitting). [[migration-model]]
- **`gcloud` is authed and CAN read+write secrets here** (used it to fix `DATABASE_URL_STAGING`, the BOM'd
  `MSG91_AUTH_KEY` v5, `CORS_ORIGINS` v3). **`wrangler` is Cloudflare-authed.** The dev Cloud SQL proxy uses the
  `--token` trick (`& "$env:TEMP\cloud-sql-proxy.exe" <conn> --port 5433 --token (gcloud auth print-access-token)`;
  ADC is NOT set up — don't ask the owner for `application-default login`).
- **OTP: prod = real MSG91 only; staging = `FIXED_OTP=123456`** (re-enabled 2026-06-22 for fast UAT, gated by `isFixedOtpAllowed` to the `gifsy_staging` DB, hard-denied on `gifsy_prod`; set in `deploy-staging.yml`, revert by unsetting `ALLOW_FIXED_OTP`). Local dev = `FIXED_OTP=123456`. **MSG91 secrets must be saved WITHOUT a UTF-8 BOM** (a BOM on `MSG91_AUTH_KEY` 500'd OTP via a fetch ByteString error; `.trim()` in `msg91.service` now defends).
- **The Chrome extension blocks NEW domains** until the owner adds them to the extension's own allowed-sites list
  (separate from Chrome's site-access). It refused `uat.deoleoloyalty.gifsy.in` ("Navigation to this domain is not
  allowed") even with Chrome site-access on — so own-domain UI driving may need the owner to allow the domain first.

## Operating model (unchanged — owner-agreed)
You ORCHESTRATE, plan, GATE, own docs. **Per task: plan (Opus) → execute (Sonnet executor, background, NO shell — you
run the gate) → ONE independent adversarial audit (fresh agent, Read/Grep) → Opus gate → RUNTIME-VERIFY → commit → doc
sweep.** **AUDIT EVERYTHING — do not risk-tier** (the owner caught me skipping audits TWICE this session; the audit
then found a real defect every time, incl. a money-path TDS-index drop on the prod cutover). **DIAGNOSE BEFORE BUILD
(owner caught me 2026-06-21 about to rebuild a hierarchy read that P2.1 deliberately designed as snapshot-fed):** before
proposing ANY fix, answer two questions and cite evidence — (1) **Design intent:** what do the plan/reconcile docs say
this was MEANT to do? Is the current behaviour deliberate? (`00-MASTER-PLAN` 2.1 = "save persists the relational tree IN
ADDITION TO the JSON snapshot" → the snapshot is the intended read model; the empty page was a *seed-fixture* artifact,
not a code gap.) (2) **Real data path:** how does data ACTUALLY arrive for go-live — the upload/PUT or the #76 load
script, NOT the seed fixture? Does that path already satisfy the requirement? Never inherit a gap-register entry's framing
without re-deriving it; never mistake the seed (a test fixture) for the canonical data path. **Auditors must be handed the
PROBLEM to re-derive, NOT my proposed FIX to rubber-stamp** — a leading, solution-shaped claim makes the audit validate
the wrong thing (that's how the hierarchy misframe slipped 2 auditors). Parallelize disjoint-file
streams; **Opus owns `schema.prisma` + migrations** so executors never collide. **Definition of done
(`VERIFICATION-PROTOCOL.md`):** a real user, in the correct role, completes the flow end-to-end at RUNTIME against
realistic data — `tsc`/unit-tests/audits are necessary, NEVER sufficient. ⚠️ **The hard lesson this session: staging
had NEVER been exercised end-to-end, so 4 stacked login bugs sat latent until the owner logged in. Run real flows
EARLY — don't trust "it's deployed" = "it works".** The gate (run it YOURSELF): `cd api && npx tsc -p
tsconfig.build.json --noEmit` (0) + `npx jest <area>`; FE: `cd platform && npx tsc --noEmit` + `npx vitest run <area>`
(platform = **vitest**) + `node scripts/check-doc-consistency.mjs` GREEN. **🚦 BEFORE EVERY PUSH run the FULL suites — `cd
api && npx jest --no-coverage` (N/N, 0 failed) + `cd platform && npx vitest run` — exactly what CI's `test` job gates the
DEPLOYS on. A red full suite SILENTLY SKIPS all staging deploys (`needs: test`); it froze staging a whole day 2026-06-21 on
2 stale specs while my targeted gate stayed green. And "pushed" ≠ "deployed" — verify the serving Cloud Run image SHA
ends in `staging-<short-sha>` (`gcloud run services describe gifsy-frontend-staging|gifsy-api-staging`) + curl the surface
before claiming UAT-ready. See [[staging-deploy-gate]].** Sweep docs (RESUME/bundle/gap-register/
reconcile/memory) after every task (`DOC-MAINTENANCE.md`).

## Constraints (must hold)
- **Work on `develop`.** `main` = prod releases — they go out via the cutover/CI path WITH the owner approving the
  GitHub "production" gate (that's how the cutover shipped). **Commit/push ONLY when the owner asks.** Never expose
  secrets. ⚠️ Don't `git add -A` while a background executor is mid-write.
- **DB migrations:** baseline + `migrate deploy` via the in-VPC job (above). **NEVER `prisma migrate dev`** (resets
  `gifsy_dev`). `migrations-manual/` is LEGACY (don't add to it). For any **prod/staging DB op**: double-guard
  (`current_database()` assert) + take a backup + show the SQL + WAIT for owner go (the instance hosts prod).
- **DEV DB** = `gifsy-db-dev` via Auth Proxy on `127.0.0.1:5433` / `gifsy_dev` (drops after reboot — `DEV-DB.md`).
  `SELECT 1` + confirm `current_database='gifsy_dev'` before touching it. NEVER point dev at prod. ⚠️ `api/.env` was
  once found pointing at PROD — re-verify it reads `127.0.0.1:5433/gifsy_dev`. **Schema source of truth =
  `api/prisma/schema.prisma`.**
- **Backend dev gotchas:** runs a compiled `dist/`; repeated `tsc --noEmit` poisons `tsconfig.tsbuildinfo` → rebuild
  with `tsc -p tsconfig.build.json --incremental false` then `node dist/main.js`; a stale backend may hold :4000
  (`Get-NetTCPConnection -LocalPort 4000` → `Stop-Process`). FE :3000 is `next dev` (live from disk).

## Architecture + the REAL model (do not relitigate)
- **API-first:** `api/` (NestJS) owns the DB + all logic; thin Next.js FE over a `next.config.ts` proxy (`/api/*` →
  backend `/v1/*`, wrapped `{success,data}`). **Never add local `app/api/*` routes** (the proxy forwards; such routes
  are dead). [[architecture-backend-split]] · `docs/spec/04-architecture.md`.
- **The real model** ([[platform-real-model]]): sales/achievement = **upload FINAL amounts per outlet × parameter, NO
  compute**; program = a reporting/filter facet, NOT a targeting dimension; no point-tiers, no SKU. Validate inherited
  concepts against this before building ([[reconcile-fit-before-build]]).

## Reference (read before building)
- Launch: `DEOLEO-GO-LIVE-BUNDLE.md` · `GO-LIVE-READINESS.md` · `POST-GO-LIVE-BACKLOG.md` · `runbooks/PROD-CUTOVER-RECORD.md`
  · `E2E-COVERAGE-PLAN.md` · `MIGRATIONS.md` · `runbooks/{PROD-DB-MIGRATION,PROD-DATA-WIPE}.md` · `ENVIRONMENTS.md`
- Build/process: `00-MASTER-PLAN.md` · `08-agent-execution-guide.md` · `VERIFICATION-PROTOCOL.md` · `DATA-VISIBILITY.md`
  · `DOC-MAINTENANCE.md` · `RBAC-ENABLEMENT.md` · `DEV-DB.md` · `GIT-WORKFLOW.md` · `docs/spec/gap-register.md` (latest #54)
- memory: [[deoleo-go-live-bundle]] · [[migration-model]] · [[audit-every-build-item]] · [[verify-flows-at-runtime]] ·
  [[e2e-harness]] · [[environments-topology]] · [[architecture-backend-split]] · [[platform-real-model]] · the P3–P6 completes.
- **Seeded phones — LOCAL `gifsy_dev`** (FIXED_OTP=123456): gifsy `9830011252`/clientId `gifsy`, deoleo admin
  `9000000001`, partner `9000000002`, sales `9000000003`, clientb admin `9000000020`. **STAGING `gifsy_staging`**
  (**FIXED_OTP=123456** since 2026-06-22): GIFSY admin `9830011252`/clientId `gifsy`, deoleo admin `6289864191`, partner+outlet `7795096288` (sales `9875436349` parked off its user 2026-06-22). **PROD `gifsy_prod`: EMPTY.**
- Local: dev proxy `127.0.0.1:5433` (DEV-DB.md); FE `:3000` (`next dev`); backend `:4000` (rebuild `dist` + `node
  dist/main.js`). Confirm on `develop` + dev DB reachable. Before any irreversible/prod step, show the plan (audited) + wait.
```
