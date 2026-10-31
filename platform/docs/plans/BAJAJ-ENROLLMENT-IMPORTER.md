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

## 6. Verification (definition of done)
Dry-run counts reconcile (creates/updates/flags) → owner approves → real run → spot-check in the Bajaj staging UI across roles (admin outlet master, partner app login for a clean outlet, KYC-approved grid, sales rep sees assigned outlets). Independent audit must pass (no cross-tenant write, no Deoleo impact, idempotent re-run safe, no money/identity misroute).
