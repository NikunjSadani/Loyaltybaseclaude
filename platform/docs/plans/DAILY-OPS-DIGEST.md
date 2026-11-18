# Daily Operations Digest

**Approved by the owner on 2026-11-13 (option A, ⚠️ PLATFORM-WIDE).** One internal Gifsy email replaces the two daily
emails ("Credits/Payouts summary" and "KYC actionables digest"). It has an all-tenant summary at the top, then one
section per tenant. It goes to internal Gifsy recipients only, never to clients. The schedule (Cloud Scheduler, Mon–Sat
09:30 IST → `POST /v1/reports/run`), the transport (MSG91 SMTP) and the mobile-friendly email layout are unchanged.
Activation and recipients: `runbooks/email-reports-activation.md`. Rendered sample:
`samples/daily-ops-digest-sample.html`.

**Status (2026-11-18):** branch `feat/daily-ops-digest` brought up to `develop` `71df01f7`, reconciled (17 Nov), then
the two audits' findings fixed (see "Audit fixes 2026-11-18" below). Not pushed or merged.

**Classification: ⚠️ PLATFORM-WIDE** (shared report code + the admin KYC dashboard's query/rule extracted into a shared
helper, behaviour-identical for the dashboard). Owner approved the digest as option A on 2026-11-13.

## Code
- `api/src/reports/scheduled/scheduled-reports.service.ts`: the runner. It does every Prisma query, tenant by tenant
  and section by section, and each section has its own try/catch.
- `api/src/reports/scheduled/daily-ops-digest-report.ts`: PURE builder. It has no database or clock access. It
  contains `digestWindow`, `kycPendingBuckets`, `needsAttention` and `buildDailyOpsDigest`.
- `api/src/reports/scheduled/report.types.ts`: the plain structs passed between the runner and the builder.
- `api/src/reports/scheduled/digest-run-state.ts`: run state (last successful send, last attempt, lease) and the PURE
  window plan `planDigestWindow`.
- `api/src/reports/scheduled/scheduled-reports.controller.ts`: the secret-gated trigger, `?force=true`, and the HTTP
  status per outcome (`httpStatusFor`).
- `api/src/common/report-recipients.ts`: the recipient list, with the legacy fallback and the internal-domain rule.
- `api/src/admin-core/dashboards/kyc-pending-sla.ts`: the admin KYC dashboard's pending-SLA population + rule, shared
  by the dashboard and the digest.
