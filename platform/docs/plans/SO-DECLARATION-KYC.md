# SO Declaration KYC — build contract (Bajaj-gated, platform-wide)

**Status:** Wave 0 (contract) · owner gave explicit platform-wide go 2026-10-13.
**Prototype (UX source of truth):** https://claude.ai/artifact/WgJfASFZwMiCLtJrf4ZV8n (v6, full flow).
**Owner rules:** keep Deoleo's STANDARD flow byte-identical; new behaviour gated to Bajaj via a feature flag.

## 1. What this is

A **variant of the existing KYC enrollment wizard** (NOT a second form) for outlets whose owner
won't share KYC documents. The rep picks the flow up front; the **entire enrollment still happens**
(owner details, address, owner + board photos, **full bank account** details, T&C + comms consent,
the **outlet owner's digital signature**, outlet-owner **consent OTP**). Only these become **optional**
(not removed, not asterisked): **PAN, GST number, GST certificate, address proof**. The SO fills a
declaration (the client's "SO DECLARATION DRAFT"), **signs it**, and at approval the **ASM signs** it.
A **dual-signed PDF** is saved against the outlet and shown to reviewers.

### Three signatures
1. **Outlet owner** — existing enrollment digital signature on the Bank step (`signatureDataUrl`), KEPT.
2. **Sales Officer** — signs the declaration at submission.
3. **ASM** — signs the declaration at `firstApprove`.

### Complete step flow (rep PWA)
Flow-select → Outlet (master) → Details (owner name+mobile reused; +s/o father, +residence, +owner photo)
→ Address (street[new]+city/state; +board photo) → Bank (full bank/UPI + T&C/comms consent + **owner signature**)
→ Declaration (PAN/GSTIN optional; SO declaration WYSIWYG + **SO signature**) → OTP (owner consent) → submit.
Then: **ASM** signs & approves (`firstApprove`) → **Gifsy** final review (variant-aware grid + dual-signed PDF).

## 2. Field sources (verified against outlet master + Outlet model)
- **From master (reliable):** outlet name, outletCode, city, state, **distributorName, distributorCode**
  (`distributorId`), **programName** (Bajaj: retailer→"Unnati", wholesaler→"BSC"; names configurable).
- **Reused from KYC wizard:** owner name (`partnerName`), mobile, outlet street address (`address`/pincode),
  bank/UPI, owner photo, board photo, consent, owner signature, OTP.
- **New (SO-declaration only):** s/o father's name, owner's residence address (+ "same as outlet" toggle).
- **Auto:** physical-verification date = submission date (today). SO name = logged-in rep. ASM = hierarchy approver.
- PAN/GSTIN optional, validated-if-present (PAN format when entered; group/uniqueness still enforced when present).

## 3. Schema (api/prisma/schema.prisma) — ALL ADDITIVE

```prisma
enum KycVariant { STANDARD SO_DECLARATION }          // NEW

// enum KycDocumentType { ... SO_DECLARATION }        // ADD value SO_DECLARATION (the dual-signed PDF)

model KycSubmission {
  // ...existing...
  kycVariant        KycVariant @default(STANDARD)     // NEW — STANDARD keeps every tenant byte-identical
  declarationData   Json?                             // NEW — {soName, soFatherName?, ownerFatherName, ownerResidence,
                                                       //        verificationDate, programName, distributorName, distributorCode,
                                                       //        outletAddressSnapshot}
  soSignatureKey    String?                           // NEW — SO declaration signature (GCS key); owner sig stays via existing docs
  asmSignatureKey   String?                           // NEW — ASM declaration signature (GCS key), set at firstApprove
  declarationPdfKey String?                           // NEW — final dual-signed PDF (also stored as a KycDocument SO_DECLARATION)
}
```
Migration: additive `CREATE TYPE`/`ALTER TYPE ADD VALUE`/`ALTER TABLE ADD COLUMN`. `prisma generate` before gating.
⚠️ `ALTER TYPE ... ADD VALUE` cannot run inside a txn with its use in PG — keep the enum add in its own migration step.

## 4. DTO (api/src/kyc/dto/kyc.dto.ts, CreateKycDto)
Add (all optional, default STANDARD so existing callers unaffected):
```ts
@IsOptional() @IsEnum(['STANDARD','SO_DECLARATION']) kycVariant?: 'STANDARD'|'SO_DECLARATION';
@IsOptional() declaration?: {               // required ONLY when kycVariant==='SO_DECLARATION'
  ownerFatherName: string; ownerResidence: string; soSignatureFileKey: string;
};
```
`first-approve` DTO: add `@IsOptional() asmSignatureFileKey?: string; @IsOptional() declarationPdfFileKey?: string;`
(required when the submission is SO_DECLARATION).

## 5. Backend logic (api/src/kyc/*)
1. **create()** (`kyc.service.ts`): accept `kycVariant`+`declaration`. When `SO_DECLARATION`:
   - **Skip the GSTIN-required throw** (currently ~1326-1332) — do NOT call/enforce `getKycGstinRequiredUncached`.
   - Persist `kycVariant`, `declarationData`, `soSignatureKey`.
   - **Default classification** on the partner: `entityType=INDIVIDUAL`, `gstRegistrationType=UNREGISTERED` when
     PAN/GST absent (overridable later by Gifsy `gstDetails`). Keep group/uniqueness checks (no-op on null PAN).
   - Everything else (bank mandate, photos, address, owner signature doc, consent) unchanged.
2. **Verification grid** (`kyc-verification.helper.ts`): replace the hard-coded `KYC_FIELD_KEYS` iteration with
   `requiredFieldKeys(submission)`:
   - STANDARD → all 7 (unchanged).
   - SO_DECLARATION → `[PAYMENT, ADDRESS, BOARD_PHOTO, OWNER_PHOTO]` required; `GST_VALIDATION, GST_DOCUMENT,
     ADDRESS_DOCUMENT` **non-blocking** (missing ≠ PENDING-block; still reviewable/approvable if evidence present).
   - Update `evaluateSubmission()` AND `approve()`'s fill-missing loop to use `requiredFieldKeys`.
   - ⚠️ STANDARD path must stay byte-identical — add tests asserting the 7-key behaviour is unchanged.
3. **firstApprove()** (`kyc.service.ts` ~2692): when SO_DECLARATION, require `asmSignatureFileKey`+`declarationPdfFileKey`;
   persist `asmSignatureKey`, `declarationPdfKey`, and attach the final PDF as a `KycDocument` type `SO_DECLARATION`;
   then the normal transition → `PENDING_GIFSY`.
4. **Controller**: `first-approve` accepts the new optional fields; `kyc:approve` perms unchanged.

## 6. PDF generation — client-side jsPDF (no new api dep)
`jspdf` is already a `platform` dependency (used by `downloadSelfDeclarationTemplate`, new/page.tsx ~1066). Reuse it:
- **At submission:** FE renders the declaration (template below) with the **SO signature** → uploads via
  `POST /v1/kyc/documents` → gets `fileKey` → passed as `declaration.soSignatureFileKey` is the SIGNATURE; the
  draft PDF fileKey travels with create (optional) OR is (re)generated at approval. Simplest: store SO signature +
  `declarationData` at submission; generate the **final PDF at ASM approval** (both signatures available) and also
  render a read-only on-screen view from `declarationData` for the ASM.
- **At ASM approval:** FE renders final declaration with SO + ASM signatures → `POST /v1/kyc/documents`
  (type SO_DECLARATION) → `fileKey` → `first-approve({ asmSignatureFileKey, declarationPdfFileKey })`.
- Gifsy sees the SO_DECLARATION doc via the existing `getOne()` `viewUrl`.
- **Declaration template text:** the client draft (scratchpad `so-decl/SO-DECLARATION-TEMPLATE.txt`), bank line worded
  generically ("Bajaj loyalty portal", NOT "Mobile application"); program line = the outlet's `programName`.

## 7. Frontend (platform/src/app/sales/kyc/*)
- **Feature flag:** add `soDeclarationKyc: boolean` to `FeatureFlags` (`client-config.ts`) + `normalizeFeatures`
  (`tenant-features.ts`, default false). Enable only in Bajaj `clients.features`. Treat like `kycAddressProofWaiver`
  (runtime behaviour flag; exclude from `FeatureKey` if it should not be a console module toggle).
- **new/page.tsx:** when `soDeclarationKyc`, show the flow-select first screen. SO_DECLARATION branch:
  GST/PAN/doc uploads become optional (no `*`); add the 2 new fields (s/o father, residence + same-as-outlet);
  keep bank+consent+owner signature; add the Declaration step (PAN/GSTIN plain fields, WYSIWYG, SO signature);
  submit with `kycVariant` + `declaration`. **Reuse the existing signature pad + step bar components** so the UI
  matches exactly (brand green `--brand-primary` #16a34a, `inputCls`, numbered step bar).
- **[id]/page.tsx:** SO_DECLARATION approval shows the SO-signed declaration + an **"Approve & Sign"** panel with an
  ASM signature pad; on approve, generate+upload the final PDF then call `first-approve`.
- **Gifsy review:** render the dual-signed PDF; the verification grid shows the non-required keys as
  "Not required — SO Declaration" (muted), active only if evidence attached; classification pre-defaulted.

## 8. Payout / TDS
No new code. No-PAN outlets pay normally; reported under existing 194R `__NO_PAN__` 20% bucket. PAN (if optionally
entered) auto-routes to the PAN-keyed rate.

## 9. Deoleo-safety invariants (MUST hold)
- `kycVariant` defaults STANDARD everywhere; no STANDARD code path changes behaviour.
- `requiredFieldKeys(STANDARD)` === the current 7 keys (test-asserted).
- Flow-select / relaxations only render/apply when `soDeclarationKyc` is on (Bajaj only).
- GSTIN-required enforcement unchanged for STANDARD.

## 10. Test + audit + verify plan
- **Gates (full):** `cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run`
  · `cd platform && npx tsc --noEmit`.
- **Unit:** requiredFieldKeys (both variants), create() GSTIN-skip only for SO_DECLARATION, classification defaults,
  firstApprove ASM-sig requirement, DTO validation.
- **Dual adversarial audit:** (1) correctness; (2) money/identity — no-PAN→20% TDS, signature integrity, variant
  gating cannot leak to Deoleo, PDF contains both signatures, non-blocking keys can't bypass required ones.
- **UI/UX audit lane.**
- **Runtime (staging, fixed OTP):** seed a Bajaj rep + ASM hierarchy + an assigned retailer outlet; run rep→ASM→Gifsy
  end-to-end; confirm dual-signed PDF saved + visible; confirm a no-PAN outlet reports at 20%; confirm Deoleo STANDARD
  flow unchanged.

## 11. Build sequence (orchestration)
- **Wave 1a — foundation (me/1 agent):** schema+enum+migration+`prisma generate`, DTO, feature-flag plumbing.
- **Wave 1b — parallel:** BE agent (api: create/grid/firstApprove/classification/controller) ‖ FE agent
  (platform: wizard variant, declaration+PDF, ASM sign, Gifsy grid) ‖ tests agent (api specs). api vs platform are
  disjoint trees → safe to parallelize after foundation.
- **Wave 2 (me):** integrate + full gates + fix.
- **Wave 3:** dual + UI/UX audit (3 agents); I own verdict + fixes.
- **Wave 4 (me):** staging runtime verify; Deoleo regression check.
