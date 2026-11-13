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

## 9. Retailer payout history — ✅ DONE on prod 2026-11-13 (after release `247fae4b` put the 194R VENDOR_IMPORT rule live), verified
- Result: backup `1794552515663` → `bajaj-prod-payout-history` (DRY_RUN=false, TDS_RULE_LIVE=true) → **48,086 PAID entries / 18 monthly batches, Σ ₹2,89,09,560.70**; verifier PASS (every row = file by outlet/month/amount/UTR; status PAID; sourceKind VENDOR_IMPORT; no TDS fields; 0 TDS deduction rows and 0 wallet movements created).
- Source: `…\Files received\2026.11.04\Payout RLP.xlsx` (21 monthly sheets; Jan–Mar 2025 sheets excluded — **Apr 2025 onward only**, owner). Same model as staging: **Done rows only** → one PAID `CreditPayoutEntry` per row ("Incentive Payout", fieldId `historical-incentive-payout`), one CONFIRMED `CreditBatch` per month (`sourceKind=VENDOR_IMPORT`, `sourceKey=bajaj-prod-payout-rlp-<YYYY-MM>`), paidAt = payout date, no wallet/invoice/TDS/disbursement.
- Prod scope: **48,086 rows / 3,964 outlets / 18 months / ₹2,89,09,560.70** (amounts kept to the paisa, half-up — history of money already paid, NOT the whole-rupee rule for new credits; raw file Σ ₹2,89,09,556.20). Skipped: 1,045 outlets not on prod (₹27.7 L); Failed/Rejected/Reversed 579; "UTR no. awaited" 843 (ask Bajaj for final status).
- Differences vs staging (owner-agreed): 228 placeholder references ("Same Bank does not provide Utr No.", "-", …) stored as `utr = NULL` with the text in narration (staging stored the text as the UTR); amounts to the paisa.
- **BLOCKER (owner decision 2026-11-12): import only AFTER the 194R `VENDOR_IMPORT` exclusion (`f6b0cf0`, reverted on main by `e8c3f46` at cutover #56) is back on prod** — ship it in the next prod release (do NOT keep the TDS revert when preparing main). Job refuses LIVE unless `TDS_RULE_LIVE=true`.
- Job `bajaj-prod-payout-history` (guards EXPECTED_DB/CONFIRM_TENANT/EXPECTED_ROWS=48086/EXPECTED_PAISE=2890956070; idempotent per month), manifest `gs://gifsy-platform-files/migrations/bajaj-prod-payout-rlp-manifest-2026-11-12.json`. After release: backup → `DRY_RUN=false TDS_RULE_LIVE=true` → verify (counts/Σ per month, UTRs, 0 TDS rows, partner wallet "Lifetime payout").

### 9.1 Retailer TDS on the imported payouts — owner decision 2026-11-13
Bajaj confirmed **no TDS has been deposited for retailers so far**. Decision (recommended option): a **Bajaj-only setting**
makes imported (VENDOR_IMPORT) payouts **dated from 1 Apr 2026 (FY 2026-27)** count in the 194R report, so each retailer's
liability (₹20k threshold, 10% / 20% no-PAN) is visible; **FY 2025-26 imports stay excluded** (closed year — Bajaj's CA
handles late payment outside the platform); deposits made later are uploaded with "TDS for month" and subtract; **no
automatic recovery from future payouts** until Bajaj's CA decides who bears it. Build = small fast follow-up AFTER this
release (the report is computed live, so the payout-history import does not wait for it).
- **Built 2026-11-13 on `feat/tds-count-imports`** (not yet pushed/deployed): ProgramSetting `tdsImportedPayouts` =
  `{ countFrom: 'YYYY-MM-DD' | null }` (absent/null = OFF for every tenant → report byte-identical). Edited ONLY by a
  Gifsy Admin on **TDS Config** (`PUT /v1/admin/tds/config/imported-payouts`; generic settings PUT refuses the key;
  audit `TdsImportedPayouts` old→new). ON → `compute194R` adds VENDOR_IMPORT entries with paidAt ≥ that IST date
  (clamped to the FY) — report/liability only; the 194R screen shows an "Includes imported payouts…" note.
  **After the release ships: a Gifsy Admin sets Bajaj's date to 2026-04-01 on TDS Config** (no SQL needed).
  Withholding/gross-up/auto-invoice/recovery paths are untouched: they read only visibility fieldIds or entries with a
  frozen `tdsSection` (imported rows: `tdsSection` NULL, fieldId `historical-incentive-payout`).

## 9b. Wholesaler points (Earn & Burn) — ✅ DONE on prod 2026-11-12 (night), verified
- Sources: File 1 `…\2026.11.04\Earn  Burn Points of 25 to 26  Expire points data Year 25.xlsx` (sheet "File", history Apr 2025 → 31 Oct 2026, 103 cols = staging layout + 16–31 Oct burn) + File 2 `…\2026.11.04\12.11\WholesalerCumulativePointsReport2026-2027 (1).xls` (vendor FY26-27 monthly report to 11 Nov). Files agree at 31 Oct (2,331/2,333 within 1 pt); File 2 adds only 1–11 Nov redemptions (25 outlets, 1,24,691 pts). Vendor stopped redemptions on 11 Nov (owner) → this is the FINAL balance.
- Owner rule: **every closing balance = vendor's 11-Nov closing (File 2 ClosingPoints, rounded)** → 2,281 wallets, Σ **67,27,723**; 0 mismatches. 50270366/50293463: vendor recovered pre-Apr-25 over-redemption from FY25-26 earnings → shown as "Last year's over-redemption recovered" (ADJUST, 1 Apr 2025) (staging had excluded it; corrected on prod).
- Passbook: monthly earns at the file's header dates; SPL4–7 scratch payouts dated **30 Jun 2025** (their column position between Jun and Jul 2025 — file has no transaction dates), SPL MAH-Sept 25 Sep 2025, Bottle QPS Nov-25 25 Nov 2025; FY26-27 redemptions dated by their real periods (per-period columns, verified = their totals); FY25-26 lapse 30 Jun 2026; Nov redemptions 11 Nov 2026. 40 outlets still dip below 0 mid-history (vendor's own sequencing); closings exact.
- Prod-only: FIFO `remainingPoints` set on earn lots (Σ = max(net,0)) so oldest-first redemption works; earned counters = Σ EARN only (ADJUST moves balance only); lots non-expiring.
- 8 wallets end NEGATIVE (sales returns, owner: keep) — the wallet fix "never credit points when debiting a negative wallet" ships in the next release; **no credit-batch reversal on these before it**.
- Not imported: 408 File-1 outlets not on prod (52 of them Active, 66,916 pts — not CISPL-approved; import their balance if onboarded later); 59 prod wholesalers with zero in both files. No Oct/Nov 2026 EARN exists in either vendor file → those earnings come via our own pipeline.
- Backup `1794502277650` → job `bajaj-prod-earnburn` (manifest `migrations/bajaj-prod-earnburn-manifest-2026-11-12-v3.json`) → LIVE 2,281 outlets / 29,283 events / 0 dirty → verifier PASS (redeemable/counters/row counts/FIFO/balance chain per wallet; 0 other-tenant rows). Builder `scratchpad/prodimport/eb_build_prod_spljun.js`. Independent money audit done before live.

