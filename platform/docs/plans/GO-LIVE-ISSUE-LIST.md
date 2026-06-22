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
| U6 | Cash redemption (UPI/Bank): partner saw **fabricated** bank details; should be one free-amount flow from KYC, one offline settlement file | **Unified cash payout:** real-KYC beneficiary on `/me`; admin cash-item free-amount-with-min (un-gated); settlement export = one file (all bank/UPI cols, blank where missing); **upstream beneficiary guard BEFORE debit.** Independently audited SAFE. | `4de8794` | ⚠️ **committed, NOT pushed (money path — owner pushes)** |

**Migration this session (dev-applied):** `20260622120000_kpi_one_primary_per_client` (self-healing partial unique index). **Session-end gate:** api jest **940**, FE vitest green, tsc clean. **Open:** push `4de8794`; owner re-test pushed fixes on staging; gap-#57(a) sub-dashboards still mock (hide/wire); the planned **5-agent parallel UAT sweep is still queued** (went owner-driven). **Recurring lesson:** `next dev` (tolerant, skips tsc) ≠ `next build` (strict) — verify FE fixes against a prod build or deploy + owner-retest.

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
