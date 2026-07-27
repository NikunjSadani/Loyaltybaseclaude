# Visibility (POSM) — Design Doc (locked pre-build)

> Status: **✅ LIVE ON STAGING (pushed `6e3b897`, migration applied+verified, API-surface runtime-verified) — NOT in prod.**
> Next step: optional synthetic-capture write-path proof → **~10-min owner phone smoke** (camera/geo/push) → owner UAT →
> prod cutover. See **§16 AS-BUILT + STATUS** (the authoritative current-state record) at the bottom.
> Feature-name (user-facing + internal): **Visibility** (proof of POSM — point-of-sale material).
> This REPLACES the half-built photo-capture scaffolding in the existing `visibility` module and grafts on the
> proven **Scheme** capture instrument. See §8 (audit) for what exists today.

---

## 0. What "Visibility" is (the reframe)

A **recurring, per-period, sales-captured photo+geo proof that point-of-sale material is present at an outlet**,
approved by Gifsy. A tenant configures which outlets are in scope, how many times a month it must be captured, and
who may capture it. The sales team captures it (photos + geo + optional fields) from their Tasks; Gifsy approves or
rejects; a rejected capture must be re-done. **Capture + approval only — NO reward/points/payout engine** (mirrors
the Scheme decision; the dead reward columns in the current module are removed, not carried forward).

---

## 1. Locked decisions (D#)

- **D1 — Capture + approval only.** No points/payout/incentive. Reward-free "proof of POSM".
- **D2 — Rebuild in-place in the `visibility` domain on the Scheme capture instrument** (clone-and-adapt Scheme's
  proven pieces; **do NOT refactor the live Scheme module**). Retire the dead partner-only photo path, the fake
  admin approve/reject queue, the hardcoded fraud log, and all dead reward fields/UI.
- **D3 — Two capture modes coexist, per-tenant `visibilityCaptureMode`** (unchanged toggle):
  - `PHOTO_APPROVAL` — the NEW sales photo-capture flow (this doc).
  - `AMOUNT_UPLOAD` — the EXISTING Excel back-office record path (`OutletVisibilityRecord`), **kept untouched**
    as an optional mode for tenants who capture visibility outside the app. The two never collide (different
    tables). Sales status surfaces are **mode-aware** (photo tenants read the new capture model; amount-upload
    tenants keep reading `OutletVisibilityRecord`).
- **D4 — Config owner = GIFSY_ADMIN only.** Tenant admin gets **read-only** reports.
- **D5 — Outlet scope = per-tenant list of `OutletType.code`** (e.g. `["SSS","SSS_TOT"]`), intersected with the
  tenant's enabled types (`OutletTypeClientConfig.isEnabled` + its own `visibilityEnabled`).
- **D6 — Frequency = per-tenant 1–4× / month → windows** by equal-day buckets, remainder in the last window:
  - 1× → `[1–end]`; 2× → `[1–15][16–end]`; 3× → `[1–10][11–20][21–end]`; 4× → `[1–8][9–15][16–23][24–end]`.
  - Window key = **`YYYY-MM-Pn`** (e.g. `2026-07-P2`), computed **at capture time in IST** (`istDateKey` shift-then-
    read-UTC pattern — never server-local `Date`, which is UTC in prod).
- **D7 — A window is satisfied ONLY by an APPROVED capture.** `SUBMITTED` = awaiting approval; `REJECTED` = re-opens
  the window. A window that closes with no approved capture = **MISSED** (reported). **Late capture allowed within
  the same calendar month, flagged "late"; windows do NOT roll over** (a missed window stays missed).
- **D8 — Who captures:** the configured `allowedSalesLevels` (list of `SalesHierarchyLevel.code`, e.g.
  `["XSR","SO","ASM"]`) **and** a manager for any outlet in their **downline** (`descendantSalesUserIds`). Everyone
  else (out-of-level and out-of-downline) is **VIEW-ONLY** — sees whether visibility is done, cannot capture.
  **First APPROVED capture per (outlet, window) wins.**
- **D9 — What's captured:** a **Gifsy-configurable form** (the Scheme form-builder): one or more **camera fields**
  (Gifsy decides how many), **each with its own instruction text and an optional reference/sample image**; plus
  automatic geo on submit and optional fields (POSM type / condition / notes). Gallery disabled on camera fields
  (native camera, D14-scheme).
