# Visibility (POSM) — Design Doc (locked pre-build)

> Status: **DESIGN — decisions locked with owner 2026-07-27. Awaiting final sign-off on the wave plan before code.**
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
