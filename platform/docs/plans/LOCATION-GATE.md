# Location gate + Location Report — design note

**Status:** built on `feat/location-gate` (worktree `.claude/worktrees/location-gate`, from `7ba69566`), not merged,
not deployed, not runtime-verified on a phone.
**Scope:** TENANT-SCOPED in effect — the gate, the Location Report (tile + API) and the Daily Ops Digest "Location"
line all appear only for tenants with `requireLocation` ON (Deoleo sees nothing new). The code paths are shared
(KYC / visibility services, reports, digest) — owner-approved 2026-11-18.

## Prod fix 2026-11-19 — conditional fence photos (`fix/vis-fence-conditional-fields`, owner-approved)

Bug: Bajaj's visibility form has a Privilege-only "Window 2" (`geoFenceRequired`, `visibleWhen`/`requiredWhen`
`__subProgram__ == Privilege`). At Elite / Unnati outlets the phone correctly hides it, but the server's per-photo fence
iterated EVERY `geoFenceRequired` field, read the hidden empty slot as `'unverifiable'`, and stored `geoFenceOk = null`
(+ `GEO_UNVERIFIABLE`) even though Window 1 was 7–34 m from the outlet.

Fix (helper `applicableCameraFields` in `visibility-form.helper.ts` — reuses `evaluateVisibleWhen` / `isFieldRequired`
with the server outlet context, exactly like submit validation): only photos that APPLY to the outlet — visible AND
(required OR actually captured) — are considered.
- **Fence verdict** (`visibility-capture.service.ts`): gated on `outletMasterGeoEnabled` (the per-photo fence's Bajaj
  tenant gate). Every other tenant evaluates all fence fields as before (Deoleo byte-identical). The per-photo vs legacy
  PATH still follows the schema; an empty applicable list stays "unverifiable" as today.
- **Location gate** (`visibility-location.helper.ts`): runs only under `requireLocation`; it now considers only
  applicable tagged photos (it already skipped hidden/empty ones for the per-photo check; the change makes the
  "form has no location field" decision applicability-aware too).
- **Stored location** (`firstRealFix`) and **review badges** (`visibility-review.service.ts`) already read only photos
  that are present in the stored (validation-projected) values, so a hidden slot never reached them — unchanged.

## Final-audit fixes (round 4, 2026-11-19, on b2570896) — 7 items, all confirmed (none refuted)

1. **Future-timed / untimed board fix**: the phone's `isFixStale` now matches the server exactly — missing / unreadable
   `ts`, older than 55 min (phone) / 60 min (server), OR more than 10 min in the future → Retry location shows. The
   server answers the missing / future case honestly: "The store board photo location has a wrong time — go back to the
   Address step and tap "Retry location"…" (the phone mirrors it, and its stale line says "has a wrong time").
2. **Stored visibility location on the fence path** (switch-on only): the stored representative fix is ALWAYS chosen
   fresh-first (new photos of this request → `captureGeo` → GPS sent now → carried-forward), not the farthest of the
   merged values; the stored `distanceMeters` is recomputed for that SAME fix (null without a reference or when its
   accuracy is worse than the fence radius). The fence verdict (`geoFenceOk`, blocking, flags) still uses every photo
   as before. Switch-off tenants (Deoleo) store the farthest photo exactly as before (test). The Location report reads
   `captureLat/Lng/Accuracy` only (unchanged); `distanceMeters` is shown to reviewers and now matches the stored pin.
3. **No board location at submit**: "No store board location yet — go back to the Address step and tap Retry
   location" (the Retry button shows whenever there is no fix).
4. **Failed Retry on a stale fix**: the green "Location captured" line / icon / green box are hidden while the fix is
   stale (amber box + amber stale line + the red error only). Switch-off tenants render exactly as before.
