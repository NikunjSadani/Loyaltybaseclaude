# Capture Bank/UPI payout details at redemption — design (source of truth)

**Status:** DESIGN FROZEN · build in progress · 2026-11-03
**Classification:** ⚠️ PLATFORM-WIDE (shared redeem + payout + KYC code + schema). Owner-approved
to build 2026-11-03. Deoleo stays **byte-identical** via: additive nullable schema defaulting
VERIFIED, and the whole capture UX gated behind a per-tenant feature flag defaulting **OFF**.
**Tenant:** first enabled for **Bajaj** only.

---

## 1. Problem & intent

Bajaj point-earning **wholesalers** redeem points for **cash** (UPI / bank transfer), but most have
**no bank/UPI on file** (they were bulk-imported for points; only the SSS payout outlets got bank
details via the RLP import). Today the Redeem → Cash tab **dead-ends**: when the partner has no
beneficiary it shows a blocking card "Bank / UPI details needed → Go to KYC / Profile"
(`platform/src/app/partner/rewards/page.tsx:1300-1319`) and the backend hard-blocks at confirm
(`api/src/rewards/rewards.service.ts:1841-1853`). The partner profile page is **read-only**, so
there is no partner self-service way to add payout details — a true dead-end.

**Intent (owner):** let the wholesaler capture bank/UPI **in-flow** at redemption, using the *same*
form/rules as KYC (not a reinvention), and surface those details in the outlet's Store Information
**only once a payout actually completes** ("auto-back-fill only if paid").

## 2. The two payout rails (why this hooks rail ②)

- **Rail ① — admin credits-payouts** (`CreditPayoutEntry`/`CreditBatch`, nav "Credits & Payouts",
  parser `api/src/credits/credits.helpers.ts`). Admin-driven bulk incentive payouts (the ₹3,500
  test + the RLP retailer payout). **Not** this feature.
- **Rail ② — redemption cash-out** (`PayoutTransaction`, nav "Redemption Payouts → Payout Batches",
  parser `api/src/payouts/payout-utr.helpers.ts`). A wholesaler's points→cash redemption creates a
  `PayoutTransaction` at OTP-confirm (`rewards.service.ts:2100`), which an operator funds, batches,
  pays, and marks **PAID** via UTR upload (`payouts.service.ts:727`). **This feature lives here.**

## 3. Locked decisions

| # | Decision | Resolution |
|---|----------|------------|
| 1 | Verify-stamp rail | `PayoutTransaction` → **PAID** flip at `payouts.service.ts:727`. (FAILED → NEEDS_RECAPTURE.) |
| 2 | Hide-until-verified | Store Info shows payout details only when `paymentDetailsStatus = VERIFIED`. New column **defaults VERIFIED** → existing + Deoleo unchanged; only redemption-capture writes UNVERIFIED. |
| 3 | Uniqueness | **ON** for Bajaj (`uniquenessPolicy.bank=true, upi=true` — already set & verified; 0 existing dups). Capture runs `checkGroupUniqueness`. |
| 4 | Cancelled cheque | **Required for bank mode, hidden for UPI mode** (mirrors KYC). File-picker (camera-or-gallery), same as KYC — not forced live camera. UPI uses the QR scanner. |

## 4. Data model (schema change — ⚠️ migration)

On **`ChannelPartner`** (`api/prisma/schema.prisma`, `channel_partners`):

```prisma
enum PaymentDetailsStatus {
  VERIFIED         // operator/KYC-captured OR payout-confirmed → SHOWN in Store Info (default)
  UNVERIFIED       // self-captured at redemption, no completed payout yet → HIDDEN
  NEEDS_RECAPTURE  // a payout on these details FAILED → HIDDEN + re-prompt next redemption
}

model ChannelPartner {
  // … existing …
  paymentDetailsStatus PaymentDetailsStatus @default(VERIFIED)   // additive; backfill all existing = VERIFIED
  bankVerifiedAt       DateTime?                                 // set when a payout on these details is PAID
  payoutChequeFileKey  String?                                   // redemption-captured cheque (GCS key kyc/<clientId>/…)
}
```

- **Additive + default VERIFIED** → every existing row (Bajaj + Deoleo) migrates to VERIFIED, so all
  current displays are unchanged. ⚠️ Sweep `prisma/seed.ts` + `prisma/bootstrap.ts` for the enum so
  the api Dockerfile's separate seed compile doesn't break (staging-deploy-gate trap).
