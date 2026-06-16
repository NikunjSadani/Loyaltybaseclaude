# KYC Approval Revamp — Gifsy bulk verification & approval

> Design agreed 2026-06-15 (owner). Lives in **P3 · Onboarding & KYC** (task 3.4 area; gaps #12 GST/bank
> validation, #14 field-level rejection, #15 reg-type capture). This is the canonical design for the Gifsy
> KYC-approval revamp the owner is doing. Captures decisions; the exact schema is finalized at P3.0/3.4
> reconcile (the approval page is being redesigned — code wins at reconcile).

## Demo status (built 2026-06-15; rebuilt to the 7-field hybrid model)
The **full field-level hybrid workspace is built in DEMO mode on `develop`** (gated + independently audited):
`lib/kyc-review-dump.ts` (40-col dump: all enrollment fields + clickable document hyperlinks + a Decision+Remark
column per field), `lib/kyc-bulk-verify.ts` (`parseKycApprovalSheet` → per-field updates + concise-English error
report), `api/admin/kyc/{approvals,review-dump,bulk-verify}` (GIFSY-only), and `admin/kyc/approvals` — a unified
workspace: queue with *n/7* progress → export → upload-**merge** (blank cells never clear a status) → per-entry
detail (photos w/ **click-to-enlarge lightbox**, per-field Approve/Reject + remark) → completion banner (all
approved → credentials+WhatsApp; any reject → re-share to sales). Sidebar **KYC Management → KYC Approvals**
points here. **No schema, no DB writes** (demo). Verified end-to-end in DEMO (queue, export, upload→merge,
error report, lightbox, completion).

**Remaining for P3:** **3.4a** schema + dev-DB migration (entityType/gstRegistrationType + persisted per-field
verification), **3.4e** real persistence (commit writes + status transitions + audit) + credential creation
(3.3) + **WhatsApp (P7/MSG91)** + the rejection→Re-KYC re-share wiring (reuse `reKycFlags`), and the
single-record detail-page field-level rejection. **Audit notes folded forward:** N1 — mark the nav link
`gifsyOnly:true` once real roles are wired (left visible now because gifsyOnly links are hidden in demo mode);
N2 — cosmetic (`remark:undefined` on approved merges).

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
- **Field-level verification** (on `KycSubmission`, or a normalized `KycVerificationItem` table — decide at
  reconcile): **bank** reuse `pennydrop*` + add `bankNameMatch` + `bankVerifiedById`; **GST** add
  `gstLegalName`, `gstStatus`, `gstVerifiedById/At`; **address** `addressApproved/ById/At`; **owner**
  `ownerApproved/ById/At`; per-check `notes`. Documents already have `KycDocument.status`.
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

## Open questions for the owner (resolve at build time)
- GST registration-type value set: `REGULAR / COMPOSITE / UNREGISTERED` — also add `CASUAL` / `SEZ`?
- On bulk commit, does an all-fields-pass row **auto-approve**, or always require a final explicit Gifsy commit?
- "Verified by" identity for bulk = the uploading Gifsy admin (single actor for the batch)?
- KYC validity period before `RE_KYC_REQUIRED`.
