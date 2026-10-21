# Visibility — per-photo approval & partial re-capture (build contract)

**Owner GO 2026-10-21 (orchestrate).** Today a visibility capture is approved/rejected as ONE unit
(`VisibilityCapture.status`), and a reject re-opens the whole window → the rep re-shoots EVERY photo.
Requirement: the reviewer approves/rejects **each photo (CAMERA field) individually**, and on re-submit the
rep re-captures **only the rejected photo(s)** — approved photos carry forward untouched.

Additive + platform-wide (shared visibility code). **Single-photo forms must behave identically** (one photo →
the per-photo decision IS the capture decision). Visibility is dormant for Deoleo; non-rejected flows unchanged.

## Model (additive)
- **`VisibilityCapture.photoReviews Json?`** — per-CAMERA-field review state, keyed by field id:
  `{ "<fieldId>": { "status": "APPROVED" | "REJECTED", "reasonCode"?: string, "reason"?: string, "reviewedAt": ISO, "reviewedByUserId": string } }`.
  A field absent from the map = not yet reviewed (pending).
- **New status `CHANGES_REQUESTED`** on `VisibilityCaptureStatus` (enum, additive) — some photos rejected, window
  NOT satisfied, rep must re-capture the rejected ones. (Keep SUBMITTED/APPROVED/REJECTED; REJECTED stays the
  whole-capture reject for back-compat / "reject everything".)
- Snapshot `photoReviews` into **`VisibilityCaptureSubmission.photoReviews Json?`** per version (history/trace).
- Migration: additive columns + enum value; no data reset. Deoleo byte-identical (feature dormant).

## Derived capture status (server-authoritative — the single rule)
Over the REQUIRED CAMERA fields of the capture's form version:
- all required photos `APPROVED` → capture **APPROVED** (satisfies the window, D7).
- any required photo `REJECTED` → capture **CHANGES_REQUESTED**.
- else (some pending, none rejected) → **SUBMITTED**.
Recompute this after every per-photo decision and after every resubmit. The window (D7) is satisfied ONLY by
capture status APPROVED. `getSalesEligible`/report/notify must treat CHANGES_REQUESTED like "re-open" (rep acts).

## Backend — Stream A (`api/src/visibility/*`)
1. **schema.prisma + migration** — add the two `photoReviews Json?` columns + the `CHANGES_REQUESTED` enum value.
2. **`visibility-review.service.ts`** — new `reviewPhoto(user, captureId, fieldId, decision, reasonCode?, reason?)`:
   validate fieldId is a CAMERA field of the capture's form version; set `photoReviews[fieldId]`; recompute +
   persist the derived capture status; reject reasonCode from the existing `VISIBILITY_REJECT_REASONS`. Keep the
   existing `approve`/`reject` as approve-ALL / reject-ALL (they now also set every photo's review + derive status,
   so a 1-photo capture is identical to today). An approve-ALL is refused if any photo is REJECTED (must be
   re-captured first). Expose via the admin controller (`POST /v1/visibility/admin/captures/:id/photo-review`).
3. **`visibility-capture.service.ts` resubmit (`persistCapture`)** — when the prior capture is CHANGES_REQUESTED:
   MERGE — carry forward the APPROVED photos' media + their APPROVED review untouched; accept new media ONLY for
   the REJECTED fields; clear those fields' reviews (back to pending); derive status (→ SUBMITTED for re-review).
   ⚠️ ANTI-TAMPER: the server keeps approved photos from the stored capture — a resubmit payload must NOT be able
   to replace an already-APPROVED photo (ignore/!reject changes to approved fields). New `VisibilityCaptureSubmission`
   version as today.
4. **Queue detail** (`extractMedia`/adminGetCapture) — return each photo's `review` state so the FE can render
   per-photo controls.

## Frontend — Stream B (`platform/src/**`)
5. **Review queue** (`platform/src/components/admin/VisibilityCaptureQueue.tsx` + the admin visibility page) —
   per-photo **Approve / Reject (with reason)** controls; show the derived capture status; disable whole-capture
   "Approve" while any photo is rejected.
6. **Rep capture form** (`platform/src/components/visibility/VisibilityCaptureForm.tsx` + `VisibilityCaptureSheet.tsx`)
   — on a CHANGES_REQUESTED re-entry, show ONLY the rejected photos (with their reject reason); approved photos
   shown read-only/carried-forward, not re-shot. Submit sends only the re-captured fields.
7. FE status labels + the sales tasks/outlet surfaces that show capture state handle CHANGES_REQUESTED.

## Backward-compat / safety (audit targets)
- Single-photo form: one CAMERA field → approve/reject of that photo == the capture decision → identical to today.
- A capture can reach APPROVED only when every required photo is APPROVED (no partial approval satisfies the window).
- Resubmit cannot alter an already-APPROVED photo (server-side carry-forward is authoritative).
- CHANGES_REQUESTED everywhere the old REJECTED "re-open" was honored (eligibility, notify, report, window).
- Deoleo / dormant tenants unaffected (additive schema; no behavior change without multi-photo review usage).

## Done = full gates (api jest + nest build; platform tsc + vitest) + independent adversarial audit (compliance/
evidence path: can an unreviewed or rejected photo end up satisfying the window? can a resubmit overwrite an
approved photo?) + runtime verify. Estimate ~1–1.5 days. Migration applied to staging as part of the cutover.