- **Cheque home decision:** store the redemption-captured cheque fileKey **directly on
  `ChannelPartner.payoutChequeFileKey`**, NOT as a `KycDocument`/submission. Rationale: avoids
  coupling to KycSubmission existence (bulk-imported wholesalers may lack one), avoids injecting
  rows into the KYC review queue, and keeps the capture self-contained. The KYC cheque (reps, via
  submissions) is untouched.

## 5. State machine for `paymentDetailsStatus`

```
                         ┌─────────── default (migration + new partners) ───────────┐
                         ▼                                                            │
  (any existing/KYC-captured details)  ──────────────────────────────────►  VERIFIED (shown)
                                                                               ▲      │
  redemption capture sheet writes bank/UPI ──► UNVERIFIED (hidden)             │      │
                                                   │                           │      │
                   partout PAID on these details ──┼──────────────────────────┘      │
                                                   │   (set bankVerifiedAt)           │
                   payout FAILED on these details ─┴──► NEEDS_RECAPTURE (hidden) ─────┘
                                                        (re-prompt at next redemption;
                                                         recapture → UNVERIFIED again)
```

**Invariant:** the KYC submission path (`KycService.create`) **never sets UNVERIFIED** — operator/rep
captured details stay/flip to VERIFIED (they are reviewable & shown exactly as today). Only the new
redemption-capture path introduces UNVERIFIED. This is what keeps the entire KYC review flow and all
of Deoleo unchanged.

## 6. Capture flow (FE)

Replace the dead-end at `rewards/page.tsx:1300-1319`:
- **Show the capture sheet when** `(featureFlag ON) && (!partnerHasBeneficiary || paymentDetailsStatus === 'NEEDS_RECAPTURE')`.
- **Flag OFF → keep today's dead-end card** (Deoleo/other tenants unchanged).
- Reuse **`platform/src/components/bank-or-upi-section.tsx`** (bank↔UPI toggle gated by tenant
  `salesApp.upiEnabled` + the outlet's `requiredPaymentType` mandate via `lib/payment-type.ts`;
  bank fields; UPI-QR scanner via `lib/upi-utils.ts`). Cheque via a file-picker (mirror KYC's
  `FileUploadCard`).
- **Write-before-confirm:** on submit → capture persists bank/UPI to `ChannelPartner` (UNVERIFIED)
  **before** the redeem/confirm runs, so `confirmRedeem`'s fresh partner read
  (`rewards.service.ts:2060`) snapshots the real beneficiary onto the `PayoutTransaction`. Then the
  FE refreshes `beneficiary` → `partnerHasBeneficiary` true → proceeds into the existing
  `CashPayoutSheet` (amount → OTP → confirm).

## 7. Capture flow (backend) — focused, reuses KYC helpers (NOT `KycService.create`)

Routing through `KycService.create()` would spawn a full KYC submission and flip an APPROVED outlet
back to pending review — wrong altitude. Instead add a **partner-scoped** capture that reuses the
shared helpers:

- **New routes (partner-scoped, roles WHOLESALER/SSS/SUB_STOCKIST):**
  - `POST /v1/partner/documents` — partner cheque upload (reuses `StorageService`, key
    `kyc/<clientId>/…`, magic-byte sniff + 5 MB cap exactly like `KycService.uploadDocument`),
    returns `{fileKey, fileUrl}`. (Partners cannot hit the KYC `kyc:initiate` doc route.)
  - `POST /v1/partner/payout-details` — body `{paymentMode, bankName?, accountHolderName?,
    accountNumber?, ifscCode?, upiId?, chequeFileKey?}`.
- **The service method** (in `PartnerService`) does, in one `$transaction`:
  1. Resolve partner + outlet `requiredPaymentType` + tenant `salesApp.upiEnabled`.
  2. Validate mode (`isPaymentModeAllowed`) + required fields (bank → name/acct/IFSC **+ cheque**;
     UPI → upiId) — **identical rules to** `kyc.service.ts:1515-1554`.
  3. `acquireIdentityLocks` + **`checkGroupUniqueness`** (bank+upi) → 400 on collision (reuse
     `api/src/common/partner-group.helper.ts`).
  4. Persist via **`normalizeIdentityValue`** (same canonical form as KYC), set
     `paymentDetailsStatus = UNVERIFIED`, `payoutChequeFileKey` (bank mode), `paymentMode`.
  5. Validate `chequeFileKey` ownership (must start `kyc/<clientId>/`).

