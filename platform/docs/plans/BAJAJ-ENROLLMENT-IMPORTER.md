# Bajaj Enrollment Importer — build contract

**Status:** BUILDING (started 2026-10-31). Owner gave the platform-wide go.
**Target:** `bajaj` tenant, **staging first** (`gifsy_staging`). Script-based (not a UI feature).
**Companion:** data analysis + decisions in `BAJAJ-DATA-MIGRATION.md`.

## 0. Guardrails
- Tenant-asserted to **`bajaj`** on every write (hard guard; the Deoleo mix-up must not recur).
- `current_database()='gifsy_staging'` guard in the job before any write.
- **Idempotent / overwrite**, keyed on **OutletCode** — re-running with a corrected file overwrites cleanly.
- Dry-run FIRST (no writes) → owner reviews → real run.

## 1. Handling policy — "RELAX INTO MISSING DATA" (owner, 2026-10-31)
- Import **ALL** rows. Skip **none**. Relax **no** platform rule (uniqueness stays ON).
- Any field that is **duplicate / conflicting / invalid / un-downloadable** → stored **BLANK (missing), flagged** — never the conflicting value. The corrected re-upload fills the blanks. Rationale: re-upload trials never hit the rejection again.
- Per issue:
  - Shared/duplicate bank account (97), junk `na`/`N/A` (29), no-account (1,770), no-IFSC (1,839) → **bank mandate blank/incomplete**, flagged.
  - Owner mobile == existing rep phone (9) or in-file dup (2) → **owner-login phone blank** (no User login created yet), flagged.
  - Bad pincode (23) → **pincode blank**, flagged.
  - IFSC `O`→`0` typo (27) → **auto-corrected** (kept, only where it yields a valid IFSC).
  - ISR `1388` (2 outlets) → **overridden → `1380`** (verified active XSR).
  - Enrollment_Status ≠ 1 (2) → imported, flagged (not skipped).
  - Dead doc link (1,016) → doc **not attached**, logged.
- Every blanked/flagged field is recorded in the import log + the consolidated report so the vendor can correct.

## 2. Architecture
- **Part A — local parser/transformer** (my machine, reads the owner-shared dump): map + clean + validate → a JSON **manifest** (1 record/outlet, all mapped fields + flags) + a **dry-run report (Excel)**. Manifest uploaded to a GCS bucket.
- **Part B — in-VPC import job** (Cloud Run job, staging api image, `@prisma/client`+`pg`): reads the manifest from GCS → upserts into the DB → import log to Cloud Logging. `--vpc-egress=private-ranges-only` reaches GCS (internet) + the private DB.
- **Part C — doc pipeline (phase 2)**: separate job downloads the manifest's doc URLs (retry/skip dead) → `storage.uploadFile` (`kyc/bajaj/…`) → attach `KycDocument`.

## 3. Column → model mapping (per outlet)
*(creation-call shapes/FK-order being finalized from the model-map investigation; see BAJAJ-DATA-MIGRATION.md §3 for the column mapping)*
- **Outlet** — OutletCode→outletCode, OutletName→name, Outlet Type RLP→`SSS`/BSC→`WHOLESALER`, DistributorName/SAPCODE, MainState/City/Pin/Address, Metro, Zone, Program/Sub-program, RetailerName→ownerName, requiredPaymentType (BANK/UPI).
- **Owner** — ChannelPartner + User(login, phone). Phone blanked on collision → no User login (flagged).
- **Bank mandate** — bankName/accountHolder/branch/account/IFSC, or UPI (BankName=UPI→upiId). Blank on duplicate/invalid.
- **KYC-APPROVED** — KycSubmission(status=approved) + verification items so it reads as approved + provenance.
- **Rep link** — SalesUserAssignment by ISR employeeCode (1388→1380).
- **Docs** (phase 2) — the 5 URL columns → KycDocument types.
- **Provenance** — additive `enrollmentSource=VENDOR_IMPORT` + import batch id/date (default keeps all other tenants byte-identical).

## 4. Transforms
UPI (`BankName=UPI`→`upiId`, clear bank fields) · trim leading spaces · IFSC `O`→`0` (valid only) · outlet-type code map · ISR 1388→1380 · state normalize (MainState) · approval date = cisplApprovaldate (blank the 1899/empty).

## 5. Phasing + timeline (estimate)
- **P0** contract + model-map investigation — *now*.
- **P1** core importer (provenance schema+migration → local parser → import job) → FULL gates → **DUAL adversarial audit** (money/identity/KYC-approved = sensitive path) → **staging DRY-RUN delivered for owner review**. ≈ ~1 day of focused build+gate+audit.
- **P2** real staging import + **runtime verify in the Bajaj UI** (outlets, owner app, KYC-approved state, rep links). ≈ a few hours after dry-run sign-off.
- **P3** doc pipeline (~3 GB download+store, 1,016 dead skipped+logged). ≈ ~half a day build + 30–90 min run.
- Prod = separate owner-gated cutover, later.