5. **Clock offset** (byte-identical for switch-off tenants — follow-up): every tenant sends the ORIGINAL settings
   request unchanged. On the two gate pages its `Date` / `Age` headers are read passively → offset `now − (Date + Age)`
   (defensive: either may be missing). Only when the gate is ENABLED and that offset is > 24 h does the phone make ONE
   confirmation request (`cache: 'no-store'`) and recompute; it blocks on the clock only if the confirmation is > 24 h
   too. A failed confirmation never blocks on the clock (the server still refuses with its message). Switch-off
   tenants never make the confirmation request.
6. **Clock guide "Test again"** re-reads the server clock (the same no-store confirmation request) and clears the block when the clock
   is now right; the guide says "Then tap Test again".
7. **Wording**: visibility's stale photo message says "older than 60 minutes" (the server limit), and a future /
   missing photo time says "has a wrong time".

## Re-audit fixes (round 3, 2026-11-19, on e4696bcf) — 8 findings, all confirmed (none refuted)

1. **Location Report tile for MIS_USER**: the index read `/admin/settings/config` (GIFSY_ADMIN / CLIENT_ADMIN only).
   It now calls `GET /v1/reports/location-compliance/enabled` → `{ enabled }` with EXACTLY the report's roles
   (GIFSY_ADMIN, MIS_USER, CLIENT_ADMIN + `reports:read`), so the tile shows exactly when the report would answer.
2. **No submit-time swap of the board fix** (supersedes audit fix 3's swap): the board-photo fix always stays the
   photo's own location + lock time. When it is older than 55 minutes, "Retry location" (the same timed precise acquire
   as the photo, replacing fix and lock time together) and the line "This location is older than 55 minutes — tap
   Retry location" appear on their own (a 30 s on-device timer, gate tenants with a board fix only). The address step
   asks for a fresh board location, and a submit with a stale one stops with the same wording as the server refusal
   ("…Go back to the Address step and tap "Retry location" under the store board photo…").
3. **Phone date/time wrong (> 24 h)**: the API refuses KYC and visibility on switch-on tenants with "Your phone's date
   and time are wrong — set them to automatic (Settings → Date & time) and try again" (when the phone sends
   `clientNow`). The phone notices it first: the settings request's `Date` header gives the server clock (same single
   request — `useTenantFeatures` exposes `serverSkewMs`), and the gate blocks with reason `clock` and that guide.
4. **Camera hold** (supersedes audit fix 6): the last-known "Require location" per signed-in user + tenant host is kept
   in browser storage (try/catch-wrapped). The camera is held only when the last-known value is TRUE and settings are
   still loading, for at most 5 s; unknown (first ever load) and false → never held (the server enforces). Deoleo reps
   never see a held camera.
5. **Settings failure note** returns, only for last-known-TRUE reps: "Couldn't load programme settings — location may
   be required; keep location on." Deoleo never sees it.
6. Covered by the timer in 2.
7. **Only a revoke cancels a submit check**: a newer check (e.g. a "granted" change event) no longer turns the submit
   check into null — it answers with its own valid result; only a permission revoke (`denied`) cancels it.
8. **Stored visibility location prefers fresh sources**: new photos of this request → `captureGeo` → GPS fields sent
   now → only then carried-forward photos / merged-back GPS values.

## Independent audit fixes (2026-11-19, on 7cf3c24c) — all 9 findings confirmed in the code, none refuted

1. **Stored location** (switch-on only): the fence sets `captureLat/Lng/Accuracy` only when it could measure a distance,
   so captures with a fix were stored as "No GPS" (no outlet coordinates, fix worse than 200 m, geotag-without-fence
   forms). Now a representative real fix is ALWAYS stored: first tagged-photo fix → submit-time `captureGeo` → GPS
   field. The fence verdict / distance / flags are untouched, so a poor fix is reported as poor accuracy. Switch-off
   tenants store exactly what they stored before.
2. **geoFenceRequired without geotag**: on switch-on tenants such a photo now records a shutter-time fix (the server
   requires one). Switch-off: unchanged (geotag only).
