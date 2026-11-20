# Visibility (POSM) — Design Doc (locked pre-build)

> Status: **✅ IN PROD since cutover #16 (2026-07-28)** — per-tenant `visibilityConfig`; see the status section further down. _(Original header: LIVE ON STAGING `6e3b897` — NOT in prod, at the time.)_
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
  *Review layout (2026-11-19):* the review opens in a centred dialog (~90% viewport; full-screen on a phone) —
  header = outlet name + code + **Program / Sub-Program** + window + rep + geo verdict; photos large
  (side by side, stacked on narrow screens); Geo-fence / Captured values / History scroll below the
  photos; Approve/Reject are a footer pinned to the bottom of the dialog (outside the scroll area;
  Approve right-aligned as primary); an explicit "Next capture" button after a decision. The dialog
  starts below the Gifsy operator banner (`data-operator-banner`) so its header + close are never covered. The queue list has a Program column. **Program / Sub-Program are
  read from the LIVE outlet master** (`Outlet.programName` / `Outlet.programCategory`, joined at read time,
  not denormalised onto the capture) — so if the outlet's programme changes after capture, the review shows
  the current value, not the value at capture time (deliberate: decisions follow the current programme).
- **D13 — Outlet info view** (`sales/kyc/[id]`): a "Visibility — this period" card showing each window's status,
  with a **Capture CTA** (redirect preselected to the outlet) when the current window is due / missing / rejected.
- **D14 — Sales Tasks:** a "Visibility captures due" group (mode-aware, reach-scoped), showing **N-of-M for the
  current window** and opening the capture sheet.