- **D10 — Geo-fence (per-tenant `{ enabled, radiusMeters }`):** on capture, device GPS is compared (server-side
  haversine) to the outlet's **reference geo = its APPROVED `KycSubmission.boardPhotoLat/boardPhotoLng`** (the KYC
  store-board geo). If beyond `radiusMeters` → **block** the submission (server-enforced, not just client). If the
  outlet has **no reference geo** (standalone, or KYC predates board-photo geo capture) → **ALLOW but FLAG**
  ("geo-fence unverifiable") with a report column. Default radius suggestion: 50 m.
- **D11 — Immutable versioned reject→recapture**, per window (v1 rejected → v2 …), mirroring Scheme's submission
  history. Captured data is never edited in place.
- **D12 — Approval = GIFSY_ADMIN** in a real admin queue (replacing the fake one): approve / reject-with-reason,
  captured photos (auth-gated view), geo pin + distance-from-outlet, submission history.
- **D13 — Outlet info view** (`sales/kyc/[id]`): a "Visibility — this period" card showing each window's status,
  with a **Capture CTA** (redirect preselected to the outlet) when the current window is due / missing / rejected.
- **D14 — Sales Tasks:** a "Visibility captures due" group (mode-aware, reach-scoped), showing **N-of-M for the
  current window** and opening the capture sheet.
- **D15 — Reporting:** Gifsy coverage view **per window** (captured / pending / approved / rejected / missed) +
  tenant **read-only** + **Excel export with auth-gated photo links** and a geo-fence-flag column.
- **D16 — Reference/sample image per photo field is IN v1** (Gifsy uploads an example shot shown to the rep).
- **D17 — Single visibility configuration per tenant** (one outlet-scope + frequency + levels + form). The owner's
  spec is singular; multiple concurrent named visibility programs are OUT of v1 (the model can extend later).
  *(Assumption flagged for final sign-off.)*

### Explicitly out of scope (v1)
- Rewards / points / payout / visibility invoices (removed as dead code).
- **Offline capture — DROPPED entirely (not phase-2).** Offline-first would let capture geo/timestamp be
  taken away from the outlet (or with a spoofed clock), defeating the geo-fence + server timestamp = a fraud
  hole. **v1 is ONLINE capture:** photo bytes upload with retry on flaky signal, but submit (window-key +
  geo-fence + server `receivedAt`) is live/online. A rep in a dead zone cannot submit (correct).
- Server-side photo watermark — DROPPED (geo/time/outlet/rep already stored as columns + in the Excel export).
- Multiple concurrent visibility programs per tenant (D17).
- Partner/outlet self-capture (visibility is sales-captured; outlets are subjects, not capturers).

