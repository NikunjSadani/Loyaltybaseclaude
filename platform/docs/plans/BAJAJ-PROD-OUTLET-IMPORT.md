# Bajaj — production outlet / KYC / document import (runbook + record)

**Status:** ✅ DONE on prod 2026-11-12 (~12:10 IST) and verified. Owner-approved at each step. Visibility history also ✅ DONE 2026-11-12 evening (§8).
**Batch id:** `bajaj-prod-2026-11-12` · **Tenant:** `bajaj` · **DB:** `gifsy_prod` (instance `gifsy-db`)

## 1. Source and scope
- Owner file: `D:\Work\Gifsy\Clients\Bajaj Consumer Care\Loyalty\Files received\2026.11.04\Customer Data main file.csv (2).xlsx` (8,078 rows, 50 cols incl. "Same owner").
- **Import scope = `CISPL_Approval = Approved` → 6,491 outlets** (4,112 RLP · 39 SSS TOT · 2,340 BSC). Nothing taken from staging (owner rule).
- `profileStatus` not Approved/blank (67) → imported, then **Re-KYC after all other data files land** (not flagged yet).

## 2. Owner-approved rules
- Import everything; invalid/duplicate fields are **blanked + flagged, never guessed**.
- Mapping: Unnati→Unnati/Unnati · Unnati Lite→Lite · SAMT Privilege→Privilege · SAMT Elite/ELITE→Elite · Urban_BSC & Urban_BSC_Lite→BSC/BSC · TOT→TOT/TOT (outlet type **SSS_TOT**). Prod settings carry programs SAMT/BSC/Unnati/TOT and sub-programs Lite/Elite/Unnati/Privilege/BSC/TOT.
- "Same owner" column → owner groups (19 groups / 72 outlets); parents `CPP-<main outlet code>` created **approved**; group PAN = the group's single valid PAN.
- Fill blanks from the owner group only: PAN (group has exactly one), GSTIN (exactly one + same state), bank (only into empty). Never overwrite. Flag `filledFromGroup`.
- A bank account / UPI shared by **different owners** → blanked on **all** of them.
- Payout method = ANY. Placeholder login `__import__:<code>` when the owner mobile is missing or belongs to a sales employee/admin.
- City/pincode blank → taken from the ADDRESS column (Google format "…, City, State PIN, India"; Delhi/Chandigarh → state name) and flagged `cityFromAddress` / `pincodeFromAddress` (60 + 71).
- Every imported row is marked `enrollmentSource = VENDOR_IMPORT`, `importBatchId`, `importedAt` (outlet + KYC submission).

## 3. Documents (vendor links expire ~20 days)
- MODE=FETCH copied every working link into OUR storage: `gs://<GCS_BUCKET>/kyc/bajaj/vendor-import/prod/bajaj-prod-2026-11-12/<outletCode>/<TYPE>.<ext>` — 22,621 stored, 369 exact duplicates skipped, 0 dead/errors (5.3 GB). Report: `kyc/bajaj/vendor-import/prod/_reports/bajaj-prod-2026-11-12-fetch.json`.
- MODE=ATTACH linked them to each outlet's VENDOR_IMPORT KYC submission (22,621 KycDocument rows, VERIFIED). No vendor URL is stored anywhere.
- Type mapping: ID proof → AADHAAR_FRONT / PAN_CARD / GST_CERTIFICATE / OTHER(DL, VoterID); GST cert → GST_CERTIFICATE; board → STORE_BOARD_PHOTO; counter → OTHER ("Counter photo"); cheque → CANCELLED_CHEQUE.
- ⚠️ Never delete objects under `vendor-import/` — native re-KYC copies these file keys. Rollback = delete KycDocument rows only.

## 4. How it was run (safety)
1. Data check + issue report (owner reviewed): `Downloads\Bajaj outlet data check - updated file - 2026-11-12.xlsx`.
2. Parser → manifest `gs://gifsy-platform-files/migrations/bajaj-prod-manifest-2026-11-12-v3.json` (local `scratchpad/prodimport/parse_manifest.py`).
3. Import + docs jobs dual-audited (3 rounds), then **rehearsed for real on a Cloud SQL clone of prod** (incl. re-run idempotency and FILL mode) and verified PASS; clone deleted.
4. Fresh prod backup `1794483041432` → prod import → attach → read-only verification → screen spot checks (Outlet Master 6,491; KYC detail renders docs from our storage).

