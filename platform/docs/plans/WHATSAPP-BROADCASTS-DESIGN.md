# WhatsApp Broadcasts — design & build contract

**Owner decisions (2026-08-21):** Operator = **Gifsy-operator only** (in `/admin` shell, `gifsyOnly` nav + GIFSY route guard; audience = the ASSUMED tenant's `clientId`; tenant CLIENT_ADMIN does NOT see it). Audiences = **Outlets (owner phones) + Sales reps + Excel phone list**. Templates = **managed per-tenant library** (pick + preview + variable contract). Build = **full module in one pass** (gated + tri-lane audited + staging-verified).

**Reuse (reconcile, don't reinvent):** `api/src/schemes/scheme-notify.service.ts` (`resolveRecipientPhones`, `resolveOutletPhones`, `resolveSalesPhones`, `send`) + `Msg91Service.sendWhatsappTemplate` + the `recipientFilter`/`audienceConfig` filter shapes (`{ outletTypeIds, programNames, programCategories, zones, states, kycApprovedOnly }`). Generalize the audience resolver OUT of schemes into a shared helper both the scheme broadcaster and this module call — **do NOT break the scheme broadcast** (keep its behavior; add tests proving it still works).

**MSG91 status (verified against msg91.com/help/webhook-new):** outbound report webhook "On Outbound Report Received" → statuses **Sent / Delivered / Read / Failed**; callback must ack ≤8s (retries ×4); a fallback **status-by-requestID API** for missed events; a custom **`crqid`** param we send is echoed back on the webhook → correlation key.

---

## Data model (additive migration — no changes to existing tables)

**`WhatsappTemplate`** (`@@map whatsapp_templates`) — per-tenant library:
- id, clientId, name (display), msg91TemplateName (registered/approved in MSG91), category (`MARKETING|UTILITY|AUTHENTICATION`), languageCode (default `en`), bodyText (with `{{1}}…{{n}}`), variableContract (Json: ordered `[{index, label}]`), headerType?/footer? (optional, phase-later), status (`ACTIVE|ARCHIVED`), createdByUserId, createdAt, updatedAt. `@@unique([clientId, name])`.

**`WhatsappBroadcast`** (`@@map whatsapp_broadcasts`) — a campaign:
- id, clientId, templateId (FK→WhatsappTemplate, onDelete Restrict), title, audienceMode (`FILTER|EXCEL`), audienceScope (`OUTLETS|SALES|BOTH` — for FILTER mode), audienceConfig (Json: the filter), status (`DRAFT|SCHEDULED|SENDING|SENT|CANCELLED`), scheduledAt?, recipientCount, sentCount, deliveredCount, readCount, failedCount, createdByUserId, createdAt, updatedAt, sentAt?.

**`WhatsappBroadcastRecipient`** (`@@map whatsapp_broadcast_recipients`) — one row per message:
- id, broadcastId (FK→WhatsappBroadcast, onDelete Cascade), clientId, phone (bare 10-digit), variables (Json: ordered values for this recipient), **crqid** (= this row id, sent to MSG91), status (`QUEUED|SENT|DELIVERED|READ|FAILED|SKIPPED`), msg91RequestId?, sentAt?/deliveredAt?/readAt?, errorReason?, createdAt, updatedAt. Indexes: `[broadcastId, status]`, `[clientId, status]`, unique or index on crqid (= id, so PK covers it — store the id as crqid directly).

---

## Backend API (all `/v1/admin/...`, Gifsy-operator-gated: `@Roles('GIFSY_ADMIN')` + service `isGifsyOperator`/`platformWide`-aware; clientId from assumed tenant)

**Template library:**
- `GET /admin/whatsapp-templates` → list (ACTIVE first).
- `POST /admin/whatsapp-templates` → create (nested-validated DTO — survive the whitelist pipe).
- `PATCH /admin/whatsapp-templates/:id` → edit; `DELETE` → soft-archive (status ARCHIVED; keep for historical broadcasts).

**Broadcast:**
- `POST /admin/whatsapp-broadcasts/preview` `{ mode, scope, filter } | { mode:'EXCEL', rows:[{phone,vars…}] }` → `{ recipientCount, deduped, invalidCount, sample:[{phone, renderedBody}] }` (renders the chosen template with resolved vars; NO send, NO row).
- `POST /admin/whatsapp-broadcasts` `{ title, templateId, mode, scope?, filter?, excelRows?, scheduledAt?, variableMapping? }` → creates the broadcast + recipient rows (QUEUED) + enqueues send (or schedules). FILTER mode derives per-recipient vars from outlet/rep fields via `variableMapping` (var index → a field key or a constant); EXCEL mode takes vars from the uploaded columns.
- `POST /admin/whatsapp-broadcasts/:id/test-send` `{ phones:[…] }` → send to 1–5 test numbers only (no campaign rows / separate flag).
- `GET /admin/whatsapp-broadcasts` → history (counts, status). `GET /admin/whatsapp-broadcasts/:id` → detail + live status funnel.
- `GET /admin/whatsapp-broadcasts/:id/report` → **Excel** (phone, variables, status, sent/delivered/read timestamps, failure reason).
- `POST /admin/whatsapp-broadcasts/:id/resend-failed` → new broadcast targeting this one's FAILED/undelivered. `POST /:id/cancel` → cancel a SCHEDULED/QUEUED-not-yet-sent campaign.

**Delivery pipeline:**
- **Send worker** (reuse the drain discipline + atomic QUEUED→SENDING claim from the notifications build): picks QUEUED recipient rows, sends via `sendWhatsappTemplate` (extend it to pass `crqid` = row id + capture the returned `requestId`), **throttled** to respect MSG91/Meta rate limits, marks SENT/FAILED. Cloud Scheduler drain endpoint (secret-guarded) + the interval.
- **Status webhook** `@Public POST /v1/whatsapp/status` — secret-guarded (constant-time, env `WHATSAPP_STATUS_SECRET`), parses the MSG91 outbound-report payload, updates the recipient row by `crqid` → DELIVERED/READ/FAILED + timestamp, and rolls the campaign counters. **Acks ≤8s** (do the minimal update, defer heavy work). Hit directly by MSG91 (not the FE edge) → no PUBLIC_PATHS entry needed, but IS `@Public` on the backend.
- **Fallback poll** — a scheduled reconcile of non-terminal recipients older than N minutes via the MSG91 status-by-requestID API (catches missed webhooks).

---

## Frontend — `/admin/whatsapp-broadcasts` (Gifsy-operator only; `gifsyOnly` nav like Help & Guides)
- **List/history** + "New broadcast" **wizard**: ① audience (FILTER: the outlet/rep filters + scope, live count; or EXCEL upload: phone + variable columns) → ② pick template from the library (shows body `{{1}}…{{n}}` + variable contract) → ③ map variables (FILTER: var→field/constant; EXCEL: var→column) → ④ **preview** (count, dedup, invalid, sample rendered message, est. cost) → ⑤ **test-send to myself** → ⑥ send now / schedule / cancel.
- **Campaign detail**: status funnel (Queued→Sent→Delivered→Read / Failed) + failure-reason breakdown + **Download Excel report** + resend-failed.
- **Template library** management page (CRUD).

## Compliance + enrichment (build in)
Only ACTIVE approved templates selectable; **opt-out/DND suppression list** applied at resolve; **test-send before blast**; **confirm step** with recipient count + est. cost; **dedup + invalid-number pre-flight** in preview; **throttle** sends; **idempotent** send (atomic claim — no double-message on retry); **scheduled send** + cancel; **saved audiences** (phase-later ok); **audit trail** (who sent what/when/count). Marketing templates carry per-message cost + Meta quality/limits — surfaced, not hidden.

## Assurance
Full gates + **tri-lane audit** (DUAL money/identity+PII — cost, cross-tenant recipient leak, webhook auth/spoofing, no double-send; + UI/UX) + **staging runtime-verify**: real operator (assumed tenant) creates a template, previews an audience, **test-sends to a real number**, and a **simulated MSG91 status webhook** flips a recipient to DELIVERED/READ in the report. Prove the scheme broadcast still works (no regression). ⚠️ DI/wiring changes need a real BOOT check (staging Ready), not just green gates.
