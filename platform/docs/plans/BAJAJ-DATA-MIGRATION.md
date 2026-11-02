# Bajaj — Data Migration (from prior provider) — living plan doc

**Status:** Enrollment imported; **POINTS being rebuilt from the Earn & Burn ledger (2026-11-02 pivot — see §0)**; payout + TDS + visibility pending owner files.
**Target:** the **Bajaj** tenant on **STAGING** first — `uat-bajaj.gifsy.in` / `clientId='bajaj'` /
DB `gifsy_staging`. Prod is a later, owner-gated step.
**Last updated:** 2026-11-02.

> ⚠️ **TENANT-SAFETY RULE (learned the hard way):** on 2026-10-30 a Bajaj hierarchy file was
> bulk-uploaded into the **Deoleo** staging tenant by mistake (1,048 rows; cleaned up 2026-10-31).
> EVERY import in this effort MUST assert the target tenant is `bajaj` before any write. Never run a
> Bajaj import against Deoleo or any other tenant.

---

## 0. ⚠️ 2026-11-02 UPDATE — Final UAT data set + POINTS pivot (authoritative; SUPERSEDES the points parts below)

**Final data folder (owner-shared):** `D:\Work\Gifsy\Clients\Bajaj Consumer Care\Loyalty\Files received\Final UAT data upload\` — the 5 UAT files:
- **`Earn & Burn Points of 25 to 26 Year & Expire points data Year 25.xlsx`** — the WHOLESALER points ledger (monthly earn / burn(redemption) / FY laps + a rolling **Final Closing Points**). **NOW THE SOURCE OF TRUTH FOR POINTS.**
- `Enrollment dump.xlsx` — outlet master + KYC + doc links (category #2; already imported).
- `Retailer payout earning april 25 to sept 26.xlsx` — ⚠️ the earlier use of this file's BSC sheet for POINTS was WRONG. Correct retailer-payout source still TBD (below).
- `TDS Sheet.zip` — TDS already-submitted-to-govt data (for the FY27 reconciliation).
- `Visibility Dump 25 TO 26.xlsx` — visibility history (category #3).

**THE PIVOT (why):** the trial points import credited earn from the **payout file's BSC sheet (`Capped @125%`)**; that earn **MISMATCHED the authoritative Earn & Burn ledger for 72% of outlets** (±13.1 lakh pts; e.g. outlet 197325 payout-file=7,295 vs ledger=4,676). So the payout file was the WRONG source. On **2026-11-02 BOTH payout-file imports were DELETED** (points: 23,942 txns / 3.24 cr / 2,322 wallets REVERSED — counters decremented + rows deleted; payout: 50,128 `CreditPayoutEntry` / ₹3.02 cr / 18 batches deleted), **backed up** to `gs://gifsy-platform-files/migrations/backups/bajaj-payoutfile-import-backup-2026-11-02T07-40-19-267Z.json`. Old import pipeline (9 Cloud Run jobs) removed.

