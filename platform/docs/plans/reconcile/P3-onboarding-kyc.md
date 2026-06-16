# P3 Reconcile — Onboarding & KYC (Task 3.0)

**Task 3.0.** Reconcile the existing KYC code against spec **§02 Workflow 1** (`docs/spec/02-workflows.md:49`)
and the owner-locked redesign (`docs/plans/KYC-APPROVAL-REVAMP.md`). Establishes what 3.1–3.6 build on, the
concrete Option-A schema, the Stage-1↔Stage-2 bridge, and the auto-approve commit transaction. **This document is
the artifact for the independent review** (run before the 3.4a migration gate).

> **Rule:** plan against the spec, build against the code; where they disagree, **the code (and the owner's locked
> decisions) win** — the spec note is a correction. Tags: **BUILD** (missing) · **COMPLETE** (partial/DEMO — finish
> it) · **VERIFY** (looks done — prove with a test).

> **Method.** Opus read every load-bearing file directly (the backend `api/src/kyc/*` module, the 3 platform demo
> routes + 2 libs, the KYC schema models, `lib/invoice` enums, RBAC perms) — not relayed on an executor's word. See
> the audit summary in the session that produced this doc.

---

## 0 · The big picture (two parallel stacks)

The backend split (Phase S) changed which KYC code is authoritative:

| Stack | What it is | Reuse verdict |
|---|---|---|
| **Backend** `api/src/kyc/*` | Single-record pipeline, re-homed in S4 | **REAL** — production-shaped; the spine for 3.1/3.3/3.5/3.6 |
| **Platform demo** `admin/kyc/approvals` + `lib/kyc-{review-dump,bulk-verify}.ts` + 3 routes | 7-field Lane A bulk workspace (the locked UX) | **DEMO** — in-memory, **zero DB**, preview-only. Port to backend + add persistence (3.4) |

The dead duplicate `platform/src/lib/kyc-approval.ts` is superseded by `api/src/kyc/kyc-approval.helper.ts`
(retires with the deferred 112-file cleanup).

---

## 1 · Capability tags

| Capability | Tag | Evidence | clientId-scoped? | Gap |
|---|---|---|---|---|
| Submission create (`POST /v1/kyc`) — partner upsert + docs + geo + escalation + history | **VERIFY** | `api/src/kyc/kyc.service.ts:79` | ✅ `user:{clientId}` | — |
| List / queue (`GET /v1/kyc`) — role-scoped (SO/ASM/RSM see their queue) | **VERIFY** | `kyc.service.ts:207` | ✅ | — |
| Detail (`GET /v1/kyc/:id`) | **VERIFY** | `kyc.service.ts:262` | ✅ | — |
| First-approve (`POST /v1/kyc/:id/first-approve`) — sales-chain Stage 1 | **VERIFY** | `kyc.service.ts:331` | ✅ | #9 (routing source) |
| Gifsy approve (`POST /v1/kyc/:id/approve`) — flips → APPROVED + activate + wallet | **COMPLETE** (semantics change — must gate on the bridge, see §4) | `kyc.service.ts:393` | ✅ | — |
| Reject (`POST /v1/kyc/:id/reject`) — single `rejectionReason` string | **COMPLETE** (needs field-level) | `kyc.service.ts:470` | ✅ | #14 |
| Consent + OTP (`POST /v1/kyc/consent`) | **VERIFY** | `kyc.service.ts:591` | ✅ (userId) | — (3.5 extends) |
| Not-interested (`POST /v1/kyc/not-interested`) → `Outlet.kycIntent` | **VERIFY** | `kyc.service.ts:636` | ✅ `clientId_outletCode` | — |
| SLA metrics (`GET /v1/kyc/sla-metrics`) — Gifsy-only | **VERIFY** | `kyc.service.ts:664` | ✅ | #13 (re-KYC side) |
| Ledger (`GET /v1/kyc/:id/ledger`) | **VERIFY** | `kyc.service.ts:541` | ✅ | — |
| Approval routing (pure) `resolveApprover/initialKycStatus/...` | **COMPLETE** (works off hardcoded `ROLE_PHONES`) | `kyc-approval.helper.ts:31` | n/a | **#9** |
| **Lane A: review-dump export** (40-col xlsx + doc hyperlinks + 7×decision/remark) | **COMPLETE** (DEMO, platform-only, pure) | `platform/src/lib/kyc-review-dump.ts` | n/a | port to backend |
| **Lane A: bulk-verify parser** (per-field merge + error report) | **COMPLETE** (DEMO, preview-only) | `platform/src/lib/kyc-bulk-verify.ts`; route `bulk-verify/route.ts:79` `TODO(P3): load real pending IDs` | n/a | + commit mode |
| **Field-level verification persistence** (the 7-field state) | **BUILD** | in-memory `KycFieldState` (`@/types:1177`); nothing persisted | — | **3.4a** |
| **`entityType` / `gstRegistrationType` on partner** | **BUILD** | string-unions in `lib/invoice.ts:20`, NOT on `ChannelPartner` | — | **#12/#15** |
| RBAC `kyc:*` (6 perms: read/initiate/approve/reject/gifsy_approve/view_documents) | **VERIFY** | `api/src/common/rbac/permissions.ts:92` | n/a | — |
| Submission form + GCS doc upload (UI) | **VERIFY** | `platform/src/app/sales/kyc/new` + `lib/s3.ts` / `StorageService` | — | 3.1 |
| Consent / DPDP `DataRequest` | **BUILD** | `ConsentRecord` model exists; `DataRequest` flow not wired | — | 3.5 |

