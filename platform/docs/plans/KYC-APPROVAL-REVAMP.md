# KYC Approval Revamp — Gifsy bulk verification & approval

> Design agreed 2026-06-15 (owner). The canonical design for the Gifsy KYC-approval revamp; captures the locked
> decisions (resolved at the bottom). **✅ BUILT IN P3 (3.4a–e + 3.3, 2026-06-17)** — see the build record in
> `reconcile/P3-onboarding-kyc.md`. This doc is now a design/decisions reference, not a status tracker.

## ✅ Status — BUILT (P3), 2026-06-17
The field-level hybrid workspace shipped **for real in the NestJS backend** (no longer the demo):
`KycVerificationItem` schema (Option A) + `entityType`/`gstRegistrationType` on `ChannelPartner`; `GET
/v1/kyc/review-queue` + `GET /v1/kyc/review-dump` + `POST /v1/kyc/bulk-verify?apply=` (preview→commit,
**auto-approve**) + `POST /v1/kyc/:id/verify` (per-field portal); the shared `applyBridgeOutcome`; the `admin/kyc/
approvals` UI + the `admin/kyc/[id]` detail panel **repointed to the backend and browser-verified**.
**The original DEMO (`lib/kyc-review-dump.ts`, `lib/kyc-bulk-verify.ts`, `api/admin/kyc/*`) was PORTED to the backend
and then DELETED** (commit `e548aa7`). Closes gaps #12/#14/#15.

**Carried to later phases (not done):** credential issuance = the activate-user-on-approve (built); **WhatsApp delivery
= P7/MSG91**; assigned-sales-owner re-KYC notification (only the partner is notified today) = P4; nav link
`gifsyOnly:true` once real roles wired (RBAC enable).

## Expanded approval model (owner, 2026-06-15)
**7 approval fields**, each independently `PENDING → APPROVED / REJECTED(+remark)`, with **source (Excel|Portal)
+ who/when** recorded:
1. **Payment** (bank: name/holder/acct/IFSC **or** UPI) + cancelled-cheque doc + payment geo
2. **GST validation** (the GSTIN; reg type/legal name from offline check)
3. **GST document** (certificate)
4. **Address** (address/city/state/pincode; name-mismatch flag)
5. **Address document** (shop-establishment + self-declaration)
6. **Store board photo** (+ board geo)
7. **Owner photo** (selfie)
PAN rides with GST (auto-derived at enrollment); signature/consent handled via OTP, not separately approved.

**Two-stage architecture (owner-confirmed 2026-06-16).** The approval is two linked tables, not one:
- **Stage 1 = submission lifecycle** (`KycSubmission.status`, the existing sales-chain state machine
  `PENDING_SO → … → PENDING_GIFSY → APPROVED`). The field-sales chain does the *first* approval; everything
  funnels to `PENDING_GIFSY`.
- **Stage 2 = the 7-field grid** (`KycVerificationItem` rows). It **begins only when Stage 1 reaches
  `PENDING_GIFSY`** (the submission surfaces in the Gifsy portal) and the verification rows are created then.
- **`status` stays `PENDING_GIFSY` for the entire time Stage 2 is worked** — partial progress ("n of 7") is
  **derived from the `KycVerificationItem` rows, never encoded in the status enum** (avoids enum explosion). The
  status moves only at the boundaries.
- **Bridge:** all 7 rows terminal-and-APPROVED ⟹ Stage 1 flips to `APPROVED` (→ activate user + wallet +
  credentials + WhatsApp). Any row REJECTED ⟹ Stage 1 → `RE_UPLOAD_REQUIRED`, re-opening only the rejected
  field(s) via the existing `reKycFlags` re-share.