## 5. Result (prod, verifier PASS, 0 unexplained)
- 6,491 created / 0 errors; 19 parents / 72 linked; 6,491 wallets; one active rep each; lat/long on 6,475; PAN 746, GSTIN 421.
- Explained differences (21): 6 PAN + 4 GSTIN already held by another owner → omitted; 11 placeholder logins (8 rep/admin numbers, 3 missing).
- Isolation: zero rows touched for Deoleo / other tenants.

## 6. Cloud Run jobs kept on prod (use for corrections)
| Job | Purpose |
|---|---|
| `bajaj-import-prod` | importer. **FULL is create-only** (existing outlets skipped `existsUseFill`). Corrections: re-run with `MODE=FILL` + a new manifest — fills ONLY blank fields, never overwrites, skips outlets re-KYC'd natively. |
| `bajaj-prod-docs-fetch` | MODE=FETCH (no DB). Idempotent; never deletes. |
| `bajaj-docs-attach-prod` | MODE=ATTACH. Idempotent; never overwrites reviewer decisions. |
| `bajaj-import-verify-prod` | read-only verifier (ISOLATION_TOUCHED=REPORT on prod). |
Scripts: `gs://gifsy-platform-files/migrations/jobs/` (launched by a small bootstrap that downloads the script into `/app` and `require`s it). Env guards: `EXPECTED_DB`, `TARGET_INSTANCE`, `CONFIRM_TENANT=bajaj`, `EXPECTED_ROWS`, `DRY_RUN` (default true).

## 7. Applying Bajaj's corrections
Correction list sent to the owner: `…\Files received\2026.11.04\Bajaj - data corrections needed - 2026-11-12.xlsx` (5,434 outlets need ≥1 fix; biggest: 5,187 PAN/GST numbers). When the corrected file arrives: run the data check → build a new manifest → (rehearse on a clone if large) → owner OK → backup → `bajaj-import-prod` with `MODE=FILL` → attach new docs → verifier.

## 8. Visibility history — ✅ DONE on prod 2026-11-12 (~20:20 IST), verified
- Source: `…\Files received\2026.11.04\12.11\Visibility Dump 25 TO 26 till 11th (1).xlsx` (sheets Data 25 / Data 26; 81,495 rows, Apr 2025 → 11 Nov 2026).
- Rule (owner): only `Approved CISPL Status = Approved` (77,341; Rejected 2,962 + Partially Approved 1,191 excluded); only outlets on prod (65,462 rows / 3,897 outlets; 1,295 outlets not imported → skipped); 14,339 exact duplicate rows (Apr–Sep 2025, identical dates+photos) collapsed → **51,123 captures, 61,779 photos**. November 2026 included (owner).
- Photos copied into OUR storage first: `visibility-media/bajaj/vendor-import/prod/bajaj-prod-vis-2026-11-12/<outletCode>/<YYYY-MM>_v<1|2>.<ext>` — 61,779 stored, 0 dead/errors (job `bajaj-prod-vis-rehost`, no DB). Staging copies live under a different prefix (never shared).
- Captures: one `visibility_captures` row per outlet × month, status APPROVED, windowKey `YYYY-MM-P1`, form version + CAMERA field ids read from PROD config (Window 1 `wtk11hn` ← Visibility1, Window 2 `np9d0cc` ← Visibility2), receivedAt = entry date, reviewedAt = CISPL approval date (IST → UTC, unlike staging which is 5½ h off), approvedBy = Gifsy admin, no geo (vendor photos carry none). `ON CONFLICT DO NOTHING` — never overwrites a native capture (there were none). Pure proof: no points/payout/TDS.
- Backup `1794494902117` → job `bajaj-prod-vis-captures` (DRY_RUN default) → verifier `bajaj-prod-vis-verify`: **PASS** — 51,123 = manifest field-by-field, 61,779 photo links all present, 0 money rows created.
- Rollback = delete bajaj `visibility_captures` whose formValues reference this batch prefix (never delete the photo objects).
- Scripts: scratchpad `prodimport/bajaj-prod-vis-*.job.js`; manifest `gs://gifsy-platform-files/migrations/bajaj-prod-visibility-manifest-2026-11-12.json`.