**POINTS — rebuild from the Earn & Burn ledger (owner decisions 2026-11-02):**
- **Source of truth = Earn & Burn ledger.** Each wholesaler's wallet is set from its vendor **"Final Closing Points"** — the LAST of 5 period-progressive "Final Closing Points" columns (after 1Apr–30Jun → 1Jul–25Aug → 26Aug–15Sep → 16Sep–15Oct). VERIFIED: it is the latest cumulative net (earn − burn − laps), and it **already EXCLUDES the expired pre-Apr'25 Last-Year-Closing** (Cispl-Closing = Earn − Burn, not LYC+Earn−Burn).
- **`redeemablePoints` = net** (Final Closing Points). **`earnedPoints`/`lifetimeEarned` = GROSS earn** = net + Σ(all period burns) + FY laps = total earned Apr'25→now; `redeemedPoints` = gross − net. → the partner sees honest **lifetime-earned (gross)** + **available (net)**.
- **Negatives PRESERVED** (9 outlets — legit sales-return clawbacks → negative redeemable; the platform's never-negative invariant is a noted latent edge, safe now: non-expiring + redemption gated). **Fractions round half-up.** Outlets with gross=0 AND net=0 skipped.
- **Scope = CODE exists in STAGING** (else skip + flag). ✅ **LIVE + DB-VERIFIED 2026-11-02:** **2,317 wallets** set (2,316 carry ledger lots; 1 fully-inactive 0/0 outlet correctly skipped) / 372 not-in-staging. Wallets tie out **EXACTLY** to the manifest on all four totals — **net 79,94,576** · **gross 3,30,86,843** · burn 2,45,68,785 · laps 5,23,482; per-record `redeemable==net` & `earned==gross` (0 mismatch); coherence invariant `redeemable = earned − redeemed − expired` holds for every wallet (0 violations); 0 non-Bajaj contamination. Data quality: **0 duplicate CODEs**. DUAL-audited (correctness + safety); guards: `gifsy_staging` DB guard, advisory lock, dedup-abort, pooled-refusal, overwrite-abort, gross=net+burn+laps validation, `VENDOR_IMPORT` tag on every row. Verify jobs: `scratchpad/verify-earnburn*.job.js`.

**RETAILER PAYOUT — DELETED; owner will share the CORRECT source separately** (the Earn & Burn ledger is points/wholesalers only). Re-import when shared.

**TDS — PARKED:** load `TDS Sheet.zip` (already-deposited TDS) later; compute **FY2026-27 (FY27)** liability on BOTH **points-redemption** AND **payout**, then **subtract TDS already deposited** → net outstanding. **NOT FY26.** The platform fix (`compute194R` excludes `VENDOR_IMPORT` payout batches) is **RETAINED** — vendor imports carry NO live TDS.

**STANDING RULES (every vendor import):** tag all rows `VENDOR_IMPORT`; run data-quality checks (duplicate outlet IDs + inconsistencies) on each file; in-VPC Cloud Run jobs (DRY_RUN-first, `current_database` guard, advisory lock); dual-audit money paths; owner-gated live writes.

**Artifacts (scratchpad):** `earnburn-parser.js` → manifest `gs://…/migrations/bajaj-earnburn-manifest.json`; `bajaj-earnburn-import.job.js`; `delete-payoutfile-import.job.js`. See memory [[bajaj-data-migration]].

---

## 1. Scope — 6 data categories (prior provider → our platform)
1. **Employee hierarchy** (ISR→SO→ASM→RSM→ZNM→NSM).
2. **Outlet master + KYC + document links** ← the **"Enrollment dump"** analysed below.
3. **Visibility details** (POSM).
4. **Historical sales & targets** from **1-Apr-2025**.
5. **Historical points (wholesaler)** — set from the **Earn & Burn ledger's Final Closing Points** (net); gross earn → lifetime-earned (see §0). **Retailer payout** — correct source pending from owner.
6. **TDS data** (reconcile FY26-27).

## 2. Locked decisions (owner)
- **Overwrite-style** import (append-vs-overwrite is moot under overwrite).
- Data from **1-Apr-2025** (pre-Apr'25 = expired/settled → excluded).
- **Points → see §0 (2026-11-02 pivot):** source of truth = the **Earn & Burn ledger**; set redeemable = **Final Closing Points** (net), lifetime-earned = gross. *(The earlier "payout-file BSC + full ledger" approach was WRONG — 72% earn mismatch — and was deleted.)*
- **TDS reconcile (parked): FY2026-27 (FY27)** on points-redemption + payout, minus already-deposited; **FY25-26 nothing**. Vendor imports carry NO live TDS.
- Docs: prior provider's **public download links are IN the outlet-master/enrollment file** → extract + store in our portal.
- Cutover timestamp: **not required** for the staging test import.
- **Program→earn-model (confirmed 2026-10-31): RLP = Retailer = PAYOUT (cash-on-target) + Visibility; BSC = Wholesaler = POINTS (reward catalogue).** Routed by outlet type via `CreditField.outletTypeAwards` (not by program name). *(Vendor-imported points/payout carry NO live TDS — `VENDOR_IMPORT`-tagged + excluded from `compute194R`; statutory TDS is the separate parked FY27 reconciliation, §0.)* See [[bajaj-onboarding]].
- **Import as ALREADY-APPROVED (confirmed 2026-10-31):** these outlets are live/approved upstream (Active=1), so import them as **pre-approved outlets, KYC-APPROVED straightaway, with docs attached — NO re-validation, do NOT push 6,505 through the KYC wizard.** Needs a dedicated enrollment importer.
- **PROVENANCE marker (owner, 2026-10-31):** our records MUST show these are **imported / vendor-enrolled** outlets (enrolled by the prior vendor, not by Gifsy). The importer stamps a provenance marker on each imported outlet/KYC (e.g. `enrollmentSource='VENDOR_IMPORT'` + an import batch id/date). ⚠️ likely a small **additive schema field** → platform-wide schema change → flagged approval before building.
- Sequence (dependency order): **hierarchy → outlets/KYC/docs → sales/targets → points/payouts → TDS.**

### Column semantics — CONFIRMED by owner (2026-10-31)
- #2 **RetailerName = owner/proprietor name**; #8 **OutletName = shop name** (stored separately). ✓
- #3 **RLP → Retailer (code SSS, PAYOUT/cash); BSC → Wholesaler (code WHOLESALER, POINTS).** ✓ (drives money routing)
- #7 **OutletCode = the canonical key** the sales/targets/points/TDS files ALSO key on → **no crosswalk needed.** ✓
- #11 **ISR ID = leaf rep employee code, matches the hierarchy file** → outlet→rep assignment. ✓ (import hierarchy first)
- #9 **SAPCODE = distributor's SAP code** (assumption from data: repeats per distributor; owner "yes" — reconfirm if wrong).
- #17–19 **ID Proof → identity/PAN doc slot; GSTPath → GST doc slot** (when IdProofType=GST, ID Proof is itself a GST image). ✓
- #14 **cisplApprovaldate = the outlet's APPROVAL date** (NOT enrollment date — owner corrected). Store as approval date.

## 3. Source file: "Copy of Enrollment dump.xlsx"
- Location: `D:\Work\Gifsy\Clients\Bajaj Consumer Care\Loyalty\Copy of Enrollment dump.xlsx` (owner pre-cleaned).
- **6,505 data rows**, 1 sheet, 32 columns. It is a FULL enrollment dump — outlet master **+** owner/bank/KYC **+** 5 document links. So it feeds imports #2 (outlet master), KYC/enrollment, and the doc extraction at once.
- Outlet types present: **RLP 4,142 (retailer) / BSC 2,363 (wholesaler)**. Zones: West/North/East/South.
- Programs: Unnati 3,238 · BSC 2,363 · SAMT 866 · TOT 38. Sub-programs: Unnati 2,646 · BSC 2,363 · Privilege 770 · Unnati Lite 592 · Elite 96 · TOT 38. (BSC type ↔ BSC program align exactly; RLP splits into Unnati/SAMT/TOT.) Program/Sub-program are **segmentation labels** → map verbatim to `programName` / sub-program; they do NOT drive the earn model (outlet type does).
- Keys: **OutletCode — 6,505 distinct, 0 blank, 0 duplicates** (clean primary key). **ISR ID — 723 distinct** (must exist in the hierarchy import). MobileNo — 6,504 distinct (1 dup pair).

### Column → our-field mapping
| Dump column | Our field | Notes |
|---|---|---|
| OutletCode | `outletId` | required key |
| OutletName | `outletName` | |
| Outlet Type (RLP/BSC) | outlet-type **code** SSS / WHOLESALER | RLP/BSC are the Bajaj DISPLAY labels (displayName); upload accepts code/label/name |
| DistributorName | `distributorName` | |
| SAPCODE | distributor SAP code | repeats per distributor (confirmed) |
| ISR ID | outlet→rep assignment (`SalesUserAssignment`) | depends on hierarchy import first |
| MainState / State | state | two cols, trailing spaces; normalize, pick one |
| City / Pin Code / Address | city / pincode / address | |
| Metro or Non Metro | metro flag | |
| Program / Sub program | `programName` / sub-program | labels only |
| MobileNo | owner login phone | |
| RetailerName | **owner/proprietor name** | stored separately from OutletName |
| BankName/Accountholdername/Branch/AccountNumber/IFSCCode | bank mandate | **UPI transform** (below) |
| ID Proof + IdProofType | KYC identity doc | types: Aadhar 2,720 · PanCard 1,358 · GST 1,224 · "-" 1,071 · DL 90 · VoterID 42 |
| GSTPath / Outlet Board / Counter Image / chequeImage | KYC docs | download + store |
| cisplApprovaldate | outlet **approval date** | owner-corrected (not enrollment date) |

### Transforms the importer must apply
- **UPI:** `BankName == "UPI"` (1,277 rows) → put `AccountNumber` (the VPA) into our **`upiId`**, clear bank-name/account/IFSC. (All 1,277 VPAs are valid.)
- Trim leading/trailing spaces (State/City/bank fields).
- **IFSC `O`→`0`** normalize, only where it yields a valid IFSC; else flag.
- State normalize (MainState vs State disagree slightly: 29 vs 33 distinct).
- Outlet type RLP→SSS, BSC→WHOLESALER (codes); labels already supported.

### ISR → hierarchy check (authorized method)
- The shared Enrollment dump carries an **ISR ID** per outlet (**723 distinct**). Verify every outlet's ISR exists in the hierarchy by cross-checking these 723 against the **Bajaj employee hierarchy loaded in STAGING** (`gifsy_staging`, `clientId='bajaj'`, read-only in-VPC job) — NOT against any other file.
- ⚠️ Source-file scope: use ONLY files the owner explicitly shares. (Earlier cross-checks that used non-shared files were discarded per owner, 2026-10-31.)
- **RESULT (2026-10-31, read-only in-VPC job vs `gifsy_staging`):** Bajaj hierarchy loaded in staging = **1,057 employees** (XSR 784 · SO 216 · ASM 39 · RSM 11 · ZNM 5 · NSM 2). Of the 723 ISR IDs in the shared dump, **722 present, 1 MISSING = ISR `1388`** → referenced by **2 outlets**: `50063963` Shree maha Lakshmi traders (RLP, MH) + `50757731` Beautiful mega mart (RLP, MH). Fix = add ISR 1388 to the hierarchy, or reassign those 2 outlets to a valid rep, before import.
  - **RESOLVED (owner, 2026-10-31):** the importer **overrides ISR `1388` → `1380`** for outlets `50063963` + `50757731`. Verified `1380` exists in Bajaj staging = **Raghunath krishnat patil, active XSR** (1388 confirmed absent). Bake this override into the importer's rep-link step.

## 4. Document links — FULL sweep of all 5 columns (2026-10-31, every URL, with retry)
| Column | URLs | Reachable | Dead | Dead % |
|---|---|---|---|---|
| ID Proof | 5,434 | 5,283 | 151 | 2.8% |
| GSTPath | 1,688 | 1,574 | 114 | 6.8% |
| Outlet Board | 6,505 | 6,490 | 15 | 0.2% |
| Counter Image | 6,505 | 6,483 | 22 | 0.3% |
| chequeImage | 4,153 | 3,439 | **714** | **17.2%** |
| **TOTAL** | **24,285** | 23,269 | **1,016** | **4.2%** |
- **1,016 docs dead at source.** Board/Counter near-perfect; the big gap is **cheque proofs (714, mostly `/RTGS/` variants)**, then ID Proof (151) + GST (114). 3 hosts (`new.`/`portal.`/bare `bajajrewardclub.com`). Full dead-link list (OutletCode+Column+URL) → `Bajaj-DocLinks-FullSweep.xlsx` (Downloads).
- **Doc migration approach:** per outlet, download each present URL → store in our doc store (GCS via `storage.service`) → attach as the matching `KycDocument` type. Log every dead link per outlet; never fail the whole outlet on one missing image.
- **THREE hosts:** `new.bajajrewardclub.com//RENewBajajUploadFiles//` (2026), `portal.bajajrewardclub.com//BajajUploadFiles//` (older/2023, esp. GST), and bare `bajajrewardclub.com`. Importer handles all three. Doubled slashes are fine.
- **Doc migration approach:** per outlet, download each present URL → store in our doc store (GCS via `storage.service`) → attach as the matching `KycDocument` type. Full reachability sweep with retry during import; **log every dead link per outlet; never fail the whole outlet on one missing image.**

## 5. Data-quality / error report (delivered as Excel)
Error workbook: **`C:\tmp\Bajaj-Enrollment-Errors.xlsx`** (Summary + Row Errors sheets; 1,876 outlets flagged). Counts:
| Issue | Count | Severity | Action |
|---|---|---|---|
| No payment destination (bank name, no account, not UPI) | **1,770** | HIGH | import outlet+owner; bank flagged incomplete → payout blocked until filled |
| Bank rows missing IFSC | **1,839** | HIGH | collect IFSC or convert to UPI |
| Malformed IFSC (O-for-0) | 27 | MED | auto-fix where valid (col "Suggested IFSC fix"); else manual |
| Invalid pincode | 23 | MED | correct or leave blank |
| Duplicate mobile (7290968066 ×2) | 2 | HIGH | one must change (one owner-phone per outlet) |
| Enrollment_Status ≠ 1 (0, 3) | 2 | LOW | confirm include/exclude |
| (info) UPI rows | 1,277 | INFO | not an error — routed to UPI field |
Clean: 0 invalid mobiles, 0 duplicate outlet codes, all UPI VPAs valid, every outlet has board+counter images.

**Payment uniqueness (2026-10-31):** **UPI VPAs — all 1,277 unique ✓.** **Bank accounts — 24 account numbers shared across 97 outlets** (e.g. `21170200033621`×21, `916020018258019`×9, `344605500142`×6). Some are junk placeholders (`"na"`×13, `"N/A"`×7, dummy repeated-digit numbers) = effectively no account → payment-gap. ⚠️ If Bajaj has **payout-uniqueness enforced** ([[global-settings-wiring]]), the real shared accounts would COLLIDE on import → owner decision: allow shared accounts (relax the setting) vs treat as data errors to fix.

## 6. Build map — existing vs new
- **Existing uploaders (reuse):** hierarchy bulk upload (#1); outlet-master upload (#2, outlet fields). Geo (lat/long) = already-built optional path + `outletMasterGeo` flag ON for Bajaj staging → merge the separate geo file by OutletCode.
- **New build needed:**
  - **Enrollment importer** — lands outlet master + owner (ChannelPartner) + bank mandate (UPI transform) + marks **pre-approved/enrolled** + attaches the 5 docs (download from both hosts). Idempotent, tenant-asserted (`bajaj`), overwrite semantics.
  - **Historical sales/targets backfill (#4)** — the sales/target upload **locks past months** (`isMonthLocked` → skip, `targets.service.ts:568`) → needs a **GIFSY-gated `allowLockedMonths` mode** to write Apr-2025+.
  - **Points import (#5) — built via the Earn & Burn pivot (§0):** sets wholesaler redeemable = Final Closing Points (net) + gross→lifetime-earned; dual-audited. ✅ **LIVE + DB-VERIFIED 2026-11-02** (2,317 wallets; exact 4-way tie-out to manifest). **Retailer payout** awaits the correct source file.
  - **TDS import + FY26-27 reconcile (#6).**
  - **Visibility history (#3).**

## 7. Open items / next steps
- ✅ RESOLVED (owner 2026-10-31): all 7 column semantics (§3); RLP→PAYOUT / BSC→POINTS; OutletCode canonical → no crosswalk; import **KYC-APPROVED + provenance marker + no re-validation**.
- ❓ OPEN — **payment-gap rows** (1,770 no-payment / 1,839 no-IFSC): import outlet+owner with bank **flagged-incomplete** (recommended) vs hold out?
- ❓ OPEN — **minor-fix defaults:** auto-fix 27 IFSC O→0 where valid; drop/flag 23 bad pincodes; resolve the 1 dup-mobile pair; exclude the 2 enr≠1 rows?
- ❓ OPEN — run the full **GST+cheque dead-link sweep** (~5,800 req) for exact missing-doc counts before import?
- ⚠️ **Provenance marker** = additive schema field → PLATFORM-WIDE → flagged approval before building.
- ✅ **DONE:** enrollment importer (outlets + owner + bank + KYC-APPROVED + provenance + docs) built & run on staging (6,505 outlets). **POINTS** rebuilt from the Earn & Burn ledger — see §0 (✅ LIVE + DB-VERIFIED 2026-11-02: 2,317 wallets, exact 4-way tie-out).
- ▶ **REMAINING (awaiting owner files):** retailer payout (correct source), historical sales/targets (needs the GIFSY-gated `allowLockedMonths` mode), TDS (`TDS Sheet.zip` → FY27 reconcile), visibility (`Visibility Dump 25 TO 26.xlsx`). Prod cutover = later, owner-gated (land the TDS `compute194R` fix on `main` first).
- ✅ **SHIPPED to develop→staging (2026-11-02, batched with the 30-day session change):** partner-wallet statement **double-negative** display fix. Root cause: backend stores `wallet_transactions.points` SIGNED (neg on debit) + API returns raw, but shared `platform/src/components/wallet/transaction-item.tsx` prepended its own `−` → `−-6,939` on every debit/expiry (latent on Deoleo too). Fix = render magnitude (`formatPoints(amtSign ? Math.abs(tx.amount) : tx.amount)`); LOCK rows (no prefix) untouched. Regression test `platform/src/components/__tests__/transaction-item.test.tsx`. **⚠️ PLATFORM-WIDE** (shared component). Gates GREEN (tsc + full vitest 2,853). Working-tree only — NOT committed/pushed; fold into the next batched `develop` push, then verify on staging (`uat-bajaj.gifsy.in/partner/wallet` for DILIP KUMAR `9234722895` shows `−6,939`).

## 8. Staging pre-import checks — RESULTS (2026-10-31, read-only in-VPC job vs `gifsy_staging`)
- **Outlet-type config:** ✅ `SSS`(label **RLP**), `WHOLESALER`(label **BSC**), `SSS_TOT`, `SUB_STOCKIST` — all active/enabled for bajaj. Import won't reject on type. Programs = free-text (no validation) → won't reject on any Program/Sub-program value.
- **Outlet-code collisions:** ✅ **0** — bajaj staging has only **10** outlets (test data, BJR/BJW/OUT-2026); none collide with the dump's numeric codes → all 6,505 are clean **creates**.
- ⚠️⚠️ **Uniqueness policy for bajaj = ALL ON** `{gst:true, phone:true, bank:true, upi:true}` (NOT the default). Consequences on import:
  - **bank:true** → the **97 outlets sharing 24 bank accounts** (§5) WILL be **rejected** (bank-account must be unique). UPI unique already (upi:true OK).
  - **phone:true** → the **1 in-file dup-mobile pair** + **9 outlets whose owner-mobile equals an existing active bajaj phone (a rep's)** = ~11 rows **rejected**. (9 outlets: 50261816, 50935354, 50201455, 50259864, 50341104, 50626498, 50860667, 50888258, 50970002.)
  - gst:true → no GST numbers in the file → N/A.
- **DECISION for the trial:** relax **bank-uniqueness** for bajaj (legit shared distributor accounts) so the 97 import; keep **phone-uniqueness ON** and flag/skip the ~11 phone-collision rows (don't relax login phone-uniqueness). Owner to confirm.