## 9c. Historical targets + achievements — ✅ DONE on prod 2026-11-13, verified
- Source: `…\Files received\Final UAT data upload\Retailer payout earning april 25 to sept 26.xlsx` (same file as staging) —
  sheets "RLP" (retailers) + "BSC25-26" (wholesalers); WOA pivot sheets ignored. Apr 2025 → Sep 2026. October file to come
  (same import); November targets entered by the owner on the platform; November achievements via Sales Import.
- Owner decisions (2026-11-13, all recommended): RLP → TOTAL ← Month Target/Month Achievement · ADHO ← ADHO Target/ACHV ·
  NON ADHO ← Non ADHO Target/ACHV · FOCUS BRAND ← FB Target/ACHV · LINES ← Line Target/Line Ach · FOCUS BRAND 2 ← nothing;
  BSC → TOTAL only (FB1/FB4/ADHO 100/CNO case counts have no target → not imported); prod outlets only (3,634 skipped,
  listed in scratchpad `targets-skipped-not-on-prod.json`); 21 sheet/type mismatches imported (out-of-scope KPIs stay
  hidden); 2 decimals; negatives kept (442 achievement cells); 5 duplicate outlet-months imported once (first wins):
  50799828 Jul-25 (RLP×2), 50193574 Jan-26 (BSC×2), 50911506 / 50912500 / 50857270 May-25 (in both sheets → RLP row kept).
  RLP check: Month Target = ADHO + Non ADHO on every sampled row.