## 8. Verify-stamp (backend)

In `payouts.service.ts` `processBatch`, inside the atomic UTR-apply tx:
- **PAID** (`:727`, after the `payoutTransaction.update → SUCCESS`): also
  `channelPartner.update({ where:{id: txn.partnerId}, data:{ paymentDetailsStatus:'VERIFIED',
  bankVerifiedAt: now } })` — **only when the partner is currently UNVERIFIED** (never downgrade a
  VERIFIED record; never touch Deoleo's default-VERIFIED rows).
- **FAILED**: set `paymentDetailsStatus = 'NEEDS_RECAPTURE'` **only when currently UNVERIFIED**
  (a failed payout on already-verified KYC details must not hide them).

Edge handled: a partner with multiple redemptions — the stamp is idempotent (guarded on
UNVERIFIED), and the "only when UNVERIFIED" guard means a later failed payout can't un-verify
details an earlier payout already confirmed.

## 9. Display gate (hide unless VERIFIED)

Gate at the **backend emitters** (chokepoints), FE blocks as defense-in-depth. Null/omit the five
payout fields (`bankName, accountNumber/bankAccountNumber, bankAccountHolder, ifscCode, upiId`) +
cheque unless `partner.paymentDetailsStatus === 'VERIFIED'`:

- `api/src/auth/auth.service.ts:75-85,152` (`/auth/me` → partner's own view) ← drives partner profile.
- `api/src/kyc/kyc.service.ts` `maskPartnerSensitiveFields`/`overlayProposedIdentity` (`:609-676`,
  applied `:2616-2619`) ← KYC detail pages.
- `kyc.service.ts` review-queue (`:5193-5197`), review-dump (`:5291-5295`), rejected export (`:5423-5425`).
- FE: partner profile card (`platform/src/app/partner/profile/page.tsx:309-348`), sales KYC detail
  (`sales/kyc/[id]/page.tsx:2031-2074`), admin KYC detail (`admin/kyc/[id]/page.tsx:1184-1247`).

**Note:** because KYC-captured details are VERIFIED, every current KYC review/detail display is
unchanged. Only redemption-captured-but-unpaid details are hidden.

## 10. Feature flag (`captureBankAtRedemption`, default OFF, console-toggleable)

Mirror `hubbleVoucherEnabled` (a `clients.features` `FeatureKey`):
1. `platform/src/lib/platform/client-config.ts` — add to `FeatureFlags` (keep it IN `FeatureKey`,
   i.e. console-toggleable).
2. `platform/src/lib/platform/default-client-config.ts` — `captureBankAtRedemption: false`.
3. `platform/src/lib/tenant-features.ts` — add to `normalizeFeatures()`.
4. `platform/src/app/gifsy/clients/[slug]/page.tsx` — `FEATURE_META` entry.
5. `api/src/gifsy/gifsy.service.ts` — add to the **three** projections (create/detail/list).
6. Backend read: gate the capture sheet exposure + the partner routes via `resolveTenantFeatures`
   (`api/src/common/tenant-features.helper.ts`) / direct `clients.features` read
   (pattern `rewards.service.ts:2867`).
7. Enable for Bajaj via the Gifsy console toggle (or a targeted `clients.features` write) **after**
   the owner reviews — not in code.

## 11. Why Deoleo is byte-identical
- Schema additive, default VERIFIED → no display change, no null surprises.
- Flag defaults OFF → the capture sheet never renders; the dead-end card is unchanged.
- Verify-stamp guarded on `UNVERIFIED` → Deoleo's default-VERIFIED partners are never written.
- Capture routes/validator are new code paths, unreachable when the flag is OFF.

## 12. Test + audit plan
- **Unit:** payment-mode/required-field validation; uniqueness collision; status state machine
  (capture→UNVERIFIED, PAID→VERIFIED+bankVerifiedAt, FAILED→NEEDS_RECAPTURE, guards); display-gate
  emitters hide/show by status; flag OFF → capture route 404/forbidden + dead-end intact.
- **Full gates:** `api` jest + `nest build`; `platform` vitest + `tsc`.
- **Runtime (staging, Bajaj):** real wholesaler with no bank → capture UPI via QR → redeem → OTP →
  PayoutTransaction created with UPI → operator funds+pays+UTR → PAID → details appear in Store Info
  + `bankVerifiedAt` set. Repeat bank+cheque. FAILED path → NEEDS_RECAPTURE + re-prompt. Deoleo
  regression: flag OFF → dead-end unchanged, store info unchanged.
- **DUAL adversarial audit** (money + identity/uniqueness): verify no double-write/clobber of
  verified details; uniqueness can't be bypassed via the new route; cheque fileKey can't be forged
  to another tenant; the PAID-stamp can't un-verify; flag-off reachability = none.

## 13. Open implementation decisions (recommendations — owner may adjust at doc review)
- **D1 Console toggle vs pure behaviour flag** — *rec: console toggle* (owner manages tenant flags there).
- **D2 Cheque storage** — *rec: `ChannelPartner.payoutChequeFileKey`* (self-contained; decided above).
- **D3 Re-prompt on NEEDS_RECAPTURE** — *rec: show the capture sheet again even though stale fields exist.*
- **D4 Sales-assisted redemption** (`confirmRedeemForOutlet`) — reps already capture via KYC; the
  self-service capture sheet is partner-only for now. *rec: out of scope this iteration.*

## 14. Audit hardening (dual adversarial audit, 2026-11-03)

A dual audit (money + identity/privacy) ran after the build; all confirmed findings were fixed:

- **Capture guard (HIGH):** `capturePayoutDetails` now rejects when a beneficiary is already on file
  unless status is `NEEDS_RECAPTURE` — mirrors the FE gate server-side so a direct POST can't wipe a
  VERIFIED rail (which the credits bank-file reads live) or re-capture mid-payout.
- **Verify-stamp (MED):** the PAID stamp promotes `{UNVERIFIED, NEEDS_RECAPTURE}` **and** snapshot-matches
  the paid rail (`upiId` or `bankAccountNumber`+`ifscCode`) so a never-paid, re-captured rail can't ride
  a payout on old details into VERIFIED, and a real payment clears a prior `NEEDS_RECAPTURE`.
- **Missed emitter (MED):** `sales.service.buildOutlets` (re-KYC prefill) and `resolveGroupIdentity`
  (grouped-child prefill) now blank the payout fields when the source is not VERIFIED, so a self-captured
  unpaid rail never leaks into a rep's KYC form.
- **Upload flag-gate (LOW):** `POST /v1/partner/documents` is now gated on `captureBankAtRedemption` too.
- **Cheque-key hardening (LOW):** `chequeFileKey` is rejected if it contains `..` (path traversal), in
  addition to the `kyc/<clientId>/` prefix check.
- **Accepted (no fix):** `/auth/me` returns the raw bank/UPI (the redeem flow needs them) + the status,
  and the partner's OWN profile hides them on the FE — the partner's own data, not a cross-tenant leak.

## 15. File touch-list (from the surface maps)
- Schema/BE: `api/prisma/schema.prisma`, new migration, `prisma/seed.ts`+`bootstrap.ts` sweep;
  `api/src/partner/partner.service.ts` + `partner.controller.ts` (new routes); `api/src/payouts/payouts.service.ts` (stamp);
  `api/src/common/partner-group.helper.ts` + `payment-type.helper.ts` (reuse); display emitters in
  `api/src/auth/auth.service.ts` + `api/src/kyc/kyc.service.ts` + `api/src/kyc/kyc-review-dump.ts`.
- Flag: `platform/src/lib/platform/client-config.ts`, `default-client-config.ts`, `tenant-features.ts`,
  `app/gifsy/clients/[slug]/page.tsx`, `api/src/gifsy/gifsy.service.ts`.
- FE: `platform/src/app/partner/rewards/page.tsx` (capture sheet), reuse
  `components/bank-or-upi-section.tsx` + `lib/upi-utils.ts` + `lib/payment-type.ts`; display gates in
  `app/partner/profile/page.tsx`, `app/sales/kyc/[id]/page.tsx`, `app/admin/kyc/[id]/page.tsx`.