3. **Stale board fix**: "Retry location" also shows for a stale fix. (The submit-time swap added here was REMOVED in
   round 3 — see re-audit fix 2.) Clock skew: the phone sends `clientNow`; the server measures the fix age on the phone clock when `clientNow` is
   within 24 h of the server clock (else the server clock). `ts` is client-supplied anyway — the rule refuses honest
   OLD fixes (re-KYC pre-fill), and the 24 h bound keeps `clientNow` from widening it.
4. **Location Report** tile listed only when the tenant has `requireLocation` ON (round 3: via the report's own
   `/enabled` probe); the API refuses switch-off tenants with 403 "available only for programmes with Require location…".
5. **No settings-failure note**: removed — Deoleo sees nothing new; the gate stays open on a settings failure and the
   server refuses with a clear message.
6. **Settings still loading**: the visibility camera's shutter is held while settings load (round 3 narrowed this to
   last-known-TRUE reps, ≤ 5 s — see re-audit fix 4). (KYC: the board photo is
   steps away from the first screen and always records a fix.)
7. **Visibility freshness** (switch-on only): new photo fixes, GPS values and `captureGeo` must be ≤ 60 min old /
   ≤ 10 min "future" (same window and same `clientNow` clock rule as KYC). Too old → "the location on "X" is too old —
   retake".
8. **Photo fix budget** (switch-on only, non-precise path): 20 s timeout + cached fix ≤ 30 s, matching the gate.
   Switch-off tenants keep `{ enableHighAccuracy, timeout: 10 s }`.
9. **Revoked mid-check**: a check superseded while in flight (e.g. permission revoked) now returns null, so a submit
   never proceeds on a fix taken before the revoke.

## Release-gate review fixes (2026-11-19)

- **KYC wizard stays mounted** behind the guide (hidden), so typed fields, the signature canvas and photos survive a
  block at submit / a permission change (before: the wizard unmounted, the canvas was destroyed while `hasSigned`
  stayed true → a BLANK consent signature could be sent). The camera overlay is closed while the guide shows. On gate
  tenants a submit also checks the signature canvas has ink (`lib/signature-canvas.ts`); an empty pad resets to
  "Signature required" and nothing is sent. (This canvas check runs only on gate tenants — Deoleo unchanged.)
- **Visibility server rule** (`visibility-location.helper.ts`): every NEW location-tagged photo in THIS request needs a
  real fix; carried-forward photos never cause a refusal; the request needs ≥ 1 fresh fix — a new tagged photo's, a
  GPS_POINT sent in this request, or the phone's submit-time `captureGeo` (new optional field on submit / resubmit,
  sent by the capture sheet from its submit-time check). No fresh fix + a form with no location field → "This form
  has no location field — ask Gifsy to add one".
- **Android app-level block**: geolocation code 1 while the SITE permission reads granted → reason `device` → guide
  "Settings → Apps → Chrome → Permissions → Location → Allow" + phone Location on (iPhone / desktop equivalents).
- **Digest**: the Location section is loaded and shown only for switch-on tenants; blocked attempts are counted by
  `metadata.clientId` (same key as the report).
- **Re-KYC stale geo**: with the switch on the API refuses a board-photo fix whose `ts` is older than **60 minutes**
  (or more than 10 min in the future, or missing) — "take a fresh board photo location". The review suggested ~15 min;
  60 was chosen because a full KYC (address step → bank → signature) often takes longer than 15 min after the board
  photo, and the target is a pre-filled fix from an EARLIER submission (days old). Tunable: `BOARD_FIX_MAX_AGE_MS`.
  The phone clears a pre-filled board-photo fix on gate tenants so the rep re-acquires it (Retry location).
- **Submit-time check UX**: buttons read "Checking location…" (KYC) / a "Checking location…" status line (visibility);
  the check reuses a browser-cached fix up to 30 s old. "Test again" keeps the guide on screen (button "Checking…",
  `aria-disabled` so focus stays), announces "Still no location" via a live region, and shows a visible note.