- **D15 — Reporting:** Gifsy coverage view **per window** (captured / pending / approved / rejected / missed) +
  tenant **read-only** + **Excel export with auth-gated photo links** and a geo-fence-flag column.
  *(Superseded 2026-11-20 by the MONTH-WISE report screen + dashboards and the redesigned monthly Excel export — see §17.)*
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
- **Go-live infra — ✅ DONE 2026-07-28 (post cutover #16):** `VISIBILITY_REMINDER_SECRET` (prod) +
  `VISIBILITY_REMINDER_SECRET_STAGING` Secret-Manager secrets created + granted to `gifsy-api-sa` + bound
  additively on both api services + wired DURABLY into `deploy.yml`/`deploy-staging.yml` `--set-secrets`
  (KYC-cleanup lesson: a manual `gcloud run update` is wiped by the next `--set-secrets` deploy). Weekly
  Cloud Scheduler `visibility-reminder-prod` / `-staging` (Mon 09:00 IST, header-gated `x-visibility-reminder-secret`,
  no OIDC — mirrors `kyc-cleanup-*`). VERIFIED: prod correct-secret → `201 {tenants:0,...}` (dormant), wrong/no
  secret → 403 fail-closed; staging correct-secret → `201 {tenants:1,repsNotified:141,outletsPending:694}` (proves
  the compute+enqueue path end-to-end). A rep with no push subscription simply gets nothing pushed — the Tasks
  badge is the always-visible fallback.
- **Photo retention lifecycle — ✅ DONE 2026-07-28 (owner "now"): Standard → Archive → delete at 7 years.**
  GCS Object Lifecycle on `gifsy-platform-files` scoped to the `visibility-media/` prefix: **age 120d →
  SetStorageClass ARCHIVE; age 2555d (7y) → Delete** (added ALONGSIDE the 2 pre-existing rules — whole-bucket
  NEARLINE@90d + tmp/ Delete@730d — both preserved; terraform `gcs-memorystore.tf` synced to match, no drift).
  ⚠️ NUANCE: the pre-existing whole-bucket NEARLINE@90d ALSO applies to visibility-media (GCS lifecycle has no
  prefix-exclusion), so visibility photos actually flow **Standard → NEARLINE@90d → ARCHIVE@120d → Delete@2555d** —
  cheaper than the literal "Standard 4mo" but functionally equivalent (all classes instant-access; ARCHIVE min-
  duration 365d satisfied 120d→2555d). Archived photos stay instantly viewable via the same auth-gated link (tiny
  per-view retrieval fee, no restore step). NOTE separately: KYC docs have no retention policy — future compliance.

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
`GET /report`, `GET /report/tenant` (read-only), `GET /report/export[?month=YYYY-MM][&windowKey=]` (§17), auth-gated `GET /captures/media?key=`.
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

**✅ BUILT + dual-audited + fully gated. Committed `2e28ac4` on develop — since SHIPPED: LIVE in prod from cutover #16 (dormant per tenant until `visibilityConfig` is set).**
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

---

## 17. Visibility reporting, review history + plain words (2026-11-20, ⚠️ PLATFORM-WIDE, owner-approved in-session)

Three tracks integrated on `feat/visibility-integration` (develop `54a6d63b` + `feat/visibility-review-history` +
`feat/visibility-report-dashboards`); local only — not pushed / applied anywhere yet. §17.1 holds the rules every
surface shares (written once); §17.2–17.5 describe each surface.

### 17.1 Shared rules — one module, one in-scope rule, one word list

- **Imported (old-app) history — ONE module** `api/src/visibility/visibility-portal-go-live.ts` (do not re-derive):
  - *Imported capture* = a photo key containing `/vendor-import/` (`isImportedVisibilityCapture`; the import re-hosted
    old-app photos there, BAJAJ-PROD-OUTLET-IMPORT §8). Never "no submitting rep" (a removed rep nulls that column — shown
    *Rep (no longer on file)*). The review-events migration SQL uses the same string.
  - *Portal go-live* = the INSTANT of the earliest capture with no imported photo (`visibilityPortalGoLive`, MIN
    `receivedAt`); go-live month = its IST month.
  - *Per window* (`classifyWindowAgainstGoLive`): **old** = ended at/before go-live (no go-live yet: the reported scope
    holds imported captures) → only what the old app recorded, no "Missed"; **part-old** = holds imported captures or
    began before go-live → a closed window with no capture is *No approved record — part of this window was on the old
    app*; else **portal** (normal rules). Used by the Excel Not-captured sheet AND the report screen.
  - *Imported month* = every window of it is old (`isVisibilityImportedMonth`: before the go-live month; no go-live yet →
    a month holding captures): coverage / Missed / participation are not tracked (`IMPORTED_MONTH_NOTE`). Used by the
    report screen, the Operations funnel and the digest.
- **In scope — THE single rule** `visibilityUniverseWhere` (`visibility-scope.helper.ts`): not deleted · not deactivated ·
  **`isActive: true` (KYC-approved)** · kycIntent not NOT_INTERESTED / PARKED · outletType.code ∈ `outletScope` · optional
  programs / sub-programs. Option `activeDuring: {start, end}` (Excel Not-captured sheet, past windows): created before
  `end` and active today or deactivated after `start` (deactivation flips `isActive` off and only hits active outlets).
  Why `isActive`: a pending-KYC outlet the rep can never see was reported as *Missed* under the old KYC "addressable"
  universe (that universe stays for KYC program-health only). The SAME rule drives the rep capture list, weekly reminder,
  admin "outlets in scope", report screen, Excel, both dashboards, digest, submit / resubmit (`loadInScopeOutlet`, a 400
  with a plain reason from `visibilityOutOfScopeReason`), the outlet status card, the sales team view and the partner
  group page (§17.5). Known limit: a past period uses TODAY's outlet type / programme / KYC state (no outlet history).
- **Plain status words — one list per side, same strings, pinned by a test on each side:** API `VISIBILITY_WORDS`
  (`visibility-report-labels.ts` → `PLAIN_STATUS_LABEL` in `visibility-metrics.ts`, the Excel, status report, digest);
  platform `VISIBILITY_STATUS_WORDS` (`lib/visibility-types.ts` → `lib/visibility-report.ts`, queue / dialog, sales,
  partner).

| Plain status | Rule |
|---|---|
| Waiting for review | capture `SUBMITTED` (any window — Gifsy can still review it) |
| Approved | capture `APPROVED` |
| Needs re-take | `CHANGES_REQUESTED` and the window is still **open** |
| Rejected | `REJECTED` (whole capture) and the window is still **open** |
| Not approved — window closed | `CHANGES_REQUESTED` / `REJECTED` and the window has **closed** — a resubmit is refused (`resubmitCapture`), so it is final, never "waiting on reps". Report screen, Excel (status + About), queue / dialog badge (API `windowClosed`), digest |
| Not captured yet | no capture, window open (Excel: "Not started" when the window has not begun) |
| Missed | no capture by the time the window **closed** (IST) — never in an old / part-old window |
| Not tracked for imported months | an old window / imported month — no slot for a missing visit |
| No approved record — part of this window was on the old app | closed part-old window, no capture |

### 17.2 Month-wise report screen + dashboards + digest

One set of definitions behind every Visibility number: the report screen, the admin **Pending Visibility Approvals**
tile, the Operations **Visibility Program Funnel** and the **Daily Ops Digest**. Code: `api/src/visibility/visibility-metrics.ts`
(+ `visibility-report.service.ts`); FE client: `platform/src/lib/visibility-report.ts` (words from `lib/visibility-types.ts`, §17.1).
**Only PHOTO_APPROVAL tenants** get the new numbers; **AMOUNT_UPLOAD tenants (no capture flow) are unchanged** on every
surface (the old queries run, byte-identical).

**Month-wise.** Every surface takes a month `YYYY-MM` (default = the current **IST** month; any past month). A month selects
every window `YYYY-MM-Pn` of it. Imported old-app records carry `windowKey = <their month>-P1`, so they count in their
own month (the outlet list labels them *Old app (imported)*).

**Unit = an outlet-window ("visit due").** In scope × windows of the selection (frequency 1 → one per outlet). Each has
exactly one plain status.
The plain statuses and their rules are in §17.1 (one table for every surface).

**Report** (`GET /v1/visibility/report[/tenant]?month=&windowKey=`): tiles In scope · the plain statuses (the old-app tile only when non-zero) · Coverage
(= Approved ÷ In scope); breakdowns by **Programme / Sub-programme**, **Rep** (the outlet's current active assignment to a
non-deleted rep) and **Manager** (the first ACTIVE manager above that rep, vacant levels skipped — `firstActiveApproverId`);
`GET …/outlets?status=&group=&groupKey=&page=&pageSize≤200` = the outlets behind any tile or row (status, rep, manager,
captured by/on, reviewed by/on — reviewer = the last photo decision's reviewer, else the whole-capture reviewer; a capture
back in *Waiting for review* only shows photo decisions made after its last (re)submission `receivedAt`). Tiles, rows and
lists come from ONE slot table, so they always add up. **Not counted, shown loudly:** captures in the selection whose
outlet is no longer in scope, and (all-windows view) captures in a window the current frequency does not have
(`notCounted`) — the screen states the count and that every one of them is in the month's Excel export (the month
export reads every window key P1..P4 and every capture, in scope or not). Definitions are keyboard /
touch toggletips, the breakdown tabs are ARIA tabs (arrow keys), and the coverage bar has a text alternative + legend. Known limit: "in scope" for a past month
uses TODAY's outlet state (there is no per-month outlet snapshot). **Exports on the screen (admin AND client admin):**
*Export Excel* = one window (pick one when the month has several); *Export <month>* = the whole selected month
(background → Downloads page). Response also carries `portalGoLive` (ISO / null).

