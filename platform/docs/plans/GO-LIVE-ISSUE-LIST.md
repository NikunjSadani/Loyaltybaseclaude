# Go-Live Issue List — authoritative master tracker (updated 2026-06-22)

> **STATUS: FIX WAVE COMPLETE + pushed. NOW = OWNER-DRIVEN UAT on staging — fix-as-you-find (see the UAT-FOUND block below).**
> Originally NOT go-live ready (6 blockers + 4 majors). The GO-LIVE FIX WAVE (2026-06-21→22) closed them via disjoint streams
> (GLM · GL-Money · GL-RBAC · GL-FE-enroll · GL-FE-settle), each executor → INDEPENDENT adversarial audit → Opus gate →
> runtime-verify. The money re-audit caught a real BLOCKER the first pass missed (GLM-2 never implemented = lost awards) plus
> a payouts-rail resolver gap — both then fixed and re-verified. See the FIX WAVE RESULTS block below.

## 🔎 UAT-FOUND FIXES (2026-06-22, owner testing staging) — each diagnosed → executor → INDEPENDENT audit → gate → runtime-verify
| # | Found | Fix | Commit | Status |
|---|---|---|---|---|
| U1 | Employee Hierarchy upload "not a valid .xlsx" on the **downloaded template** | `XLSX.read(ArrayBuffer,{type:'array'})` needs a **Uint8Array** — dev-build tolerates it, **`next build` (staging) throws**. Coerce + un-swallow the real error + Playwright round-trip test. | `5601ba8` | ✅ pushed |
| U2 | Hierarchy upload `(raw[..]??'').trim is not a function` | SheetJS returns **numbers** for numeric cells; `String(v??'').trim()` in both parse paths + numeric-cell vitest. | `be9d685` | ✅ pushed |
| U3 | Sales-data/target upload values land on the **WRONG KPI** (when a cell is blank) — DATA INTEGRITY | parser mapped KPI cols POSITIONALLY off the row-1 merged month header → drift mis-assigns; rewrote to **name-keyed absolute-column** mapping + integrity guard. Covers target + achievement (shared parser). | `089270d` | ✅ pushed |
| U4 | Upload error lists are a 100-row on-screen table, un-fixable | shared **downloadable .xlsx error report** (`lib/error-report.ts` + button) on Outlet Master + Targets + Payout-UTR + KYC bulk-verify. | `a811fe2` | ✅ pushed |
| U5 | "Primary" KPI could be ticked on **multiple** rows (should be exactly one; "changeable not addition") | **4-layer single-primary:** UI radio (move) + backend `setPrimary`+`P2002→409` + **self-healing partial unique index** `20260622120000` + retired 2 **dead** KPI blob stores. Plan + impl independently audited. **Layer 4b (partner surface honors isPrimary) DEFERRED.** | `c17887c` | ✅ pushed |
| U6 | Cash redemption (UPI/Bank): partner saw **fabricated** bank details; should be one free-amount flow from KYC, one offline settlement file | **Unified cash payout:** real-KYC beneficiary on `/me`; admin cash-item free-amount-with-min (un-gated); settlement export = one file (all bank/UPI cols, blank where missing); **upstream beneficiary guard BEFORE debit.** Independently audited SAFE. | `4de8794` | ✅ pushed |
| U7 | Employee Hierarchy upload "shows N → **0 after refresh**" (regular template) | Snapshot stored `[[],[]]`: the global ValidationPipe (`whitelist+transform+enableImplicitConversion`) mangled the untyped `employees: any[]` into Array instances (JSON-serialize to `[]`) + stripped props. PUT now reads the **raw Express body** (passthrough blob) + 400-guards malformed elements. | `771276f` | ✅ pushed |
| U8 | KPI "name override" was a **dead setting** — template had no name column, nothing displayed | Wired end-to-end: template emits a name column per override KPI; parser stores per-outlet names in a reserved `targetValues.__names` map; partner Targets view shows custom-name-if-set-else-label. No schema change. Runtime-proven round-trip + independent audit SOUND. | `0fa9d92` | ✅ pushed |
| U9 | Employee Hierarchy **CHAIN** upload (18-col, →11 emps) "11 created → 0 after refresh" — **the real recurring bug** | Staging logs: `salesHierarchyLevel.upsert` P2002 on `(clientId,level)` → whole `$transaction` rolled back → snapshot lost; FE hid the 500 (fire-and-forget PUT + swallowed `.catch()`). Fix: free the level space before re-assign (collision-proof, orphan-safe) + tx timeout + **FE awaits PUT & surfaces errors** + reload-round-trip E2E. **A/B-proven** (same deoleo tenant: 500→200+GET 11). Audit SOUND. | `141c385` | ✅ pushed |
| U10 | Pace View **target numbers misplaced** when an outlet has a blank KPI cell | Backend correct (stores/returns by code); the FE Sales pace table built columns from `outlets[0]` but rendered each row's `kpis` array **positionally** → blank KPI shifts values left. Fix: union-of-codes column set + **by-code cell lookup** (blank → "—" in the right column). | `3b4209b` | ✅ pushed |
| U11 | CHAIN upload **STILL 500** after U9 (deployed `3b4209b`) — staging logs showed a **different** P2002: `salesUser.upsert` on **`userId`**. A phone already attached to a sales-user (seed/prior upload) under another code is re-used under a new code → `SalesUser.userId @unique` blows up → 500 → snapshot rolled back. | **Two-part fix.** Backend (`hierarchy-persistence.ts`): pre-write guard rejects, with a clean **400**, (a) a phone given to two codes in one file, (b) a phone already owned by a different existing code / a non-sales account, (c) blank/duplicate `emp.id` (closes a same-symptom **P2002 on employeeCode** the audit found); blank mobile → unique synthetic (no `(clientId,'')` collapse). Frontend (`employee-hierarchy.ts`, owner rule): same employee ID **blank in some rows but filled in others** → hard `BLANK_CONFLICT` in the error report (was silently healed). 7 BE + 3 FE tests; **runtime-proven on live `gifsy_dev`** (conflict→400, clean→persist, blank-id→400); independent audit = core fix SOUND. **Known limitations (recorded, not blocking):** a phone-swap between two codes in one file, and resign→re-hire-same-number, are rejected by policy (owner chose reject-with-clear-error). | `5153bcb` | ✅ pushed |
| U12 | Outlet Master "shows added but did NOT add" | Root cause (data): the **Deoleo tenant had ZERO enabled `OutletTypeClientConfig`** rows, so the backend `upsert` rejected every row as "Unknown outlet type", pushed per-row ERROR + `continue` (no throw) → **HTTP 200, created:0**. FE bug: `onConfirm` showed success on any 200, never reading `created/updated/errors`. Third defect: FE validated types against a **hardcoded** `VALID_OUTLET_TYPES` (also stale — had `SSS`, missing `RETAILER`). **Fix (FE code):** `GET /admin/outlets` now returns the tenant's enabled type codes; `validateOutletUpload` + the **download template + example rows + HTML guide** all source types from THAT (no hardcoded list); `onConfirm` reports success only when `created+updated>0`, else surfaces per-row errors; list re-fetches on success. Backend list() + 5 FE spec cases; runtime-proven (outletTypes query on gifsy_dev); independent audit caught + closed the template-still-says-SSS gap (C1). **NOTE (data, owner-deferred):** Deoleo staging still needs its outlet types **enabled** before outlets can be added. **Known follow-ups:** outlet-type catalog is **inconsistent across envs** (dev has both `SSS`+`RETAILER`; staging only `RETAILER`) — reconcile before #76; other hardcoded type lists remain in `campaign.ts`/`credits-payouts/fields` (L1); rekyc/deactivate `onConfirm` still drop per-row errors on PARTIAL failure (L2, they throw on total failure). | `1bd58e4` | ✅ pushed (deoleo types enabled on staging via guarded job) |
| U13 | **Feature (owner request):** Employee Hierarchy had no way to **download the currently stored hierarchy** | Added a **"Download Current"** button that exports the saved snapshot as the same 18-column chain workbook the upload accepts (download → edit → re-upload round-trip). Pure `buildHierarchyChainExportRows` (inverse of `parseHierarchyChainRows`) walks tree-leaves up via reportsToId; **completeness safety net** guarantees every stored employee appears in ≥1 row (no silent drop on malformed/seed snapshots — found by independent audit). 6 round-trip/edge tests; runtime-confirmed snapshot shape on gifsy_dev. | _pending push_ | 🔧 done, pending push |