## 9. Retailer payout history — ⏸ PREPARED + DRY-RUN PASSED 2026-11-12, LIVE WAITS FOR THE TDS RULE
- Source: `…\Files received\2026.11.04\Payout RLP.xlsx` (21 monthly sheets; Jan–Mar 2025 sheets excluded — **Apr 2025 onward only**, owner). Same model as staging: **Done rows only** → one PAID `CreditPayoutEntry` per row ("Incentive Payout", fieldId `historical-incentive-payout`), one CONFIRMED `CreditBatch` per month (`sourceKind=VENDOR_IMPORT`, `sourceKey=bajaj-prod-payout-rlp-<YYYY-MM>`), paidAt = payout date, no wallet/invoice/TDS/disbursement.
- Prod scope: **48,086 rows / 3,964 outlets / 18 months / ₹2,89,09,560.70** (amounts kept to the paisa, half-up — history of money already paid, NOT the whole-rupee rule for new credits; raw file Σ ₹2,89,09,556.20). Skipped: 1,045 outlets not on prod (₹27.7 L); Failed/Rejected/Reversed 579; "UTR no. awaited" 843 (ask Bajaj for final status).
- Differences vs staging (owner-agreed): 228 placeholder references ("Same Bank does not provide Utr No.", "-", …) stored as `utr = NULL` with the text in narration (staging stored the text as the UTR); amounts to the paisa.
- **BLOCKER (owner decision 2026-11-12): import only AFTER the 194R `VENDOR_IMPORT` exclusion (`f6b0cf0`, reverted on main by `e8c3f46` at cutover #56) is back on prod** — ship it in the next prod release (do NOT keep the TDS revert when preparing main). Job refuses LIVE unless `TDS_RULE_LIVE=true`.
- Job `bajaj-prod-payout-history` (guards EXPECTED_DB/CONFIRM_TENANT/EXPECTED_ROWS=48086/EXPECTED_PAISE=2890956070; idempotent per month), manifest `gs://gifsy-platform-files/migrations/bajaj-prod-payout-rlp-manifest-2026-11-12.json`. After release: backup → `DRY_RUN=false TDS_RULE_LIVE=true` → verify (counts/Σ per month, UTRs, 0 TDS rows, partner wallet "Lifetime payout").

## 10. TDS already deducted by the vendor (FY 2026-27) — APPROVED as a PARTIAL import (owner 2026-11-12)
- Source: `…\Files received\2026.11.04\TDS Calculation FY 2026-27.xlsx` — 124 outlet rows, all wholesaler points TDS (119 on prod = WHOLESALER/BSC; 5 not on prod: 16069, 27618, 451278 not in the master; 50333738, 50781620 CISPL blank). Monthly APR–SEP TDS per outlet, Σ ₹6,50,166; challans per month (no./value/date) Σ ₹10,47,030.
- PAN on prod: 59 have it; 25 vendor-has-PAN but missing on prod (in the corrections list); 35 no PAN (20%) → needs the no-PAN TDS keys from the no-PAN release.
- Plan: AFTER next release (no-PAN + 194R vendor-import rule) → payout history (§9) → Earn & Burn points → import per-outlet monthly TDS deducted for the 119, each tied to that month's challan. Left OUT until Bajaj sends retailer TDS: the ₹3.97 L challan remainder (likely retailer payout TDS) + the 5 outlets. Check before relying on it: re-keying no-PAN TDS rows to the PAN once corrections land.
- Asked of Bajaj/vendor: outlet-wise TDS deducted + deposited Apr–Oct 2026 for retailer payouts AND wholesaler points (PAN + challan per outlet); confirm rows taxed on exactly 20,000 points (threshold is "exceeds").

## 11. Still to do
- Import the other files (targets/achievements history → Earn & Burn wallet), each check → rehearsal → owner OK → run → verify. Watch: rows for the 1,587 non-approved outlets have no outlet (count points on them).
- Then bulk Re-KYC flag (67 + flagged) and send Bajaj the correction file.