**Admin tile** (`GET /v1/admin/dashboard/kpis?visibilityMonth=`): `pendingVisibility` = **every** in-scope capture still
**Waiting for review, any month** (Gifsy's whole queue — an older capture still waiting is never dropped);
`visibility.waiting` = the picked month's share, `waitingEarlierMonths` = the rest; `waitingOnReps` = Needs re-take +
Rejected in an open window; `closedNotApproved` shown apart. The program filter is ANDed onto the in-scope rule. AMOUNT_UPLOAD: unchanged all-time `SUBMITTED` count, `visibility: null`.

**Operations funnel** (`operations?visibilityMonth=`, `operations/visibility?month=`, `operations/visibility/flags?month=`):

| Figure | Definition |
|---|---|
| Submitted | this month's captures for in-scope outlets, any status |
| Approved / Waiting / Needs re-take / Rejected / Not approved — window closed | by current status + whether the window has closed; `waitingAllMonths` / `waitingEarlierMonths` = Gifsy's whole queue |
| Approval rate | Approved ÷ every decided capture (Approved + Needs re-take + Rejected + Not approved — window closed); *Waiting* excluded; `null` ("—") when nothing is decided |
| Flagged | captures with a **duplicate photo** (a `VisibilityImageHash` shared with ANOTHER capture of the tenant, any outlet / month) **or** a photo **outside the fence** (stored `geoFenceOk = false`, or any fence-required photo classified `outside` today by the reviewer's per-photo policy: outlet-master tenants = outlet coords + 200 m + accuracy buffer; others = latest APPROVED KYC board-photo geo + configured radius). Counted once per capture; computed whether or not the fence is switched on. *Unverifiable* (no fix / no reference) is NOT outside, so imported photos are never flagged |
| Fraud flag rate | Flagged ÷ Submitted (`null` when nothing was submitted) |
| Participation | in-scope outlets with ≥1 capture this month ÷ in-scope outlets; `null` ("Not tracked") for an imported month |

The flags list gives each flagged capture's reason(s): which other captures share the photo (at most 10 listed, the full
`duplicateCount` kept), which photo is outside. **Gifsy roles only for now** (owner decision pending): client roles get
the counts on the funnel (`flagDetailsAvailable: false`) and a 403 on `…/flags`. One fraud scan per tenant-month is reused
for 60 s by the funnel and every flag-list page.

**Daily Ops Digest** (PHOTO_APPROVAL tenants): *reviews done / approved / sent back or rejected* = **one per capture per IST
day, by that day's final outcome** (each photo's last decision that day; any rejected → sent back), rebuilt from the live +
every submission version's `photoReviews` — so a rejection then a same-day resubmit still counts; TODO hook for the
review-events table (§17.4) — still OPEN: the digest does not read it yet. *Right now* = Waiting for review across **all months** (earlier-months share called out) and waiting
on reps (open windows only); "not approved — window closed" listed when non-zero. The section never hides while anything is
waiting. See DAILY-OPS-DIGEST.md.