- **Never-called-back guard**: 20 s request timeout + 25 s while a permission prompt may be open (45 s), + 5 s when the
  site permission is already granted.
- **Photo with no fix**: "Couldn't get a location for this photo — move to open sky and retake." The uploaded file is
  NOT deleted — there is no delete endpoint for sales media (same as today's accuracy-cap rejection); it stays an
  unreferenced object in the media bucket.
- **Features fetch failure**: the gate stays open on the phone (the server still refuses). (The note added in the
  review round was removed after the audit — see audit fix 5.)
- LOW: 0,0 is never a fix (phone + server); the report's roster reads run inside its statement-timeout transaction; the
  visibility form's live cameras are closed while the guide shows; Chrome wording "Permissions → turn Location on".

## Owner decisions (2026-11-18)

1. "No location, no use" applies to **KYC and visibility capture only** (not the rest of the sales app). A rep cannot
   START or SUBMIT either until (a) the site's location permission is granted AND (b) a real GPS fix arrives.
2. When blocked: a full-panel guide for the rep's phone/browser with a **Test again** button. Honest wording.
3. Per-tenant setting, ON for Bajaj, OFF for Deoleo. The API refuses a submission without a valid fix when the setting
   is on. Today's fence rules are unchanged (more than 200 m outside = blocked; outlet without coordinates = allowed
   but flagged).
4. A Location Report (same access as the Usage Report) and a Daily Ops Digest line.

## The setting — `clients.features.requireLocation`

- A new explicit BEHAVIOUR flag (not a reuse of `outletMasterGeo` — the two are independent: the fence needs outlet
  coordinates; the gate needs a fix). Absent / `false` = OFF. Only a real boolean `true` turns it on (the console
  PATCH refuses a non-boolean, like every behaviour flag).
- Read by: `api/src/common/location-gate.helper.ts` (`isLocationRequiredFor` — ON only for `SALES_*` callers; partner
  self-enrollment and admins are never gated), the KYC create path, the visibility capture path, the report (setting
  state), the digest (which tenants show the line); FE via `/api/sales/me` → `normalizeFeatures` → `requireLocation`.

### How to switch it on for a tenant (owner / GIFSY admin — Claude does NOT write staging/prod data)

1. Gifsy console → **Clients** → open the tenant (e.g. Bajaj) → section **Behaviour flags**.
2. Switch on **"Require location for KYC and visibility capture"**. A confirmation lists what changes; confirm.
   (Same `PATCH /api/gifsy/clients/:slug { features: { requireLocation: true } }` path as every behaviour flag —
   GIFSY_ADMIN + `tenancy:write`, audited per key; every other stored flag is kept.)
3. Reps pick it up the next time the KYC page / capture sheet loads (features are read on page load). Switching it
   off takes effect the same way.
4. Recommended order for Bajaj: deploy → switch on in **staging** → check on an Android phone and an iPhone (allow /
   deny / Location off / Test again) → switch on in **prod**.

No in-app Help guide: switching it on is one toggle.

## Phone side (platform)

- `src/lib/location-gate.ts` — `checkLocation()`: no geolocation → `unsupported`; not https → `insecure`; Permissions
  API says `denied` → `denied` **without asking** (the browser would not prompt anyway); otherwise one
  `getCurrentPosition({ enableHighAccuracy: true, timeout: 20 s, maximumAge: 30 s })` → OK with a valid fix, or
  `denied` (code 1) / `unavailable` (code 2) / `timeout` (code 3). A garbage fix (NaN / out of range) = `unavailable`.
  Never rejects; a 5 s guard covers browsers that never call back.
  **Honest limit:** a browser cannot read the phone's Location switch — "Location off" shows up as no fix
  (`unavailable` / `timeout`). Older Safari has no Permissions API → we rely on the request result. Both are stated
  in the guide footnote.
