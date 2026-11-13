# Daily Operations Digest

**Approved by the owner on 2026-11-13 (option A, ⚠️ PLATFORM-WIDE).** One internal Gifsy email replaces the two daily
emails ("Credits/Payouts summary" and "KYC actionables digest"). It has an all-tenant summary at the top, then one
section per tenant. It goes to internal Gifsy recipients only, never to clients. The schedule (Cloud Scheduler, Mon–Sat
09:30 IST → `POST /v1/reports/run`), the transport (MSG91 SMTP) and the mobile-friendly email layout are unchanged.
Activation and recipients: `runbooks/email-reports-activation.md`. Rendered sample:
`samples/daily-ops-digest-sample.html`.

## Code
- `api/src/reports/scheduled/scheduled-reports.service.ts`: the runner. It does every Prisma query, tenant by tenant
  and section by section, and each section has its own try/catch.
- `api/src/reports/scheduled/daily-ops-digest-report.ts`: PURE builder. It has no database or clock access. It
  contains `digestWindow`, `kycPendingBuckets`, `needsAttention` and `buildDailyOpsDigest`.
- `api/src/reports/scheduled/report.types.ts`: the plain structs passed between the runner and the builder.
- `api/src/common/report-recipients.ts`: the recipient list, with the legacy fallback.
- The retired builders (`credits-payouts-report.ts`, `kyc-actionables-report.ts`) and their specs were removed. The
  digest reuses their logic: the shared `kycStageSla`, and the same CreditBatch and PayoutTransaction queries.

## Window
The window starts at the same time on the previous working day and ends when the digest runs (`nowMs`, IST). On
Monday it covers **Saturday 09:30 → Monday 09:30** (48 h). On every other day it covers the last 24 h.

## Tenants
The digest covers every `Client` with `status = ACTIVE`, except the Gifsy operator row (`gifsy`). Each tenant is shown
under its display name: `branding.displayName`, or `internalName` when that is empty.

Three sections are optional. Each one appears only for tenants that have it switched on:
- **Vouchers (Hubble)**: `features.hubbleVoucherEnabled === true`.
- **Sales Import**: `features.salesImport === true`.
- **Visibility**: the `visibilityEnabled` program setting is `true`. This is the same rule `TenantSettingsService` uses.

## Sections and data sources
Labels used below:
- "in window" means the timestamp falls in `[start, end)`.
- "now" means the current state, whatever the date.

| Section | Figure | Source |
|---|---|---|
| KYC | submitted | `KycSubmission.submittedAt` in window (tenant via `user.clientId`) |
| | approved | `KycSubmission.status = APPROVED` and `approvedAt` in window |
| | rejected | `KycStatusHistory.toStatus ∈ {REJECTED, RE_UPLOAD_REQUIRED, RESUBMISSION_REQUIRED}`, `createdAt` in window |
| | pending by stage | Field statuses and `PENDING_GIFSY` (now). Each row is aged with the shared two-stage business-hours `kycStageSla` (holidays and per-tenant targets apply). Field rows start from submission. Gifsy rows start from the latest `PENDING_GIFSY` entry. Each row is then bucketed as **within** (< 75 % of target), **nearing** (75–100 %) or **breached** (> target). |
| Points | credited / redeemed / expired | `PointsLedger` `EARN` / `REDEEM` / `EXPIRE` points summed over `createdAt` in window (tenant via `wallet.partner.clientId`). Redeemed and expired are shown as absolute values. |
| | negative wallets | `Wallet.redeemablePoints < 0` (now) |
| Redemptions | requested | `RedemptionOrder.createdAt` in window |
| | completed / failed | `RedemptionStatusHistory.toStatus = DELIVERED / FAILED`, `createdAt` in window |
| | failed list (≤ 10) | Latest FAILED history rows. Shows the outlet (`partner.businessName (partnerCode)`), the reward (`reward.name`) and the reason (`order.cancelReason`, falling back to the history `notes`). |
| Vouchers (Hubble) | issued / failed | The same history transitions, limited to orders with `voucherProvider = 'Hubble'` (case-insensitive) |
| | stuck in processing | Hubble orders with `status = PROCESSING` and `updatedAt` more than 30 min ago (now) |
| | needs reconcile | `metadata.hubbleNeedsReconcile = true` (now) |
| Payouts | batches confirmed | `CreditBatch` with status `CONFIRMED`/`PARTIALLY_REVERSED`, `confirmedAt` in window. Shows the count, Σ `totalPoints` and Σ `totalPayoutPaise`. This logic comes from the old Credits/Payouts report. |
| | credit payouts paid | `CreditPayoutEntry.status = PAID`, `paidAt` in window (count and Σ `amountPaise`) |
| | redemption payouts paid | `PayoutTransaction.status = SUCCESS`, `completedAt` in window. This also comes from the old report. |
| | failed / returned | `CreditPayoutEntry FAILED` plus `PayoutTransaction FAILED/REVERSED`, `updatedAt` in window |
| | awaiting UTR | `CreditPayoutEntry.status = PROCESSING`, meaning it is in a downloaded bank file and the UTR upload is pending (now; count and ₹) |
| Messages | OTP | `OtpCode.deliveryStatus = FAILED`, `updatedAt` in window, tenant via `user.clientId`. The query is also bounded by `expiresAt ≥ start − 24 h` (an indexed column). OTPs that have no user (failures before login) are shown once, in the summary. |
| | SMS / WhatsApp | `MessageDeliveryReceipt.status = FAILED` by `channel`, `updatedAt` in window |
| | WhatsApp broadcasts | `WhatsappBroadcastRecipient.status = FAILED`, `updatedAt` in window |
| Visibility | submitted | `VisibilityCaptureSubmission.createdAt` in window (includes re-submissions) |
| | approved / rejected | `VisibilityCapture.status = APPROVED` / `REJECTED`/`CHANGES_REQUESTED`, `reviewedAt` in window |
| | pending | `VisibilityCapture.status = SUBMITTED` (now) |
| Sales Import | processed / failed | `SalesImport` `READY` with `finishedAt` in window, and `FAILED` with `updatedAt` in window |
| | open months | The last 6 months, kept when `resolveMonthState` says OPEN and the month is not in the future. Each shows `SalesMonthStatus.lastAppliedAt` and `targetsChangedSinceApply`. That flag uses the same rule as `SalesMonthsService`: `tenantHasTargetNamesDef`, then `latestTargetWriteByMonth`, then `targetsNewerThanApply`. Focus-product blockers are deliberately left out because they are too heavy to compute here. |

