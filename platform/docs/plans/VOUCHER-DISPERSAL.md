# Voucher Dispersal — design, API contract, runbook, safety rules

Owner-approved 2026-11-16. **Money code**: every confirmed row spends real money on the platform Hubble account.
Branch `feat/vd-api` (server) + `feat/vd-ui` (screens).

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
  the brief's `@@unique([campaignId, phone])` made workable — a DUPLICATE row must still be stored and shown.

## 3. API contract (`/v1/admin/voucher-dispersal`, GIFSY_ADMIN, `{ success, data }` envelope; errors `{ success:false, error }`)

| Method + path | Body / query | Returns |
|---|---|---|
| `GET /brands` | — | `[{ key, label, productId, minAmount, maxAmount, denominations \| null, denominationType, available, unavailableReason }]` — limits read LIVE from Hubble (never hard-coded) |
| `GET /template.xlsx` | — | template (Recipients sheet, Brand dropdown, Phone as text, Instructions sheet with each brand's live amount rule) |
| `POST /campaigns` | `{ name, programLabel, billedToClientId?, note?, budgetRupees }` | campaign (DRAFT) |
| `POST /campaigns/:id/upload` | multipart `file` (.xlsx) | `{ previewId, campaign, rows:[{rowNumber, phone, name, amount, brand, brandKey, note, status, invalidReason, warning}], summary:{ total, valid, invalid, duplicates, totalRupees, budgetRupees, overBudget, perBrand:[{brandKey, brand, count, totalRupees}], warningCount, skippedBlankRows, skippedFormulaRows, skippedNote, hiddenRowsIncluded, hiddenNote } }` — re-upload replaces rows while DRAFT/PREVIEWED; every upload gets a NEW `previewId` |
| `POST /campaigns/:id/confirm` | `{ previewId, expectedValidCount, expectedTotalRupees }` | campaign. Refuses: Hubble not configured (503), 0 valid / over budget (400), previewId not current or numbers changed (409). **Idempotent**: repeating a confirm with the already-confirmed previewId returns the campaign (200) — nothing queued or bought again |
| `POST /campaigns/:id/process` | — | `{ pass, campaign, hubbleConfigured, summary }` — a bounded in-request processing pass (≤ 25 s, ≤ 25 buys). *Addition to the brief* — see §5 |
| `GET /campaigns` | `?page=` (50 per page) | `[{ ...campaign, summary:{ total, valid, invalid, duplicates, queued, pending, bought, buyFailed, cancelled, spentRupees } }]` newest first |
| `GET /campaigns/:id` | — | `{ campaign, hubbleConfigured, summary:{ total, valid, invalid, duplicates, totalRupees, budgetRupees, overBudget, perBrand, queued, buying, pendingReconcile, pending, bought, buyFailed, cancelled, spentRupees, committedRupees, messageSent, delivered, read, messageFailed, messageNotSent } }` |
| `GET /campaigns/:id/rows` | `?status=&page=` (100 per page) | `{ rows, total, page, pageSize }` |
| `GET /campaigns/:id/report.xlsx` | — | Row, Phone, Name, Amount, Brand, Voucher status, Hubble order ref, Bought at, Failure reason, WhatsApp status, Sent at, Delivered at, Read at, Message failure reason (**no codes**) |
| `POST /campaigns/:id/rows/:rowId/resend` | — | row — re-sends the WhatsApp for a BOUGHT row (new receipt); never buys; only after the first send has an outcome; max 3 per row |
| `POST /campaigns/:id/rows/:rowId/retry-buy` | — | `{ message, row }` — rules in §4; idempotent |
| `POST /campaigns/:id/cancel` | — | `{ campaign, cancelledRows, stillWithHubble, alreadyBought }` |

**Campaign fields:** id, name, programLabel, billedToClient `{id, name} | null` (id = `Client.id`, the same `id`/`slug`
`GET /v1/gifsy/clients` returns), note, budgetRupees, status, sourceFileName, previewId (only while PREVIEWED), uploadedAt,
createdById/At, confirmedById/At, cancelledById/At, **completedAt** (set on COMPLETED / COMPLETED_WITH_ERRORS),
updatedAt, **canCancel**.

**Row fields:** id, rowNumber, phone, name, amount, brand, brandKey, note, status, invalidReason, pendingReason,
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
   reached Hubble — `referenceSentAt` set) + this row ≤ budget, else BUY_FAILED `BUDGET`. A failed row whose reference
   reached Hubble keeps counting (Hubble may still complete it); a retry releases it only by re-queueing it, and the claim
   re-checks. A local failure (`BUDGET` / `NOT_SENT`) on a row whose reference reached Hubble EARLIER stays in the
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
REPORT_DOWNLOADED, STATUS (system: every COMPLETED / COMPLETED_WITH_ERRORS / re-open change). Row (`VOUCHER_DISPERSAL_ROW`): BOUGHT (masked code), BUY_FAILED, PENDING,
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

## 9. Open questions

- **Q1 Flipkart prod id** — default registry assumes the same product id as staging; prod "Load from Hubble" earlier
  reported Flipkart as FIXED on prod. Recommendation: verify with `GET /brands` on prod before the first campaign.
- **Q2 Reference reuse after FAILED** — we mint a new reference for a Hubble-FAILED row (old kept). Recommendation: confirm
  with Hubble whether a failed reference can be re-placed; if it can, switch to always-same-reference.
- **Q3 Scheduler** — creating the drain job is an owner infra step (§8).