- `detectLocationPlatform()` → `android` / `ios-safari` / `ios-app` (home-screen app) / `desktop`; `locationGuide()`
  gives the steps per platform × reason (Android: site settings → Location → Allow; device Location + Google Location
  Accuracy; installed app uses Chrome's site setting. iPhone: Settings → Privacy & Security → Location Services → On →
  Safari Websites → "While Using the App" + Precise Location; Safari "aA" → Website Settings → Location; installed app:
  same Safari Websites setting, then close and reopen. Desktop: address-bar site info → Location → Allow; Windows /
  Mac location services).
- `src/lib/use-location-gate.ts` — OFF → does nothing at all (no permission query, no geolocation call, no listener).
  ON → checks on mount ("checking" → "ok" | "blocked"), re-checks when the browser reports a permission change,
  `recheck()` for **Test again**, `recheck({ quiet: true })` for the submit-time check (page stays as-is unless it
  fails).
- `src/components/location/LocationGatePanel.tsx` — "Checking your location…" (polite live region), or the guide:
  heading takes focus, numbered steps, footnote, **Test again**.
- **KYC** (`app/sales/kyc/new/page.tsx`): while blocking, the wizard is replaced by the panel (with a back link to the
  KYC list); wizard state lives in the page, so nothing typed is lost. `handleSubmit` runs a quiet re-check before
  anything is sent. The OTP / done steps (after submission) are never gated. The existing board-photo / payment
  location requirements are unchanged.