---

## 2 · Spec §02 WF1 ⇄ code reconcile (corrections)

| Spec WF1 says | Code / owner-decision reality | Resolution |
|---|---|---|
| `PENDING_GIFSY → PENDING_PENNY_DROP → APPROVED` (penny-drop is its own state) | Owner-locked: **status stays `PENDING_GIFSY` for the whole 7-field grid**; PAYMENT field carries the penny-drop result | **Spec correction:** `PENDING_PENNY_DROP` (and `PENDING_AGREEMENT`) become **unused** — folded into the grid's PAYMENT verification. Status moves only at the boundaries. |
| First-approve checks hardcoded SO/ASM/RSM | `ROLE_PHONES` constant in the helper | **#9** — 3.2 swaps the data source to the relational `SalesUser` tree (P2.1) behind the same function signatures. |
| Field-level rejection intended; `reject` stores one string | `reject()` writes a single `rejectionReason` | **#14** — field-level lives in the new `KycVerificationItem` rows + per-field `reKycFlags` re-share. |
| GST reg type recorded, drives invoice GST (#12c) | only a string-union in `lib/invoice`, not persisted | **#12/#15** — 3.4a persists `gstRegistrationType` on `ChannelPartner`; `lib/invoice` reconciles to read it (P6). |
| `RE_KYC_REQUIRED` trigger TBD | — | **#13** — owner-decided **event-driven/manual** (no time expiry). 3.6 = manual trigger + SLA metrics. |
| Escalation decided once at submit | `initialKycStatus` resolves once; mid-flow resignation not re-evaluated | Carry-forward (acceptable); note in 3.2. |

---

## 3 · The decided model (owner-locked 2026-06-16 — see KYC-APPROVAL-REVAMP.md)

- **Two stages.** Stage 1 = `KycSubmission.status` sales-chain machine (`PENDING_SO → … → PENDING_GIFSY →
  APPROVED`). Stage 2 = the 7-field grid (`KycVerificationItem` rows), which **starts when Stage 1 hits
  `PENDING_GIFSY`** (rows created then) and the submission surfaces in the Gifsy portal.
- **`status` stays `PENDING_GIFSY`** through Stage 2; "n of 7" is **derived from the rows**, never an enum value.
- **Option A** — one normalized `KycVerificationItem` table (chosen over scattering decisions across
  `KycDocument.status` + `pennydrop*` + columns).
- **Resolved questions:** 3 reg-types (`REGULAR/COMPOSITE/UNREGISTERED`); **auto-approve** on all-7-APPROVE commit;
  **verified-by = the uploading admin** for the batch; re-KYC **event-driven/manual**.

---

## 4 · Concrete schema (Option A) — the 3.4a migration ⚠️ human-gated

> Additive only. Applied to `gifsy_dev` via `prisma migrate diff` → guarded SQL
> (`current_database='gifsy_dev'`), **never** `prisma migrate dev`. Show SQL + wait for owner go.

```prisma
enum KycFieldKey {
  PAYMENT
  GST_VALIDATION
  GST_DOCUMENT
  ADDRESS
  ADDRESS_DOCUMENT
  BOARD_PHOTO
  OWNER_PHOTO
}
enum KycFieldDecision { PENDING  APPROVED  REJECTED }
enum KycFieldSource   { EXCEL    PORTAL }

enum EntityType          { INDIVIDUAL  HUF  COMPANY  FIRM  LLP  OTHERS }
enum GstRegistrationType { REGULAR  COMPOSITE  UNREGISTERED }

model KycVerificationItem {
  id              String           @id @default(cuid())
  kycSubmissionId String
  fieldKey        KycFieldKey
  decision        KycFieldDecision @default(PENDING)
  source          KycFieldSource?
  remark          String?
  verifiedById    String?          // the Gifsy admin (uploader for EXCEL; actor for PORTAL)
  verifiedAt      DateTime?
  evidence        Json?            // PAYMENT:{pennydropRef,nameMatch} · GST:{legalName,status} · doc:{kycDocumentId}
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  kycSubmission   KycSubmission    @relation(fields: [kycSubmissionId], references: [id], onDelete: Cascade)

  @@unique([kycSubmissionId, fieldKey])   // exactly one row per (submission × field)
  @@index([kycSubmissionId])
  @@index([decision])
  @@map("kyc_verification_items")
}

// ChannelPartner — add:
//   entityType          EntityType?
//   gstRegistrationType GstRegistrationType?
//
// KycSubmission — add the REVERSE relation (Prisma requires both sides, else
//   `prisma validate` / `migrate diff` fails — independent-review BLOCKER #1):
//   kycVerificationItems KycVerificationItem[]
```

**Tenant scoping:** `KycVerificationItem` has no direct `clientId` — scoped via
`kycSubmission → user → clientId` (same pattern as `KycDocument` / `KycStatusHistory`). All queries filter through
that relation.

**Evidence, not duplication:** the 4 document fields' `evidence.kycDocumentId` points at the existing
`KycDocument`; `KycDocument` stays the uploaded-file record. The verification **decision** lives only in
`KycVerificationItem` (no dual source of truth). `pennydrop*` on `KycSubmission` is read as the PAYMENT field's
evidence input but the decision is the item's.

---

## 5 · The bridge (shared by Lane A bulk + Lane B portal) — DRY

One pure helper, used by **both** the bulk commit and the single-record portal actions, so they can never diverge:

```ts
// pure: given the 7 items, what should the submission status become?
function evaluateSubmission(items: KycVerificationItem[]):
  { next: 'APPROVED' | 'RE_UPLOAD_REQUIRED' | 'PENDING_GIFSY'; rejectedFields: KycFieldKey[] } {
  if (items.length < 7 || items.some(i => i.decision === 'PENDING')) return { next: 'PENDING_GIFSY', rejectedFields: [] };
  const rejected = items.filter(i => i.decision === 'REJECTED').map(i => i.fieldKey);
  return rejected.length ? { next: 'RE_UPLOAD_REQUIRED', rejectedFields: rejected }
                         : { next: 'APPROVED', rejectedFields: [] };
}
```

**Reconcile note — `POST /v1/kyc/:id/approve` semantics change.** Today it flips `PENDING_GIFSY → APPROVED`
unconditionally. Under the model it must be **gated on `evaluateSubmission` returning APPROVED** (i.e. all 7 items
approved). Decide at build: either repurpose it as "approve all still-pending fields, then evaluate," or deprecate
it in favor of per-field portal actions + the bridge. **Decision (locked): per-field portal endpoint + bridge;
keep `/approve` as a convenience that approves all still-pending fields, then evaluates** (one-click single-record
approve keeps working). ⚠️ **This breaks an existing passing test** — `api/src/kyc/kyc.service.spec.ts` *"approves,
activates the user, creates a wallet, and notifies"* drives `approve()` on a `PENDING_GIFSY` submission with **zero
`KycVerificationItem` rows** and expects APPROVED. Under the new gate `evaluateSubmission([]) → PENDING_GIFSY`, so
3.3 must rewrite that test to seed 7 items (or assert the convenience "approve-remaining-then-evaluate" path). Track
as a required 3.3 update (independent-review SHOULD-FIX #2).

---

## 6 · The auto-approve commit transaction (3.4c/e) — the high-risk path

This is what fires user-activation + wallet + credentials + WhatsApp **in bulk from a spreadsheet**, so the failure
modes matter more than the happy path. Design:

**Boundary = one transaction *per submission*, not one giant batch transaction.** A bad row 3 must not roll back the
good rows 1–2. The commit returns a per-row report (`committed | skipped | errored`) mirroring the dry-run preview.

Per submission (inside its own `prisma.$transaction`):
1. **Re-load + assert** `status === 'PENDING_GIFSY'`. If it moved (concurrent action / already APPROVED) → **skip**,
   report "no longer pending" (this is the idempotency guard).
2. **Upsert** the `KycVerificationItem` rows the sheet sets — **merge semantics**: a blank Excel cell never clears a
   field; last-write-wins per field; `source=EXCEL`, `verifiedById=uploader`, `verifiedAt=now`.
3. **Bridge:** load all 7 items → `evaluateSubmission`.
   - `APPROVED` → set submission `APPROVED` + `approvedAt`; `User.status → ACTIVE`; create `Wallet` **if not
     exists**; write `KycStatusHistory` + `AuditLog`; **enqueue** the `KYC_APPROVED` WhatsApp.
   - `RE_UPLOAD_REQUIRED` → set status; set `reKycFlags` for the rejected fields (**via the field-map below — NOT a
     drop-in**); history + audit; notify the outlet's sales owner.
   - `PENDING_GIFSY` → no status change (partial progress recorded only).

**Failure modes addressed (the independent-review targets):**
- **Idempotency / re-upload the same sheet.** Step 1's `PENDING_GIFSY` assertion means an already-APPROVED
  submission is skipped — the side effects can't re-fire. Re-writing identical item values is a net no-op.
  ⚠️ **Race hardening (review NIT #5):** the assert is a read-then-write at Read-Committed; two concurrent commits of
  the same sheet could both pass the assert before either flips. Make the flip a **conditional**
  `updateMany({ where: { id, status: 'PENDING_GIFSY' }, … })` and treat `count === 0` as "skip" — so the second
  writer cleanly no-ops instead of erroring on the `Wallet.partnerId @unique` collision.
- **Partial-batch failure.** Per-submission transactions → row N failing leaves 1..N-1 committed; the report names
  the failure. No all-or-nothing rollback of a 200-row sheet.
- **Post-flip external side-effect failure.** **There is no synchronous external call in the commit path.** Status
  flip + activation + wallet are all in the DB transaction (atomic, durable). The only outward delivery — WhatsApp —
  is **enqueued** (a `NotificationQueue` row; delivery is P7) inside the tx, so a delivery failure later is a worker
  retry, never a half-committed approval. "Credentials" = `User.status → ACTIVE` (in-tx); no password/secret is
  generated synchronously. → the auto-approve path is DB-durable + enqueue-only by construction.

**The RE_UPLOAD re-share is underspecified without two things (review SHOULD-FIX #3):**
1. **`KycFieldKey → ReKYCFlags` map.** `reKycFlags` is a **19-boolean** struct on **`Outlet`** (`types/index.ts:692`,
   `schema.prisma:848`), not on `KycSubmission`, and its keys don't 1:1 the 7 grid fields. Proposed map:
   - `PAYMENT` → `{ bankName, accountHolderName, accountNumber, ifscCode, upiId, cancelledCheque }`
   - `GST_VALIDATION` → `{ gstNumber, panNumber }` · `GST_DOCUMENT` → `{ gstCertificate }`
   - `ADDRESS` → `{ streetAddress, city, state, pincode }` · `ADDRESS_DOCUMENT` → `{ addressProof, selfDeclaration }`
   - `BOARD_PHOTO` → `{ storeBoardPhoto }` · `OWNER_PHOTO` → `{ ownerPhoto }`
2. **Submission→outlet resolution.** `KycSubmission.partnerId` is optional and a partner can own **many** outlets
   (`ChannelPartner.outlets Outlet[]`), so "which outlet's `reKycFlags`" is ambiguous. Resolve via the **primary**
   outlet (`Outlet.isPrimary`, the same one `ledger()` already picks at `kyc.service.ts:549`); error the row if none.
   Decide at 3.4c/3.6 build.

**Authority note (review NIT #6):** the *only* gate on auto-approve is the human-reviewed **dry-run preview** — the
parser accepts literal `APPROVE` in all 7 cells with no cross-check that PAYMENT/GST evidence actually validated
(owner-accepted, REVAMP.md). State this plainly in the UI: committing the sheet *is* the approval authority.

---

## 7 · Task breakdown (3.1–3.6)

| Task | What | Reuses | Builds |
|---|---|---|---|
| **3.1** | Submission form + GCS doc upload | `sales/kyc/new`, `StorageService`, `POST /v1/kyc` (real) | wire FE→`/v1`; multipart on StorageService |
| **3.2** | Tree-based approval routing; retire `ROLE_PHONES` (#9) | helper fn signatures | swap data source → `SalesUser` tree |
| **3.3** | first-approve / approve / reject + activate+wallet | `approve()` (real) | gate `/approve` on the bridge (§5) |
| **3.4a** | schema (§4) + **human-gated migration** | existing `KycDocument`/`pennydrop*` as evidence | `KycVerificationItem` + 2 enums on partner |
| **3.4b** ✅ | review-dump export (`GET /v1/kyc/review-dump`, Gifsy-only, StreamableFile) | `lib/kyc-review-dump.ts` ported pure | demo data → real `PENDING_GIFSY` query (clientId-scoped) + signed doc URLs; **columns kept verbatim** (owner) — "Partner Class" header retained, populated from outlet type |
| **3.4c** | bulk upload: parser + dry-run preview + **commit** (§6) | `lib/kyc-bulk-verify.ts` (port) | per-submission commit tx; the bridge |
| **3.4d** | bulk-approval UI + field-level rejection on detail page (#14) | `admin/kyc/approvals` (locked UX), `admin/kyc/[id]` | wire to real `/v1` |
| **3.4e** | GST/bank evidence + reg-type → invoicing wiring (#12/#15) + DPDP masking | `lib/invoice` | read persisted enums |
| **3.5** | consent persistence only (DPDP `DataRequest` **DESCOPED** by owner 2026-06-16) | `consent()` OTP-verify (already timestamped, phone-bound) | **minimal:** one `ConsentRecord` on consent (terms version + `consentedAt`), OR no-op if OTP rows are retained + single T&C version (owner's call) |
| **3.6** | **manual** re-KYC trigger (#13) + SLA metrics | `slaMetrics()`, `reKycFlags` | manual trigger endpoint |

---

## 8 · For the independent review (before the 3.4a gate)

Review targets, in priority order:
1. **§6 auto-approve commit** — the per-submission transaction boundary, the idempotency assertion, and the claim
   that "no synchronous external side effect exists." This is the money/access-adjacent, least-reversible path.
2. **§4 schema** — `KycVerificationItem` shape; the evidence-not-duplication decision vs `KycDocument.status`.
3. **§5 bridge** — that Lane A and Lane B share one helper and `/approve` semantics are reconciled.

Open build-time decisions (not blockers): submission→outlet resolution for re-share (§6, primary-outlet proposed);
exact convenience-path test rewrite (§5/3.3).

**Build follow-up (found in 3.4b):** the submission form overloads `KycDocumentType.OTHER` for **both** the store
board photo and the self-declaration, so the dump can't cleanly distinguish them (currently split best-effort by file
name). Proper fix = distinct doc types (`STORE_BOARD_PHOTO` / `SELF_DECLARATION` enum values — a small additive
migration) wired into the submission form (3.1) and the dump mapping. Low priority; the 4 unambiguous docs
(GST cert, address doc, owner photo, cheque) map cleanly today.

---

## 9 · Independent review outcome (2026-06-16)

An independent agent reviewed §4/§5/§6 against the actual source. **Confirmed TRUE:** the §6 "no synchronous external
side effect / DB-durable + enqueue-only" claim (verified `notifications.service.ts` enqueue = pure
`notificationQueue.create`, and `approve()` makes no sync external call); the per-submission `$transaction` boundary;
the idempotency assertion; the tenant-scoping pattern; all §1 line citations. Findings, all folded in above:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | **BLOCKER** | §4 schema omitted the reverse relation on `KycSubmission` → Prisma won't validate | §4 now adds `kycVerificationItems KycVerificationItem[]` — **must be in the 3.4a diff-SQL** |
| 2 | SHOULD-FIX | §5 `/approve` re-gate breaks an existing passing test (`kyc.service.spec.ts`, approve with 0 items) | §5 locks the convenience path + flags the test as a required 3.3 rewrite |
| 3 | SHOULD-FIX | §6 `reKycFlags` re-share not a drop-in (wrong entity + shape mismatch) | §6 adds the `KycFieldKey→ReKYCFlags` map + primary-outlet resolution |
| 4 | SHOULD-FIX | §1 said "7 perms" — actually 6 | §1 corrected to 6 |
| 5 | NIT | §6 read-then-write race at Read-Committed | §6 adds conditional-`updateMany` hardening |
| 6 | NIT | auto-approve's only gate is "7 cells say APPROVE" | §6 states the dry-run preview is the sole authority gate (owner-accepted) |

**Verdict:** sound to proceed to the 3.4a migration gate **once BLOCKER #1 is in the schema** (it now is, in §4).
Findings 2 & 3 are 3.3/3.4c build items, not migration blockers.

---

## 10 · Retro-audit of built tasks (3.1 / bridge / 3.4b), 2026-06-16

Three **independent parallel** auditors reviewed the already-built tasks (owner adopted the full plan→execute→audit
model). All confirmed: 3.1 tenant-foldering + size guard correct; the bridge implements §5 exactly (pure,
deterministic); **3.4b query is correctly tenant-scoped — no cross-tenant leak**. Findings remediated (gated, tsc 0,
49/49):

| Task | Sev | Finding | Resolution |
|---|---|---|---|
| 3.1 | **security** | `create()` trusted a client `fileKey` with no ownership check → a foreign key would be signed into another tenant's doc at review | reject any `fileKey` not under `kyc/<clientId>/`; reconstruct `fileUrl` server-side via `storage.publicUrl` (never trust client URL) + test |
| 3.1 | SHOULD-FIX | `documentType` accepted any string (`as never`) → 500 on bad value | `@IsEnum(KycDocumentType)` on both DTOs; honest `as KycDocumentType` |
| 3.1 | NIT | zero-byte file passed the guard | `!file.buffer?.length` check |
| 3.4b | SHOULD-FIX | signed-URL **fail-open** returned a raw private GCS URL into the xlsx | fail **closed** — return `undefined` on signing error |
| 3.4b | SHOULD-FIX | OTHER doc-split could mis-assign board ↔ self-declaration | deterministic non-overlapping match; blank (not a guess) when no filename matches |
| 3.4b | SHOULD-FIX | remark-less REJECT broke the parser round-trip | dump emits a placeholder remark for remark-less REJECT |
| bridge | tests | missing edge coverage | +all-rejected, +unknown-key, +order-independence |

**Deferred (low-priority follow-ups, tracked):** 3.1 MIME/extension allow-list; orphaned-GCS-object cleanup (upload
without a later `create()`); 3.4b no-primary-outlet reviewer signal.

**Owner decision (bridge audit #1) — RESOLVED 2026-06-16: keep as-is.** Rejects are surfaced only once all 7 fields
are terminal (one consolidated re-upload). Early per-field re-share was considered and declined.

---

## 11 · 3.4c bulk auto-approve commit — built (Sonnet executor) + independently audited, 2026-06-16

`POST /v1/kyc/bulk-verify?apply=true|false` (Gifsy-only, multipart): dry-run preview (no writes) / per-submission
commit. Ported parser (`kyc-bulk-verify.ts`), per-submission `$transaction`, conditional `updateMany` idempotency,
the bridge, auto-approve side effects (activate + wallet + audit), RE_UPLOAD → `reKycFlags` (the §6 field-map). The
independent auditor **confirmed** per-submission isolation, the idempotency guard, tenant scoping, merge semantics,
and the field-map — and found two atomicity bugs the mocked-`$transaction` tests structurally couldn't catch:

| Sev | Finding | Resolution |
|---|---|---|
| **BLOCKER (B1)** | `notify()` ran *inside* the commit tx, but `NotificationsService.enqueue` writes on its own base client → a rolled-back approval could still deliver "KYC approved" | commit returns a **notification intent**; the caller enqueues **after** the tx resolves (mirrors single-record `approve()`). +regression test (tx fails → no notify) |
| **SHOULD-FIX (S1)** | RE_UPLOAD with no primary outlet flipped status then returned `error` → half-commit (re-upload state, no flags) | resolve the outlet **before** the flip; **throw** if none → whole tx rolls back, clean `error`, no mutation. +test asserting no flip |

Deferred (tracked): S2 — RE_UPLOAD notifies the partner; add the assigned sales owner via `SalesUserAssignment` in
P3.6 (TODO in code). N1 — blank-row no-op tx. Gated after remediation: tsc 0, **89/89** kyc tests, boot smoke
(route maps, unauth 401).

---

## 12 · 3.3 — bridge wired into single-record approval (+ §5 DRY refactor), 2026-06-16

Built by a Sonnet executor, independently audited (**verdict: sound to commit**). What shipped:
- **`applyBridgeOutcome(tx, submission, bridgeResult, source, actorId, now)`** — the shared side-effect helper now
  used by BOTH Lane A (`commitSubmissionVerification`, `source='EXCEL'`) and Lane B (`verifyField` + `approve`,
  `source='PORTAL'`). Lane A & B can no longer diverge (§5). **B1 + S1 preserved structurally** inside it (returns a
  notification intent — callers enqueue post-tx; resolves the primary outlet and throws *before* the RE_UPLOAD flip).
- **`POST /v1/kyc/:id/verify`** (#14) — Gifsy-only per-field approve/reject (REJECT requires a remark: DTO
  `@ValidateIf` **+** a service-level guard added per audit NIT). Upserts one `KycVerificationItem` (`PORTAL`), runs
  the bridge, finalizes via the shared helper.
- **`POST /v1/kyc/:id/approve` re-gated** (§5): approves only the still-PENDING items (`updateMany where
  decision=PENDING` + `createMany skipDuplicates` for missing) — **an already-REJECTED field can never be flipped to
  APPROVED** (audit-confirmed) — then the bridge; bridge→RE_UPLOAD ⟹ **ConflictException** (tx rolls back, no side
  effects). The old broken "approve with 0 items" test was rewritten.

Audit confirmed: B1/S1 preserved; REJECTED not overwritten; tenant-scoped + tx-atomic on both new paths; enqueue
only post-commit. NITs (service remark guard + its test) folded in; redundant pre-tx load left as-is. Gated: tsc 0,
**101/101** kyc tests.

---

## 13 · 3.2 — tree-based approval routing, `ROLE_PHONES` retired (gap #9 RESOLVED), 2026-06-16

Built by a Sonnet executor, independently audited (**verdict: sound to commit**). `KycService.resolveInitialRouting`
replaces the hardcoded `ROLE_PHONES` table: it finds the submitter's `SalesUser` (tenant-scoped), walks
`reportingToId` upward to the first **ACTIVE** manager (skipping `isActive:false`/soft-deleted), and maps the
manager's hierarchy level → `PENDING_SO/ASM/RSM_APPROVAL` (RSM/ZNM/NSM collapse to RSM). Escalation = the first
skipped level. Fallbacks: no `SalesUser` → `SUBMITTED`; no active manager up-chain → `PENDING_RSM_APPROVAL`.
`ROLE_PHONES` + `resolveApprover`/`initialKycStatus`/`detectEscalation` retired (grep-clean); `canFirstApprove`/
`nextStatusAfterFirstApprove` kept. **Audit confirmed the key invariant: per-hop tenant scoping is airtight** (id +
clientId on a global-unique PK ⟹ cross-tenant resolution impossible); walk doubly-bounded (10 hops + visited-set
cycle guard). NIT folded in: a test now asserts `clientId` on the per-hop manager lookup. Gated: tsc 0, **105/105**
kyc tests. Closes gap #9.

---

## 14 · 3.5 / 3.6 / 3.4e (Lane D) — built (one Sonnet executor) + independently audited, 2026-06-16

Audit **verdict: sound to commit** (no blocker; confirmed S1/B1 on re-kyc, gst-details tenant scoping, consent-after-verify).
- **3.5 consent persistence:** `consent()` writes one durable `ConsentRecord` (`consentType:'KYC_TERMS'`, version, `consentedAt = otp.verifiedAt`) only after OTP verify on the caller's own submission. (DPDP `DataRequest` stays descoped.)
- **3.6 manual re-KYC:** `POST /v1/kyc/:id/re-kyc` (Gifsy-only) — APPROVED-only guard (else Conflict), flips to `RE_KYC_REQUIRED`, sets `reKycFlags` on the primary outlet via the field-map (**S1**: outlet-before-flip throw), notify post-tx (**B1**). `slaMetrics()` unchanged (sufficient).
- **3.4e reg-type capture + DPDP masking:** `POST /v1/kyc/:id/gst-details` (Gifsy-only) persists `entityType`/`gstRegistrationType` on the partner (tenant-scoped via the submission join, enum-validated) + GST evidence on the item; `lib/invoice` reads these in **P6** (seam noted). `getOne()` masks bank/PAN/GST to last-4.

Audit remediations folded in: **masking now unmasks the submission OWNER** (the audit showed `getOne` already 403s non-admin non-owners, so the only caller ever masked was the owner viewing their own data — wrong; now owner + admin see full, masking is defensive cover for any future non-owner read) + a direct mask-helper test; consent lookup `clientId`-scoped for consistency. **Open decisions (documented, fail-safe):** masking keys on `isAdmin` not the `kyc:view_documents` permission (TODO in code, switch when the RBAC flag-gate is enforced; CLIENT_ADMIN sees full for its own tenant — intended). Deferred NIT: scope the consent OTP to the submission/owner phone (pre-existing). Gated: tsc 0, **124/124** kyc tests, boot smoke (both routes map, unauth 401).

---

## 15 · 3.4d — Gifsy bulk-approval UI wired to the real backend, 2026-06-16

Built by a Sonnet executor; backend part independently audited (**sound to commit**). 
- **Backend:** `GET /v1/kyc/review-queue` (Gifsy-only, tenant-scoped) returns each `PENDING_GIFSY` submission **with its 7-field state** (reuses `dumpFieldStates`) for the queue's n/7 progress. `getOne()` now also returns `verificationItems` so the detail panel seeds real state (audit-driven). +5 queue tests → **129 kyc tests**, tsc 0.
- **FE:** `admin/kyc/approvals` repointed off the platform demo routes onto the backend via the proxy — queue → `/api/kyc/review-queue`, export → `/api/kyc/review-dump`, preview → `/api/kyc/bulk-verify?apply=false`, **commit → `?apply=true`**; envelope-unwrapped, Bearer auth preserved. `admin/kyc/[id]` detail page gained a per-field Approve/Reject panel → `POST /api/kyc/:id/verify` (remark required on reject), seeded from `verificationItems`.
- **Live browser verification (Chrome extension, against the running dev servers):** the approvals page renders the workspace; it fires `GET /api/kyc/review-queue`; the Next proxy forwards `/api/kyc/*` → backend `/v1/kyc/*`; the backend route is live (curl `/v1/kyc/review-queue` unauth → **401**, `/health` → 200) and returns 401 to the unauthenticated browser, which the page handles gracefully. **Full FE→proxy→backend wiring confirmed**; queue DATA needs a Gifsy login (auth-gated, expected).
- **Unrelated pre-existing bug surfaced:** platform RootLayout errors `clients.partnerClasses does not exist` (platform schema references a dev-DB-dropped column from the partner-class retirement). Tracked separately — not a 3.4d defect.
- Platform typecheck clean. Demo routes (`admin/kyc/*`) left in place (retired separately).
