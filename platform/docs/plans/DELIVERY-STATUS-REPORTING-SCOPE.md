# Delivery-Status Reporting — Build Scope (SMS · OTP · transactional WhatsApp)

**Status:** ✅ BUILT 2026-08-25 (Waves 0–4, on `develop`, pending cutover #37) — additive + ships DORMANT.
All 5 waves gated + adversarially audited + runtime-proven on staging. SMS/OTP/transactional-WhatsApp
delivery tracking + the team+tenant report all working end-to-end on the deployed container. Decisions §6.

**As-built (HEADs verify via `git log`):** W0 `72276ac` (receipt table + OtpCode fields + provider signatures) ·
W1 `924cabf` (SMS ingestion — shared `MessageDeliveryStatusService` + `/v1/notifications/status` webhook +
receipt-writing; a boot bug [a stray `@paralleldrive/cuid2` dep] was caught at the staging health-gate and fixed —
crqid now uses `node:crypto`; the audit HIGH [MSG91 SMS DLR is a NUMERIC code + `CRQID` field] fixed with a verified
code map) · W2 `cf0381b`/`34af500` (transactional WhatsApp receipts + the ONE MSG91 WhatsApp webhook delegates
broadcast-miss → shared service; no DI cycle) · W3 `f4dbda8` (OTP light — request-id on `OtpCode` at send [best-effort,
never throws → login OTP unaffected] + OtpCode correlation fallback + rolling ~24h rate) · W4 `9f851b6` (report
`/v1/admin/notification-delivery` summary/list/export, CLIENT_ADMIN hard-scoped [isolation runtime-proven 5/5] +
GIFSY_ADMIN platform/assumed, OTP `indicative` caveat, 90-day retention worker; FE `/admin/notification-delivery`).
Migrations: 3 additive (receipt table + reconcile index + otp index).

**WHOLE-FEATURE E2E EDGE-CASE AUDIT (across all 5 waves) — DONE `df5cb7b`.** 3 parallel adversarial lanes
(cross-wave chain+integrity · isolation/PII/auth · edge-cases/concurrency/UI-UX): **isolation/auth/PII CLEAN**
(tenant isolation runtime-proven 5/5; webhooks fail-closed; no cross-tenant recipient-PII leak on summary/list/export),
seams sound, concurrency + query-bounding robust, FE↔BE contract matches. Fixes applied (accuracy + true-dormancy, no
correctness holes): **M1** funnel "Sent" now = dispatched (`sentAt != null`) so a dispatched-then-failed row is counted
(runtime-proven: 2 SENT+1 DELIVERED+1 FAILED → Sent=4); **M2** one gate `DELIVERY_RECEIPTS_ENABLED` (default OFF) makes
ALL receipt production dormant (off = byte-identical pre-feature, no crqid in the MSG91 payload); **M3** export emits a
truncation-notice row at the 100k cap; **M4** SMS retry no longer leaves a duplicate receipt (QUEUED-guarded delete on
re-queue, one FAILED only on terminal); plus OTP tile total/pending, an explicit OTP-stats window, transactional-WhatsApp
reconcile, a fail-closed empty-scope assert, and FE from>to/download hints. **Deferred (flagged):** D3 scheme-SMS-via-OTP-transport
coverage (owner scope Q); D7 the full MSG91 numeric-code map (the existing live-payload RUNTIME-VERIFY).

**▶ owner-gated to go live:** wire the MSG91 SMS-DLR + WhatsApp outbound-report + (optional) OTP callback URLs at
`/v1/notifications/status` (+ keep the broadcast `/v1/whatsapp/status`), then set **`DELIVERY_RECEIPTS_ENABLED=true`**
(the production gate — without it nothing is tracked) + `NOTIFICATIONS_STATUS_SECRET` + `NOTIFICATIONS_RETENTION_ENABLED=true`,
and confirm the LIVE SMS-DLR payload shape (the one remaining RUNTIME-VERIFY).
**Author:** this session, 2026-08-24. **Design source of truth once approved:** this file.

## 1. Goal

Give the operator (and, where useful, the tenant) a **true per-message delivery-status report** for the
three message classes that have none today:
- **Transactional SMS** (the notification fan-out — order/KYC/reward triggers)
- **OTP** (login / KYC / redemption OTPs)
- **Transactional WhatsApp** (trigger-based notifications — NOT the broadcast console, which is already covered)

"Delivery status" = the real provider outcome per message: **submitted → delivered / failed / (read, WhatsApp only)**,
not just our send-attempt SENT/FAILED. Surfaced as an in-portal funnel + a downloadable/shareable report,
filterable by channel, tenant, event, and date range.

## 2. Feasibility — VERIFIED against MSG91 (2026-08-24)

The whole design hinges on MSG91 supporting delivery callbacks per channel. Confirmed:

| Channel | MSG91 support | Correlation handle | Source |
|---|---|---|---|
| **SMS** | ✅ DLR webhook — one JSON payload **per recipient**, callback URL configurable | custom **CRQID** (alphanumeric, no spaces) echoed back | [SMS DLR webhook](https://msg91.com/help/webhook-new/how-to-receive-sms-delivery-reports-via-webhook-new) |
| **OTP** | ✅ 24-char **request id** returned + query API; **AND** OTP status callback URL (delivered/failed/verified) | request id (+ CRQID where the FLOW path is used) | [OTP delivery status](https://msg91.com/guide/exact-information-of-the-delivery-report-status) |
| **WhatsApp** | ✅ already integrated (broadcast outbound-report webhook + report-by-requestId poll) | CRQID (already used) | in-repo `whatsapp-status.service.ts` |

**Implication:** we already have a *proven* end-to-end delivery-tracking implementation for WhatsApp broadcasts.
This build is largely **generalizing that proven pattern** to transactional messages + adding SMS/OTP ingestion —
not inventing anything new.

## 3. What exists today (reuse map — from the codebase audit)

Directly reusable (the broadcast delivery pattern is the template):
- **Correlation + idempotency**: broadcast uses CRQID = recipient row id, captures `msg91RequestId`, applies each
  transition via a `updateMany` **guarded on the not-yet-set timestamp**, and rolls a counter **only when
  `count === 1`** — so MSG91's retries never double-count (`whatsapp-status.service.ts`).
- **Webhook shape**: `@Public` + constant-time secret, **fail-closed in prod**, fast idempotent ack
  (`whatsapp-ops.controller.ts` `POST /v1/whatsapp/status`).
- **Reconcile fallback**: poll SENT-but-not-terminal rows via a report-by-requestId call (`getWhatsappStatusByRequestId`).
- **Export**: shared `buildXlsx` (`api/src/common/xlsx.ts`) + the funnel via `groupBy(['status'])`.
- **Dormancy + per-tenant config**: env flags (`*_WORKER_ENABLED`, `*_STATUS_SECRET`, `MSG91_AUTH_KEY` unset ⇒ DEV
  bypass) + the `notificationTemplates` per-tenant config panel (`/admin/notification-templates`).
- **Enum readiness**: `NotificationStatus.DELIVERED` already exists (never written yet); `NotificationDeliveryLog`
  already has an unused `providerRef` column.

## 4. Gaps (the concrete build surface)

1. **No correlation id is stored** on transactional messages. `NotificationQueue` has no crqid/requestId column;
   `msg91.sendSms` / `sendOtp` return `void` (discard MSG91's id) and send no crqid. `NotificationDeliveryLog.providerRef`
   exists but is never written.
2. **Transactional WhatsApp has no DB row at all** — `notifyUserWithChannels` calls `sendWhatsappTemplate` directly,
   fire-and-forget, no crqid. Nothing to correlate a callback to.
3. **OTP has no persisted send handle** — `OtpCode` stores the code, not the MSG91 request id.
4. **No SMS/OTP status webhook** — the only status endpoint is hard-wired to broadcast recipients.
5. **Lifecycle stops at SENT** — nothing writes DELIVERED; no delivered/failed transition or counters on the
   transactional side.
6. **No transactional delivery report/funnel** anywhere in the portal.

## 5. Proposed architecture (generalize the proven pattern)

**Core idea:** every billable transactional send (SMS, OTP, WhatsApp) gets a **persisted per-message row with a
CRQID**, a **single generalized status webhook** correlates MSG91 callbacks back to those rows via CRQID (requestId
fallback), transitions them with the same idempotent guarded-update + counter mechanism, and a **reporting surface**
renders the funnel + xlsx.

- **Data model (fork D2):** either (a) extend `NotificationQueue` with `crqid` (unique, indexed), `msg91RequestId`,
  `deliveredAt`, `failedReason` and start writing `NotificationDeliveryLog.providerRef`; **or** (b) a dedicated
  `MessageDeliveryReceipt` table keyed by crqid (channel, tenant, event, phone, status, timestamps, requestId) that
  every send writes. (b) isolates high-volume delivery rows from the bell-feed queue and is cleaner for OTP; (a)
  reuses more. **Recommendation: (b)** — a purpose-built receipt table with a per-tenant + per-channel + date index.
- **SMS**: `sendSms` gains a `crqid` param + returns `requestId`; the drain worker writes the receipt row (crqid,
  requestId) on send; a new `POST /v1/notifications/status` (or `/v1/sms/status`) webhook correlates DLR → DELIVERED/FAILED.
- **Transactional WhatsApp**: route it through the same receipt row (write crqid before send, pass crqid to
  `sendWhatsappTemplate`), and **extend the status ingestion to resolve BOTH broadcast recipients AND transactional
  receipts** (fork D3: one webhook that checks both tables, or a shared correlation service).
- **OTP (fork D1)**: capture the MSG91 request id on `OtpCode` (cheap, always) and optionally a receipt row +
  webhook/poll. OTP is the **highest-volume + most ephemeral** channel — full per-message delivery rows for every OTP
  is real data volume, so this is a deliberate scope choice (see D1).
- **Reporting surface (fork D4)**: a funnel (`groupBy status`) + xlsx export (`buildXlsx`), filterable by
  channel/tenant/event/date, under a new `/admin/notification-delivery` page (or extend `/admin/notification-templates`).
  Tenant-readable variant optional.
- **Dormancy**: ships behind env flags + secret-gated webhook + `MSG91_AUTH_KEY`-unset DEV bypass, exactly like the
  broadcast module. No behavior change until the owner wires the MSG91 callback URLs + secrets.

## 6. Decisions — LOCKED (owner, 2026-08-24)

- **D1 = light OTP:** capture the MSG91 request-id on `OtpCode` (+ a delivery-status/deliveredAt on the OtpCode row) and provide an **aggregate OTP delivery-rate** report only — NOT a full per-OTP receipt table.
- **D2 = new table:** a dedicated `MessageDeliveryReceipt` table keyed by crqid (for SMS + transactional WhatsApp). (OTP uses OtpCode per D1.)
- **D3 = one shared status service:** a single generalized status-ingestion service; both `/v1/whatsapp/status` (broadcast) and the new transactional status webhook delegate to it.
- **D4 = team + tenant, 90-day retention:** a delivery-report surface visible to BOTH the operator team (all / assumed-tenant) AND the tenant (scoped to their own data); receipts retained **3 months (90 days)** then pruned.
- **D5 = all member-facing sends:** cover the 10 canonical notification events AND include the payout + scheme SMS that currently route through the OTP send method.

Original fork write-up retained below for context.

### Original forks (pre-decision)

- **D1 — OTP depth.** (a) Full per-message OTP delivery receipts + report (most complete, highest volume/retention
  cost); (b) capture requestId on `OtpCode` + a lightweight aggregate delivery-rate report only; (c) skip OTP for now.
  *Recommendation: (b)* — OTP volume is high and each is ephemeral; an aggregate delivery-rate view + the request-id
  handle (for one-off lookups) gives 90% of the value at a fraction of the storage/complexity.
- **D2 — Data model.** New `MessageDeliveryReceipt` table (recommended) vs extend `NotificationQueue`.
- **D3 — Webhook topology.** One generalized `/v1/notifications/status` resolving all transactional channels, and
  whether the existing `/v1/whatsapp/status` broadcast webhook is extended to also resolve transactional WhatsApp or
  kept separate. *Recommendation: one generalized status service that both endpoints delegate to.*
- **D4 — Reporting surface + retention.** New page vs extend the templates panel; tenant-visible or operator-only;
  how long delivery receipts are retained (e.g. 90/180 days) before pruning.
- **D5 — Scope of "transactional".** Confirm the channel/event set (the 10 canonical notification events) that get
  delivery tracking, and whether cash/payout and scheme SMS (which currently route through `sendOtp`) are included.

## 7. Proposed waves (orchestrated; each = build agents → central gate → tri-lane audit → staging runtime-verify)

| Wave | Scope | Agents | Rough effort |
|---|---|---|---|
| **0** | Schema (`MessageDeliveryReceipt` + indexes; OtpCode.requestId) + `msg91.service` (crqid param + return requestId on sendSms/sendOtp; verify MSG91 crqid field names per channel) | 1 | ~0.5 day |
| **1** | SMS ingestion — generalized status webhook + status service (crqid→receipt, guarded idempotent transitions + counters) + worker writes receipt + reconcile poll | 1–2 | ~1 day |
| **2** | Transactional WhatsApp — write a receipt row per send with crqid; extend ingestion to resolve broadcast + transactional | 1 | ~0.5–1 day |
| **3** | OTP per chosen D1 option (requestId capture + aggregate or full receipts) | 1 | ~0.5 day |
| **4** | Reporting surface — funnel + xlsx export (channel/tenant/event/date) + FE page | 1–2 | ~1 day |
| — | Per-wave: full gates + tri-lane audit (money is N/A; PII + isolation + UI/UX) + staging runtime-verify (real callbacks) | orchestrator | included |

**Total rough effort:** ~3.5–4.5 working days of orchestrated build, + the standard per-wave audit/verify. One
additive migration in Wave 0 (new table + a nullable column); everything additive + dormant (no change to live flows
until the owner wires MSG91 callbacks). RUNTIME-VERIFY items: the exact MSG91 crqid/requestId field spellings on the
SMS FLOW + OTP callbacks (same class of ⚠️ note the broadcast module already carries for WhatsApp).

## 8. Out of scope / assumptions
- Email delivery reporting (separate; SMTP has its own bounce/log path) — not included unless asked.
- No change to the existing WhatsApp **broadcast** delivery reporting (already live-capable).
- Assumes MSG91 remains the sole provider (single `msg91.service`).