The old `visibilityApi.getReport/getTenantReport` + `VisibilityReport` type (per-window shape) are superseded by
`visibilityReportApi`.

### 17.3 Visibility Excel report (export kind `visibility-captures`)

Export kind `visibility-captures` (`api/src/exports/kinds/batch1/visibility-captures.ts`), `GET /v1/visibility/report/export`
(GIFSY_ADMIN + CLIENT_ADMIN, `visibility:read`). Applies to every photo-capture tenant (Bajaj is the main one).

- **Scope:** one IST month — `?month=YYYY-MM`, default = the request's IST month (→ Downloads page, background) — or one
  window `?windowKey=YYYY-MM-Pn` (old param, kept; streams now). A month reads every window key P1..P4 of that month.
  Imported old-app history is included in its month and labelled **Source = "Imported (old app)"** (§17.1 rule);
  everything else is "Portal app".
- **Sheet "Visibility"** — one row per capture (outlet × window): Outlet Code · Outlet Name · Outlet Type · Programme ·
  Sub-programme · City · State · Window · Source · Status (**Waiting for review** / **Approved** / **Needs re-take** /
  **Rejected** / **Not approved — window closed** for a re-take / rejection whose window has closed) · Captured by · Rep code · Rep designation · Manager (first ACTIVE manager up the chain, "Name
  (Designation)", `firstActiveApproverId`) · Captured on (**"Not recorded"** when the phone sent no capture time;
  "Not recorded (old app)" for imported — never a silent blank) · Submitted on · Re-takes (currentVersion − 1) · Location
  check (Inside fence / Outside fence / Unverifiable + m + ±accuracy; imported = "Not recorded (old app)") · Duplicate
  photo (Yes/No) · Reviewed by / Reviewed on (latest per-photo review, else the whole-capture reviewer) · Overall remark
  (whole-capture reject reason, else "Re-take needed: <photo label>: <reason>; …").
  Then per CAMERA field — the union across the form versions in scope, ordered by the CURRENT form, header = the
  field's LABEL (duplicate labels get " (2)"): `<Label> – Photo` (clickable "Open photo") · `– Decision` (Approved /
  Rejected / Pending / **Not applicable** when the field's visibleWhen hides it for the outlet / blank when not taken) ·
  `– Reason` · `– Reviewed by` · `– Reviewed on` · `– Location`.