- **Visibility** (`app/sales/visibility/VisibilityCaptureSheet.tsx`): the panel shows above the form, the form area is
  HIDDEN but stays mounted (photos already taken are kept); submit re-checks first and is not sent on failure.
  `VisibilityCaptureForm` gets `requireLocation`: a location-tagged photo taken with no fix is NOT kept ("No location
  was captured — location is required here…"), and a submit-time GPS fill with no fix stops the submit. OFF → exactly
  as before (photo kept "saved without location", flagged by the server).
- No network request is added (geolocation / Permissions API are on-device) → nothing needs `X-Background`.

## Server side (api)

- **KYC** (`kyc.service.ts` `create`): when ON for a sales caller, `boardPhotoGeo` must be a valid fix
  (`isValidGeo`) → else 400 `LOCATION_REQUIRED_KYC_MESSAGE`, before any write. Board photo = the fence subject and the
  report's KYC location. (The payment-step location stays a phone-side requirement only.)
- **Visibility** (`visibility-capture.service.ts` `persistCapture` + `visibility-location.helper.ts`): when ON, every
  location-tagged photo submitted NOW (CAMERA with `geoFenceRequired` or `geotag`, with a key) must carry a valid fix;
  photos carried forward unchanged on a partial re-capture are not re-checked; a GPS_POINT-only form needs one valid
  point; a form with **no location field at all** is refused with "ask Gifsy to add a location to the form" (never
  silently accepted). 400 before any write.
- **Blocked outside the fence**: when ON, every "more than 200 m from the outlet" refusal (KYC and visibility) writes
  ONE `AuditLog` row — action `REJECT`, entityType `LOCATION_FENCE_BLOCK`, entityId = outlet id, actor = the rep,
  metadata `{ flow, clientId, distanceM, accuracyM }` — best-effort (a failed write is logged, the rep still gets the
  same message). Not recorded for tenants with the setting OFF, and never before this shipped.
- Unchanged: the fence itself (200 m, accuracy buffer, coordinates-missing → unverifiable), every OFF tenant.
- No schema change, no migration.

## Location Report

- **Page** `/admin/reports/location` (listed on `/admin/reports`, Engagement — only for switch-on tenants; the API answers 403 for others). **API**
  `GET /v1/reports/location-compliance?from&to&role&region&sort&page&pageSize[&format=xlsx]` —
  `@Roles('GIFSY_ADMIN','MIS_USER','CLIENT_ADMIN')` + `reports:read`, exactly the Usage Report's gate; page permission
  inherits `/admin/reports` (`reports:read`). IST dates inclusive, default last 30 days, max 366.
- **Scope:** the caller's JWT `clientId`. Reps = the tenant's `SALES_*` users (incl. deactivated — their past work
  counts); every source joins through those ids AND re-checks the tenant where the row has it.
- **Builder** `api/src/reports/location/location-compliance-report.ts`: reads features + `visibilityConfig` (is the
  visibility fence on?), the reps, their assignments (region), then ONE SQL (`GROUPING SETS` → per-rep rows + one
  totals row, so medians of the filtered population are real medians) in its own transaction with a 20 s statement
  timeout (timeout / pool busy → clear 503). Proven against real Postgres (PGlite) in the spec.
- **Columns:** KYCs (by `submittedAt`, filed by the rep) · visibility captures (every submission incl. re-captures, by
  `createdAt`) · no GPS · accuracy worse than 50 m · flagged unverifiable (KYC `geoFenceStatus = UNVERIFIABLE` —
  recorded on outlet-coordinate-fence tenants only; visibility `geoFenceOk` NULL counted only when the tenant's fence
  is on) · blocked outside fence (the audit rows above) · median accuracy (all fixes) · median KYC lock time
  (`geoLockMs`, outlet-coordinate-fence tenants only). Rows = reps with any of these in the range.
- **Filters:** role, region (employee-record region, else directly-assigned outlets' states — same rule as Usage),
  sort (most issues / most captures / name). Totals follow the filters.
- **Excel** export kind `location-compliance` (light → streams): "Location" sheet (rows + TOTAL row) + "About" sheet
  (setting state, every column rule, filters). 0 rows → 404 "0 reps matched these filters." One `AuditLog`
  (EXPORT / LOCATION_COMPLIANCE_REPORT) before any byte (names + mobiles leave the system).

## Daily Ops Digest line

- `scheduled-reports.service.ts` `location()` per tenant (7 indexed counts): sales-rep KYCs + visibility submissions
  in the window, without GPS, accuracy worse than 50 m, and recorded fence blocks. Section **"Location"** shown only
  for a tenant with `requireLocation` ON (then also with zeros, plus a "Require location is ON" note and the blocked
  count). Switch-off tenants (Deoleo) never load it (email unchanged). Blocks counted by `metadata.clientId`. Amber
  figures; not an attention bullet. A failed load degrades the run like any section.

## Tests (targeted)

api: `common/location-gate.helper.spec.ts`, `visibility/visibility-location.helper.spec.ts`,
`kyc/kyc.service.spec.ts` (describe `requireLocation`), `visibility/visibility-capture.service.spec.ts`
(describe `requireLocation`), `gifsy/gifsy.service.spec.ts` (requireLocation PATCH), 
`reports/location/location-compliance-report.spec.ts` (incl. real-Postgres SQL), `exports/kinds/round-trip.spec.ts`,
`reports/scheduled/*` (Location line).
platform: `lib/__tests__/location-gate.test.tsx`, `app/sales/kyc/new/__tests__/kyc-location-gate.test.tsx`,
`app/sales/visibility/__tests__/capture-sheet-location-gate.test.tsx`,
`components/visibility/__tests__/capture-form-gps.test.tsx` (CFG-LG), `app/admin/reports/__tests__/location-report.test.tsx`,
`lib/__tests__/tenant-features.test.ts`, `lib/__tests__/route-permissions.test.ts`.

## Not verified / open

- Not exercised on real phones (Android Chrome, iPhone Safari, installed apps): permission prompts, the guide steps'
  exact menu names on the owner's devices, Permissions API `change` events.
- "Not interested" on the KYC page sits behind the gate on the phone (the whole page is gated) but the
  `/kyc/not-interested` API is NOT location-gated (it is not a KYC submission).
- Refusals for "no location" are not recorded (only fence blocks are) — they never create a row, so the report
  cannot count them.
