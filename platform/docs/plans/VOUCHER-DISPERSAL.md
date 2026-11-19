# Voucher Dispersal — design, API contract, runbook, safety rules

Owner-approved 2026-11-16. **Money code**: every confirmed row spends real money on the platform Hubble account.
Branch `feat/vd-api` (server) + `feat/vd-ui` (screens). **2026-11-18 (owner-approved, branch `feat/vd-campaign-extend`):**
clickable campaign cards + per-card Excel, **Edit campaign** (name / budget) and **"Add more people"** batches — §10.
**Status:** base tool LIVE since 2026-11-16 (`720ffce9`); the §10–§10f extension is ✅ **LIVE on prod `7ba69566`
(2026-11-19)** — migration `20261118160000_voucher_dispersal_batches` applied; staging-verified 2026-11-18 (edit refusal +
history, batch-2 DUPLICATE, discard, Excel). Prod deploy ran with `voucher-dispersal-drain-prod` paused (resumed after).

## 1. What it is

A **platform-level Gifsy admin tool** (not tenant data; not linked to the app-adoption installed-users list):

1. Create a campaign: name, `programLabel` (the WhatsApp `{{3}}` "program" text, e.g. "Bajaj Loyalty" / "Gifsy Rewards"),
   optional `billedToClientId` (reporting label only), budget in ₹.
2. Download the template, fill **Phone | Name | Amount (₹) | Brand | Note**, upload it → preview with every invalid /
   duplicate row and the total against the budget.
3. **Buy & send vouchers** (one click + normal confirm dialog). The server buys **one Hubble voucher per valid row** and
   sends it on WhatsApp with the existing approved `voucher_code` template.
4. Watch the per-row report (voucher status + WhatsApp sent / delivered / read / failed); download `report.xlsx`;
   resend a message; retry a failed purchase (safety rules below).

Recipients are bare phone numbers — never looked up against users / outlets. Every `GIFSY_ADMIN` (assumed into a tenant
or not) sees every campaign. `GIFSY_STAFF` and every tenant role are refused (controller `@Roles('GIFSY_ADMIN')` with no
`@RequirePermission`, re-checked in the service).

## 2. Data (migration `api/prisma/migrations/20261117140000_voucher_dispersal`, additive only)

- `VoucherDispersalCampaign` — name, programLabel, billedToClientId (no FK), note, budgetPaise, status
  `DRAFT|PREVIEWED|CONFIRMED|PROCESSING|COMPLETED|COMPLETED_WITH_ERRORS|CANCELLED`, previewId (current preview),
  created/uploaded/confirmed/cancelled by+at, completedAt.
  (`CONFIRMED` exists in the enum for the contract; confirm moves straight to `PROCESSING` in the same transaction.)
- `VoucherDispersalRow` — rowNumber (Excel row), phone (normalised 10 digits) + rawPhone, name, amountPaise, brand
  (key/label/productId), note, status `VALID|INVALID|DUPLICATE|QUEUED|BUYING|PENDING_RECONCILE|BOUGHT|BUY_FAILED|CANCELLED`,
  invalidReason, **hubbleReferenceId (unique)** + previousReferenceIds, hubbleAccount (fingerprint at place time),
  hubbleOrderId, place/claim/pending/reconcile evidence, voucherCode / voucherPin (stored like
  `RedemptionOrder.voucherCode`), buy failure reason + source (`HUBBLE_FAILED|REJECTED|NOT_SENT|BUDGET`),
  whatsappReceiptId (→ `MessageDeliveryReceipt.id`, no FK) + a status mirror, resendCount, attempts.
- **One voucher per phone per campaign** is DB-enforced by `@@unique([campaignId, dedupePhone])`: `dedupePhone` is set
  only on the FIRST row of the file for a phone (NULLs are distinct, so INVALID/DUPLICATE rows never collide). This is
  the brief's `@@unique([campaignId, phone])` made workable — a DUPLICATE row must still be stored and shown. The key
  spans **every batch** (§10).
- Migration `20261118160000_voucher_dispersal_batches`: `VoucherDispersalRow.batchNumber` (default 1 — every existing
  row is batch 1), table `VoucherDispersalBatch` (batches 2, 3, …: status `PREVIEWED|CONFIRMED|DISCARDED`, previewId,
  file, uploaded / confirmed / discarded by + at, discardReason; `@@unique([campaignId, batchNumber])`), and the row-number
  unique widened from `(campaignId, rowNumber)` to `(campaignId, batchNumber, rowNumber)` (new index created before the old
  one is dropped; no data touched). `SET lock_timeout = '5s'` … `RESET lock_timeout`; also `settleFailures` / `settleError` on campaigns.

## 3. API contract (`/v1/admin/voucher-dispersal`, GIFSY_ADMIN, `{ success, data }` envelope; errors `{ success:false, error }`)

