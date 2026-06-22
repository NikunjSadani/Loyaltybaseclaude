# UAT Checklist — Deoleo Loyalty on the Gifsy platform

> **Purpose.** The exhaustive, tester-executable acceptance script for the Deoleo go-live. Every row is run by a **real user in
> the correct role, end-to-end through the real stack** (FE → proxy → backend → DB), against realistic data — `tsc`/unit/E2E are
> necessary but never sufficient (`VERIFICATION-PROTOCOL.md`). A flow is **DONE** only when a different session sees the persisted
> result and the unhappy path is honest. Mark each row ✅ / ❌ / ⬜ (n/a) and add notes.
>
> **Scope of this revision (2026-06-22).** Updated after the GO-LIVE FIX WAVE (all 6 blockers + 5 majors closed — see
> [`GO-LIVE-ISSUE-LIST.md`](GO-LIVE-ISSUE-LIST.md)). New/strengthened sections call out the just-fixed behaviours: **§5 money
> eligibility + settlement**, **§6 TDS multi-row + finance**, **§3 scheme catalog + enrollment persistence**, **§7 RBAC /
> privilege-escalation**. Run those with extra care — they are the riskiest and newest.
>
> **Robustness expansion (2026-06-22, independent platform audit).** §1–§11 cover **functional correctness** (the axis we've
> been burned on). §12–§19 add the three axes an industry-grade go-live for a **real-money, multi-tenant, India-tax platform**
> also needs: **security beyond RBAC** (§12–§13), **non-functional** (§14 scale, §15 concurrency/resilience), and
> **operational + regulatory readiness** (§16 tax/DLT/audit, §17 ops, §18 real-data load, §19 device/locale). Every row is
> tiered and owned — see the legend below.
>
> **Tier legend.** 🔴 = **go-live BLOCKER** (the "passed UAT, broke at launch" class — must be green). 🟠 = **strongly
> recommended before real money**. 🟡 = **post-launch acceptable** (verify or consciously defer to `POST-GO-LIVE-BACKLOG.md`).
>
> **Owner legend.** `[A]`–`[F]` = the parallel UAT streams (A Auth/RBAC · B KYC · C Schemes/Targets · D Wallet/Redemption ·
> E Finance/TDS · F UI/UX-readonly). **`[operator]` = run by the owner/orchestrator on STAGING/PROD** — these cannot be proven
> on the local automated stack (DLT delivery, prod backdoor state, backups/PITR, scheduled-job execution, real-data load,
> Cloud Run scale/timeout, multi-instance throttling).

---

## 0. Pre-UAT setup (do once, before any section)