Failures in the message tables are counted when the failure was **recorded** (`updatedAt`), not when the message was
sent. A delivery report that arrives after the send is therefore still counted, in the next digest.

## Needs attention
Each tenant section starts with a bullet list of every abnormal item:
- KYCs breaching the Gifsy SLA or the field SLA
- negative wallets
- failed redemptions
- Hubble: vouchers failed, vouchers stuck in processing for more than 30 min, orders that need reconcile
- payouts that failed or were returned
- messages that failed delivery
- failed Sales Imports
- "Targets changed — recalculate <month>"
- every section that could not be loaded

The summary at the top has one row per tenant: the number of attention items, KYC pending, redemptions requested, points
credited and payouts paid. Tenants are ordered by attention count (highest first), then by name.

Some sections hold only figures from the window and states that are not problems, such as awaiting UTR or visibility
pending review. These sections are hidden when every figure is zero. A tenant with nothing at all to show takes 2 lines:
its name, then "All quiet — nothing to report."

Subject: `Gifsy daily operations — <date> — <N> need attention`, where N is the number of tenants that have at least
one attention item.

## Failure handling
- **One section fails** (a query throws): that tenant's section shows "Couldn't load this section (reason)". It also
  becomes an attention item. Every other section and tenant still renders, and the email still sends. A failed
  section is never left out silently.
- **Sending is skipped only when there are no recipients.** On a day when every tenant is quiet, the email still goes
  out and says "All quiet".
- **The send itself fails** (for example SMTP): the endpoint returns `status: "error"` with the reason. The runner
  never throws.

## Recipients
The recipient list is `reportRecipients.dailyDigest`, stored in a platform `program_settings` row (`clientId='gifsy'`).
- **When `dailyDigest` is absent**, the digest goes to the union of the legacy `creditsPayouts` and `kycActionables`
  lists. Prod and staging therefore keep sending to whoever receives today's emails.
- **Editing the list:** the Gifsy-admin "Report Recipients" card on `/gifsy/settings` manages the single list. The card
  is GIFSY_ADMIN-only and carries the platform-wide badge.
- **After a save**, the stored list is used exactly as saved, even when it is empty.

## Scale
Queries run one tenant at a time, and within a tenant one section at a time. Every query is an indexed or
relation-scoped count, aggregate or groupBy. The only row-level reads are:
- the pending KYC rows, needed for the SLA calculation
- up to 10 failed redemptions

With a handful of tenants (Bajaj ~6.5k outlets, Deoleo with a longer history), one run is a few dozen small queries.