- Result: **102,591 OutletTarget + 102,591 OutletSalesRecord rows** (6,379 outlets, 18 months), one target + one sales
  upload batch per month for provenance; ON CONFLICT DO NOTHING (prod had none). Σ TOTAL target ₹334.97 cr / achieved
  ₹309.97 cr. Backup `1794546891138` → job `bajaj-prod-targets` → verifier PASS (every KPI value per row = file).
- ⚠️ **Points engine is ON for Bajaj prod: NEVER run a points compute for Apr 2025 – Sep 2026** — those months were already
  paid by the vendor (points imported via Earn & Burn §9b; payouts via §9). Same for the October file once imported.

## 10. TDS already deducted by the vendor (FY 2026-27) — APPROVED as a PARTIAL import (owner 2026-11-12)
- ✅ **DONE on prod 2026-11-13** (owner: vendor TDS was PAID BY BAJAJ ON TOP → gross-up; import as-is). 212 TdsOffPlatformEntry
  (194R benefit value per outlet-month, Σ ₹50,53,115 = vendor "Outlet Points"; monthly split from TDS/rate scaled to the
  total) + 212 TdsDeposit (vendor TDS per outlet-month, Σ ₹6,25,285, depositDate = that month's challan date (first of
  a pair), forPeriod = the month, depositorType CLIENT). **Every row stores panNumber '' + outletCode** → the report
  resolves the outlet owner's CURRENT PAN at read time, so PANs added later (corrections) switch 20% → 10% automatically —
  no re-import (owner reminder 2026-11-13). Expected report effect for these 119 deductees at import time: liability ₹8,84,251
  (gross-up 10/90 · 20/80, >₹20k) / deposited ₹6,25,285 / outstanding ₹2,58,966 (vendor deducted at flat 10/20%; 25 outlets
  10%-vs-20% until PANs land; 2 outlets taxed at exactly ₹20k). Backup `1794553985636` → job `bajaj-prod-vendor-tds`
  (batch `bajaj-vendor-tds-fy2627-2026-11-13`, refuses re-run) → verifier PASS (row-by-row, 0 other-tenant rows).
- Source: `…\Files received\2026.11.04\TDS Calculation FY 2026-27.xlsx` — 124 outlet rows, all wholesaler points TDS (119 on prod = WHOLESALER/BSC; 5 not on prod: 16069, 27618, 451278 not in the master; 50333738, 50781620 CISPL blank). Monthly APR–SEP TDS per outlet, Σ ₹6,50,166; challans per month (no./value/date) Σ ₹10,47,030.
- PAN on prod: 59 have it; 25 vendor-has-PAN but missing on prod (in the corrections list); 35 no PAN (20%) → needs the no-PAN TDS keys from the no-PAN release.
- Plan: AFTER next release (no-PAN + 194R vendor-import rule) → payout history (§9) → Earn & Burn points → import per-outlet monthly TDS deducted for the 119, each tied to that month's challan. Left OUT until Bajaj sends retailer TDS: the ₹3.97 L challan remainder (likely retailer payout TDS) + the 5 outlets. Check before relying on it: re-keying no-PAN TDS rows to the PAN once corrections land.
- Asked of Bajaj/vendor: outlet-wise TDS deducted + deposited Apr–Oct 2026 for retailer payouts AND wholesaler points (PAN + challan per outlet); confirm rows taxed on exactly 20,000 points (threshold is "exceeds").

## 11. Still to do
- Import the other files (targets/achievements history → Earn & Burn wallet), each check → rehearsal → owner OK → run → verify. Watch: rows for the 1,587 non-approved outlets have no outlet (count points on them).
- Then bulk Re-KYC flag (67 + flagged) and send Bajaj the correction file.