- **Sheet "Review history"** — one row per submitted version per photo (`VisibilityCaptureSubmission` + its
  `photoReviews` snapshot). An older version without a snapshot reads "Not recorded". Imported captures have no
  submission rows. Full who/when history for whole-capture rejects is recorded from the next release (noted on About).
- **Sheet "Not captured"** — in-scope outlets (`visibilityUniverseWhere` with its `activeDuring` option — §17.1) with
  no capture for an expected window: assigned ACTIVE rep(s) + manager; status **"Not captured yet"** (window open, IST),
  **"Missed"** (closed) or **"Not started"** (not begun). Expected windows = the CURRENT frequency's windows only
  (history not stored). Old-app windows per the §17.1 go-live rule: an 'old' window → one row "Not tracked for imported
  months — …"; a CLOSED 'part-old' window → **"No approved record — part of this window was on the old app"** instead of
  Missed (counted on About). A window from an EARLIER frequency (P3 when the programme is now monthly) lists its visits
  but has no Not-captured rows and no guessed dates (About explains).
- **400s** (endpoint `assertExportScope`, re-checked in the run): a malformed window ("That window isn't valid."); a
  future month/window; a window the frequency has no period for (P2 on a monthly programme) unless captures exist for
  that key. The admin month picker stops at the
  current India month.
- **Current-version review info:** a per-photo approval older than the current version's submission is shown as
  "Approved (earlier version)"; the visit-level Reviewed by/on only uses reviews of the current version (blank while
  waiting for review).