| # | Step | Expected | ✅/❌ |
|---|---|---|---|
| 0.1 | Confirm the env under test. **UAT runs on STAGING** with **real MSG91 OTP** (no fixed OTP). Subdomains: GIFSY `uat.app.gifsy.in`, Deoleo `uat.deoleoloyalty.gifsy.in`. | Both load the login screen over HTTPS. | |
| 0.2 | Confirm the serving image is the fix-wave build — `gcloud run services describe gifsy-api-staging` / `gifsy-frontend-staging` shows an image tag ending in the latest `develop` short-SHA. | SHA matches the pushed fix-wave commit. | |
| 0.3 | Confirm the staging DB has been migrated to include `20260621120000` + `20260621130000` (auto-applies on `develop` push). | Migrations show as applied; no pending. | |
| 0.4 | Have the **test phone numbers** for each role ready (real SIMs to receive OTP). Confirm them against the **current staging seed** before starting (these have drifted across seeds — verify, don't assume): GIFSY admin, Deoleo CLIENT_ADMIN, partner+outlet, sales user, (optional) MIS. | Each number receives an OTP SMS. | |
| 0.5 | Pick **two browsers/profiles** (or incognito) so a write made in session A can be independently verified in session B (the persistence check). | Two isolated sessions available. | |
| 0.6 | ⚠️ **Known pre-UAT item:** the admin sub-dashboards `/admin/dashboards/{payments,engagement,redemptions,kyc}` may still render mock figures (gap #57a) — they are OUT OF UAT SCOPE until wired/hidden. Do not test them. | Tester is aware; skips them. | |

---

## 1. Authentication & access control

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 1.1 | GIFSY admin | Login via `uat.app.gifsy.in` with OTP. | Lands on the GIFSY console; identity shows the real operator, not a demo persona. | |
| 1.2 | CLIENT_ADMIN (Deoleo) | Login via `uat.deoleoloyalty.gifsy.in`. | Lands on the Deoleo admin dashboard, scoped to Deoleo. | |
| 1.3 | Partner | Login with the partner phone. | Lands on the partner app (wallet/home). | |
| 1.4 | Sales | Login with the sales phone. | Lands on the sales app (beat/tasks). | |
| 1.5 | Any | Enter a **wrong OTP**. | Honest error; no login; no session created. | |
| 1.6 | Any | Request OTP twice quickly (resend). | Rate-limit/cooldown behaves; latest OTP works. | |
| 1.7 | Any | **Logout**, then press Back / reuse the old tab. | Session cleared; protected pages bounce to login. | |
| 1.8 | Any | (Security) After login, an admin **revokes the user's session** (or the user logs in elsewhere changing identity). On the next request the old access token is rejected. | Old token → 401 promptly (≤ a few minutes / next refresh). | |
| 1.9 | Wrong role | A partner/sales user manually navigates to an `/admin/*` URL. | Scoped out — redirect or honest 403, never admin data. | |

---

## 2. Onboarding & KYC (P3)

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 2.1 | Partner/Sales | Start a KYC submission for an outlet; fill required fields + photos (with geo). | Submission saved as in-flight; cannot start a duplicate while one is pending. | |
| 2.2 | Approver (per routing) | Two-stage **field-level** review: approve/clarify individual fields, then final approval. | Field decisions persist; status advances through the routing chain. | |
| 2.3 | CLIENT_ADMIN / GIFSY | **Approve** the KYC. | Status → APPROVED; **the owning outlet becomes active** (`isActive` flips true). Verify in session B / outlet list. | |
| 2.4 | — | Trigger **RE_KYC** on an APPROVED partner. | Status flips to RE_KYC_REQUIRED in place; the partner is now treated as not-approved for payouts (see §5). | |
| 2.5 | — | Re-upload after RE_KYC. | No 500; clean conflict handling if a stage is wrong; resubmission accepted. | |
| 2.6 | GIFSY | Open `/admin/kyc/approvals` review workspace. | Pending queue renders **real** rows; for GIFSY it spans **both tenants**, tagged by brand (cross-tenant read). | |

---

## 3. Schemes / Programs / Enrollment (P4) — *catalog + enrollment rewired (GLB-5)*

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 3.1 | CLIENT_ADMIN | Create/publish a scheme in the Scheme Builder. | Scheme persists to the backend (not localStorage); appears in the admin schemes list. | |
| 3.2 | Partner | Open the dashboard; view the scheme acceptance banner. | The banner shows the **real** admin-published scheme(s) — **NOT** demo names like "Summer Push Q2" / `sch_q2_2026`. | |
| 3.3 | Partner | **Accept & enrol** a scheme (SELF). | Enrollment **POSTs to `/api/schemes/:id/enroll`** and succeeds (no 404). Verify it persists. | |
| 3.4 | Partner | **Reload** the page after enrolling. | The enrolled scheme **no longer re-appears** as pending (it's excluded via the backend). | |
| 3.5 | Sales | Sales-assisted enrol on behalf of a partner outlet (SALES mode + OTP step). | Enrollment persists against the correct **ChannelPartner** (not the outlet id); admin export/list shows it. | |
| 3.6 | CLIENT_ADMIN | Download the targets template → fill → upload (verbatim, no compute). | Round-trips; uploaded final amounts stored per outlet × parameter. | |
| 3.7 | CLIENT_ADMIN | Upload achievement data; partner views target vs achievement + pace. | Achievement stored; partner sees real numbers. | |
| 3.8 | Sales | Sales dashboard scheme widget. | Shows **real** schemes (no demo data on this live surface). | |

---

## 4. Wallet / Points / Rewards / Redemption (P5)

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 4.1 | Partner | Open wallet. | Real redeemable / lifetime balances; no fabricated figures. | |
| 4.2 | Partner | View the reward catalog. | Real `RewardCatalog` items (no JSON-blob demo gifts). | |
| 4.3 | Partner | Redeem a **points/voucher** reward → confirm with OTP. | Points debit exactly once; order created; ledger + passbook updated. Verify balance in session B. | |
| 4.4 | Partner | Attempt to redeem with **insufficient balance**. | Honest 400; **no debit**; no order stranded. | |
| 4.5 | Partner | **Double-submit** the same confirm (rapid). | Only one debit / one order (atomic claim); the second is rejected. | |
| 4.6 | Admin/Partner | Order lifecycle: progress → fulfil; trigger a refund where allowed. | Status history correct; refund returns points **once** (idempotent). | |
| 4.7 | Admin | Bulk fulfilment Excel download → fill → upload. | Round-trips; statuses update. | |

---

## 5. Money path — eligibility, zero-value, redemption settlement *(GL-Money + GL-FE-settle — the riskiest section)*

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 5.1 | Partner | Redeem an **INR cash** reward (UPI / BANK_TRANSFER) → OTP confirm, for an **APPROVED + active** partner. | Confirms; points debit; a `PayoutTransaction` is created for the order. | |
| 5.2 | — | **GLB-1 eligibility:** move a partner to **RE_KYC_REQUIRED** (or deactivate the outlet), then attempt a cash redemption confirm. | **Blocked** with an honest error **before** any debit — an ineligible partner cannot be paid. | |
| 5.3 | — | **GLB-1 TOCTOU:** partner is eligible at the start of confirm but is suspended mid-flow. | No points are debited for the now-ineligible partner (in-tx re-check rolls back). | |
| 5.4 | — | **GLB-2 zero-value:** (config check) confirm that a cash redemption never debits points for a ₹0 payout. | Zero-value cash redemption is rejected/rolled back; backend refuses to boot on a `POINTS_CONVERSION_RATE` ≤ 0. | |
| 5.5 | — | **Manual cancel block:** try to manually CANCEL/RETURN/FAIL a CONFIRMED INR redemption. | Refused — INR redemptions are uncancellable once OTP-confirmed; reversal is driven **only** by an uploaded UTR=FAILED. | |
| 5.6 | GIFSY | **GLB-6 settlement UI** (`/admin/payouts`): create a batch → **assign pending** transactions → **process**. | Each step calls the real backend and the batch advances (DRAFT→…→SUBMITTED); fund summary card shows **real** numbers (no mock "₹1.24 Cr"). | |
| 5.7 | GIFSY | Download the **UTR template** for the batch. | A real `.xlsx` downloads. | |
| 5.8 | GIFSY | Fill UTR = **SUCCESS** for a row → upload. | Matched transaction → SUCCESS, order → DELIVERED; no wallet change. | |
| 5.9 | GIFSY | Fill UTR = **FAILED** for a row → upload. | Transaction → FAILED; points reversed **once** (idempotent on re-upload). | |
| 5.10 | GIFSY | Re-upload the **same** UTR file. | Idempotent — no double settlement / double reversal. | |
| 5.11 | GIFSY | Select a batch whose transactions exceed the first page. | The batch's transactions all load (batch-filtered fetch — none silently hidden). | |

---

## 6. Finance — credits, invoicing, TDS *(GL-Money credit rail + GLB-3)*

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 6.1 | CLIENT_ADMIN | Create a credit batch → confirm; credits award to wallets. | Credits land in partner wallets; ledger correct. | |
| 6.2 | CLIENT_ADMIN/GIFSY | Build a **credit payout (bank-file) download** for a period. | Only **APPROVED + active** partners appear as payable rows; **ineligible partners are listed as HELD** (not in the payable file), and their entries stay PENDING for the next download (GLB-1 credit rail). No hardcoded "APPROVED". | |
| 6.3 | GIFSY | Upload UTR=FAILED for a credit entry, then **re-download** the next bank file. | The bank-FAILED entry is **re-bankable** — it re-appears (GLM-2). A corrected re-upload flips it to PAID. | |
| 6.4 | GIFSY | Approve a **PAYOUT-type reversal** for an outlet with one or more entries. | All matching entries are marked **REVERSED** (removed from payability); already-PAID amounts are reported as a recoverable receivable (GLM-1). A REVERSED entry never re-appears in a download. | |
| 6.5 | GIFSY | Process a payout batch containing a transaction **missing beneficiary fields** (UPI without `upiId`, or bank without acct/IFSC). | That transaction is **rejected/excluded** with a clear reason (GLM-3); valid ones proceed. | |
| 6.6 | CLIENT_ADMIN | **TDS 194R off-platform** upload — a file with **multiple rows** (different PANs/amounts). | **GLB-3:** **every row persists** (not just the first); the 194R liability reflects all PANs/amounts. (This was the live bug — verify the stored count = uploaded count.) | |
| 6.7 | CLIENT_ADMIN | **Re-upload the same TDS file**. | Rows are reported as **skipped — duplicate entry** (file-level dedup); totals don't inflate. | |
| 6.8 | CLIENT_ADMIN | Upload a **different** TDS file with a repeat PAN/amount. | New file's rows are recorded (genuine repeat preserved). | |
| 6.9 | CLIENT_ADMIN | View 194R / 194C liability + export. | Liability computed (IST FY boundary); export sanitised (PAN/name cells safe). | |
| 6.10 | CLIENT_ADMIN | Self-bill invoice generation + Excel round-trip. | One invoice per outlet/month; GST derived; round-trips. | |

---

## 7. RBAC & tenant isolation *(GL-RBAC — GLB-4)*

| # | Role | Steps | Expected | ✅/❌ |
|---|---|---|---|---|
| 7.1 | CLIENT_ADMIN | In user management, try to **create a user with role GIFSY_ADMIN** (or CLIENT_ADMIN). | **Forbidden** — a tenant admin cannot mint a super-admin or another client admin (GLB-4). | |
| 7.2 | CLIENT_ADMIN | Try to **promote an existing user to GIFSY_ADMIN** (PATCH). | Forbidden; the role change is rejected; no write. | |
| 7.3 | GIFSY admin | Create/assign GIFSY_ADMIN / CLIENT_ADMIN. | Allowed (GIFSY may assign any role). | |
| 7.4 | CLIENT_ADMIN | Edit a normal user's non-role fields (name/phone). | Succeeds (legitimate flow unaffected). | |
| 7.5 | GIFSY | `/admin/kyc` list page — **Export Excel**. | Export works (real `/v1/kyc/review-dump`); the button is **only shown to GIFSY_ADMIN**. | |
| 7.6 | CLIENT_ADMIN | Confirm the KYC **Export** button is **not** shown (or 403s) for non-GIFSY. | Not available to a tenant admin (no broken 403 UX). | |
| 7.7 | CLIENT_ADMIN (Deoleo) | Across every list (outlets, users, KYC, credits, payouts, dashboards) confirm **no other tenant's data** ever appears. | Strict tenant scoping; cross-tenant never leaks. | |
| 7.8 | GIFSY | Confirm GIFSY **can** reach the cross-tenant data it must (review queue spans brands). | Cross-tenant read works for the operator only. | |
| 7.9 | Support | Ticket **escalation** to an assignee. | Assignee must be **in the same tenant**; a foreign-tenant assignee is rejected. | |

---

## 8. Data integrity & no-fabrication (cross-cutting)

| # | Steps | Expected | ✅/❌ |
|---|---|---|---|
| 8.1 | Spot-check every live page touched in UAT for **fabricated/demo values** (e.g. `4,821`, `8,550`, "Kumar General Store", "Rajesh Kumar", "₹1.24 Cr"). | None on live surfaces (excluding the out-of-scope §0.6 sub-dashboards). | |
| 8.2 | For each WRITE done above, verify it in a **second session** (different login). | The persisted change is visible to another user — no fake success. | |
| 8.3 | Confirm money everywhere is exact (no float drift) and amounts reconcile across wallet ↔ payout ↔ invoice. | Consistent paise-level amounts. | |

---

## 9. Unhappy-path matrix (must all behave honestly)

| # | Scenario | Expected |
|---|---|---|
| 9.1 | Wrong OTP / expired OTP | Honest error, no side effect. |
| 9.2 | Insufficient wallet balance on redeem | 400, no debit. |
| 9.3 | Ineligible (RE_KYC / inactive) partner on cash redeem or payout | Blocked before debit / excluded from batch. |
| 9.4 | Zero-value cash redemption | Rejected/rolled back. |
| 9.5 | Manual cancel of a confirmed INR redemption | Refused. |
| 9.6 | Duplicate TDS file re-upload | Skipped-as-duplicate, totals stable. |
| 9.7 | Double-submit of any money action (redeem confirm, process batch, UTR upload) | Single effect; second rejected/guarded. |
| 9.8 | Privilege-escalation attempt (tenant admin → GIFSY_ADMIN) | Forbidden. |
| 9.9 | Cross-tenant URL/id probing | Scoped out / 404, never another tenant's data. |
| 9.10 | Network/backend error mid-action | Honest error surfaced; no fake success state. |

---

## 10. Excel round-trip & re-upload matrix — *every upload/export surface (exhaustive)*

For **each** row: the template/export **downloads a real `.xlsx`** (open it — headers + sheet correct); fill it; the upload
**parses + persists** (verify in a 2nd session); **bad rows are reported per-row** (not a silent drop); and the **re-upload**
behaves per its design. Also test a **malformed/corrupt file** and a **wrong-template** upload → honest error, **no partial
corruption**. Owning stream in brackets.

| # | Surface | Role | Download→fill→upload | Re-upload expected | ✅/❌ |
|---|---|---|---|---|---|
| 10.1 | **Targets** [C] | CLIENT_ADMIN | template → fill → upload (verbatim, NO compute) | re-upload updates; **past-month lock** enforced | |
| 10.2 | **Achievements** [C] | CLIENT_ADMIN | template → fill → upload; pace recomputes; delete-batch works | re-upload updates the batch | |
| 10.3 | **Bulk fulfilment** (rewards) [D] | admin | download pending → fill statuses → upload | idempotent / status updates | |
| 10.4 | **Credit payout bank-file** [E] | GIFSY/admin | build download (held vs payable) → UTR upload (PAID/FAILED) | re-download **includes FAILED (GLM-2)**; corrected UTR flips FAILED→PAID; **REVERSED never re-appears** | |
| 10.5 | **Redemption payout UTR** (settlement) [D] | GIFSY | `utr-template` → fill → upload (SUCCESS/FAILED) | **idempotent** re-upload — no double settle / double reverse | |
| 10.6 | **Reconciliation** [D] | GIFSY | download reconciliation `.xlsx` | read-only | |
| 10.7 | **TDS 194R off-platform** [E] | CLIENT_ADMIN | template → **multi-row** fill → upload — **ALL rows persist (GLB-3)** | exact-dup re-upload **skipped (reported)**; a *different* file is recorded | |
| 10.8 | **TDS deposits** [E] | CLIENT_ADMIN/GIFSY | template → fill → upload | file-level dedup on re-upload | |
| 10.9 | **TDS 194R / 194C export** [E] | admin | download liability export (IST FY; PAN/name cells sanitised) | read-only | |
| 10.10 | **KYC review-dump / bulk-verify** [A/B] | GIFSY | export dump → fill decisions → `bulk-verify` (dry-run `apply=false`, then `apply=true`) | re-apply idempotent | |
| 10.11 | **Invoices export** [E] | admin | download invoice export | read-only | |
| 10.12 | **Scheme enrollments export** [C] | admin | download enrollments export (reflects real enrollments) | read-only | |
| 10.13 | **Visibility export/upload** [F-adj] | admin | per visibility flow | per design | |
| 10.14 | **Admin users/outlets bulk** [A] | admin | `bulk-upload` (template → fill → upload), `bulk-edit`, `bulk-delete` | re-upload behaves; partial-failure reporting | |

## 11. Navigation & link integrity — *nothing dead, every route reachable*

| # | Steps | Expected | ✅/❌ |
|---|---|---|---|
| 11.1 | For **each role**, click **every item** in that role's nav/shell (and every sub-item). | Each loads a real page — no 404, no infinite spinner, no error boundary, no console error. | |
| 11.2 | On every page reached, click **every button / link / tab / action**. | Each does something valid — no dead `#`/no-op, no console error, no broken modal. | |
| 11.3 | **Deep-link** each route by pasting the URL directly (fresh load). | Loads with auth + real data (not a flash of error/empty then content). | |
| 11.4 | Browser **back/forward** across a multi-step flow (e.g. redeem, settlement, KYC). | State stays coherent; no broken/blank screen. | |
| 11.5 | Navigate to a **truly-bad route** (`/admin/nonexistent`). | Graceful 404/not-found page, not a crash. | |
| 11.6 | Confirm **no orphan route renders mock data** (e.g. the #57(a) sub-dashboards if not hidden). | Either hidden, or known-mock + flagged — never presented as real. | |
| 11.7 | Cross-shell: a partner/sales URL opened as admin (and vice-versa). | Scoped out, never the wrong shell's data. | |

## 12. Security — authorization depth & abuse *(beyond §7 role/tenant; covers audit findings A1/A2/A5/A6 + mass-assignment)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 12.1 | 🔴 | [D] | **IDOR — redemption rail.** As partner A, fetch/act on **partner B's** `RedemptionOrder` / `PayoutTransaction` id directly (same tenant — guess/increment the id). | 403/404 — never B's data or B's order acted on. Object-level (horizontal) auth, not just tenant scope. | |
| 12.2 | 🔴 | [A/E] | **IDOR — finance/KYC.** Same probe against another owner's `Invoice`, `CreditPayoutEntry`, `KycSubmission`, `Wallet` ids within the tenant. | Scoped to the authenticated owner; foreign-owner ids rejected. | |
| 12.3 | 🔴 | [A] | **OTP send-throttle.** Request OTP for one phone repeatedly/rapidly (resend spam). | A per-phone cooldown/limit kicks in; no unbounded SMS (cost + bombing); the attempts counter can't be reset to grant unlimited guesses. *(Code today: `sendOtp` has no resend cooldown — confirm behaviour.)* | |
| 12.4 | 🟠 | [operator] | **Throttler is global, not per-instance.** With prod scaled to >1 Cloud Run instance, confirm rate-limiting is backed by Redis/DB, not in-memory per-instance. | Limits hold across instances (known gap — readiness §3.2). | |
| 12.5 | 🔴 | [A] | **Token after logout/revoke** (extends §1.8). After logout, the old access token is rejected; token never appears in a URL/query string or logs. | Old token → 401; no token leakage. | |
| 12.6 | 🟠 | [F] | **Token storage.** Inspect where the FE keeps the JWT. | If `localStorage`, note the XSS-exfiltration exposure (vs httpOnly cookie) as a finding. | |
| 12.7 | 🟠 | [operator/F] | **FE security headers.** `curl -I` the user-facing HTML origin (Next/Cloudflare, not the API). | CSP / HSTS / `X-Frame-Options`(or `frame-ancestors`) present — partner app not clickjackable. (`helmet()` only covers the API.) | |
| 12.8 | 🟠 | [A] | **Mass-assignment / over-posting.** POST/PATCH a write with extra fields (`clientId`, `role`, `isActive`, wallet/points). | Stripped or 400 — verify `forbidNonWhitelisted` actually blocks at runtime on real write DTOs (GLB-4 was this class). | |

---

## 13. Injection & file-upload safety *(audit findings A3/A4)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 13.1 | 🟠 | [B] | **Stored XSS.** Register/KYC a partner with `businessName` = `<script>alert(1)</script>` (and similar in ticket text, names). | Rendered inert everywhere it surfaces (admin lists/detail, exports) — no script execution. | |
| 13.2 | 🟠 | [E/A] | **CSV/formula injection across ALL exports.** A field starting with `=` `+` `-` `@` flows into **every** Excel export (TDS, invoices, enrollments, bulk users/outlets, reconciliation — not just §6.9's TDS). | Every export neutralises the cell (leading-quote/escape); none is formula-executable in Excel. | |
| 13.3 | 🟠 | [C/E] | **Oversized upload.** Upload a very large `.xlsx` (e.g. 50k rows / large file). | Honest size/timeout handling; size cap enforced; no OOM/500; no Cloud Run memory blow-up. | |
| 13.4 | 🟠 | [A] | **Content-type spoof.** Upload a non-xlsx (renamed `.exe`/`.html`/`.csv`) to a template-upload surface. | Rejected by content sniffing, not extension alone; honest error. | |
| 13.5 | 🟠 | [E] | **Re-export of an accepted formula cell.** A formula-like value accepted on upload is later exported. | Neutralised on export (no round-trip injection). | |

---

## 14. Performance & scale *(audit finding B1 — nothing in §1–§11 runs at volume)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 14.1 | 🔴 | [operator+F] | **Volume pages.** Seed/point at realistic volume (≈10k outlets, ≈100k ledger rows); load outlets, users, wallet/ledger, dashboards, lists. | Acceptable load time; correct pagination; no N+1 stalls or timeouts that a tiny seed hides. | |
| 14.2 | 🔴 | [E] | **Large export vs Cloud Run request timeout.** Export a large TDS/invoice/reconciliation dataset. | Completes within the request timeout (≈60s) **or** is async/streamed — no 5xx/timeout in prod. | |
| 14.3 | 🔴 | [C] | **Large upload vs timeout.** Upload a max-size targets/achievements file. | Completes or chunks; doesn't hit the Cloud Run request cap. | |
| 14.4 | 🟠 | [A] | **Pagination integrity at volume.** List with many pages of rows. | Every row reachable; no dup/skip across pages; stable sort. | |

---

## 15. Concurrency & resilience *(audit findings B2/B3/B4 — beyond §4.5/§9.7 double-submit)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 15.1 | 🟠 | [D] | **Parallel wallet drain.** Two sessions/devices for the **same** partner redeem concurrently against a balance that covers only one. | Exactly one succeeds; no negative balance / oversell (atomic claim proven under real parallelism). | |
| 15.2 | 🟠 | [A] | **Concurrent edit.** Two admins edit the same user/outlet at once. | Coherent last-write or version-conflict — no silent clobber/corruption. | |
| 15.3 | 🟠 | [D] | **Concurrent batch process.** Process the same payout batch from two sessions. | Single effect; the second is guarded. | |
| 15.4 | 🟠 | [operator] | **OTP provider down/slow.** Simulate MSG91 failure/slow response. | Honest error within ~10s (the timeout exists); no hang; user can retry. | |
| 15.5 | 🟠 | [F] | **Backend/DB down mid-flow.** Kill the backend mid-action. | FE surfaces an honest error (no fake success); on recovery, state is consistent. | |
| 15.6 | 🔴 | [D] | **Transaction rollback proof.** Force a failure inside a redemption/credit `$transaction`. | Wallet + ledger + order roll back **together** — no half-debit / orphaned order. | |
| 15.7 | 🟠 | [D] | **Retry idempotency.** Replay the same redeem-confirm / credit-award POST (network-retry simulation). | Single effect — no double-charge (FMCG field 3G makes this real). | |

---

## 16. Regulatory & tax compliance *(audit findings C1/C3/C4 — India-specific)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 16.1 | 🔴 | [operator] | **DLT template registration.** Confirm the MSG91 OTP (and any txn) template is **DLT-approved** with the correct sender ID; send a real OTP to an unfamiliar number on a different telco. | Delivered. *(DLT lives in the MSG91 dashboard, not code — the classic "works in UAT, telcos drop it in prod" trap.)* | |
| 16.2 | 🟠 | [E] | **TDS correctness.** Verify 194R/194C **rate, threshold, grossing-up** on known inputs vs a hand calculation. | Numbers match the rule, not just "a number appears". | |
| 16.3 | 🟠 | [E] | **26Q export format + FY boundary.** Download the TDS export. | Matches Form 26Q expected columns/format; FY boundary is IST-correct. | |
| 16.4 | 🟠 | [B/E] | **GSTIN checksum + GST rate.** Enter an invalid GSTIN (bad checksum) and a valid one. | Invalid rejected on input; valid accepted; GST rate/derivation correct. | |
| 16.5 | 🟠 | [E] | **Invoice numbering.** Generate self-bill invoices across a month. | Numbers are sequential, **gap-free**, unique per series (a GST requirement) — no dup/missing. | |
| 16.6 | 🟡 | [E/A] | **PAN masking.** View PAN in UI and exports. | Masked in UI (full only where authorised); exports sanitised. | |
| 16.7 | 🟠 | [A] | **Audit-trail coverage.** Spot-check that every money action, KYC decision, and role change writes an immutable `auditLog` row attributable to the real actor (incl. assumed-tenant → real operator). | Coverage is complete, not partial (model exists — verify it's actually written on each path). | |

---

## 17. Operational readiness *(audit findings C2/C5/C6/C7 — mostly operator-run on staging/prod)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 17.1 | 🔴 | [operator] | **Prod backdoor sweep** (runtime, not code). Confirm `NODE_ENV=production`, `FIXED_OTP` inert, DemoSwitcher absent, no seed/debug routes reachable, errors don't leak stack traces. | No dev backdoor live in prod. | |
| 17.2 | 🔴 | [operator] | **Backups + PITR** on `gifsy-db`, with **one restore rehearsed** to a scratch DB. (#74) | Automated daily backup + PITR ON **before** any real data lands (unrecoverable otherwise). | |
| 17.3 | 🟠 | [operator] | **Scheduled jobs.** Confirm how points-expiry / FY jobs actually execute in prod (`ScheduleModule` is wired; an in-process `@Cron` won't fire reliably on a scale-to-zero / multi-instance Cloud Run — likely needs Cloud Scheduler). | Job runs exactly once — no double-fire, no never-fire. | |
| 17.4 | 🟠 | [operator] | **Observability.** Trace a single redemption end-to-end in Cloud Logging (request/correlation id); fire a synthetic error. | Traceable; the #74 monitoring alert actually fires. | |
| 17.5 | 🟠 | [operator] | **Deploy rollback.** Confirm a bad deploy can be rolled back (prior Cloud Run revision). | Rollback path proven; migrate `--wait` is the real gate. | |

---

## 18. Real-data-load acceptance (#76) *(audit finding D1 — the riskiest single go-live event)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 18.1 | 🔴 | [operator] | **Dry-run** the Deoleo master load against a realistic **copy** (never prod first). | Completes; row counts reconcile (rows-in = rows-out). | |
| 18.2 | 🔴 | [operator] | **Idempotency.** Re-run the load. | No duplicates (same phone/GSTIN/PAN deduped); no corruption. | |
| 18.3 | 🔴 | [operator] | **Encoding/format.** Indian names/special chars intact; phone/GSTIN/PAN validated; bad rows **reported, not silently dropped**. | Clean, attributable rejection of bad rows. | |
| 18.4 | 🔴 | [operator] | **Post-load spot-check.** Sample partners/outlets/catalog/schemes vs the source file; a real loaded user logs in. | Loaded data matches source; login works. | |
| 18.5 | 🔴 | [operator] | **Gate order.** Confirm the load runs only **after §17.2** backups/PITR are ON. | No real data before recoverability. | |

---

## 19. Device / browser / network / localization *(audit findings D2/D3/D4)*

| # | Tier | Owner | Steps | Expected | ✅/❌ |
|---|---|---|---|---|---|
| 19.1 | 🟠 | [F] | **Cross-browser.** Partner & sales apps on Chrome / Safari / Edge. | Render + function correctly on each. | |
| 19.2 | 🟠 | [F] | **Mobile viewport.** Partner/sales are field-mobile users. | Layout, tap targets, no overflow on a real phone viewport. | |
| 19.3 | 🟠 | [F] | **Slow network.** Throttled 3G on partner/sales flows. | Usable; honest loading states; no broken timeouts (rural field reality). | |
| 19.4 | 🟡 | [F] | **Currency/number format.** ₹ + Indian grouping (lakh/crore). | Correct formatting; amounts reconcile to paise. | |
| 19.5 | 🟡 | [operator] | **IST consistency.** FY boundary, expiry, lastLogin, invoice date. | IST everywhere — no UTC slip mis-dating a TDS FY. | |
| 19.6 | 🟡 | [F/operator] | **Launch comms posture.** Confirm which transactional notifications are live for launch (DLT applies to those too); absence of the rest is an accepted decision. | Explicit launch decision, not a silent gap. | |

---

## 20. Sign-off

| Gate | Owner | Status |
|---|---|---|
| §1 Auth | | |
| §2 KYC | | |
| §3 Schemes/Enrollment | | |
| §4 Wallet/Rewards | | |
| §5 Money/Settlement | | |
| §6 Finance/TDS | | |
| §7 RBAC/Isolation | | |
| §8–9 Integrity & unhappy paths | | |
| §10 Excel round-trips & re-uploads | | |
| §11 Navigation & link integrity | | |
| §12 Security (authz depth & abuse) | | |
| §13 Injection & file-upload safety | | |
| §14 Performance & scale | | |
| §15 Concurrency & resilience | | |
| §16 Regulatory & tax compliance | | |
| §17 Operational readiness | | |
| §18 Real-data-load acceptance (#76) | | |
| §19 Device/browser/network/localization | | |

**UAT is PASS only when every 🔴 blocker across §1–§19 is green** for the in-scope roles, every 🟠 row is green or explicitly
risk-accepted, every write was independently verified to persist, every Excel surface round-tripped **and** re-uploaded
correctly, every navigation link/route worked, and every unhappy/edge/security/concurrency path was honest. 🟡 rows are verified
or consciously deferred to `POST-GO-LIVE-BACKLOG.md`. Defects → log against `GO-LIVE-ISSUE-LIST.md` with role + steps +
expected vs actual + tier.

**Out of UAT scope (tracked separately):** admin sub-dashboards #57(a) (mock — hide/wire first), notification worker/banners
(P7), the post-launch backlog (`POST-GO-LIVE-BACKLOG.md`), and owner-ops (monitoring/backups/secret-rotation #74). Real Deoleo
master-data load into prod (#76) must precede prod UAT.