| Method + path | Body / query | Returns |
|---|---|---|
| `GET /brands` | — | `[{ key, label, productId, minAmount, maxAmount, denominations \| null, denominationType, available, unavailableReason }]` — limits read LIVE from Hubble (never hard-coded) |
| `GET /template.xlsx` | — | template (Recipients sheet, Brand dropdown, Phone as text, Instructions sheet with each brand's live amount rule) |
| `POST /campaigns` | `{ name, programLabel, billedToClientId?, note?, budgetRupees }` | campaign (DRAFT) |
| `POST /campaigns/:id/upload` | multipart `file` (.xlsx) | `{ previewId, campaign, rows:[{rowNumber, phone, name, amount, brand, brandKey, note, status, invalidReason, warning}], summary:{ total, valid, invalid, duplicates, totalRupees, budgetRupees, overBudget, perBrand:[{brandKey, brand, count, totalRupees}], warningCount, skippedBlankRows, skippedFormulaRows, skippedNote, hiddenRowsIncluded, hiddenNote } }` — re-upload replaces rows while DRAFT/PREVIEWED; every upload gets a NEW `previewId` |
| `POST /campaigns/:id/confirm` | `{ previewId, expectedValidCount, expectedTotalRupees }` | campaign. Refuses: Hubble not configured (503), 0 valid / over budget (400), previewId not current or numbers changed (409). **Idempotent**: repeating a confirm with the already-confirmed previewId returns the campaign (200) — nothing queued or bought again |
| `POST /campaigns/:id/process` | — | `{ pass, campaign, hubbleConfigured, summary }` — a bounded in-request processing pass (≤ 25 s, ≤ 25 buys). *Addition to the brief* — see §5 |
| `GET /campaigns` | `?page=` (50 per page) | `[{ ...campaign, summary:{ total, valid, invalid, duplicates, queued, pending, bought, buyFailed, cancelled, spentRupees, pendingBatchNumber } }]` newest first (every CONFIRMED batch; an unconfirmed batch is excluded and named by `pendingBatchNumber`) |
| `GET /campaigns/:id` | — | `{ campaign, hubbleConfigured, summary:{ total, valid, invalid, duplicates, totalRupees, budgetRupees, overBudget, perBrand, queued, buying, pendingReconcile, pending, bought, buyFailed, cancelled, spentRupees, budgetFloorRupees, budgetUsage:{ spentRupees, withHubbleRupees, failedMayCompleteRupees, queuedRupees, floorRupees }, messageSent, delivered, read, messageFailed, messageNotSent }, batches:[{ batchNumber, status, sourceFileName, uploadedBy(Id/Name)/At, confirmedBy…/At, discardedBy…/At, discardReason, previewId, total, valid, invalid, duplicates, bought, buyFailed, pending, cancelled, totalRupees, spentRupees }], edits:[{ at, byId, byName, changes:[{ field, from, to }] }] }` (totals cover every CONFIRMED batch) |
| `GET /campaigns/:id/rows` | `?status=&batch=&page=` (100 per page) | `{ rows, total, page, pageSize }` (an unconfirmed batch's rows only with `batch=` its number) |
| `GET /campaigns/:id/report.xlsx` | — | Batch, Source file, Row, Phone, Name, Amount, Brand, Voucher status, Hubble order ref, Bought at, Failure reason, WhatsApp status, Sent at, Delivered at, Read at, Message failure reason (**no codes**) |
| `POST /campaigns/:id/rows/:rowId/resend` | — | row — re-sends the WhatsApp for a BOUGHT row (new receipt); never buys; only after the first send has an outcome; max 3 per row |
| `POST /campaigns/:id/rows/:rowId/retry-buy` | — | `{ message, row }` — rules in §4; idempotent. 409 when Hubble answers with a status we do not recognise ("we cannot tell whether it was bought … use Mark as not bought") |
| `POST /campaigns/:id/rows/:rowId/mark-not-bought` | `{ reason }` (5–300 chars) | row — GIFSY_ADMIN only; only when the row's last Hubble answer was unrecognised (`row.canMarkNotBought`); audited `VOUCHER_DISPERSAL_MARKED_NOT_BOUGHT` (actor, reason, previous state) in the same transaction; row → BUY_FAILED `MARKED_NOT_BOUGHT` = CLOSED for good (off the budget, never looked up, never retried — no voucher will be bought for this person in this campaign; any replacement is arranged with Hubble outside it) |
| `POST /campaigns/:id/cancel` | — | `{ campaign, cancelledRows, stillWithHubble, alreadyBought, discardedPendingBatchRows }` |
| `PATCH /campaigns/:id` | `{ name?, budgetRupees? }` | campaign. 400: nothing to change / empty name / budget below the floor (the message states the floor, spent and committed); 409 on CANCELLED |
| `POST /campaigns/:id/batches` | multipart `file` (.xlsx) | `{ batchNumber, batchStatus, previewId, campaign, rows, summary:{ …upload summary, alreadyCommittedRupees, remainingBudgetRupees, crossBatchDuplicates } }` — `overBudget` = this batch > what is LEFT. 409 with the reason unless the campaign is COMPLETED / COMPLETED_WITH_ERRORS with nothing in flight. Re-upload while a batch waits = replaces it (same number, new previewId) |
| `GET /campaigns/:id/batches/:n` | — | the same preview for a batch still PREVIEWED (409 once confirmed / discarded) |
| `POST /campaigns/:id/batches/:n/confirm` | `{ previewId, expectedValidCount, expectedTotalRupees }` | campaign (→ PROCESSING). 400 over budget ("Raise the budget"), 409 stale preview / changed numbers / still processing / discarded; idempotent per batch |
| `POST /campaigns/:id/batches/:n/discard` | — | `{ campaign, batchNumber, discardedRows }` — only a PREVIEWED batch |

**Campaign fields:** id, name, programLabel, billedToClient `{id, name} | null` (id = `Client.id`, the same `id`/`slug`
`GET /v1/gifsy/clients` returns), note, budgetRupees, status, sourceFileName, previewId (only while PREVIEWED), uploadedAt,
createdById/At, confirmedById/At, cancelledById/At, **completedAt** (set on COMPLETED / COMPLETED_WITH_ERRORS),
updatedAt, **canCancel**, **canEdit** (not CANCELLED), **addPeopleBlockedReason** (null = "Add more people" available).

**Row fields:** id, batchNumber, rowNumber, phone, name, amount, brand, brandKey, note, status, invalidReason, pendingReason,
lastReconcileAt/Result, hubbleReferenceId, hubbleOrderId, boughtAt, buyFailureReason/Source, **voucherCodeMasked**
(the audit rule `maskVoucherCodeForAudit`: `••••` + last 4 only for a 12+ char code, else `••••`), hasPin, **messageStatus** (`SENT|DELIVERED|READ|FAILED|null`),
messageSentAt, messageDeliveredAt, messageReadAt, messageFailedAt, messageError, `whatsapp` (detailed view), warning,
attempts, resendCount, **canResend** (BOUGHT, the WhatsApp has an outcome, < 3 resends), **canRetryBuy** (BUY_FAILED, or
PENDING_RECONCILE ≥ 2 h after the last attempt; never on a CANCELLED campaign), retryAvailableAt.

**UI ⇄ server contract test.** `platform/src/lib/voucher-dispersal.ts` reads these field names EXACTLY (no aliases).
`api/src/voucher-dispersal/voucher-dispersal.contract.spec.ts` drives the real service and fails if any reply's key
shape drifts from `platform/src/lib/__tests__/fixtures/voucher-dispersal-server-contract.json`;
`platform/src/lib/__tests__/voucher-dispersal.contract.test.ts` runs the UI normalisers over that fixture and fails
if the UI reads a field the server does not send, or if a server field is neither read nor listed as deliberately
ignored. After an intended server change: `UPDATE_VD_CONTRACT=1 npx jest src/voucher-dispersal/voucher-dispersal.contract.spec.ts`
(in `api/`), then fix the platform test / UI. The UI shows `warning` as an amber row note + the preview's warning
count (never blocks Buy), `skippedNote` / `hiddenNote` in the preview, `pendingReason` codes in plain words, and the
list page shows purchase counts only (the list sends no WhatsApp counts).

Validation (each a visible `invalidReason`): phone = 10-digit Indian mobile (+91 / 0 stripped); name required, ≤ 60
chars, single line; brand = a configured brand (key or label); amount = whole rupees, within the brand's LIVE min/max, on
its fixed list (the reason states the allowed range / list); a FIXED brand whose amounts Hubble did not return → INVALID
("try later" — never guessed); a brand whose limits Hubble could not return → its rows INVALID ("upload again later");
note ≤ 200 chars (longer → INVALID, never truncated); second+ row with the same phone → DUPLICATE ("Same phone as row N",
or "…that row is invalid — fix it to send to this number"). ≤ 5,000 rows; missing columns → 400 naming the expected
columns. Blank rows and formula-only rows (no saved values) between data rows are counted in `skippedNote`; hidden rows
are included and counted in `hiddenNote`. **Cross-campaign warning (not a block):** a phone that got a voucher in any
other campaign in the last 30 days gets `warning` "Already got a ₹X <brand> voucher on <date> in campaign <name>" and is
counted in `warningCount`; confirm is still allowed.

Brands: default registry Amazon Pay `01HDRPKWFE2SMVM54TWD8S1927` + Flipkart `01GMMNJECTDZAG2YS61K58HVG8`
(`voucher-dispersal.brands.ts`); override per environment with `VOUCHER_DISPERSAL_BRANDS` = JSON
`[{"key":"AJIO","label":"AJIO","productId":"…"}, …]` (a malformed override is ignored → default). Staging limits
(2026-11-16): Amazon Pay FLEXIBLE ₹500–₹10,000; Flipkart FLEXIBLE ₹10–₹10,000. Prod may differ — always read live.

## 4. Money-safety rules (same owner decisions as RewardsService's Hubble path)

1. **Never buy twice for a row.** `hubbleReferenceId` (`vd` + 24 hex) is written at UPLOAD — before anything can reach
   Hubble. A row is sent to Hubble only from QUEUED, after an atomic `QUEUED→BUYING` claim (one winner across
   instances/passes). The engine NEVER re-places a BUYING / PENDING_RECONCILE row — it only looks it up by reference.
2. **Timeout / 5xx / network / unknown ≠ not bought.** Only a DEFINITIVE answer fails a row: Hubble's FAILED body, or a
   definitive 400/422 rejection whose "no order" lookup is verified by the CANARY. Everything else → PENDING_RECONCILE.
3. **Canary** (shared `api/src/hubble/hubble-canary.ts`, also used by RewardsService): before trusting "Hubble has no
   order", look up an order Hubble is KNOWN to hold on the same Hubble account (a bought dispersal row or a delivered
   redemption order with a matching account fingerprint). No candidate / not verified → fail closed (stay pending).
4. **Manual retry** (`retry-buy`):
   - BUY_FAILED never sent (`NOT_SENT` / `BUDGET`) → re-queued with the SAME (unused) reference.
   - BUY_FAILED by Hubble (`HUBBLE_FAILED` / `REJECTED`) → Hubble is asked again first; if it now holds a voucher it is
     delivered (not bought again); FAILED or a canary-verified "no order" → re-queued with a NEW reference (old one kept
     in `previousReferenceIds`; Hubble may refuse to reuse a failed reference — open question Q2).
   - PENDING_RECONCILE → only **2 hours** after the last place attempt / flag; Hubble asked again; an order → applied;
     canary-verified "no order" → re-queued with the **SAME** reference.
   - Repeated while queued / buying / bought → returns that state (idempotent).
5. **Budget can never be exceeded**: checked at upload (overBudget), at confirm under the campaign row lock, and again
   under that lock before EVERY buy: Σ(BUYING + PENDING_RECONCILE + BOUGHT + every BUY_FAILED row whose CURRENT reference
   reached Hubble — `referenceSentAt` set — EXCEPT a `REJECTED` one) + this row ≤ budget, else BUY_FAILED `BUDGET`. A failed
   row whose reference reached Hubble keeps counting (Hubble may still complete it); a retry releases it only by
   re-queueing it, and the claim re-checks. **2026-11-18 owner decision:** a `REJECTED` failure (definitive refusal +
   canary-verified "no order") is released; `HUBBLE_FAILED` still counts (§10a). Retries are also refused up front when
   they would take budget promised to queued rows (§10a). A local failure (`BUDGET` / `NOT_SENT`) on a row whose reference reached Hubble EARLIER stays in the
   reconcile sweep (and a retry of it follows the indeterminate rules: 2 h + Hubble asked + canary, same reference).
6. **Codes**: stored on the row; never logged (WhatsApp failure reasons are scrubbed via `secretValues`), audited masked
   only, never in an admin response or report.xlsx.
7. **Defence in depth**: before each place, the brand's live product is re-read; an amount it can't issue now → BUY_FAILED
   `NOT_SENT` (nothing reached Hubble). A product-lookup error never blocks (Hubble validates).
8. **Stale claim**: a BUYING row older than 5 min (worker died mid-call) → PENDING_RECONCILE `STALE_BUYING` (lookup only).
9. **Late webhook / lookup SUCCESS for a superseded reference** (or a SUCCESS that could not be stored on the row) →
   error log + audit `VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY` (possible second voucher — ops review).
10. **Campaign status under the lock:** retry's re-queue + re-open (→ PROCESSING) run in ONE transaction under the campaign
   row lock (a CANCELLED campaign refuses inside it), and the finish / re-settle (COMPLETED ↔ COMPLETED_WITH_ERRORS,
   counting BUY_FAILED rows and bought rows whose WhatsApp is FAILED / UNKNOWN) runs under the same lock — after each
   pass, after a resend and after a status-mirror change.
11. **Messages:** a send records its outcome only while its message-claim timestamp is still current (a resend's newer
   claim is never overwritten); a claim with no outcome after 30 min becomes `UNKNOWN — use Resend`. A resend detaches
   the old receipt FIRST, so a failed resend never hides behind an old DELIVERED; the status mirror never overwrites a
   newer send. A receipt stuck QUEUED after a successful send still reads SENT.

## 5. Processing (background) — drivers

Cloud Run gives the API CPU only during a request, so work is driven by requests; every driver runs the same idempotent
pass (`VoucherDispersalProcessor.drain`: stale claims → reconcile pending (every ≥ 2 min/row) → send unsent messages →
buy QUEUED rows (300 ms apart, time-boxed) → mirror WhatsApp statuses → finish campaigns):

1. **`POST /campaigns/:id/process`** — the UI calls it while the campaign page is open (in-request, reliable):
   once after each refresh while the campaign is CONFIRMED / PROCESSING or within 30 min of `completedAt` (same
   backoff as polling, paused while the tab is hidden), single-flight per campaign per tab (`vdApi.process`), plus
   one call right after a successful confirm. 4xx are ignored quietly; ≥ 2 consecutive 5xx / network failures show a
   non-blocking note.
2. **`POST /v1/voucher-dispersal/drain`** — Cloud Scheduler (restart-proof). `@Public`, header `x-drain-secret` =
   a DEDICATED `VOUCHER_DISPERSAL_DRAIN_SECRET` (no fallback to another drain's secret — this endpoint spends money);
   fail-closed (403) when unset.
3. `@Interval(30 s)` per instance (best-effort; `VOUCHER_DISPERSAL_WORKER_ENABLED=false` turns it off).
4. A best-effort kick after confirm / retry.
5. The **Hubble webhook** (`/v1/hubble/webhook`) routes `vd<24 hex>` references to the dispersal reconcile (lookup only).

All state lives in the DB, so a restart loses nothing; every transition is a guarded `updateMany`.

## 6. WhatsApp

`voucher_code` template, vars `{{1}}` Name, `{{2}}` `₹N`, `{{3}}` programLabel, `{{4}}` brand label, `{{5}}` code (or
`code | PIN: pin`). **Claim-code products (2026-11-16, `api/src/hubble/hubble-voucher.ts`):** for Amazon Pay
(`01HDRPKWFE2SMVM54TWD8S1927`, default) Hubble's `cardPin` IS the redeemable claim code and `cardNumber` is a useless
serial → `{{5}}` = the claim code ALONE (no `| PIN:`). Same rule for Bajaj catalogue redemptions. Extend per environment
with env `HUBBLE_CLAIM_CODE_PRODUCT_IDS` (comma-separated product ids; no code change). A claim-code product that arrives
WITHOUT its claim code falls back to the card number AND is flagged loudly (error log + audit
`VOUCHER_DISPERSAL_CLAIM_CODE_MISSING` / redemption metadata `hubbleClaimCodeMissing`). Other brands (Flipkart, Ajio,
MakeMyTrip, Myntra, Uber) are unchanged: code + PIN when both exist. Sent via the new `NotificationsService.sendTrackedWhatsappTemplate` (receipt QUEUED → send with crqid →
SENT/FAILED; billing-safe; never throws). Receipt `clientId` is ALWAYS the platform tenant `'gifsy'` (coordinator decision
2026-11-16 — never the billed client: client admins must not see these phone numbers in their tenant delivery report nor
count them in tenant WhatsApp stats), `eventKey` = `VOUCHER_DISPERSAL`. Tracking requires `DELIVERY_RECEIPTS_ENABLED=true` (on in prod); when off, messages are `SENT`
(untracked). The row mirrors the receipt status so it survives the 90-day receipt retention.

Report (`report.xlsx`): all times in IST ("YYYY-MM-DD HH:mm", headers say "(IST)"); a phone-like value (digits, spaces,
`+ - ( ) .`) is printed as-is; every other text cell keeps the formula-injection guard (a leading `= + - @` gets a quote).

## 7. Audit (AuditLog)

Campaign (`entityType VOUCHER_DISPERSAL_CAMPAIGN`, actor = admin): CREATED, UPLOADED (counts), CONFIRMED, CANCELLED,
REPORT_DOWNLOADED, **EDITED** (`metadata.changes` + `oldValues` / `newValues` — shown as the page's Edit history),
**BATCH_UPLOADED / BATCH_CONFIRMED / BATCH_DISCARDED** (batch number + counts), STATUS (system: every COMPLETED / COMPLETED_WITH_ERRORS / re-open change). Row (`VOUCHER_DISPERSAL_ROW`): BOUGHT (masked code), BUY_FAILED, PENDING,
NO_ORDER_UNVERIFIED, MESSAGE_FAILED, SUPERSEDED_REFERENCE_ACTIVITY (system); RESENT, RETRY_BUY (+ outcome incl.
refusals) (actor = admin).

## 8. Runbook

- **Before first use on an environment:** apply the migration (in-VPC migrate job); confirm Hubble creds
  (`HUBBLE_CLIENT_ID/SECRET`) + `HUBBLE_WEBHOOK_SECRET`; `DELIVERY_RECEIPTS_ENABLED=true` + MSG91 callbacks for statuses;
  optionally `VOUCHER_DISPERSAL_BRANDS`.
- **Drain secret (owner infra, one-time per env):** create Secret Manager secret `VOUCHER_DISPERSAL_DRAIN_SECRET`
  (staging: `VOUCHER_DISPERSAL_DRAIN_SECRET_STAGING`), bind it to the API service as env `VOUCHER_DISPERSAL_DRAIN_SECRET`
  (deploy workflow `--set-secrets` + the prod secrets preflight list). Until it exists the drain answers 403 (fail-closed).
- **Cloud Scheduler (owner infra, one-time per env):** job `voucher-dispersal-drain`, every 2 min, `POST
  https://<api-host>/v1/voucher-dispersal/drain` with header `x-drain-secret: <that secret>`. Without it, campaigns still
  progress while the admin keeps the page open (process endpoint) and on the timer while CPU is available.
- **A row stuck PENDING_RECONCILE:** it is looked up automatically every 2 min. After 2 h the admin may Retry; a refusal
  states why (Hubble unreachable / "no order" unverified). Check Hubble's dashboard for the reference before forcing
  anything; never edit rows by SQL.
- **Superseded-reference alert:** look up both references at Hubble; if two vouchers exist, recover the extra one with Hubble.
- **Deploying migration `20261118160000_voucher_dispersal_batches` (prod):** deploy during a quiet window (no campaign
  being bought). Order: (1) **pause the drain** — pause the Cloud Scheduler job `voucher-dispersal-drain-prod` (and/or set
  `VOUCHER_DISPERSAL_WORKER_ENABLED=false` on the API service so the 30 s timer stops); (2) run `npx prisma migrate deploy`
  (in-VPC migrate job); (3) deploy the new API revision; (4) **resume** the scheduler job / unset the flag. The migration
  sets `SET lock_timeout = '5s'` (a plain session SET, `RESET` at the end of the file): it waits at most 5 s for its
  locks, and queries queued behind it wait at most that long (≤ 5 s).
- **Why not `SET LOCAL`:** Prisma sends migration statements outside a transaction block, so `SET LOCAL` is ignored —
  verified 2026-11-18: Postgres logged "SET LOCAL can only be used in transaction blocks" when staging applied
  `20261118130000_sales_day_order_index` (whose 10 s limit therefore did not apply; harmless there — new, small table).
- **If it fails on `lock_timeout`** (P3018 on the run; afterwards `migrate deploy` refuses with P3009 — a failed migration
  is recorded): the statements are NOT one transaction (above), so the ones before the failing statement may already be
  applied — that is fine: the file is **re-runnable** (every statement is idempotent: the enum and the foreign key in
  guarded `DO` blocks, `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE / INDEX IF NOT EXISTS`, `DROP INDEX IF EXISTS`; the wide
  unique index is still created before the old one is dropped). **No clean-up step.** Recover with exactly
  `npx prisma migrate resolve --rolled-back 20261118160000_voucher_dispersal_batches` (in the in-VPC migrate job), then
  re-run `npx prisma migrate deploy` in a quieter window (drain paused, as above).
- **Lock contention during that deploy:** the new indexes are built on `voucher_dispersal_rows`; if a large batch upload /
  confirm (thousands of rows) is running, the build can wait past the 5 s `lock_timeout` and fail. Deploy with the drain
  PAUSED and **no admin uploads / confirms in progress**; if it still fails, recovery is as above (resolve
  `--rolled-back` + re-run — the file is re-runnable).
- **Verification of the re-runnable file (2026-11-18):** compared statement-by-statement with Prisma's own SQL for
  base schema (`ab1dbbbb`) → current `schema.prisma` (`prisma migrate diff --from-schema … --to-schema … --script`, the
  idempotency wrappers stripped): 17 = 17 statements (re-verified after the alert columns / indexes of §10d and §10f), none
  missing or extra. NOT yet run against a database (no shadow /
  scratch DB was used) — before prod, apply it TWICE to a local / throwaway database and confirm the second run is clean.
- **This migration must NOT have been applied anywhere under its earlier contents.** `20261118160000_voucher_dispersal_batches`
  was edited several times before release (columns / indexes added, re-runnable rewrite); Prisma checks the file's
  checksum. Before deploying, confirm `_prisma_migrations` on staging AND prod has no row for it (the coordinator checks
  this before deploy). If one exists, stop — do not edit or re-apply; ask engineering.
- **Edited in place — reset, don't re-run, any database that ran an earlier version.** The file was changed after it
  may have been applied to a LOCAL dev database (e.g. the order-alert columns `resolvedAt` / `lastCheckFailedAt` /
  `statusChangedAt` / `noOrderUnverifiedAt` were added to its `CREATE TABLE IF NOT EXISTS`, which an existing table
  silently skips). Such a
  database must be RESET (`npx prisma migrate reset` on local dev), never re-run with `migrate deploy` / `resolve` —
  a re-run would leave the old table without the new columns.
- **Old/new revision overlap during that deploy:** for the minutes both API revisions serve traffic, the OLD revision
  does not know about batches and would count an unconfirmed batch's rows in its list summary — harmless, because no
  batch can exist until the new revision is serving (only it can create one).

## 9. Open questions

- **Q1 Flipkart prod id** — default registry assumes the same product id as staging; prod "Load from Hubble" earlier
  reported Flipkart as FIXED on prod. Recommendation: verify with `GET /brands` on prod before the first campaign.
- **Q2 Reference reuse after FAILED** — we mint a new reference for a Hubble-FAILED row (old kept). Recommendation: confirm
  with Hubble whether a failed reference can be re-placed; if it can, switch to always-same-reference.
- **Q3 Scheduler** — creating the drain job is an owner infra step (§8).

## 10. Edit + "Add more people" batches (owner-approved 2026-11-18)

Owner's words: *"I should be able to click on [a campaign], do something about it. If the campaign needs to be
extended, I should be able to edit the budget and again upload files. I should be able to download Excel reports anytime
I want."* Owner chose **"Add to the same campaign"**.

- **List:** the whole card is one real link (the title, stretched over the card — keyboard focusable; the per-card
  "Download Excel" button and "Continue setup" link sit above it, never nested). Setup cards go to Continue setup.
  A card with an unconfirmed batch says "Batch N is waiting for confirmation — nothing in it has been bought."
- **Edit campaign** (detail page → dialog): name; budget up, or down to the **floor = Σ BUYING + PENDING_RECONCILE +
  BOUGHT + BUY_FAILED-with-reference-at-Hubble + QUEUED** (the buy engine's `budgetCommittedWhere` + queued), computed
  under the campaign row lock. Not on a CANCELLED campaign. Audited; listed under "Edit history" (who, when, old → new).
  Allowed in setup too (floor 0).
- **Batches:** batch 1 = the first file (its fields stay on the campaign; no batch record). "Add more people" is open only
  on **COMPLETED / COMPLETED_WITH_ERRORS with nothing QUEUED / BUYING / PENDING_RECONCILE** — otherwise the server's
  reason is shown ("still being bought — you can add more people once every purchase has finished"). One batch waits at a
  time; re-uploading replaces it. Same parser / validation as the first file. A phone with a **live** row in an earlier
  batch (QUEUED / BUYING / PENDING_RECONCILE / BOUGHT / BUY_FAILED) → DUPLICATE "Already sent in batch N" (or "Already in
  batch N, where its purchase failed — use Retry on that row instead"); a dead earlier row (INVALID / DUPLICATE /
  CANCELLED) gives its one-voucher key up to the new row. Confirm (under the campaign lock): preview id + numbers must
  match; **floor + this batch ≤ budget**, else 400 "Raise the budget (Edit campaign)…"; batch PREVIEWED→CONFIRMED by a
  conditional update; its VALID rows → QUEUED; campaign → PROCESSING; the existing processor buys them and
  `settleCampaign` re-settles COMPLETED ↔ COMPLETED_WITH_ERRORS over all batches. Idempotent per batch (a repeated /
  racing confirm with the confirmed preview id returns the campaign). **Discard** deletes an unconfirmed batch's rows
  (never sent to Hubble) and keeps the batch listed as DISCARDED.
- **Until confirmed** a batch's rows are in no total (detail summary, list summary, report, default rows list) and never
  in the buy queue (VALID is not a buy status).
- **Cancel:** QUEUED rows of every batch → CANCELLED; BUYING / PENDING rows keep reconciling; BOUGHT rows (any batch)
  stay; an unconfirmed batch is discarded ("Campaign cancelled before this batch was confirmed"). A finished campaign is
  not cancellable (nothing to stop) — its waiting batch is removed with Discard.
- **Report:** Batch + Source file columns, every confirmed batch, ordered batch → row.
- **Consumers traced:** processor (buys ordered campaign → batch → row; settle doc), Hubble webhook (by reference —
  unaffected), WhatsApp status mirror (receipt → row — unaffected), Daily Ops Digest (row-based counts on statuses /
  row timestamps — never the campaign status, never VALID rows → a campaign re-opened by a batch is not double-counted;
  regression spec added), UI contract fixture + platform contract test (new endpoints).

### 10a. Money-audit round (2026-11-18, two independent audits of `bc6a54ab` — no overspend / double-buy found)

- **One "can still cost money" definition** (`mayStillCostWhere` / `budgetBreakdown`, processor): spent (BOUGHT) ·
  with Hubble, not yet confirmed (BUYING + PENDING_RECONCILE) · failed purchases Hubble may still complete (BUY_FAILED
  whose current reference reached Hubble) · queued. The budget floor (Edit), batch confirm, the retry check and the
  detail page's "Budget used" line all use it; the claim-time guard is the same minus QUEUED (the claimed row is the
  queued amount it adds). Refusals name each part — never "in progress" for failed rows.
- **Owner decision 2026-11-18 — release REJECTED only:** a BUY_FAILED row whose `buyFailureSource` is `REJECTED`
  (Hubble refused the order — definitive 400/422 — AND the canary verified Hubble holds no order) no longer counts:
  it is out of `failedMayStillCompleteWhere`, so it is out of the floor, batch confirm, the retry check, the "Budget
  used" line, a batch preview's "left", and the claim-time guard (`budgetCommittedWhere`). `HUBBLE_FAILED` (Hubble's own
  FAILED body) KEEPS counting while its reference reached Hubble — `applyBody` still delivers a later SUCCESS for it
  (earlier audit decision "BUYING M1" stands for it). Local failures (`BUDGET` / `NOT_SENT`) count only if their reference
  reached Hubble on an earlier attempt, as before. Specs: `voucher-dispersal.rereview.spec.ts` (6 bought + 4 REJECTED →
  floor ₹6,000, a 4 × ₹1,000 batch confirms and is bought; 6 bought + 4 HUBBLE_FAILED → floor ₹10,000, refused).
- **Retry vs promised budget:** a retry is refused under the campaign lock when everything else that can still cost
  money (the row itself excluded — it may already be counted) + the row > budget: "Retrying needs ₹X; only ₹Y is left
  after queued rows and purchases already made or with Hubble — raise the budget (Edit campaign), then retry." Audited
  `REFUSED_BUDGET`.
- **Upload outside the lock:** parsing, live Hubble limits, warnings and the cross-batch duplicate lookup run before the
  campaign row lock; the locked transaction (20 s) re-checks the batch state and the duplicate set (rebuilds if it
  changed) and writes.
- **Audits in the transaction:** edit, batch upload / confirm / discard write their AuditLog row inside the same
  transaction — a failed audit write rolls the change back.
- **Batch notes kept:** `VoucherDispersalBatch.skippedBlankRows / skippedFormulaRows / hiddenRowsIncluded` (same
  migration — not yet deployed anywhere); a reopened waiting batch shows the same skipped / hidden notes; the upload
  audit carries warningCount / skippedRows / hiddenRowsIncluded like the first file's.
- **Wording:** first-file over budget → "Remove rows, or Edit campaign to raise the budget."
- **Bounds:** `:n` and `?batch=` accept 1..100,000 — anything else is a 400.
- **Re-review fixes (2026-11-18):** budget boxes keep what was typed and parse it strictly — a leading ₹ is fine, commas
  only in a real Indian (1,25,000) or Western (1,250,000) grouping ("25,00" is refused with a clear message), the decimal
  point is kept (paise refused); `PATCH {name:null}` / `{budgetRupees:null}` → 400; the detail reply's old
  `summary.committedRupees` is removed (`budgetUsage` is the one breakdown); every campaign-lock transaction (edit, first
  upload, confirm, batch upload / confirm / discard, cancel, buy claim, retry re-queue, settle) uses `CAMPAIGN_LOCK_TX`
  (timeout 30 s; maxWait later cut to 5 s — see below) and `finishCampaigns` logs one campaign's settle error and moves on; confirm reports a
  changed preview before the budget; notices say "Batch 2, row 5"; the add page replaces Buy & send with the server's
  reason when the campaign cannot take people (e.g. a retry re-opened it).
- **Final review fixes (2026-11-18):** H1 — a row that had FAILED (any source) and that Hubble later reports bought or
  processing is audited loudly (`VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER`: campaign, batch, row, ₹, source) with an
  error log; if what can still cost money then exceeds the budget, `VOUCHER_DISPERSAL_OVER_BUDGET` + error log, and the
  campaign page shows "Over budget by ₹X — a purchase was bought later by Hubble after it had failed/refused." (detail
  `summary.overBudgetRupees` / `lateCompletedRows`). H2 — consecutive settle failures are counted on the campaign
  (`settleFailures`, `settleError`; reset on success); at 3 an audit row `VOUCHER_DISPERSAL_SETTLE_FAILING`, the views
  expose `settleError`, the page shows "Status update keeps failing — contact Gifsy tech." and "Add more people" says
  so. M1 — a webhook / sweep / retry lookup that changes a row re-settles its campaign (terminal ones too). M2 — a batch
  preview's "left" is never negative (`overBudgetRupees` instead). L1 — "1e5" / "0x10" / non-ASCII digits → "Enter
  digits only"; a minus → "greater than 0". L2 — `CAMPAIGN_LOCK_TX` = timeout 30 s (incl. the row-lock wait), maxWait
  5 s (pool wait). L3 — `finishCampaigns` settles the longest-waiting campaigns first.
- **Last review fixes (2026-11-18):** H1 — the drain also re-settles campaigns with settle failures (any status) and
  finished campaigns with rows back in flight, so a finished campaign is never blocked forever. H2 — a settle failure is
  counted with one atomic `UPDATE … RETURNING`; the alert fires once when the count crosses 3 (old < 3 ≤ new). M1 —
  "over budget" = spent + with Hubble + failed-may-complete − budget (QUEUED is not spending); queued vouchers that no
  longer fit are shown apart ("₹X of queued vouchers can't be bought within the budget", `summary.queuedAtRiskRupees`).
  M2 — the late event is decided by a guarded write from BUY_FAILED (fires once) and marks the row `lateCompletedAt`;
  `lateCompletedRows` counts those rows (no audit-log JSON scan). M3 — the Edit dialog checks the floor only when the
  budget is lowered (rename / partial raise always allowed). M4 — an unrecognised Hubble status on a FAILED row writes
  `VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW` + an error log and leaves the row. L1 — a lookup that changes nothing
  on a failed row (`UNCHANGED`) keeps its `updatedAt` and does not re-settle. L2 — the webhook / retry-lookup re-settle
  uses `WEBHOOK_SETTLE_TX` (3 s) and, on failure, is left to the drain without counting as a settle failure. L3 — batch
  confirm refuses with the settle-failing reason like the upload. L4 — the Daily Ops Digest's voucher-dispersal block
  lists campaigns over budget, campaigns whose status update keeps failing, and purchases bought later after failing (pre-merge wording) in the
  window (each a "needs attention" line; sample HTML regenerated).
- **Pre-merge review fixes (2026-11-18):** M-1 — a retry whose Hubble lookup returns a status we do not recognise is
  refused honestly (409 "Hubble reports this order as X — it was not bought. Contact Gifsy tech before retrying."), audit
  `REFUSED_UNRECOGNISED_HUBBLE_STATUS`; the anomaly audit stays. M-2 — the anomaly is logged / audited once per status
  (not every 2-min sweep). **L-1 meaning (coordinator decision): "completed later" = Hubble BOUGHT a row that had FAILED /
  been refused** — `lateCompletedAt` + `VOUCHER_DISPERSAL_FAILED_ROW_COMPLETED_LATER` only on BOUGHT, once (`lateCompletedAt
  IS NULL`); a failed → processing flip writes `VOUCHER_DISPERSAL_FAILED_ROW_PENDING_AGAIN` (informational, keeps
  `buyFailureSource` so the later BOUGHT is recognised) and does not count; a retry with a new reference clears it. Wording
  everywhere: "bought later by Hubble after it had failed/refused"; the digest's over-budget line is neutral ("spending is
  over the budget; see the campaign's budget breakdown"). L-2 — the `updatedAt` restore is guarded on the state read
  earlier. L-4 — the settle loop stops at the drain deadline; the failure counter is updated in a 3 s transaction. L-5 —
  the "finished but in flight" grouping only looks at COMPLETED / COMPLETED_WITH_ERRORS campaigns; new index
  `voucher_dispersal_rows_lateCompletedAt_idx` (same migration, idempotent). L-6 — runbook: no uploads during the deploy.

### 10b. Owner decisions — only Hubble's documented statuses; "Mark as not bought" is FINAL; earlier-order alerts (2026-11-18, simplified)

- **Hubble documents only SUCCESS / PROCESSING / FAILED** (`HUBBLE_KNOWN_STATUSES`). CANCELLED / RETURNED are OUR
  redemption status names (rewards module), not Hubble's. **Any undocumented status takes the single safe path:** never
  applied; the budget STAYS reserved (a `HUBBLE_FAILED` / local-failure row keeps counting; a pending row stays pending
  with `HUBBLE_UNKNOWN_STATUS:X`; a `REJECTED` row goes BACK to pending — reserved again — since Hubble now holds an order
  for it); error log + anomaly audit `VOUCHER_DISPERSAL_UNKNOWN_STATUS_ON_FAILED_ROW` once per status; **Retry is refused**
  (honest 409 — "we cannot tell whether it was bought … use Mark as not bought") and hidden on the page (reason shown).
- **Mark as not bought is FINAL** (owner: simplify): GIFSY_ADMIN only, confirmation dialog, reason required, audited
  `VOUCHER_DISPERSAL_MARKED_NOT_BOUGHT` in the same transaction, idempotent (a repeat returns the row). The row → BUY_FAILED
  `MARKED_NOT_BOUGHT` = **closed**: released from the budget (`NOT_BOUGHT_FAILURE_SOURCES` = `REJECTED`,
  `MARKED_NOT_BOUGHT`), never looked up again, never retried (Retry is not offered; the endpoint answers 409), and a webhook
  never changes it (activity is alerted instead — below). The page says "Marked as not bought by <admin> — closed. Arrange
  any replacement with Hubble outside this campaign."; the report's "Failure reason" says "Marked as not bought by
  <admin>: <reason>".
- **A new reference is issued only** when Hubble definitively says the old order FAILED, or a canary-verified "no order"
  (the pre-existing retry rules for `HUBBLE_FAILED` / `REJECTED` / local failures, §4). Any other answer → refused.
- **Earlier-order alerts (loud, NOT counted):** a webhook reporting SUCCESS / PROCESSING / an undocumented status on an
  EARLIER (retired) reference of a row — or on the reference of a row marked not bought — is looked up and alerted: error
  log + a CAMPAIGN audit row (`VOUCHER_DISPERSAL_SUPERSEDED_REFERENCE_ACTIVITY`, indexed by campaign) once per reference +
  status. The campaign page shows the OPEN total and the latest 20, worded per kind and real status (§10d). The Daily Ops
  Digest has lines for the alerts created or worsened in its window. They never change a row and never enter any budget
  figure. FAILED / no order on an earlier reference creates nothing — and RESOLVES an existing alert (§10d).
- **Withdrawn** (final review of `2d1e34e5`): the "superseded spend" counting, the hourly re-check sweep of earlier
  references, and "retry after a mark → new reference" — together with the `supersededActiveRefs` / `supersededCheckedAt`
  columns (removed from the still-unapplied migration; re-verified 10 = 10 statements against Prisma's SQL).
- **Drain time caps:** the reconcile / message steps are skipped once the pass deadline has passed; settles past the
  deadline continue only within a 5 s grace (touched campaigns first, then a minimum of 5); touched campaigns a pass could
  not settle are carried over to the next pass on that instance.
- **F3** — every drain pass keeps the last min(10 s, ¼ of the pass) for settling: buying stops early; campaigns touched in
  the pass are always settled, plus at least 5 of the others even past the deadline (the rest next pass). **F5** — the
  over-budget banner states its actual causes from the server's counts ("N purchases were bought later by Hubble after they
  had failed/refused" / "N failed purchases are back with Hubble and count again"), else a neutral "spending is above the
  budget; see Budget used". **F6** — the BOUGHT audit's `fromStatus` is the real previous status (one guarded write per
  possible state).

### 10c. Review of `e0513abc` (2026-11-18)

- **Closed means closed (M1):** every write guarded on `status = BUY_FAILED` (buy-apply, back-to-pending, retry re-queue)
  also excludes `buyFailureSource = MARKED_NOT_BOUGHT` (`NOT_MARKED`), so a webhook / sweep / retry lookup racing a mark can
  never buy or move the row — it falls through to an alert. All wording says the mark closes the row for good (no "retry
  after a mark" anywhere).
- **Earlier-order alerts live in their own table** `voucher_dispersal_order_alerts` (same unapplied migration, idempotent):
  ONE alert per (campaign, reference) — the unique key makes the dedupe race-safe; a later status updates the same alert
  (`statusHistory`) and is never a second count (L1; update rules superseded by §10d). Kinds: `SUPERSEDED` (an earlier, retired reference), `MARKED_NOT_BOUGHT`
  (the reference of a row marked not bought), `NOT_APPLIED` (a Hubble SUCCESS that could not be stored on the row — M3).
  Status `LOOKUP_FAILED` = we could not check it ("couldn't check an earlier order — check with Hubble"; M2). Page: total
  count + latest 20 (per-status wording); digest: alerts first raised in the window, in the "In window" line (L2). Never
  counted against the budget. Each new alert / status change also writes a campaign audit row + an error log.
- ~~The webhook answers 503 when dispersal processing failed (M2)~~ — **REVERTED** in §10d (M3): always 200.
- **Alerts rely on Hubble webhooks (L3):** by owner decision there is NO sweep re-checking earlier references; an earlier
  order is only looked up when Hubble calls the webhook for it (a missed / never-sent webhook means no alert).
- **The "unrecognised" marker clears (M4):** the LATEST lookup decides — a later documented answer (or "no order yet")
  makes `canMarkNotBought` false again and Retry follows the normal rules; a pending row's `HUBBLE_UNKNOWN_STATUS:X` reason
  becomes `NO_ORDER_AT_HUBBLE_YET` when Hubble later has no order.
- **Digest (M4 / L4 / L2):** rows marked not bought are reported as "closed (marked not bought)" (informational) and are
  NOT in "purchase failed" / "purchase still failed"; pending rows with an undocumented Hubble status are their own line
  ("needs Gifsy tech") and are NOT in "unconfirmed > 2 h (Retry available)".
- Migration re-verified at the time: 14 = 14 statements (now 17 = 17 — §10d, §10f).

### 10d. Review of `4d8454ad` — the alert subsystem (2026-11-18)

- **The webhook ALWAYS answers 200 for dispersal processing (M3, reverts §10c M2):** `/v1/hubble/webhook` also carries
  the live rewards / gift webhooks of every tenant (incl. Deoleo), and Hubble's retry / auto-disable policy for non-2xx
  answers is unverified — so no 5xx. A failed lookup answers `{ ok: true, reconciled: false, outcome:
  "DISPERSAL_LOOKUP_FAILED" }` and is RECORDED on the alert ("couldn't check" / last check failed); a processing error
  answers `{ ok: true, reconciled: false }` with an error log. Current references are re-checked by the 2-minute reconcile
  sweep; an EARLIER reference is only looked up again when Hubble calls the webhook for it (§10c L3).
- **The strongest REAL status is kept (H1):** SUCCESS > an unrecognised status > PROCESSING. A lookup failure never
  overwrites a real status — it only sets `lastCheckFailedAt` and adds `LOOKUP_FAILED` to the history (no audit; a warn
  log). An alert whose ONLY report is a lookup failure shows `LOOKUP_FAILED` ("couldn't check it with Hubble — the lookup
  failed; no status known yet"). A lower status after a higher one (SUCCESS then PROCESSING) is kept in the history only.
- **FAILED / no order RESOLVES an alert (H2 — narrowed by §10e: only when nothing stronger than PROCESSING was ever seen,
  and "no order" needs a verified canary):** `resolvedAt` + status + history + audit (`resolved: true`); resolved
  alerts are excluded from the open count and listed apart on the page ("N resolved order alerts — nothing to do", each
  "resolved: Hubble confirmed the order failed / there is no order"). They never create an alert. Activity reported later
  re-opens it (counted as worsened). A lookup failure on a resolved alert keeps it resolved.
- **Created OR worsened (M1):** `statusChangedAt` moves only when the alert is created or gets worse (status moved up to
  SUCCESS / PROCESSING / an unrecognised status, or re-opened). The digest counts OPEN alerts created or worsened in its
  window, by kind (below), and the alerts resolved in the window apart. New columns `resolvedAt`, `lastCheckFailedAt`,
  `statusChangedAt` + indexes on `statusChangedAt` and `resolvedAt` — in the same unapplied, idempotent migration.
- **No lost update (M2):** an alert update runs in a short transaction (`ALERT_UPDATE_TX`, 5 s) that LOCKS the alert row
  first (an `updatedAt` touch = a Postgres row lock), then reads and merges under the lock — a concurrent report waits and
  sees the committed state. Nothing is conditional on the old status any more. (The spec races two reports with the fake's
  serialised transactions, the in-memory model of that row lock.) Any skip is logged.
- **Wording per kind / status (M4, L3):** `SUPERSEDED` = "an earlier order (retired by a retry)" — a voucher may have been
  issued twice; `MARKED_NOT_BOUGHT` = "the order of this row (marked not bought)" — the row stays closed; `NOT_APPLIED` =
  "this row's current order — Hubble reports it completed, but it could not be applied to the row" — a paid voucher may
  not have reached the person. The page shows the real status + the full history ("reports: PROCESSING → SUCCESS") and,
  when the last check failed, "The last check with Hubble failed (time) — Hubble may have reported more since." A
  `NOT_APPLIED` alert whose reference later turns out superseded becomes `SUPERSEDED` (never back).
- **L1:** only the unique violation (`P2002`) means "already alerted"; any other error → error log "could NOT record the
  order alert", returned as not recorded. **L2:** history deduped (consecutive) and capped at the latest 20
  (`ALERT_HISTORY_CAP`); audits / error logs only on real changes (created, worsened, resolved, kind upgraded).
- **L4:** a SUCCESS that cannot be applied because the row is now QUEUED / BUYING with the SAME reference is not an alert
  (the next buy / lookup of that reference applies it) — a warn log only.
- **L7:** rows marked "not bought" are counted as `markedClosed` ("Closed (marked not bought)" tile on the campaign page
  and the list card, "Closed" column per batch), not in "Buy failed" — the same as the digest.
- **L8:** the digest's "Hubble status not recognised" also counts FAILED rows (not marked) whose LATEST lookup was an
  undocumented status (the campaign page's `lastLookupUnrecognised` rule), besides pending rows with `HUBBLE_UNKNOWN_STATUS`.
- Migration re-verified at the time: **16 = 16** (now 17 = 17 — §10f) statements against `prisma migrate diff` (base `ab1dbbbb` → current schema); SET
  `lock_timeout` first, RESET last; the widened unique index is still created before the narrower one is dropped.

### 10e. Release-gate review of `e63d928a` (2026-11-18) — nothing may hide a paid voucher

- **H1 — an alert that ever saw SUCCESS / an unrecognised status is NEVER resolved.** FAILED / no order on it only adds a
  history entry + an error log + audit (`contradictedBy`), and the page adds "Hubble now says the order failed / there is
  no order — this contradicts its earlier report, so the alert stays open". An alert that saw at most PROCESSING (or only
  "couldn't check") is resolved by FAILED, or by "no order" ONLY with a verified canary (`verifyNotFoundCanary`, the buy
  engine's rule, max 3 tries / 10 s) — an unverified "no order" keeps it open (history `NO_ORDER_UNVERIFIED`, shown
  "no order (unverified)"). §10f: the canary is never run in the webhook — the sweep runs it.
- **H2 — a failed webhook lookup on a FAILED row's CURRENT reference** (`HUBBLE_FAILED` / `REJECTED`): the webhook still
  acks 200, records a `NOT_APPLIED` "couldn't check" alert, and the 2-minute sweep re-checks those rows (last lookup
  `LOOKUP_FAILED…`, at most `RECHECK_AFTER_LOOKUP_FAILURE_PER_PASS` = 5 per pass, besides the 20 pending rows) until Hubble
  answers. The answer settles the alert: bought / back with Hubble → resolved `APPLIED` ("Hubble's answer was applied to
  the row"); FAILED → resolved; "no order" → the canary rule; an unrecognised status → open. (The webhook controller's
  comment now says exactly which references the sweep re-checks.)
- **H3 — a webhook for a CANCELLED row** (any status other than BUYING / PENDING_RECONCILE / BUY_FAILED, BOUGHT and
  QUEUED): looked up; SUCCESS / PROCESSING / an unrecognised status → a `NOT_APPLIED` alert (error log "order completed at
  Hubble after the campaign was cancelled — check with Hubble", audit with `rowStatus`); FAILED / no order → nothing; a
  lookup error → a "couldn't check" alert. Never silently SKIPPED. BOUGHT (its own order) and QUEUED (the next buy applies
  the same reference) are not looked up. Cancelled rows are not swept — the alert stays open.
- **Digest "still open":** besides the in-window lines, every OPEN alert of any age is one attention item each day
  ("still open: N order alerts (… earlier order, … marked row, … order not applied, … couldn't check)") and a "Right now"
  figure, until resolved.
- **Settle:** rows marked "not bought" are closed, not errors — a campaign whose only non-bought rows are marked settles
  `COMPLETED`, not `COMPLETED_WITH_ERRORS`.
- **Noted for follow-up:** ~~a marked row can get a second identical alert entry for the same status~~ — **fixed
  2026-11-19 (§10g)**; webhook latency (a webhook runs one Hubble lookup inline — the canary moved to the sweep, §10f) —
  still open.

### 10f. Release gate on `b587d42c` — four mediums (2026-11-18)

- **M1 — no canary inside the webhook request.** A webhook does at most ONE Hubble lookup. A "no order" there is recorded as
  `__NO_ORDER_UNVERIFIED` (alert open; `noOrderUnverifiedAt` set when the alert could be resolved). The 2-minute sweep
  (`recheckUnverifiedNoOrderAlerts`, max 5 alerts per pass, backing off by the alert's `updatedAt`) looks the reference up
  again; still no order → `verifyNotFoundCanary` → resolved `__NO_ORDER` only when verified, else still open. A FAILED row's
  own alert is left to the row re-check (below). New column `noOrderUnverifiedAt` + index (same unapplied, idempotent
  migration — 17 = 17 statements vs `prisma migrate diff`).
- **M2 — our labels can't collide with Hubble's.** Our alert labels are prefixed: `__LOOKUP_FAILED` ("couldn't check"),
  `__NO_ORDER` ("no order"), `__NO_ORDER_UNVERIFIED` ("no order (unverified)"), `__APPLIED` ("applied to the row"). A raw
  Hubble status is stored via `hubbleAlertStatus` (upper-cased, leading `_` stripped, never empty) and only ever compared
  with the documented SUCCESS / PROCESSING / FAILED — a Hubble status reading "APPLIED", "NO_ORDER" or "LOOKUP_FAILED" is
  an UNRECOGNISED status (worsens the alert, never resolves it, never sets `lastCheckFailedAt`). The page maps our labels to
  words and shows raw statuses as "a status we do not recognise ("X")"; the digest counts only `__LOOKUP_FAILED` as
  "couldn't check".
- **M3 — an unverified no-order keeps a FAILED row in the sweep.** For a `HUBBLE_FAILED` / `REJECTED` row being re-checked
  (last result `LOOKUP_FAILED…`), a "no order" is definitive only with a verified canary (run by the sweep, never the
  webhook). Unverified → the row's `lastReconcileResult` becomes `NO_ORDER_UNVERIFIED_RECHECK` (so `noteReconcile` never
  drops it out of the sweep) and its alert reads "no order (unverified)" (`__NO_ORDER_UNVERIFIED`) until the canary verifies
  (→ `NO_ORDER_AT_HUBBLE_YET`, alert resolved) or Hubble reports something else.
- **M4 — the list shows open alerts.** `summary.openOrderAlerts` on each list item; the card shows a red badge "N open
  order alerts — check with Hubble (see the campaign)", also for a COMPLETED campaign.
- **Digest:** open / in-window alerts split also counts `noOrderUnverified` ("no order (unverified)" — kept open, re-checked
  automatically).

### 10g. Follow-ups from the 2026-11-19 release — alert entry + alert kind (branch `fix/release-followups`)

- **No duplicate alert entry.** A Hubble SUCCESS that could not be applied to a row (a superseded reference, or a row
  marked "not bought" read from a stale snapshot) used to write a row-level audit with the alert event on EVERY report,
  in addition to the campaign alert's own audit. A repeat of the same SUCCESS therefore produced a second identical
  entry, even though the alert itself was deduped. Now only the campaign alert audit is written, and only on a real change.
  It carries Hubble's order id, the row status and whether the reference was superseded. The error log still fires on
  every report.
- **The alert kind follows a later mark.** An alert's kind only moves up: `NOT_APPLIED` → `MARKED_NOT_BOUGHT` →
  `SUPERSEDED`. A report of a higher kind upgrades the alert; a lower one never downgrades it. **Mark as not bought**
  also upgrades, in the same transaction, any `NOT_APPLIED` alert on the row's current reference, with one campaign
  audit carrying `previousKind`. This covers, for example, a "couldn't check" or unrecognised-status alert on a failed
  row. Afterwards the page, digest and logs say "the order of this row (marked not bought) — the row stays closed"
  instead of "could not be applied to the row". The alert's status, history and open state are unchanged.