**Migrations (dev-applied):** `20260622120000_kpi_one_primary_per_client` (self-healing partial unique index). **U7–U10 carry NO schema change.** **Session-end gate (post-compact session):** api jest **950/950**, FE vitest **1469**, tsc clean both sides; e2e baseline **292/0/8** (the "50-failure" scare was the dev Cloud SQL proxy `--token` expiring mid-run, not product defects). **Recurring lessons:** (1) `next dev` (tolerant) ≠ `next build`/staging (strict) — verify against a prod build or deploy+retest; (2) **method-level `@UsePipes` does NOT override the global pipe** (pipes stack) — raw `@Req().body` is the reliable bypass; (3) a single `$transaction` welds the snapshot to the heavy relational write — any throw loses BOTH; (4) the FE's fire-and-forget PUT + swallowed `.catch()` made every write failure look like success (the root reason the hierarchy bug "kept coming back").

## 🔬 UAT AUDIT FINDINGS — OPEN, for later pickup (2026-06-22 hybrid UAT sweep)
> The planned 5-agent **runtime** UAT sweep was **blocked** (background subagents are denied shell, so they can't drive Playwright). Pivoted to a **hybrid**: orchestrator drives runtime; 4 background agents ran **source audits** (security/injection, money/concurrency, finance/TDS, fabricated-data/nav). The money · finance · RBAC/tenant/IDOR cores were independently **confirmed SOUND**. The items below are **NOT yet fixed** — pick them up next. Each has file:line in the agent transcripts; severity 🔴/🟠/🟡.

| ID | Sev | Finding | Where | Note |
|---|---|---|---|---|
| AF-1 | 🔴 | **Fabricated data on LIVE screens** — partner dashboard hero shows hardcoded target "of **800 cases**" (`resolveConfig(DEMO_*)`); it even contradicts `/partner/targets` | `app/partner/dashboard/page.tsx:135,228` + `lib/targets.ts` | root: `resolveConfig(DEMO_*)` still wired into live dashboards |
| AF-2 | 🔴 | Sales dashboard "Target Achievement" card built entirely from a **mock `OUTLET_ACHIEVEMENTS`** map — no API path | `app/sales/dashboard/page.tsx:90-106` | same `lib/targets.ts` demo source |
| AF-3 | 🔴 | Partner profile → Payment Details always renders **hardcoded HDFC / a/c …3456** (`MOCK_PROFILE.bank`, even on API success) | `app/partner/profile/page.tsx:87,143,146` | the fake bank removed from rewards still lives here |
| AF-4 | 🟠 | Sales outlets table target denominators (/800,/70…) hardcoded; achieved back-computed against fake targets | `app/sales/outlets/page.tsx` | same demo-config family |
| AF-5 | 🔴 | **CSV/formula injection** — partner-supplied strings written RAW (no `cellSafe`) to KYC review-dump, payout/UTR file, credits payout file, all `/reports` exports (finance TDS/invoice exports ARE sanitized) | `kyc-review-dump.ts:143`, `payout-utr.helpers.ts:86`, `credits.helpers.ts:73`, `reports.service.ts:49`, `common/xlsx.ts buildXlsx` | route ALL builders through the existing `cellSafe` |
| AF-6 | 🔴 | httpOnly cookie defeated — the **same JWT is also written to `localStorage`** (7-day TTL) → any stored-XSS exfiltrates a bearer token; the cookie is never used for auth | `auth/login/actions.ts:107`, `login/page.tsx:121`, `api-client.ts:20` | drop the redundant token (cookie OR localStorage, not both) |
| AF-7 | 🟠 | **GSTIN** input capped at **12 chars** (real GSTIN=15) + **no checksum** anywhere; server DTO accepts any string → garbage state-code/PAN derivation for invoices/TDS | `sales/kyc/new/page.tsx:413`, `kyc/dto/kyc.dto.ts:91` | add server-side `@Matches` + checksum |
| AF-8 | 🟠 | Invoice numbering: on a number collision the handler **skips the outlet** (→ no invoice) instead of retrying; sequence not gap-free/transaction-safe | `invoices.service.ts:147-221,269` | make the per-client sequence tx-safe |
| AF-9 | 🟡 | `dangerouslySetInnerHTML` brand-style sink (the only one in the FE) — 🔴 only if `brandStyle` interpolates unsanitized tenant config | `app/layout.tsx:44` | trace `brandStyle` source |
| AF-10 | 🟡 | OTP generated with `Math.random()` (non-CSPRNG); send-throttle is in-memory per-instance (multi-instance bypass); 7-day access token TTL + no per-device logout; KYC upload trusts mimetype (no magic-bytes); legacy `/reports/tds` export omits `cellSafe` | various (see security-audit transcript) | low-risk hardening cluster |
| AF-11 | 🟡 | Achievement template reuses the targets template builder, so an override-name column appears on it and lands in `OutletSalesRecord.kpiValues.__names` — **already stripped on write** (U8 O-1 hardening), inert; noted for future `kpiValues` consumers | `targets.service.ts uploadAchievements` | done-as-hardened; watch if a new reader enumerates `kpiValues` keys |

**Also still open (pre-existing):** gap-#57(a) — the 4 `/admin/dashboards/{payments,engagement,redemptions,kyc}` routes still render mock data (owner-deferred; hide-nav vs wire); Layer-4b partner surface honoring `isPrimary` (deferred). **NOT a defect:** a sales/client employee must log in on the **client's branded domain** (e.g. `uat.deoleoloyalty.gifsy.in`), not the Gifsy operator console (`uat.app.gifsy.in` → tenant `gifsy`) — tenant isolation working as designed (worth a clearer "no account on this portal" message — minor UX, see AF backlog).

## ✅ FIX WAVE RESULTS (2026-06-22)
**Gate (all green):** backend `tsc` ✅ · backend jest **921/921 (42 suites)** ✅ · FE `tsc` ✅ · FE vitest **1459 passed** ✅
· Playwright E2E **green** (287 passed; the 2 flagged were a load-flake [passes in isolation] and a brittle selector on an
unchanged page [hardened, re-ran 11/11]). The 3 FE unit tests for the rewritten payouts/scheme pages were updated to the new behavior.
**Runtime proofs (real `gifsy_dev`):** GLB-3 — two same-file-hash TDS rows persist (old coarse index would drop the 2nd =
the live bug) + exact-dup still rejected; backend boots clean (new `main.ts` `POINTS_CONVERSION_RATE>0` boot check passes);
money rails compile + serve with the canonical KYC resolver + `REVERSED` state live.

| Blocker | Resolution | Verified |
|---|---|---|
| **GLB-1** eligibility both rails | `kyc-eligibility.ts` canonical `resolveEffectiveKycStatus`+`isPartnerPayable` used by credit bank-file, `confirmRedeem`, `confirmRedeemForOutlet`, `processBatch`; non-APPROVED/inactive → held/excluded; `?? 'APPROVED'` gate-default removed | audit + jest |
| **GLB-2** zero-value redemption | cash `valuePaise==0n` hard-fails inside the tx (rolls back); `main.ts` boot check rejects non-finite/≤0 rate | audit + jest + boot |
| **GLB-3** stale coarse TDS indexes | migration `20260621120000` drops both; fine-grained dedup retained | **runtime-proven** |
| **GLB-4** privilege escalation | per-caller assignable-role allow-list in `createUser`/`updateUser`; `...dto` spread removed; tenant-scoped writes | audit + jest |
| **GLB-5** scheme enrollment | enroll WRITE wired to real `POST /v1/schemes/:id/enroll` (SELF/SALES, partnerId); CATALOG wired to real `GET /api/schemes` (no demo IDs); excludes already-enrolled; `sales/dashboard` demo source removed | audit + E2E |
| **GLB-6** payout settlement UI | full lifecycle on real endpoints (create→assign→process→UTR template/upload→reconciliation); mock fund card + setTimeout stub gone | audit + E2E |
| **GLM-1** PAYOUT-reversal clawback | reversal marks ALL matching entries `REVERSED` (new state) + records receivable for PAID | audit + jest |
| **GLM-2** FAILED-credit re-bank | download selects `status in [PENDING,FAILED]`; `REVERSED` excluded (the clash fix) — was NEVER implemented in pass 1, caught by re-audit | audit + jest |
| **GLM-3** beneficiary validation | `processBatch` rejects mode-missing UPI/bank fields | audit + jest |
| **GLM-4** one-payout-per-order | migration partial-unique on `PayoutTransaction.redemptionOrderId` | runtime-applied |
| **GLM-5** fake `/admin/kyc` bulk-approve | removed (no real bulk-by-ids endpoint); export wired to real `GET /v1/kyc/review-dump` | audit |

**Residuals (post-launch, non-blocking):** null-`partnerId` KYC submissions are safe-over-cautious (held, never wrongly paid) on all rails; enrollment-form fetch for real schemes; N+1 `my-enrollment` checks at typical scheme counts; minor RBAC defense-in-depth (in-service GIFSY re-assert on ticket escalate).

---

> **Original register (pre-fix-wave) below for traceability.** Each item has an ID, severity, file:line, the fix, and its
> runtime/E2E verification status.

## S0–S6 E2E runtime audit results (2026-06-21)
| Stream | What | Runtime verdict |
|---|---|---|
| **S0/S4** | TDS file-hash dedup | ❌ **BROKEN — GLB-3 confirmed live**: a 2-row off-platform upload **reported `succeeded:2` but stored only 1** (194R shows 1 PAN / ₹10k; PAN B's ₹20k silently dropped). Stale coarse baseline index. |
| **S1** | redemption UTR ingest + BUG-1 | ✅ verified: redeem→confirm debits exactly; UTR=FAILED reverses + idempotent re-upload; UTR=PAID→DELIVERED no wallet change; manual cash cancel/return/fail → 400. |
| **S2** | auth (atomic refresh + JWT-binding + FIXED_OTP) | ✅ verified: old access token → 401 after refresh; reused refresh token → 401; harness logs in every role. |
| **S3** | KYC approval → outlet activation | ✅ verified (DB ground-truth): approving `seed-kyc-1` flipped null-intent outlet O001 `isActive=false→true`. |
| **S5** | achievement Excel round-trip | ✅ verified: backend template → fill → upload → stored (was 0 rows before). |
| **S6** | FE mock-data removal + guards | ✅ harness no-fabricated-data assertions green + FE tsc/vitest gate. |
| **harness** | full role×page×data matrix | ✅ **292 passed / 0 failed / 7 skipped** against current code (auth, KYC reads, scoping, RBAC write-denials). |

**Takeaway:** 6 of 7 S0–S6 streams runtime-CONFIRMED good; **S4/S0 (TDS) is runtime-CONFIRMED broken (GLB-3)** — it slipped because S4 was jest-only (Prisma mocked). Lesson reinforced: runtime-verify money/DB changes against the REAL dev DB.

---

## 🔴 BLOCKERS — must fix before any real money / UAT (FIX WAVE)
| ID | Sev | Area | Issue | Fix | Status |
|---|---|---|---|---|---|
| **GLB-1** | BLOCKER | money | Eligibility (KYC-APPROVED + isActive) gate MISSING on BOTH rails. `credits.createPayoutDownload` hardcodes `kycStatus:'APPROVED'` (`credits.service.ts:567`), no join to real `KycSubmission.status` → RE_KYC'd/deactivated partners land in the payable bank file with a false APPROVED cert. Redemption rail (`confirmRedeem`/`assignPending`/`processBatch`) has ZERO KYC/active check. A partner moved APPROVED→RE_KYC_REQUIRED still gets paid. | Exclude non-APPROVED + inactive/deleted at the bank-file build (write the REAL kycStatus); mirror at `confirmRedeem`/`confirmRedeemForOutlet` (UPI/BANK) + `payouts.processBatch`. | CONFIRMED (static); needs fix + runtime-verify vs a partner moved APPROVED→RE_KYC mid-flow |
| **GLB-2** | BLOCKER | money | Zero-value redemption: `conversionRate=0` → `valuePaise=0` → points debited, ₹0 payout, order unsettleable (`rewards.service.ts:891/579`). | Hard-fail zero-value cash redemption inside the confirm tx (rollback the debit); validate `POINTS_CONVERSION_RATE>0` at boot. | CONFIRMED (static) |
| **GLB-3** | BLOCKER | data/tds | Stale coarse baseline indexes `tds_off_platform_entries_client_batch_key` + `tds_deposits_client_section_batch_key` (`(clientId,uploadBatchId)`) drop all-but-first row of every multi-row TDS upload (S4 file-hash batchId shared by all rows) → understated 194R/194C base, **reports false success**. | New migration DROPping both stale indexes; runtime-verify a multi-row upload persists ALL rows. | ❌ **CONFIRMED LIVE (E2E)** |
| **GLB-4** | BLOCKER | auth | Privilege escalation: `admin-core.createUser`/`updateUser` write `dto.role` with no allow-list; `/admin/users` open to CLIENT_ADMIN → a tenant admin creates/promotes a user to GIFSY_ADMIN (global super-admin, bypasses @Roles + flips every tenant filter to all-tenants) → full cross-tenant breach. | Per-caller assignable-role allow-list (non-GIFSY callers can't assign GIFSY_ADMIN/CLIENT_ADMIN); stop spreading `...dto` into role. | CONFIRMED (static); needs fix + runtime-verify |
| **GLB-5** | BLOCKER | core-loop | Scheme enrollment writes `localStorage` only — partner (`lib/schemes.ts:253`) + sales (`schemes.ts:283`) never call the real `POST /v1/schemes/:id/enroll` (which EXISTS + is E2E-proven). Enrollments never persist. | Wire both to the real route; runtime-verify persistence + admin export shows it. | CONFIRMED (static) |
| **GLB-6** | BLOCKER | core-loop | Payout settlement has NO working operator UI. `admin/payouts` "Process Batch" is `setTimeout+alert` (`page.tsx:204`); no FE creates/assigns/processes/UTR-uploads a batch. The S1 settle endpoints (real, runtime-proven) have no FE driver → operators cannot settle redemptions. | Build the GIFSY settlement UI on the existing endpoints (create→assign→process→UTR-template→UTR upload). | CONFIRMED (static) |

## 🟠 MAJORS
| ID | Area | Issue | Fix |
|---|---|---|---|
| GLM-1 | money | Credit `CreditReversal` `awardType:'PAYOUT'` is a silent no-op even after the cash was already PAID (`credits.service.ts:821`) — no clawback/receivable. | On PAYOUT reversal: if entry still PENDING/PROCESSING pull it from payability; if already PAID record a recoverable receivable + surface it. |
| GLM-2 | money | A FAILED credit `CreditPayoutEntry` never returns to PENDING (`credits.helpers.ts:695`) → a legitimately-owed award is un-bankable (re-download selects PENDING only). | Reset FAILED→PENDING (or include FAILED in re-download); document corrected re-upload flips FAILED→PAID intentionally. |
| GLM-3 | money | Beneficiary bank fields (UPI id / acct+IFSC) never validated → blank-beneficiary rows in the bank file (`payouts.processBatch` checks only PAN+amount). | In `processBatch` reject txns missing mode-required beneficiary fields. |
| GLM-4 | data | No DB unique on `PayoutTransaction.redemptionOrderId` — one-payout-per-order rests only on an app-layer claim. | Add partial unique `(redemptionOrderId) WHERE NOT NULL` (in the GLM migration). |
| GLM-5 | core-loop | `/admin/kyc` list page fake bulk-approve + export (`setTimeout`+alert; real path exists at `/admin/kyc/[id]` + `/approvals`). | Remove or wire to `POST /v1/kyc/bulk-verify`. |

## 🟡 MINORS
| ID | Status | Issue |
|---|---|---|
| GLm-1 | ✅ FIXED (`c40a420`) | FIXED_OTP send-side (`msg91`) + rate-limit `skipIf` (`app.module`) + DEMO_MODE (`admin-core.bulkEditUsers`) now all require `NODE_ENV!=='production'`. |
| GLm-2 | OPEN | `tickets.escalate` assigns `dto.escalateTo` without validating the assignee is in-tenant (`tickets.service.ts:114`). |
| GLm-3 | OPEN | `kyc.slaMetrics` has one un-tenant-scoped histogram (`:1205`) — GIFSY-only, defense-in-depth tighten to `kycTenantFilter`. |
| GLm-4 | OPEN (post-launch) | Legacy `sid`-less JWTs match on `(userId,clientId)` until they expire — do a hard cutover (reject `sid`-less) post-launch once old tokens age out. |
| GLm-5 | TRACK | In-memory per-instance throttler (limits scale with Cloud Run instances); dead `REDIS_URL` bound but unused. |
| GLm-6 | VERIFY | Confirm prod env has `DEMO_MODE` unset (proxy injects a GIFSY_ADMIN header when set); the proxy `DEMO_MODE` path must be off in prod. |
| GLm-7 | NOTE | TDS file-hash audit flagged a "collision" — MISREAD: it already uses a `\x01` delimiter (od-verified) + fixed 4-field arity = collision-safe. No change. |

## ⏭️ Deferred follow-ups / feature gaps (NOT launch blockers)
- **Schemes enrollments list/stats endpoint** doesn't exist → `/admin/schemes/:id/enrollments` is honestly empty-stated (only the xlsx export is real). Build the backend list/stats endpoint (separate from GLB-5 which wires the *write*).
- **S6 dead code:** `admin/visibility` `VISIBILITY_QUEUE` dead const; wire the real fraud-log (`GET /v1/visibility/fraud-log`).
- **S3 NIT:** RE_UPLOAD `ConflictException` logs nothing server-side — add a `logger.warn` with the submission id before throwing.
- **scheme-builder** `KYC_OUTLET_IDS = new Set() // TODO` (`scheme-builder.tsx:171`) — targeting-preview only.
- **lib sample data** (`lib/invoice.ts MOCK_VISIBILITY_INVOICES`, `lib/points-ledger-export.ts DEMO_OUTLETS`, `lib/campaign.ts MOCK_*`) — confirm not imported by a live page (the core-loop audit traced them as not on live surfaces).
- **#76 prod data load** must create the first GIFSY_ADMIN + the OutletType master rows via API/load-script (the seed is prod-firewalled).
- **#74 owner ops:** Cloud Monitoring alert, automated backups + PITR on `gifsy-db`, prod secret rotation.

## ✅ What the audits CONFIRMED SOUND (do not re-audit)
Money atomic-claims + reversal idempotency (S0/S1 — "could not break it"); tenant data-isolation (no unscoped query across 33
services); RBAC enforcement (one exception = GLB-4); schema↔migration parity (73 tables / 50 enums); BigInt/JSON serialization;
secrets fail-closed (`JWT_SECRET`); money FKs `onDelete: Restrict`; the S0–S6 hardening (S1/S2/S3/S5 runtime-proven; S4 broken per GLB-3).

## Sequence to go-live
1. **FIX WAVE** — close GLB-1..6 + GLM-1..5 (parallel disjoint streams; runtime-verify each against the REAL dev DB).
2. **Re-audit** the changed money/auth/data/core-loop paths + re-run the E2E harness.
3. **#76** load real Deoleo data into empty prod (via API, not seed).
4. **Owner UAT** on staging (real OTP) of the full loop incl. enrollment + settlement.
5. **#74** owner ops (monitoring/backups/cred rotation).
