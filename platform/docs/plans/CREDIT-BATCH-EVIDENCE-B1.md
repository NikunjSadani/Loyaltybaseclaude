# B1 — Audit-evidence attachments on a credit/payout batch

**Status:** BUILT + gated + independently audited + boot-verified on `develop` (local, not yet deployed). Full data-path runtime verification is deferred to staging UAT. 2026-10-04.

## Why
A client runs its visibility audit **offline** and shares the proof (photos / a PDF audit sheet) with us; we pay those outlets under **194C**. The 194C payment already has a home (the Credits & Payouts rail → self-billed invoice → payout), but there was **no place in the portal to keep the audit proof** with the payment record. B1 adds that: bulk-upload the evidence files against the **batch** that pays them.

This is deliberately **not** the POSM visibility photo module — that is in-app, sales-captured, geo-fenced-on-submit, and decoupled from payment; it cannot ingest externally-captured photos.

## Decision (owner-approved)
- Attach evidence at the **batch** level, **bulk upload** (select many → all attach), **no per-file tagging**.
- Allowed types: **JPG / PNG / WEBP + PDF**, ≤ 10 MB each.
- **Add-only after the batch is CONFIRMED** (invoices generated) — evidence can still be added, but not deleted, so the audit trail can't be rewritten.
- `outletCode` is a reserved **nullable, unused** column (no UI) so a future "evidence per outlet in the report" surfacing needs no migration.

## What was built
**Backend (`api/src/credits/`):**
- `credit-evidence.service.ts` — mirrors the hardened `VisibilityMediaService` (magic-byte sniff — client mimetype ignored; tenant-foldered GCS key `credit-evidence/<clientId>/<batchId>/…`; auth-gated inline-safe stream). Methods: `uploadEvidence` (bulk, validates **all** files before storing **any**, cleans up GCS objects if a later write fails), `listEvidence`, `viewEvidence`, `deleteEvidence` (add-only-after-confirm).
- `credits.controller.ts` — 4 endpoints (tenant-scoped; GIFSY works a tenant by assuming it):
  - `POST /v1/admin/credits/batches/:id/attachments` — `FilesInterceptor('files', 5, {fileSize:10MB})`, perm `credits:upload`.
  - `GET  /v1/admin/credits/batches/:id/attachments` — perm `credits:read`.
  - `GET  /v1/admin/credits/attachments/:id/media` — `credits:read`; `Cache-Control: no-store`; **images inline, PDFs served as attachment** (a crafted PDF can't run JS in the app origin).
  - `DELETE /v1/admin/credits/batches/:id/attachments/:attId` — `credits:upload`.
- `credit_batch_attachments` table (additive migration `20261003140000_add_credit_batch_attachment`) — metadata only, FK→`credit_batches` ON DELETE CASCADE; never touches a money row.

**Frontend (`platform/src/app/admin/credits-payouts/status/`):**
- `_components/BatchEvidencePanel.tsx` — an "Audit evidence" panel on the expanded batch in the **Payout Status** page: bulk drag/drop upload (chunks of 5), thumbnail grid (image lightbox; PDF opens via the media endpoint), delete (only while `PENDING_CONFIRM`), distinct load-error state, partial-upload reporting, a11y (Esc-to-close dialog, keyboard-reachable delete).

## Verification
- **Gates:** `tsc -p tsconfig.build.json` 0 · api jest **3468** (incl. 15 new `credit-evidence` specs) · FE `tsc --noEmit` 0 · FE vitest **2606**.
- **Independent adversarial audit** (security + correctness + UI/UX): **high-risk categories all clean** — tenant isolation / IDOR, path traversal, filename-header injection, XSS-via-image, magic-byte gate, add-only, DB atomicity. Operational findings **fixed**: in-RAM DoS (bulk cap 20→5), GCS orphan cleanup on partial failure, `Cache-Control: no-store`, PDF→attachment, FE partial-upload messaging + distinct load-error state + a11y.
- **Runtime boot:** the app boots with the new module (DI resolves; "Nest application successfully started"); all 4 routes mapped + auth-gated (401 unauth, not 404).
- **Deferred to staging UAT:** the full data-path e2e (real upload→GCS→DB→stream + cross-tenant negative), to avoid mutating the active shared dev DB.

## Open / follow-ups (not blockers)
- **GCS lifecycle:** ✅ WRITTEN in `terraform/gcs-memorystore.tf` (commit `8e65026`) — `credit-evidence/` prefix gets ARCHIVE@120d + Delete@2555d (7y), mirroring `visibility-media/` exactly; `terraform fmt`/`validate` clean. **Not applied** (touches the shared prod bucket) — `terraform apply` it at the B1 cutover with owner go.
- **TOCTOU soft cap:** the per-batch 100-file cap is a soft resource limit (count-then-insert, not locked) — concurrent uploads could slightly exceed it. Accepted; not a security boundary.
- **Perm coupling:** upload and delete both use `credits:upload` (no separate `credits:delete`), consistent with the module. Owner sign-off noted.
- **Deploy:** additive + dormant-safe; ships with the next staging deploy (the migration runs via `gifsy-migrate-staging`). Batch with the seed-packaging fix to keep deploy cutovers few.