- **Hyperlink cap:** after 60,000 links in a sheet (Excel's limit is ~65,530) the photo address is written as text and
  About says how many (`VISIBILITY_LINK_LIMIT`).
- **Sheet "About"** — scope, generated-at (IST), counts per status word incl. "Not approved — window closed" (= the
  Visibility sheet), meanings of every status (incl. why "Not approved — window closed" is final) and column, how photo links work (+ the domain-picker note when the link fell back).
- **Photo links** — ABSOLUTE `https://<tenant primary host>/visibility/photo?key=<encoded key>`; host via
  `pickTenantDomain` + `tenantPortalLink` (`api/src/tickets/ticket-link.ts`, the ticket-email rule: strictly the
  isPrimary domain, never a staging/uat host in prod, fallback `<slug>.gifsy.in`; staging → `uat-` host; local → the
  request origin). Target = the platform page `app/visibility/photo/page.tsx`: a signed-in PAGE that renders for ANY
  signed-in role (no proxy ROLE_ROUTES entry; NOT public — no session → sign-in with `next`; after sign-in EVERY role
  returns to the photo, so a role without access reads the message). It loads `/api/visibility/captures/media?key=` (role-gated,
  tenant-pinned; another tenant's key → **403**, decided from the key alone), shows it full-width with Download, and
  says "You don't have access to this photo" (403 — incl. MIS / partner / vendor) / "Photo not found" (404 / no key);
  an image the browser can't render → "can't be displayed in the browser" + Download.
- **Cells:** text via the streaming writer (`cellSafe` formula-injection guard on every string; hyperlinks as real
  cell links). Dates are IST text "20 Nov 2026, 3:05 pm" — the streaming writer runs without a styles table (memory),
  so real date cells would show as serial numbers.
- **Performance:** captures keyset-paged (≤ 2,000; windowKey, outletCode, id); per page one query each for duplicate
  hashes, reference geo, reviewer names (cached across pages); the tenant's sales directory is read once.
- **Status report** (`visibility-status`, JSON + xlsx) uses the same status words.
- **Admin UI:** the report screen (GIFSY tab and the client-admin page) has "Export Excel" (selected window) and
  "Export <month>" (the month picked on the screen — no second month picker).
- Tests: `visibility-captures.spec.ts` (workbook read-back), platform `app/visibility/photo/__tests__`, proxy +
  return-to role tests.

### 17.4 Permanent review history (append-only)

- **Why:** a resubmit nulls `rejectionReason/Code`, `approvedByUserId`, `reviewedAt` on the live `VisibilityCapture`
  and resets `photoReviews`; submission versions keep only `SUBMITTED` + a photoReviews copy → "who sent back which
  photo, when, why" was lost.
- **Table** `visibility_review_events` (model `VisibilityReviewEvent`, enum `VisibilityReviewAction`), migration
  **`20261120140000_visibility_review_events`** (additive, `lock_timeout 5s`, IF-NOT-EXISTS / DO-block guards, no FK so
  history outlives a capture row). Columns: `clientId, captureId, outletId, windowKey, version, action, statusAfter?,
  fieldId?, fieldLabel?` (snapshot) `, reasonCode?, reason?, actorUserId?, actorName?` (snapshot) `, backfilled, createdAt`.
  Indexes `(clientId, windowKey)`, `(captureId)`.
- **Actions:** `SUBMITTED` (v1) · `RESUBMITTED` (v>1) · `PHOTO_APPROVED` · `PHOTO_REJECTED` · `CAPTURE_APPROVED_ALL` ·
  `CAPTURE_REJECTED_ALL` · `CHANGES_REQUESTED_RESULT` (a per-photo reject moved the capture INTO Needs re-take; written
  once per transition).
- **Writers (same transaction as the state change):** `VisibilityReviewService.persistReview` (per-photo, approve-all,
  reject-all) and `VisibilityCaptureService.persistCapture` (submit / resubmit). Helper: `visibility-review-events.ts`
  (`appendReviewEvents(tx, …)`). App code never updates/deletes events.
- **Backfill (in the migration, runs only in the run that creates the table, rows `backfilled = true`) — only what
  the old data can honestly tell, no invented per-photo decisions:**
  - **Imported old-app captures** (Bajaj ~51k; any photo key contains `/vendor-import/` — the §17.1 rule,
    `isImportedVisibilityCapture` in `visibility-portal-go-live.ts`, the same string in the SQL): exactly ONE `CAPTURE_APPROVED_ALL` event,
    actor = **"Imported — old app approval"** with no actor id (the row's `approvedBy` is only the Gifsy admin who ran
    the import), dated at the original approval (`reviewedAt`, else `updatedAt`/`createdAt`).
  - **Every other capture:** one SUBMITTED/RESUBMITTED event per submission row (rep + name, at its `createdAt`) and ONE
    summary event for the CURRENT outcome (APPROVED → CAPTURE_APPROVED_ALL · REJECTED → CAPTURE_REJECTED_ALL + reason ·
    CHANGES_REQUESTED → CHANGES_REQUESTED_RESULT; nothing for Waiting for review), `statusAfter` filled. The UI shows these
    as the outcome only ("Approved" / "Rejected" / "Sent back") marked "from earlier records".
  - **Never aborts on bad dates:** all dates come from timestamp columns; the one JSON date read (latest sent-back photo
    for a Needs re-take capture) goes through a NULL-on-error helper `_vre_safe_ts` (regex guard + EXCEPTION block,
    created and dropped inside the migration) and falls back to `updatedAt`/`createdAt`.
  - Deterministic ids `vrebf_<captureId>_<version>_<0 submit|1 review>`; the API also sorts same-timestamp events by
    version + action rank (`compareEventsNewestFirst`).
  - Proven on real Postgres (PGlite): `api/src/visibility/visibility-review-events.migration.spec.ts` (imported, garbage
    dates, summaries, helper dropped, idempotent second run).
- **Lost-update guard:** `persistReview` writes the capture only if it is still the row that was read (same status,
  version, `updatedAt`) — Postgres re-checks under the row lock; a loser gets **409 "This visit was just changed by
  someone else — reload"** and writes no event. Approving an already-approved photo is a no-op (no second event).
- **Imported captures in the dialog:** `GET /captures/:id` returns `imported: true` and nulls `approvedBy`; the header
  reads "Imported — old app approval on <date>" and the timeline never names the importing admin.
- **Tenant wipe:** `api/prisma/wipe-tenant-data.ts` deletes `VisibilityReviewEvent` first in the Visibility tree.
- **API:** `GET /v1/visibility/captures/:id` now also returns `reviewHistory[]` (newest first; actor name = snapshot,
  else the user's current name, else null → UI "Unknown user") and `lastReview` (latest review of the CURRENT version).
- **UI (admin capture dialog):** "Review history" timeline (who / what / which photo / reason / IST time; backfilled rows
  say "from earlier records"); header "Reviewed by <name> on <date time IST>"; an orange **Needs re-take** remarks box
  listing every sent-back photo + reason (the red banner still covers whole-capture Rejected).

### 17.5 Plain words in the UI + Bajaj screen fixes

`VISIBILITY_STATUS_WORDS`: SUBMITTED **Waiting for review** · APPROVED **Approved** · CHANGES_REQUESTED **Needs re-take** ·
REJECTED **Rejected** · no capture **Not captured yet** · window closed without approval **Missed**. Derived:
`VISIBILITY_CAPTURE_STATUS_LABELS`, `visibilityStatusLabel(status, {windowClosed})`, `CAPTURE_UI_STATE_LABELS`
(due/awaiting/approved/rejected/changes_requested/late), `captureUiStateLabel`, `VISIBILITY_SUMMARY_BUCKET_LABELS`,
`reviewActionLabel`. Used by: admin queue + filter + dialog, admin coverage report tiles, sales visibility list, outlet
"Visibility — this period" card, sales dashboard summary tiles, sales outlets badges, sales task subtitles, partner group
page, month report screen. Codes stay in data.
- **Missed** is used only once the window has closed for good: a `late` row the rep can still act on (task list, sales
  capture list) reads by its capture status instead (`actionableStateLabel`). A photo chip reads **Rejected** when the
  whole capture was rejected (reject-all), **Needs re-take** for a per-photo send-back.
- The dashboard 5-bucket logic is UNCHANGED (owner's earlier design): `partial` = "Partly approved" (Needs re-take with
  ≥1 photo approved); `rejected` = "Rejected / Needs re-take" (rejected, or Needs re-take with nothing approved).

- **Partner group page** (`GET /v1/partner/group/visibility`): PHOTO_APPROVAL tenants now read `VisibilityCapture` for
  the CURRENT window (IST, tenant frequency) — `mode: 'PHOTO_APPROVAL'`, `windowKey`, `window`, counts
  `{total, approved, waiting, needsRetake, rejected, notCaptured, notInScope}`, rows with `inScope` (out-of-scope group
  outlets listed as "Not part of visibility", not counted). AMOUNT_UPLOAD tenants: unchanged response (+ `mode`).
  A FAILED request shows "Couldn't load visibility…" in the section (never hidden). In scope = `visibilityUniverseWhere`
  narrowed to the group (§17.1) — so a group outlet not KYC-approved yet reads "Not part of visibility".
- **Sales dashboard + Tasks** ask for the AMOUNT_UPLOAD month in IST (`istMonthKey`), not the UTC month.
- **`GET /v1/visibility/outlet-statuses?outletCodes=&month=`** (was called by sales outlets/tasks/dashboard but did NOT
  exist → 404 → silently empty): implemented for AMOUNT_UPLOAD tenants (`admin-programs/visibility.service.ts
  getOutletStatuses`, controller `VisibilityOutletStatusesController`): visibility ON + mode AMOUNT_UPLOAD (PHOTO_APPROVAL →
  400), partner logins 403, SALES callers limited to their downline's assigned outlets, ≤2,000 codes, month YYYY-MM.
  FE `fetchOutletVisibilityStatuses` returns **null on failure** (chunks of 250 codes — keeps the URL well under header
  limits; the server cap stays 2,000) and every caller shows
  "Couldn't load visibility status" instead of fake "pending" tasks; the outlets page only calls it for
  `visibilityEnabled && visibilityCaptureMode === 'AMOUNT_UPLOAD'` (tasks/dashboard already gated by mode).
- Which tenants are AMOUNT_UPLOAD: mode defaults to PHOTO_APPROVAL and `bulkUpload` refuses other modes; per the docs
  Deoleo launched with visibility OFF and Bajaj is PHOTO_APPROVAL — so most likely NO tenant is AMOUNT_UPLOAD today.
  **Not DB-verified** (needs a read of `clients.features->>'visibilityCaptureMode'` on staging/prod).