## 5b. STATUS (2026-10-31)
- Built (orchestrated): model-map → local parser (manifest.json, 6,505 records) → import job (`scratchpad/bajaj-enrollment-import.job.js`). Provenance schema shipped to staging (commit `5838463`, migration `20261031120000_add_enrollment_provenance`; gates green incl. Dockerfile seed/bootstrap compiles).
- **DUAL adversarial audit done** (correctness/money + safety/idempotency). Core sound (tenant isolation, idempotency, dry-run rollback). Fixes applied: (F1) partner native-overwrite guard before write; (F2) owner-user reuse by LAST-10 + owner-role only; (F3) wallet only when KYC-approved; (F4) approval-date guard.
- **Owner decisions (2026-10-31):** (1) blank-owner-mobile outlets MUST be KYC-approved (downstream points/payout files reference them) → create a UNIQUE SYNTHETIC login (`__import__:<outletCode>`), real mobile flagged `ownerMobilePending`; (2) all 7 KYC fields APPROVED incl. PAYMENT-when-bank-blank = fine.
- ⚠️ Prisma 7 runtime DMMF exposes NO enums → the enum feature-check was removed (the `Outlet.enrollmentSource` field check is the real proof the migration landed). Job must run on the PINNED `api:staging-<sha>` image (floating `:staging` lagged).
- ✅ **DRY-RUN GREEN (staging, `api:staging-5838463…`):** 6,505 wouldCreate / 0 update / **0 errors**. Nothing committed.
- ✅ **REAL IMPORT COMMITTED + DB-VERIFIED (2026-10-31, owner GO):** 6,505 created / 0 errors. Verified in `gifsy_staging`: 6,505 outlets (SSS 4,142 + WHOLESALER 2,363), all `isActive`, 6,505 owners, **6,505 KYC-APPROVED** (`enrollmentSource=VENDOR_IMPORT`), 6,505 wallets, 6,505 active rep-assignments. Spot-checks pass: ISR 1388→1380 on both outlets; synthetic login (`__import__:<code>`, ACTIVE, APPROVED) on pending-mobile outlets; a normal outlet carries owner+bank+KYC-APPROVED. **Deoleo contamination check = 0.**
- ✅ **UI SPOT-CHECK PASSED (2026-10-31):** logged into `uat-bajaj.gifsy.in` as Bajaj CLIENT_ADMIN — dashboard 6,514 active partners / Pending KYC 1; Outlet Master 6,515 total / 6,513 approved; KYC list shows imported outlets as APPROVED with real owners; opened BANSAL TRADERS → KYC detail renders, Submitted=2026-08-22 (corrected date live).
- ✅ **KYC DATE FIX (2026-10-31):** submitted/reviewed/approved all = vendor approval date (0 rows submitted>approved); re-run = 6,505 UPDATED, 0 dupes.
- ✅ **PHASE 2 DOCS — PIPELINE BUILT + VALIDATED (2026-10-31):** `scratchpad/bajaj-docs-migration.job.js` (download→magic-byte sniff→GCS `kyc/bajaj/vendor-import/<code>/<TYPE>.jpg`→`KycDocument(VERIFIED)`, idempotent, prefix-deletable, metadata-tagged). SAMPLE run (50 outlets) = **161 docs stored / 0 dead / 0 errors**, and the images **render in the KYC Document Review UI** (verified on BANSAL TRADERS). ⚠️ inline the script via gcloud WITHOUT the README (README contains `@@@`, collides with the delimiter; base64 is too big for the OS arg limit) — `sed -n '1,462p'` then `--args="^@@@^-e@@@$SCRIPT"`, pinned `staging-<sha>` image.
- ▶ **DECISION HELD:** full ~24k-doc / ~3 GB doc run DEFERRED to the final (corrected) upload — disposable trial, no point downloading 3 GB that gets deleted. Run it on the final data (drop SAMPLE_LIMIT).
- ▶ remaining: the corrected re-upload when the vendor fixes the flagged data; the other data files (sales/targets, points/payouts, TDS, visibility); prod cutover later (owner-gated).

## 6. Verification (definition of done)
Dry-run counts reconcile (creates/updates/flags) → owner approves → real run → spot-check in the Bajaj staging UI across roles (admin outlet master, partner app login for a clean outlet, KYC-approved grid, sales rep sees assigned outlets). Independent audit must pass (no cross-tenant write, no Deoleo impact, idempotent re-run safe, no money/identity misroute).