**Hybrid Excel + portal (merge, never overwrite).** The Excel dump must contain **ALL enrollment fields**
(see `sales/kyc/new`: outlet/owner, mobile, program/programCategory + outlet type *(NOT "partner class" — that's retired; the legacy `partnerClass` field actually held outlet-type values)*, GST/PAN, address, bank/UPI, geo, name-mismatch) **+ a
clickable hyperlink to every document** (GST cert, address doc, self-declaration, board photo, owner photo,
cheque) **+ a Decision + Remark column for each of the 7 fields**. The approver fills some fields in Excel and
the rest on the portal; an upload **merges** parsed statuses in — a blank Excel cell never clears a status set
on the portal, and vice-versa (last-write-wins per field). The portal detail view shows all photos/details +
each field's current status (reflecting what Excel set) and lets the approver change any field there.

**Completion + re-share.** An outlet is processed only when **all 7 fields are terminal** (a REJECT requires a
remark). **All approved → create outlet credentials + send WhatsApp** (credentials = P3.3 activate+wallet;
WhatsApp = P7/MSG91). **Any rejected → send back to the outlet's sales owner**, re-opening only the rejected
fields — this **reuses the existing per-field Re-KYC mechanism** (`reKycFlags` + the amber "Re-enter required"
badges already in `sales/kyc/new`). No new re-share concept needed.

**Excel error report:** invalid rows are returned with a concise-English **`Errors`** column (e.g. "Owner Photo
rejected without a remark; GST Validation decision 'OK' is not APPROVE/REJECT").

## The operation (owner's description)
Gifsy takes the **entire dump** of what field agents filled, **validates bank-account details + GSTIN
offline** (penny-drop tool + GST portal), then **bulk-uploads** the validated results back to the portal —
recording the **GST registration type** and **approving address + owner details** against the submitted
documents.

## Locked decisions (owner, 2026-06-15)
1. **Field-level verification** — bank / GST / address / owner / documents are tracked as **separate verified
   facts**, each with evidence + verifier. Enables **partial re-upload** (fix only the failing piece) instead
   of rejecting the whole submission. (Industry-standard fintech KYC.)
2. **Two-lane surface** — a **bulk lane is the primary** Gifsy flow; the existing single-record detail page
   (`admin/kyc/[id]`) is **kept for exceptions** (flagged rows, disputes, one-offs). Augment, don't replace.
3. **Structured, API-ready evidence** — store penny-drop reference + name-match, GST legal name + registration
   type + status, etc. as **structured fields**, so a future penny-drop / GSTIN-lookup **API** populates the
   same fields with no rework. Offline now, automatable later.

## The bulk flow (Lane A — primary)
1. **Export the KYC review dump** — one Excel of all `PENDING_GIFSY` submissions with every filled field +
   document links. **Reuses the report/export engine** (`lib/*-export.ts`) from the reporting track — the
   "dump" is a KYC-review export.
2. **Offline validation** — Gifsy fills verification columns: bank verified (Y/N + ref + name-match), GST
   registration type + legal name + status, address approved (Y/N), owner approved (Y/N), decision
   (Approve / Re-upload / Reject + reason).
3. **Upload → dry-run preview → commit** — parse the sheet, show a **per-row validation/error report and a
   preview of what will change**, then commit: write field-level verification + advance each submission's
   status + record verifier/evidence in `KycStatusHistory`. **Idempotent**, keyed by submission id / outlet
   code (mirrors the existing `lib/sales-excel-upload.ts` / `lib/target-excel-upload.ts` pattern).

## Lane B — single-record (exceptions)
The existing detail page, enhanced with **field-level rejection** (#14): reject just the bank / GST / address /
owner / a specific document with a reason → targeted `RE_UPLOAD_REQUIRED`, not a blanket reject.

## What exists today (starting point)
- Single-record approval only: `api/kyc/[id]/first-approve` (sales tree) → `api/kyc/[id]/approve` (Gifsy final);
  `lib/kyc-approval.ts`; detail page `admin/kyc/[id]`.
- Rich `KycStatus` state machine incl. `PENDING_PENNY_DROP` + `PENDING_GIFSY`; `KycSubmission.pennydrop{Ref,
  Status,VerifiedAt}` (bank evidence already half-modeled); `KycDocument.status` (doc-level); immutable
  `KycStatusHistory` audit. Maker-checker + KYC-as-Gifsy-operated already encoded in RBAC.
- **`EntityType` + `GSTRegistrationType` exist only in `lib/invoice.ts`** (for TDS/invoicing) — `REGULAR /
  UNREGISTERED / COMPOSITE`, and `INDIVIDUAL/HUF/COMPANY/FIRM/LLP/OTHERS` — **not persisted on the outlet/KYC**.
- **No bulk path** anywhere.

## Schema direction (finalize at P3.0/3.4 reconcile — needs an additive dev-DB migration ⚠️ human-gated)
- **ChannelPartner:** add `entityType` + `gstRegistrationType` (promote the `lib/invoice` string-unions to
  Prisma enums; reconcile `lib/invoice` to read the persisted values — feeds P6 invoicing/TDS). Captured at
  KYC approval.
- **Field-level verification = a normalized `KycVerificationItem` table** (Option A, owner-decided 2026-06-16 —
  one uniform store for the uniform 7-field engine; chosen over scattering decisions across `KycDocument.status` +
  `pennydrop*` + new columns, which would force a 3-way join in the dump/parse/merge/commit logic). Shape:
  `(kycSubmissionId, fieldKey, decision PENDING|APPROVED|REJECTED, source EXCEL|PORTAL, remark, verifiedById,
  verifiedAt, evidence Json?)`, one row per (submission × 7 fields). Structured offline-check evidence rides in the
  row / `evidence` JSON: **bank** → reuse `pennydrop*` + `bankNameMatch`; **GST** → `gstLegalName`, `gstStatus`;
  **address/owner** → in-row decision. The 4 document fields may **reference** the relevant `KycDocument` as
  evidence; `KycDocument` stays the uploaded-file record (the verification *decision* lives in `KycVerificationItem`,
  not duplicated in `KycDocument.status`).
- A **bulk-upload artifact** (parsed result + audit), mirroring the sales/target Excel-upload libs.

## Best practices baked in
Maker-checker · field-level (partial re-upload, not blanket reject) · **dry-run preview + per-row error
report** before commit · capture **evidence** not just a Y/N · immutable audit of each field's verifier+ref ·
**DPDP**: bank/PAN/GST are sensitive → Gifsy-only (RBAC), masked in lists, access-audited · re-KYC/expiry
triggers (`RE_KYC_REQUIRED`) + the phone-change→re-KYC hook.

## Task breakdown (slots into P3.4, split)
- **3.4a** schema: `entityType` + `gstRegistrationType` on ChannelPartner + field-level verification fields/
  table (**additive dev-DB migration — human-gated**, apply per `DEV-DB.md`, `gifsy_dev`-guarded).
- **3.4b** export the **KYC review dump** (reuse the export engine).
- **3.4c** bulk upload: parser + **dry-run preview + per-row error report** + commit (field-level verification
  + status transitions + audit); idempotent keyed by submission/outlet code.
- **3.4d** the **bulk-approval UI** (new primary Gifsy surface) + **field-level rejection** on the detail page (#14).
- **3.4e** GST/bank **evidence capture** + reg-type → **invoicing wiring** (#12/#15) + DPDP masking.

## Repercussions / dependencies
- **Migration** (3.4a) is the one human-gated, irreversible-ish step — never `prisma migrate dev`; diff-SQL,
  `current_database='gifsy_dev'`-guarded.
- **Invoicing interplay (P6):** once `entityType`/`gstRegistrationType` are persisted at KYC, `lib/invoice`
  reads them instead of recomputing — reconcile in P6.
- **Reporting track:** the dump export reuses `lib/*-export.ts`.
- **3.0 reconcile** builds against the owner's revamped approval page (code wins).
- Routing (3.2) + re-KYC (3.6) + phone-change→re-KYC hook are adjacent P3 work.

## Resolved (owner, 2026-06-16) — were open questions
- **GST registration-type value set = `REGULAR / COMPOSITE / UNREGISTERED`** (3 values; CASUAL/SEZ NOT needed).
- **Auto-approve on bulk commit:** a row with all 7 fields APPROVE **auto-flips the submission to `APPROVED`** on
  commit (no separate per-row Gifsy click) — and so fires activation + wallet + credentials + WhatsApp. The
  **dry-run preview before commit remains the safety gate** (a bad sheet is caught at preview, not after).
- **Bulk "verified-by" = the uploading Gifsy admin**, single actor for the whole batch (recorded on every field
  the upload touches). Per-field verifier identity is NOT carried in the sheet.
- **KYC validity = event-driven, NOT time-based.** No automatic expiry / no validity-period countdown. Re-KYC is
  triggered **manually** (someone flags it) → `RE_KYC_REQUIRED` + the existing `reKycFlags` re-share. (Task 3.6 is
  therefore a *manual* re-KYC trigger + SLA metrics, not a time-expiry job.)