- The retired builders (`credits-payouts-report.ts`, `kyc-actionables-report.ts`) and their specs were removed. The
  digest reuses their logic: the same CreditBatch and PayoutTransaction queries. (Since 2026-11-18 the KYC SLA uses the
  admin KYC dashboard's rule via `dashboards/kyc-pending-sla.ts`, not the rounded `kycStageSla`.)

## Window and run state
The window runs **from the end of the last COMPLETE send to now**, so neither a missed day nor an incomplete email ever
loses data: the next digest covers (and, after an incomplete one, repeats) it. Run state lives in one platform
`program_settings` row (`clientId='gifsy'`, `settingKey='dailyDigestRunState'`) — no migration. (The `ScheduledReport`
model was not used: it is a per-tenant, per-user scheduled export with a required user FK, not a platform run log.)
The row holds:
- `lastSuccess` — the last email with COMPLETE data: `windowStartMs`, `windowEndMs`, `sentAt`, `recipients`, `forced`.
  Written ONLY by a `sent` run.
- `lastAttempted` — the last email that went out at all (`sent` or `degraded`), with `failedSections` when degraded.
- `failStreaks` — section key → how many emailed runs in a row it failed (reset when it loads).
- `lastAttempt` — every run, any outcome (`at`, `status`, window, `recipients`, `error`).
- `running` — `startedAt` + `token`: the lease while a run is in flight.

Rules (`planDigestWindow`):
- **First run** (nothing ever emailed): the old fixed rule — since the same time on the previous working day (Monday:
  Saturday 09:30 → Monday 09:30, 48 h; other days 24 h). The intro says it is the first tracked run.
- **One email per IST day:** if ANY email (complete or incomplete) already went out today → skipped, `200
  { skipped:'already-sent' }`. A scheduler retry or a double trigger never sends twice.
- **`force=true`** (same secret): re-sends today — from the last complete send's end, or, when today's complete send
  already went out, re-covering its window up to now; the intro says "manual re-run".
- **After an incomplete email** the window still starts at `lastSuccess.windowEndMs` (never sent complete → the first
  emailed window's start). The email says plainly at the top: "This email repeats <from → to> because the <date> digest
  was incomplete (<sections>). Don't add these figures to that day's."
- **Cap 7 days.** The dropped span is named in red and split honestly: the part that only went out in INCOMPLETE
  digests ("appeared only in INCOMPLETE digests … never reported complete"), and — only for a span never emailed at all —
  "… is NOT in any digest".
- **Lease** (TTL 6 min, just over the 240 s run budget): taken by compare-and-set on the row's `updatedAt` after a fresh
  read (or a create that collides on the unique key). A concurrent trigger gets `409 in-progress`; `force=true` may break
  a lease older than the run budget.
- **Every state write is conditional.** `finishRun` re-reads the row, writes only while `running.token` is still this
  run's, merges into the FRESH state, and compare-and-sets on `updatedAt` (≤ 3 retries). A runner whose lease expired and
  was taken over writes nothing and never clears the newer lease — it reports `error` ("no longer holds the run lease").
  `recordAttempt` (no-recipients / early error) changes only `lastAttempt`, also by compare-and-set.
- If the run-state row **cannot be read**, the run still sends on the fixed rule, says so in red, is `degraded`, and
  never writes the state back (so the history can't be erased).

## Time budget
Cloud Run's request timeout is **300 s** on `gifsy-api` and `gifsy-api-staging`. The run budget is 240 s from the start
of the request: a section not STARTED by then is not run — it shows "Couldn't load this section (not loaded (time
budget))", which makes the run `degraded` (window repeated next time). The email is built and sent within the request.

## Tenants
The digest loads every `Client` except the Gifsy operator row (`gifsy`). Each tenant is shown under its display name:
`branding.displayName`, or `internalName` when that is empty.
- **ACTIVE** tenants are always shown.
- **ONBOARDING / INACTIVE** tenants are shown — with a status badge and "(STATUS)" in the summary table — when they
  have an attention item or any non-empty section (Billing progress alone doesn't count). The rest are NAMED in one
  line at the bottom: "Not shown (not ACTIVE, no activity and no open items): …". Never dropped silently.

Optional sections:
- **Vouchers (Hubble)**: loaded for EVERY tenant and shown when non-empty, so a live Hubble problem still shows after
  `features.hubbleVoucherEnabled` was switched off (then titled "Vouchers (Hubble) — integration switched off").
- **Sales Import** and **Billing progress**: `features.salesImport === true`.
- **Visibility**: the `visibilityEnabled` program setting is `true`. This is the same rule `TenantSettingsService` uses.

One section is **Gifsy-wide** (not a tenant) and sits in the summary at the top: **Voucher dispersal** (GIFSY-run
Excel → Hubble → WhatsApp campaigns, `VOUCHER-DISPERSAL.md`). It is hidden when every figure is zero. Its WhatsApp
receipts are written under the platform tenant `gifsy`, which the tenant list excludes, so no tenant section could
show them.

## Sections and data sources
Labels used below:
- "in window" means the timestamp falls in `[start, end)`.
- "now" means the current state, whatever the date.

| Section | Figure | Source |
|---|---|---|
| KYC | submitted | `KycSubmission.submittedAt` in window (tenant via `user.clientId`) |
| | approved | `KycSubmission.status = APPROVED` and `approvedAt` in window |
| | rejected | `KycStatusHistory.toStatus ∈ {REJECTED, RE_UPLOAD_REQUIRED, RESUBMISSION_REQUIRED}`, `createdAt` in window |
| | pending by stage | **The admin KYC dashboard's own population and rule** (`dashboards/kyc-pending-sla.ts`, used by both): the latest submission of each ADDRESSABLE outlet (not deleted, not deactivated, `kycIntent` not `NOT_INTERESTED` / `PARKED`), tenant via `outlet.clientId`. Field statuses age from `submittedAt` (else `createdAt`); `PENDING_GIFSY` from the latest `PENDING_GIFSY` entry (else `submittedAt`, else `createdAt`). Business hours, holidays and per-tenant targets apply, and the age is compared **unrounded** (breached = age > target — the dashboard's test). Buckets: **within** (< 75 % of target), **nearing** (75 % ≤ age ≤ target), **breached** (> target); breached + (within + nearing) equal the dashboard's breached / within for the same moment. |
| | fast-tracked | GIFSY-reject fast-track (Bajaj flag `gifsyRejectFastTrack`): a KYC whose PENDING_GIFSY history holds the marked DRAFT→PENDING_GIFSY row (`isFastTrackRow`, `api/src/kyc/kyc-fast-track.helper.ts` — the same predicate as the admin dashboard's field-chain exclusion; marker only, never the bare edge). It skipped the field chain, so it is **never a field-SLA item**. At Gifsy it ages on the Gifsy clock and is shown as "of which fast-tracked (skipped field)". At a field status (no code path does this today) it is left out of the field SLA and called out in red + as an attention item. Read from the same history rows (no extra query). |
| Points | credited / redeemed / expired | `PointsLedger` `EARN` / `REDEEM` / `EXPIRE` points summed over `createdAt` in window (tenant via `wallet.partner.clientId`). Redeemed and expired are shown as absolute values. |
| | negative wallets | `Wallet.redeemablePoints < 0` (now) |
| Redemptions | requested | `RedemptionOrder.createdAt` in window |
| | completed / failed | `RedemptionStatusHistory.toStatus = DELIVERED / FAILED`, `createdAt` in window |
| | failed list (≤ 10) | Latest FAILED history rows. Shows the outlet (`partner.businessName (partnerCode)`), the reward (`reward.name`) and the reason (`order.cancelReason`, falling back to the history `notes`). |
| Redemptions | still open: failed, not refunded | `RedemptionOrder.status = FAILED` and `pointsDeducted > 0` (now). Every refund path zeroes `pointsDeducted` when it fails the order. |
| Vouchers (Hubble) | issued | DELIVERED history, orders with `voucherProvider = 'Hubble'` (case-insensitive) |
| | failed | FAILED history of Hubble-ROUTED orders: `voucherProvider = 'Hubble'` **or** `cancelReason = HUBBLE_NO_ORDER_REFUND_REASON` (the no-Hubble-order refund deliberately leaves the provider empty). A subset of Redemptions → failed. |
| | stuck in processing | Hubble orders in `PROCESSING` whose latest `PROCESSING` status-history row is > 30 min old (an order with no such row falls back to `updatedAt`) (now) |
| | needs reconcile | `metadata.hubbleNeedsReconcile = true` (now) |
| Payouts | batches confirmed | `CreditBatch` with status `CONFIRMED`/`PARTIALLY_REVERSED`, `confirmedAt` in window. Shows the count, Σ `totalOutlets` (the old Credits email's "Outlets"), Σ `totalPoints` and Σ `totalPayoutPaise`. |
| | credit payouts paid | `CreditPayoutEntry.status = PAID` with **`updatedAt`** in window (count and Σ `amountPaise`) — when the payment was RECORDED. Not `paidAt`: that is the operator's Payment Date at IST midnight, which almost always falls in a window already sent. `updatedAt` is reliable here: the UTR apply is the only PROCESSING→PAID/FAILED flip, a reversal leaves a PAID entry untouched, and invoice linking only touches fresh PENDING entries at confirm — no code writes a PAID entry again. (Rows written by a bulk import carry the import time.) |
| | redemption payouts paid | `PayoutTransaction.status = SUCCESS`, `completedAt` in window. This also comes from the old report. |
| | failed / returned | `CreditPayoutEntry FAILED` plus `PayoutTransaction FAILED/REVERSED`, `updatedAt` in window (the same recorded-time clock as "paid") |
| | still open | `CreditPayoutEntry.status = FAILED` (now; count + ₹ — awaiting re-bank or reversal, both move it) and `PayoutTransaction.status = FAILED` whose redemption order is NOT `FAILED`/`CANCELLED`/`RETURNED` or has no order (a normal FAILED payout refunds + fails its order in the same transaction; one that didn't — e.g. the issued-voucher block — needs ops) |
| | awaiting UTR | `CreditPayoutEntry.status = PROCESSING`, meaning it is in a downloaded bank file and the UTR upload is pending (now; count and ₹) |
| Messages | OTP | `OtpCode.deliveryStatus = FAILED`, `updatedAt` in window, tenant via `user.clientId`. The query is also bounded by `expiresAt ≥ start − 24 h` (an indexed column). Failures with no user (before login) and failures for **Gifsy staff** users (`user.clientId = 'gifsy'`, which no tenant section covers) are Gifsy-wide attention items. |
| | SMS / WhatsApp | `MessageDeliveryReceipt.status = FAILED` by `channel`, `updatedAt` in window |
| | WhatsApp broadcasts | `WhatsappBroadcastRecipient.status = FAILED`, `updatedAt` in window |
| Visibility | submitted | `VisibilityCaptureSubmission.createdAt` in window (includes re-submissions) |
| | approved / rejected | `VisibilityCapture.status = APPROVED` / `REJECTED`/`CHANGES_REQUESTED`, `reviewedAt` in window |
| | pending | `VisibilityCapture.status = SUBMITTED` (now) |
| Sales Import | processed / failed | `SalesImport` `READY` / `FAILED` with **`finishedAt`** in window (the processor stamps it on both; the retention purge bumps `updatedAt`, which would re-count old failures) |
| | still open: failed, not replaced | `FAILED` imports created after the tenant's latest `READY` import (all of them if there is none) (now) |
| | open months | The last 6 months, kept when `resolveMonthState` says OPEN and the month is not in the future. Each shows `SalesMonthStatus.lastAppliedAt` and `targetsChangedSinceApply`. That flag uses the same rule as `SalesMonthsService`: `tenantHasTargetNamesDef`, then `latestTargetWriteByMonth`, then `targetsNewerThanApply`. Focus-product blockers are deliberately left out because they are too heavy to compute here. |
| Billing progress | not started billing | Current IST month, the tenant's report KPI (primary, else first enabled). `loadBillingProgress` + `summarizeBillingProgress` from `api/src/admin-core/dashboards/billing-progress.ts`, unfiltered — the SAME numbers as the admin "Billing progress" card. Shows "N of M with a target" (N = NOT_STARTED bucket, M = live-roster outlets with a positive target), the data date, and what is not counted (outlets with no target, outside the KPI's scope, targets for outlets not in the live roster). No enabled KPI / no targets / no sales yet are each said in words. Informational — not an attention item. Its own try/catch: a failure never hides Sales Import. |
| Voucher dispersal (Gifsy-wide) | bought | `VoucherDispersalRow.status = BOUGHT`, `boughtAt` in window |
| | purchase failed | `status = BUY_FAILED`, `updatedAt` in window — EXCLUDING rows an admin marked "not bought" (`buyFailureSource = MARKED_NOT_BOUGHT`, OR-wrapped so NULL sources count). Hubble documents only SUCCESS / PROCESSING / FAILED; any other answer is never a release. |
| | WhatsApp failed | `status = BOUGHT` and the mirrored `messageStatus` ∈ {FAILED, UNKNOWN} (or no status but `messageError`), `updatedAt` in window — the campaign screen's "message failed" rule |
| | pending | `QUEUED` + `BUYING` + `PENDING_RECONCILE` (now) — the campaign screen's "pending" |
| | unconfirmed > 2 h | `PENDING_RECONCILE` rows (except an undocumented Hubble status — see below) past the retry gate: latest of `placeAttemptAt` / `pendingSince` + `DISPERSAL_RETRY_MIN_AGE_MS` (2 h) ≤ now — the service's `retryAvailableAt` rule |
| | still open | rows in `BUY_FAILED` now EXCEPT rows marked "not bought" (closed) — a Retry moves a row out of it — and `BOUGHT` rows whose WhatsApp is failed now (a Resend clears the status) |
| | campaigns over budget | campaigns whose Σ(`BUYING` + `PENDING_RECONCILE` + `BOUGHT` + `BUY_FAILED` Hubble may still complete — reference sent, not `REJECTED`) > `budgetPaise` (now) — the campaign page's "over budget" rule (QUEUED not counted). Attention item, worded neutrally ("spending is over the budget; see the campaign's budget breakdown"). |
| | status update failing | campaigns with `settleFailures ≥ 3` (now). Attention item ("contact Gifsy tech"). |
| | earlier order reported by Hubble ("In window") | OPEN alerts (`resolvedAt` null) of `voucher_dispersal_order_alerts` CREATED or WORSENED in the window (`createdAt` or `statusChangedAt` — the latter moves only when the status gets worse: up to SUCCESS / PROCESSING / an undocumented status, or re-opened). ONE alert per (campaign, reference). Attention items worded per kind: activity on an EARLIER order retired by a retry (a voucher may have been issued twice) · on the order of a row marked "not bought" (the row stays closed) · a completed CURRENT order that could not be applied to its row (a paid voucher may not have reached the person) · "couldn't check … — the lookup failed and no status is known yet" (status `LOOKUP_FAILED` only while no real status was ever seen). NOT counted as spend. |
| | earlier-order alert resolved ("In window") | `resolvedAt` in the window — Hubble confirmed the order failed / there is no order (canary-verified), or the row took Hubble's answer. Only alerts that never saw SUCCESS / an unrecognised status can be resolved. Informational (not an attention item). |
| | order alerts still open ("Right now") | Every OPEN alert (`resolvedAt` null), any age, by kind — "couldn't check" = only our `__LOOKUP_FAILED` label; "no order (unverified)" = `__NO_ORDER_UNVERIFIED` (re-checked by the sweep; a raw Hubble status is never mistaken for either). Attention item EVERY day until resolved ("still open: N order alerts (…)"). |
| | closed (marked not bought) | rows `status = BUY_FAILED` + `buyFailureSource = MARKED_NOT_BOUGHT` (now). Informational — not "still failed". |
| | Hubble status not recognised | `PENDING_RECONCILE` rows whose `pendingReason` starts `HUBBLE_UNKNOWN_STATUS`, plus `BUY_FAILED` rows (not marked) whose LATEST lookup (`lastReconcileResult`) was an undocumented `HUBBLE_<status>` (now). Attention item ("needs Gifsy tech"); NOT counted in "unconfirmed > 2 h". |
| | bought later after failing | rows whose `lateCompletedAt` is in the window: Hubble BOUGHT a purchase after it had failed / been refused (set once, only on BOUGHT; a failed → processing flip is an informational audit and does not count). Attention item. |

Failures in the message tables are counted when the failure was **recorded** (`updatedAt`), not when the message was
sent. A delivery report that arrives after the send is therefore still counted, in the next digest.

## Needs attention
Each tenant section starts with a bullet list of every abnormal item. A window figure and its matching "still open now"
figure are ONE bullet (they overlap), e.g. "1 payout failed or returned in the window (still open: …)":
- KYCs breaching the Gifsy SLA or the field SLA
- negative wallets
- failed redemptions — ONE bullet with the Hubble share and the not-refunded count inside it ("3 redemptions failed in
  the window, 2 via Hubble (1 still holding points, not refunded)"); a separate "Hubble: N vouchers failed" bullet
  appears only if the Redemptions section itself failed to load; with no failure in the window: "Still open: …"
- Hubble: vouchers stuck in processing for more than 30 min, orders that need reconcile
- payouts failed or returned in the window, with the still-open failed credit payouts (₹, awaiting re-bank or
  reversal) and failed redemption payouts without a refund in the same bullet
- messages that failed delivery
- Sales Imports failed in the window, with the not-yet-replaced count in the same bullet
- "Targets changed — recalculate <month>"
- fast-tracked KYCs found at a field stage (not on the field SLA — check by hand)
- every section that could not be loaded (incl. Billing progress)

**Gifsy-wide** items are listed in a "Needs attention — Gifsy-wide" box in the summary: OTP failures before login and
to Gifsy staff (or that query failing), Voucher dispersal purchases / WhatsApp messages failed in the window with the
still-failed counts in the same bullet, purchases unconfirmed by Hubble for over 2 h (Retry available), or the section
could not be loaded. **Run notices** (a shared input failed, or the window was capped) sit in a red "This digest is
incomplete" box at the very top and are Gifsy-wide items too; the same box lists every section that did not load and,
after 3 runs in a row, "<section> failed to load N runs in a row". The "this email repeats …" line (amber, above it) is
not an attention item.

**Counting:** the attention total counts EVENTS, not bullets — 12 breaching KYCs = 12, a section that couldn't load = 1,
a run notice = 1. A merged window + still-open bullet counts the larger of its two figures (they overlap, and the digest
doesn't read which rows they share, so the larger is the honest lower bound of distinct events). The per-tenant
"Needs attention" column shows the same event count.

The summary at the top has one row per tenant: the number of attention items, KYC pending, redemptions requested, points
credited and payouts paid. Tenants are ordered by attention count (highest first), then by name.

Some sections hold only figures from the window and states that are not problems, such as awaiting UTR or visibility
pending review. These sections are hidden when every figure is zero. A tenant with nothing at all to show takes 2 lines:
its name, then "All quiet — nothing to report."

Subject: `[Gifsy] Daily operations — <date> — all quiet`, or `[Gifsy] Daily operations — <date> — <N> items need
attention (<T> tenants + Gifsy-wide)`, where N is every attention EVENT (tenant items, Gifsy-wide items incl. OTP
failures, standing open items and run notices). When anything did not load (or a run notice is present) the status
reads `INCOMPLETE — …`; when the same section has failed 3 runs in a row, `INCOMPLETE 3 days — …` (N = the longest
streak). The subject can therefore never say "all quiet" while the body shows a red problem.

A Sales-Import tenant always shows its Billing progress block, so it is never "All quiet" on its own.

## Failure handling and HTTP status
Cloud Scheduler treats any non-2xx as a failed attempt and alerts, so only a complete send or an idempotent skip
answers 2xx (`httpStatusFor`):

| Outcome | When | HTTP | Window advanced? |
|---|---|---|---|
| `sent` | emailed with complete data | 200 | yes |
| `skipped` | an email (complete or not) already went out today (no `force`) | 200 `{ skipped:'already-sent' }` | — |
| `degraded` | emailed, but SOMETHING did not load: any tenant section, the Gifsy-wide OTP / voucher-dispersal section, a section skipped by the time budget, a shared input (tenant list, holiday calendar, SLA targets) or the run-state read | 500 | no — the next run re-covers (repeats) it |
| `no-recipients` | the effective list is empty (or every address was non-internal) | 409 | no |
| `in-progress` | another run holds the lease | 409 | no |
| `error` | recipient read failed, collect/send threw, the email went out but the run could not be recorded, or the run's lease was taken over before it finished | 500 | no |

- **One section fails** (a query throws, or the time budget skipped it): that section shows "Couldn't load this
  section (reason)" and it becomes an attention item; everything else renders and the email goes out, but the run is
  `degraded` — its window is NOT advanced, so tomorrow's email repeats it complete (and says so).
- **A shared input fails:** the email still goes out with a red "This digest is incomplete" notice naming what failed
  and what that means — tenant list: no tenant sections, only Gifsy-wide figures; holidays: SLA ages skip weekends
  only (may overstate breaches); SLA targets: 24 h / 96 h defaults for every tenant. Run = `degraded`.
- **Recipient list can't be read** → `error` (never mistaken for "no recipients").
- **Response body.** 200 → `{ success:true, data:{ ok, dateLabel, reports:[outcome] } }`. Non-2xx → the global
  `AllExceptionsFilter` forwards only an exception's `message`, so the body is `{ success:false, error:"<summary>" }`
  where the summary is one readable line — status, reason, what didn't load, dropped recipients, notices, window — ending
  `full outcome in the API log line "daily-digest-run <id>"`. That log line (every run writes exactly one, ERROR level
  for non-2xx) is `daily-digest-run <id> {"httpStatus":…, "dateLabel":…, "reports":[<full outcome>]}`.

## Recipients
The recipient list is `reportRecipients.dailyDigest`, stored in a platform `program_settings` row (`clientId='gifsy'`).
- **When `dailyDigest` is absent**, the digest goes to the union of the legacy `creditsPayouts` and `kycActionables`
  lists. Prod and staging therefore keep sending to whoever receives today's emails.
- **Internal only.** Allowed domains = `REPORTS_RECIPIENT_DOMAINS` (comma-separated, exact match after `@`; default
  `gifsy.in`). The PUT refuses (400, naming them) any other address. At send time any other address (e.g. inherited
  from a legacy list) is dropped, named in the email footer and logged as a warning.
- **Editing the list:** the Gifsy-admin "Report Recipients" card on `/gifsy/settings` manages the single list. The card
  is GIFSY_ADMIN-only and carries the platform-wide badge. It shows the domain rule and rejects other addresses inline
  (Save disabled). Until the first save it labels the list "Inherited from the two old daily emails' lists". A failed
  load shows a red error and hides Save (it never shows an editable empty list). The empty-list text says truthfully
  whether nobody gets the digest (saved empty / nothing saved yet) or that saving an empty list would mean nobody.
- **After a save**, the stored list is used exactly as saved, even when it is empty.
- GET returns `{ recipients:{dailyDigest}, source:'saved'|'legacy'|'none', allowedDomains, blocked }`.

## Scale
Queries run one tenant at a time, and within a tenant one section at a time. Every query is an indexed or
relation-scoped count, aggregate or groupBy. The only row-level reads are:
- the KYC population: every addressable outlet with its partner's latest submission and that submission's history —
  the SAME query as opening the admin KYC dashboard once (Bajaj ≈ 6.5k outlets)
- the tenant's FAILED redemption payout transactions (one id each), then one count of their orders
- up to 10 failed redemptions
- the voucher-dispersal rows in PENDING_RECONCILE (two timestamps each)
- Billing progress (Sales-Import tenants only): the dashboard loader's ≈9 parallel queries — the whole live roster,
  targets and sales records for the month, aggregated in memory, none per outlet. Same load as opening the dashboard
  card once (Bajaj ≈6.5k outlets).

With a handful of tenants (Bajaj ~6.5k outlets, Deoleo with a longer history), one run is a few dozen small queries.

## Reconciliation 2026-11-17 (merge of `develop` `71df01f7`)
- **Merge:** conflicts only in `RESUME.md` and `BAJAJ-GO-LIVE-DECISIONS-LOG.md` (develop's side kept; both already
  described the digest). Code auto-merged; develop renamed/removed no helper the digest uses.
- **KYC fast-track** — see the KYC table rows above. A fast-tracked KYC was already never on the field clock (it sits
  in PENDING_GIFSY); the rule is now explicit, uses the dashboard's `isFastTrackRow`, and the count is shown.
- **Voucher Dispersal** — new Gifsy-wide section + attention items (above).
- **Billing progress** — new per-tenant block for Sales-Import tenants (above).
- Local note: this worktree's generated Prisma client predated the dispersal models; `npx prisma generate` (local
  `node_modules` only) was needed before the api type-checked.

## Audit fixes 2026-11-18
Two audits' findings, all fixed on this branch (tests in `api/src/reports/scheduled/*.spec.ts`,
`admin-core.service.spec.ts`, `platform-global-settings.test.tsx`):
- **H1** credit payouts paid/failed by the RECORDED time (`updatedAt`), not `paidAt` — see the Payouts rows.
- **H2** a failed run is non-2xx (`degraded`/`error` 500, `no-recipients`/`in-progress` 409); shared loaders guarded
  with a red "incomplete" notice — see "Failure handling".
- **H3** window since the last successful send (≤ 7 days), idempotent skip, `force=true`, lease; standing "still open"
  counts (failed payouts, failed-not-refunded redemptions, voucher-dispersal still failed, Sales Import failed not
  replaced).
- Subject honesty (`[Gifsy]` prefix; every attention item counted; OTP problems included).
- Sales Import FAILED by `finishedAt`.
- Recipients internal-only (`REPORTS_RECIPIENT_DOMAINS`), on save and at send; settings card load-failure / inherited
  label / truthful empty copy.
- KYC SLA = the admin dashboard's population + unrounded rule, via the shared `dashboards/kyc-pending-sla.ts`.
- Non-ACTIVE tenants with activity shown (marked); the rest named.
- Outlets figure restored; Hubble failed includes the unstamped no-order refund; stuck measured from the PROCESSING
  history row; vouchers shown even with the Hubble flag off; Gifsy-staff OTP failures on a Gifsy-wide line;
  `rupees()` one rounding rule (half away from zero) for BigInt and number; Hubble/redemption failures de-duplicated.

## Fix round 2026-11-18 (independent re-check)
- **D1** non-2xx bodies are readable through the global filter (summary `message` + one structured log line with the
  full outcome) — tested through the real Nest HTTP stack (`scheduled-reports.http.spec.ts`).
- **D2** ANY section that did not load → `degraded` (window not advanced, repeated next time with a plain "this email
  repeats …" line); one email per IST day even when degraded (`force=true` to re-send); "INCOMPLETE N days" after 3 runs
  in a row; the "NOT in any digest" notice only for spans never emailed.
- **D3** 240 s run budget inside Cloud Run's 300 s limit; lease TTL 6 min; every state write compare-and-set on a fresh
  read, gated on the run's own lease token.
- **D4** a window figure and its still-open figure are one bullet; the attention total counts events.
- **D5** tripwire spec `digest-recorded-time-guard.spec.ts` lists every write site on `CreditPayoutEntry` and
  `PayoutTransaction`; a new or changed one fails until reviewed.

## Recorded-time clocks — what must stay true
The digest counts **credit payouts PAID / FAILED by `CreditPayoutEntry.updatedAt`** and **redemption payouts FAILED /
REVERSED by `PayoutTransaction.updatedAt`**. That is only right while no code path writes a row that is already PAID
(credit entry) or FAILED / REVERSED (payout transaction) without changing its status.
- Audit 2026-11-18, `CreditPayoutEntry` (6 write sites): download claim (PENDING/FAILED → PROCESSING), the TDS stamp on
  entries that same download just claimed, the UTR apply (the only PROCESSING → PAID/FAILED flip), the reversal
  (PENDING/FAILED → REVERSED; a PAID entry is skipped before the write), and two `generateForBatch` invoice links on
  entries created moments earlier in the same confirm transaction. None touches a PAID row.
- Audit 2026-11-18, `PayoutTransaction` (3 write sites, `payouts.service.ts`): assign-to-batch (PENDING only),
  disburse (PENDING → INITIATED only), UTR report (terminal rows skipped, except FAILED/REVERSED → SUCCESS when paid off
  the platform — the status changes, so the row leaves the FAILED/REVERSED count). No path rewrites a FAILED / REVERSED
  row in place; no code sets REVERSED today. DB-level `ON DELETE SET NULL` does not touch `updatedAt` (Prisma stamps it,
  not Postgres). **Result: safe today.**
- ⚠️ **Wallet reversal engine (in build)** and any future writer: must NOT update a PAID `CreditPayoutEntry` (or a
  FAILED/REVERSED `PayoutTransaction`) in place — or it must add a dedicated stamp (e.g. `paidRecordedAt`) and switch
  the digest to it. The tripwire spec fails on any new write site until this is decided.
