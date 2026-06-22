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

## 10. Sign-off

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

**UAT is PASS only when §1–§9 are all green for the in-scope roles**, every write was independently verified to persist, and every
unhappy path was honest. Defects → log against `GO-LIVE-ISSUE-LIST.md` with role + steps + expected vs actual.

**Out of UAT scope (tracked separately):** admin sub-dashboards #57(a) (mock — hide/wire first), notification worker/banners
(P7), the post-launch backlog (`POST-GO-LIVE-BACKLOG.md`), and owner-ops (monitoring/backups/secret-rotation #74). Real Deoleo
master-data load into prod (#76) must precede prod UAT.