### Weekly reminders — IN v1 (owner confirmed 2026-07-27: web-push + Tasks badge, capturing reps only)
- **Channel = in-app WEB-PUSH** (the existing free `NotificationQueue` → push-drain worker path, reusing the
  `sales-notifications.service` `enqueuePush` pattern) **+ a prominent "N captures due this period" badge/count on
  the sales Tasks page** (the Tasks page already lists pending captures — W2 adds the badge). NO SMS/WhatsApp
  (cost-free). NO new persistent inbox (the sales bell stays the deferred P7 #21 work).
- **Recipients = capturing reps only** (allowed level + outlet in their subtree with a pending/rejected/missed
  capture this window). No manager escalation in v1.
- **Cadence = weekly.** New `visibility-notify.service` + a `@Public`, shared-secret-gated `POST
  /v1/visibility/weekly-reminder` (pattern of push-drain / kyc-cleanup, fail-closed on unset secret) computing
  per-tenant (visibilityEnabled + PHOTO_APPROVAL) the current window's in-scope outlets NOT approved-captured →
  one aggregated push per rep with a click-URL to the visibility Tasks. Sample push:
  "Deoleo Visibility: {N} outlet(s) still need a photo this period (due {date}). Tap to capture."
- **Go-live infra (owner-gated at cutover):** create the weekly Cloud Scheduler job + a `VISIBILITY_REMINDER_SECRET`
  secret bound on the api service (mirrors the KYC-cleanup scheduler setup). A rep with no push subscription simply
  gets nothing pushed — the Tasks badge is the always-visible fallback.
- **Photo retention lifecycle — DECIDED (owner, 2026-07-27): Standard 4 months → Archive → delete at 7 years.**
  GCS Object Lifecycle scoped to the `visibility-media/` prefix (NOT the whole bucket — KYC/invoices/logos
  untouched): **age 120d → SetStorageClass ARCHIVE; age 2555d (7y) → Delete.** (Archive's 365-day min-duration is
  satisfied — objects sit in Archive ~120d→2555d. Archived photos stay instantly viewable via the same auth-gated
  link; only a tiny per-view retrieval fee, no restore step.) All images today live in the single private bucket
  `gifsy-platform-files`, served via an auth-gated backend stream; visibility photos → `visibility-media/<clientId>/`.
  No lifecycle exists today. **Apply via terraform at/near go-live (owner-gated infra; harmless to pre-create since
  the prefix has no objects yet). NOTE separately: KYC docs have no retention policy — a future compliance decision.**

---

## 2. Data model (new tables; mirror Scheme, keyed by window)

New (`api/prisma/schema.prisma`), all `@@index`/`@@unique` tenant-scoped:

- **`VisibilityForm`** + **`VisibilityFormVersion`** — the per-tenant configurable capture form, **versioned**
  (mirror `SchemeEnrollmentForm(+Version)`); snapshots so old captures render coherently.
- **`VisibilityCapture`** — current state per `(clientId, outletId, windowKey)`:
  `outletCode`, `outletName`, `windowKey` (`YYYY-MM-Pn`), `status` (`SUBMITTED|APPROVED|REJECTED`),
  `currentVersion`, `formVersion`, `formValues` (Json: photo keys + fields), `captureLat/Lng/Accuracy`,
  `geoFenceOk` (Bool?, null = unverifiable), `distanceMeters` (Decimal?), `submittedByUserId`, `approvedByUserId`,
  `rejectionReason`, timestamps. **`@@unique([clientId, outletId, windowKey])`** (one current capture per window).
- **`VisibilityCaptureSubmission`** — append-only version history (mirror `SchemeSubmission`),
  `@@unique([captureId, version])`.
- **Status enum** `VisibilityCaptureStatus { SUBMITTED, APPROVED, REJECTED }`.

Retire (drop, with a 0-row abort-guard like the scheme migration — the photo path is dead everywhere):
`VisibilitySubmission`, `VisibilityApproval`, `VisibilityFraudLog`, `VisibilityImageHash`, `VisibilityProgram`
(+ their dead reward columns). **Keep** `OutletVisibilityRecord`/batch/audit (AMOUNT_UPLOAD, real).

Config lives in **`program_settings`** (mirror `outletPrograms`/`creditsPayouts`), key e.g. `visibilityConfig`:
```
{ outletScope: string[],            // OutletType.code list, e.g. ["SSS","SSS_TOT"]
  frequencyPerMonth: 1|2|3|4,
  allowedSalesLevels: string[],     // SalesHierarchyLevel.code list
  geoFence: { enabled: boolean, radiusMeters: number } }
```
Master switch `visibilityEnabled` and `visibilityCaptureMode` stay as-is (`TenantService`/`clients.features`).

---

## 3. Window helper (new pure module, mirror `targets.helpers.ts`)

`visibility-window.helper.ts` (api) + FE mirror:
- `windowsForMonth(month, freq)` → `['YYYY-MM-P1', …]` (equal-day buckets, remainder in last).
- `windowKeyForDate(dateUtc, freq)` → IST-shifted day-of-month → bucket → `YYYY-MM-Pn` (computed once at write).
- `windowBounds(windowKey, freq)` → `{ startDay, endDay }` for display + "days left".
- `isWindowClosed(windowKey, nowUtc, freq)` (string-order + IST).

Coverage/miss = set-difference over the addressable denominator (mirror `program-health-dashboard` `addressableWhere`):
denominator = in-scope outlets (`outletType.code ∈ outletScope`, `deletedAt/deactivatedAt null`); numerator per window
= outlets with an APPROVED `VisibilityCapture` at that windowKey; miss = denominator − numerator once the window closes.

---

## 4. Reuse map

**From Scheme (clone-and-adapt — do NOT touch live scheme):** media upload + auth-gated `viewMedia`
(`visibility-media/<clientId>/`), the form engine (`enrollment-form.helper.ts` incl. CAMERA/GPS + validation),
`SchemeFormRenderer` (camera `capture`, GPS-on-submit, media upload), the versioned submit/reject transaction,
`SchemeFormBuilder` (+ new per-field instruction text + sample image), the admin approval drawer
(`enrollments/page.tsx` — captured values, media grid, `GeoPin` haversine, reject-with-reason, history),
the sales capture sheet (`SchemeEnrollSheet`), the coverage report + export.

**From existing visibility (real — reuse in place):** the `visibility` name/routes/domain, `visibilityEnabled` +
`visibilityCaptureMode` settings, the sales-tasks group hook (`buildVisibilityTaskItems`, repointed), the outlet-view
"Submit Visibility Photo" quick-action slot (upgraded to the status card + capture redirect), `OutletTypeClientConfig`.

**New:** the window model (§3), the per-tenant `visibilityConfig` settings block, the geo-fence enforcement,
per-photo instruction + sample image, and a real admin approve/reject queue.

---

## 5. Integration points (exact)

- Sales tasks: `platform/src/lib/sales-tasks.ts::buildVisibilityTaskItems` + `sales/tasks/page.tsx` (+ mirror in
  `sales/dashboard`) — repoint to a real capture sheet, show N-of-M this window, gate on `allowedSalesLevels` +
  reach.
- Outlet info view: `sales/kyc/[id]/page.tsx` — insert "Visibility — this period" card near the Redeem CTA;
  replace the dead "Submit Visibility Photo" quick action with a capture redirect `?outletId=`.
- Rep identity / scope: `GET /api/sales/outlets` (`SalesService.getMyOutlets`, subtree), `subtreeOutletCodes`.
- Reference geo: `KycSubmission.boardPhotoLat/Lng` (latest APPROVED submission for the outlet).

---

## 6. Endpoints (base `/v1/visibility`, mode PHOTO_APPROVAL)

Admin (GIFSY): `PUT /config` (outletScope/freq/levels/geoFence), `PUT /form` (versioned), `GET /form`,
`GET /captures` (queue, filters), `GET /captures/:id`, `POST /captures/:id/approve`, `POST /captures/:id/reject`,
`GET /report`, `GET /report/tenant` (read-only), `GET /report/export`, auth-gated `GET /captures/media?key=`.
Sales: `GET /sales/eligible` (in-scope outlets + current-window status, reach+level scoped),
`POST /captures/media` (upload), `POST /capture` (submit → window key computed + geo-fence enforced),
`POST /captures/:id/resubmit` (after reject). All gated by `visibilityEnabled` + role/level + reach + capture-mode.

---

## 7. Wave plan (estimates assume end-to-end by me, orchestrated)

| Wave | Scope | Est. |
|---|---|---|
| **W0** | Schema + migration (new tables + enum + drop dead photo tables w/ 0-row guard) · window helper (+ tests) · `visibilityConfig` settings key (validate/overlay/cache) · seed a photo-mode tenant | 0.5 day |
| **W1** | Backend: config CRUD · versioned form · capture submit (window-key + **geo-fence enforcement**) · resubmit · approve/reject · sales-eligible (reach+level) · report/export · media reuse | 1.5 days |
| **W2** | Frontend: admin config + form-builder (per-photo instruction + sample image) + real approve/reject queue (drawer, geo-pin) · sales capture sheet + tasks group (mode-aware) · outlet-view status card + capture redirect · tenant read-only report | 1.5 days |
| **W3** | Integrate · **dual adversarial audit** (geo-fence bypass, window/IST correctness, reach/level scoping, media RBAC, cross-tenant, miss/late) · fix · full gate · **full role-matrix runtime-verify on staging** · docs/memory | 1 day |
| | **Total** | **~4.5 days**, then a ~10-min real-phone smoke (camera/geo) + owner UAT, then owner-gated prod cutover |

Retire the dead scaffolding as part of W0/W2 (no separate wave). Money-path-grade discipline throughout (owner UATs
only once live).

---

## 16. AS-BUILT + STATUS (authoritative — 2026-07-27)

**✅ BUILT + dual-audited + fully gated. Committed `2e28ac4` on develop. NOT pushed.**
Gate: **api `nest build` 0 · jest 86 suites / 1931 · FE `tsc` 0 · vitest 207 files / 2014.**

### DB (migration `20260727120000_visibility_posm_rebuild`, guarded destructive)
New models: `VisibilityForm`(+`VisibilityFormVersion`) — per-tenant versioned capture form; `VisibilityCapture`
— current capture per `@@unique([clientId, outletId, windowKey])` (status `VisibilityCaptureStatus` = SUBMITTED|
APPROVED|REJECTED); `VisibilityCaptureSubmission` — append-only version history; `VisibilityImageHash` — dup
detection. **Dropped** the dead photo tables (`visibility_programs`/`_submissions`/`_approvals`/`_fraud_log`) +
re-columned `visibility_image_hashes`; abort-guard asserts 0 legacy rows. **Kept** the Excel `OutletVisibilityRecord`
(AMOUNT_UPLOAD) path untouched. Repointed 4 live consumers off the dropped model (ops dashboard, tenant report,
KYC delete-safety, admin pending-count).

### Backend (`api/src/visibility/`)
`visibility-window.helper.ts` (IST `windowKeyForDate`/`windowsForMonth`/`isWindowClosed` — reuses `IST_OFFSET_MIN`),
`visibility-form.helper.ts` (trimmed field engine + `parseGpsPoint` range-validation), `visibility-media.service.ts`
(upload/auth-gated view + sha256 dup-hash), `visibility-admin.service.ts` (config/versioned-form/scope), capture/
review/report/notify services, 5 controllers. Config in `program_settings.visibilityConfig` {outletScope,
frequencyPerMonth, allowedSalesLevels, geoFence:{enabled,radiusMeters}} via `TenantSettingsService`.
**Endpoints** (base `/v1/visibility`): admin `GET/PUT config`, `GET/PUT form`, `GET outlets`, `POST media`,
auth-gated `GET captures/media?key=` (GIFSY+CLIENT_ADMIN+sales, tenant-pinned); sales `GET sales/eligible`,
`GET sales/form`, `POST sales/media`, `GET outlet/:id/status`, `POST capture`, `POST captures/:id/resubmit`;
review `GET captures`, `GET captures/:id`, `POST captures/:id/{approve,reject}`; report `GET report`,
`GET report/tenant`, `GET report/export`; `@Public POST weekly-reminder` (secret-gated, fail-closed).

### Frontend (`platform/src/`)
`lib/visibility.ts` (`visibilityApi`) + `lib/visibility-types.ts` + `lib/visibility-window.ts`;
`components/visibility/VisibilityCaptureForm.tsx` (camera `capture` + per-shot instruction/sample + GPS-on-submit +
client-side JPEG compression); admin `VisibilityConfigEditor`/`VisibilityFormBuilder`/`VisibilityCaptureQueue`
(geo-pin, dup-matches, controlled reject reasons)/`VisibilityReportView`/`VisibilityAmountUploadPanel`;
`app/admin/visibility/**` (mode-branched: PHOTO_APPROVAL tabs vs AMOUNT_UPLOAD Excel) + `admin/visibility-reports/**`
(tenant read-only); `app/sales/visibility/**` (list + `VisibilityCaptureSheet`); sales Tasks badge (mode-aware,
`canCapture`-driven so manager reach-levels get it) + `sales/kyc/[id]` "Visibility — this period" card + capture
redirect. Retired `partner/visibility/**`.

### Dual adversarial audit (W3) — ALL FIXED
2 HIGH: **geo-fence fail-OPEN** (garbage/absent client GPS → now fail-CLOSED block when fence-on + reference exists;
`parseGpsPoint` range-validates; missing *reference* geo still allow-but-flag) · **no sales media upload route**
(added `POST sales/media`). 5 MED: resubmit-across-window → 409 window-guard · coverage numerator now
scope-intersected (≤100%) + submit tightened to deactivated-excluded · geo reference confirmed per-outlet
(owner-group Option-B: each outlet keeps its own ChannelPartner, so KYC board-geo is per-outlet — non-issue) ·
CLIENT_ADMIN can open export photo links (method-level role override, tenant-pinned) · export N+1 batched. LOWs:
cross-tenant CAMERA-key rejected at submit · reminder null-userId guard · sales granted `visibility:read/write`
perms (future RBAC_ENFORCEMENT-safe). VERIFIED CLEAN: cross-tenant isolation, first-approved-wins/versioning races,
reach+level scoping, IST windows, dup-hash, media path-traversal, reminder secret gate, media RBAC (auth-gated
app routes only — no public GCS URLs), XSS.

### Owner decisions folded in
Reward-free; single per-tenant config (D17); window splits 1–4× (2×=[1-15][16-end], 3×/4× equal-day remainder-last);
approved-capture satisfies the window, reject re-opens (versioned), late allowed same-month/flagged, no roll-over;
geo-fence per-tenant on/off + radius (ref = outlet KYC board-photo geo, no-ref = allow-but-flag);
**multi-photo with per-shot instructions + sample images (v1)**; capture gated to configured `SalesHierarchyLevel`
codes + downline reach, others view-only; **weekly reminder IN v1 = in-app web-push + Tasks badge, capturing reps
only**; AMOUNT_UPLOAD Excel mode kept as the alternate `visibilityCaptureMode`.

### ✅ STAGING DONE (2026-07-27) — pushed `6e3b897`, migration applied+verified, API-surface runtime-verified
1. **Guarded staging cleanup DONE** — the 1 legacy `visibility_programs` row backed up to job logs + deleted (guard
   `current_database='gifsy_staging'`; all 4 child/hash tables re-counted 0 first per the audit condition).
2. **Pushed develop → staging DONE** — both `gifsy-api-staging`/`gifsy-frontend-staging` serve `6e3b897`;
   `/health/ready` db:up. **Migration verified:** `finished_at` set / not rolled back; 5 new tables created, 4 dead
   dropped, 3 AMOUNT_UPLOAD tables kept, `visibility_image_hashes` re-columned, enum `{SUBMITTED,APPROVED,REJECTED}`.
3. **API-surface runtime-verified LIVE** (GIFSY-assumed-deoleo + XSR sales `9900000011` + deoleo CLIENT_ADMIN
   `6289864191`): master-switch gate (off→403), config round-trip, form round-trip (validator contract
   `captureGpsOnSubmit⇒GPS_POINT`), admin outlets-in-scope (denominator **694** SSS+SSS_TOT), **IST window `2026-07-P2`
   =[16-31]**, sales eligibility + level-gating (`levelAllowed:true`, `outlets:[]`), tenant report + export
   (CLIENT_ADMIN), full RBAC negative matrix (sales→config 403, CLIENT_ADMIN→gifsy-config/report 403), weekly-reminder
   fail-closed (wrong + no secret → 403). Deoleo **left ENABLED + configured** on staging (SSS/SSS_TOT · freq 2 ·
   XSR/SO/ASM · geoFence 50m) — ready for the owner's smoke.
   - ⚠️ **NOT exercised live:** the capture→approve/reject/resubmit **DB write** state machine — no capture-level rep on
     staging reaches an ACTIVE in-scope outlet (the XSR test rep reaches only 2 inactive WHOLESALER outlets, no
     partner/KYC-geo). It IS jest-covered + is the owner's phone smoke. **Offered the owner a synthetic staging capture**
     (assign a test rep to an active SSS outlet) to prove the write path + the `sales/media` route live before the smoke.

### REMAINING (owner-gated)
1. *(optional)* synthetic staging capture to prove the write state machine live — owner to choose.
2. **~10-min owner phone smoke** (camera / real-GPS geo-fence / web-push — the one device path).
3. **Owner UAT** (owner UATs only once live → I own bug-free).
4. **Prod cutover** — merge develop→main + owner-approved gate; prod pre-check the legacy visibility tables (prod
   dead-scaffolding may have rows — pre-check like scheme). Post-cutover **infra**: Cloud Scheduler for the weekly
   reminder + `VISIBILITY_REMINDER_SECRET`; the `visibility-media/` GCS lifecycle (Standard 4mo → Archive → delete 7y).
