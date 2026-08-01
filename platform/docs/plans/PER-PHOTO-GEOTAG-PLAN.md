# Per-Photo Geotag — capture GPS at each photo (schemes + visibility) — plan

> ## ✅ BUILT + GATED + DUAL-AUDITED — on develop `ee00dd2` (2026-08-01), awaiting staging data-path verify + owner real-phone smoke.
> **NO DB migration** (per-photo geo `{key, geo:{lat,lng,accuracy,capturedAt}}` rides in the existing `formValues` JSON;
> the visibility geo columns became aggregates). Backward-compatible (bare-string media values + legacy single-GPS captures
> behave identically). Built as 6 disjoint streams (shared contract → FE capture / builders / backend geo-fence / review-report),
> integrated, full gate GREEN (**api jest 2177 + 18 new geo-fence spec · nest 0 · FE tsc 0 · vitest 2066**). **Dual adversarial
> audit** (anti-fraud + backward-compat) → **2 HIGH + 2 LOW all fixed:** (H1) `geoFenceOk` is `true` ONLY when a capture is
> genuinely verified inside — all-unverifiable / fence-disabled → `null` (never a false "YES"); (H2) the tokenized report media
> link (`viewMediaByToken`) no longer 404s geotagged scheme photos; (L) pin/distance aligned to the same (worst) photo; (L)
> stale comment. New pure helper `api/src/visibility/geo-fence.helper.ts` (`evaluatePhotoFence`/`haversineMeters`/`isValidGeo`)
> unit-spec'd (18 tests). **▶ REMAINING:** staging synthetic data-path verify (geo-fence pass/fail/unverifiable + admin display +
> report) → **owner ~10-min real-phone smoke** (shoot 2 photos, confirm each geotagged + the fence verdict) → prod cutover.
> **⚠️ OPEN owner posture decision (D1 residual):** a fence-required photo with NO GPS fix is flagged `GEO_UNVERIFIABLE` (surfaced
> to the Gifsy approver), NOT hard-blocked — the legacy single-GPS path hard-blocks a missing fix. Owner to confirm keep-flag vs
> tighten-to-hard-block (one-line change) at smoke.

**Owner-approved (2026-08-01): Option A — each CAMERA capture embeds its own GPS at shutter time**, replacing the
confusing single-field / never-wired "Bound to a photo" model. Shared form renderer → lands for BOTH the Scheme
instrument and Visibility (POSM). Zero-bug bar. ✅ BUILT (see banner above).

## Why (the current gap)
Today there is ONE device location per submission: with "Capture GPS on submit" ON, a single `getCurrentPosition`
fix is taken at submit and dropped into the "Capture location" (`GPS_POINT`) field. The `GPS_POINT` "Bound to a photo"
trigger is **not actually wired** — it renders like a manual button and never fires when a photo is taken, and there's
no "which photo" link. So with two photos, the single location is tied to neither. We want each photo to carry the
lat/lng/accuracy/timestamp of where + when it was actually shot (stronger POSM anti-fraud).

## Target behaviour
- A CAMERA field can be set to **"Capture location with this photo"** (default ON for Visibility). When the rep shoots
  that photo, the app grabs a GPS fix **at that instant** and embeds it in the photo's stored value.
- Each photo carries `{ key, geo: { lat, lng, accuracy, capturedAt } }`. Store-board photo and Rack photo each have
  their own where/when.
- The `GPS_POINT` field stays available for a **standalone** location (Manual / Automatically-on-submit); the dead
  "Bound to a photo" trigger is **removed** (its job is now the per-photo geotag on the CAMERA field).
- Visibility **geo-fence** validates the per-photo geos (see D1).

## DECISIONS (owner — LOCKED 2026-08-01)
- **D1 — geo-fence rule with multiple photos: ✅ (a) EVERY FENCE-REQUIRED photo must be inside the fence, AND the admin
  CONFIGURES per camera-field WHICH photos are fence-required.** So a CAMERA field carries two related switches: capture
  GPS at shutter (geotag) + (for a geo-fenced visibility form) whether that photo MUST be inside the fence. The fence
  verdict = PASS only if every fence-required photo with a fix is inside `radiusMeters`; a fence-required photo whose
  device returns no fix → `GEO_UNVERIFIABLE` (existing flag) — flag, do NOT hard-fail (matches today's fail-soft). A
  photo that is geotagged but NOT marked fence-required carries its GPS for the record but does not gate the submission.
- **D2 — accuracy cap: ✅ YES.** Apply the existing per-field `gpsMaxAccuracy` cap (D15) to each photo's fix — reject a
  shot whose reported accuracy exceeds the cap, prompt re-capture (mirrors the current GPS_POINT behaviour).
- **D3 — default ON: ✅ YES.** Default the CAMERA geotag + fence-required ON for Visibility forms, OFF for generic
  Scheme forms (admin can toggle per field).

## BUILD (orchestrated; disjoint streams; gate + audit + verify)
**FE-1 — Form-builder (`SchemeFormBuilder.tsx`):** CAMERA field gains a "Capture location with photo" toggle
(`geotag: boolean` on the field). Remove the `GPS_POINT` "Bound to a photo" (`ON_PHOTO`) trigger option (keep MANUAL +
ON_SUBMIT). Migrate any existing `ON_PHOTO` fields to MANUAL on load (none in prod — dormant).

**FE-2 — Renderer (`SchemeFormRenderer.tsx`):** on CAMERA capture (the blob is created in `CameraField`), if `geotag`
is on, call `captureGps()` at that moment and store the value as `{ key, geo }` (was: bare `key` string). Apply the
D2 accuracy cap per photo; surface "location tagged ✓ / re-capture" inline. Keep backward-compat: a bare-string photo
value still renders.

**BE-1 — value-shape contract (`enrollment-form.helper.ts` + visibility DTOs):** widen the media field value to
`{ key: string, geo?: GpsCapture }`; validator accepts both shapes (back-compat). No DB migration needed — media lives
in `formValues` JSON (schemes) and the visibility capture JSON; if the visibility capture record has typed geo columns,
add nullable per-photo geo (additive) — confirm at build.

**BE-2 — visibility geo-fence (`visibility-capture.service.evaluateGeoFence`):** read the per-photo geos and apply the
D1 rule (default: all required geotagged photos inside `radiusMeters`; missing fix → `GEO_UNVERIFIABLE`, not a hard
fail). **This is anti-fraud → mandatory dual adversarial audit.** Preserve the existing single-geo path for legacy
captures.

**BE-3 — admin review + report:** the capture/enrollment detail + the Excel report show each photo's geo + per-photo
fence status (inside/outside/unverifiable). Extend the existing media rendering.

**Verify:** I runtime-verify the DATA path on staging (synthetic submit with per-photo geos → geo-fence pass/fail/
unverifiable, admin display, report) — but the actual **camera + device-GPS capture is phone-only**, so the final
proof is your ~10-min real-phone smoke (shoot two photos, confirm each is geotagged + the fence verdict). Full gate +
independent audit (dual for the geo-fence) each phase; backward-compat with existing captures verified.

## EFFORT (rough, orchestrated)
- FE-1 + FE-2 (builder toggle + renderer capture-at-shutter + accuracy cap + back-compat) — ~1 day.
- BE-1 + BE-2 + BE-3 (value shape + geo-fence per-photo + review/report display + **dual audit** on the fence) — ~1–1.5 days.
- Integration + full gate + staging data-path verify + docs — ~0.5 day.
- **Total ~2.5–3 days** orchestrated, + your ~10-min real-phone smoke for the camera/GPS device path.
- Additive + back-compatible (old single-geo captures keep working); dormant impact on live Deoleo until a form uses it.
- ⚠️ Touches a shared renderer (schemes + visibility) + an anti-fraud path → dual audit + careful back-compat are the
  reason this isn't a same-day change.
