# Scheme Data-Collection — Design Doc (locked pre-build)

> Status: **DESIGN — awaiting owner sign-off. No code to be written until signed off.**
> Author: reverse-engineered from the owner design discussion (2026-07-25).
> Supersedes the current half-built "scheme" feature (P4, tasks #22–29) — see the audit summary at the
> bottom for what exists today vs. what this replaces.

---

## 0. What a "scheme" is (the reframe)

A **scheme is a temporary, admin-configured data-collection instrument.** An admin (Gifsy only) creates a
scheme, defines a fully-custom form, targets a set of outlets, and the field force (or the outlet itself)
fills the form per outlet. The scheme **captures data** — text, photos, geo, documents, validated phone
numbers, calculated/looked-up values — and the admin reads/exports it.

**Explicitly enrollment/registration + data-capture ONLY.** A scheme does **not** award points, track
achievement, consume a budget, or link to targets. There is **no compute/reward engine** — that is a
deliberate scope decision (rewards continue to flow through the existing target/achievement/credit →
wallet path, untouched). `Scheme` and `OutletTarget`/`KpiDef` stay fully orthogonal.

### Decisions locked (referenced as **D#** throughout)
- **D1** — Enrollment/registration + data-capture only. No reward/compute/budget/achievement engine.
- **D2** — Create + manage + notifications = **GIFSY_ADMIN only**. Tenant admin gets **read-only** reports.
- **D3** — Schemes are **temporary**; each carries its **own roster** of outlet references.
- **D4** — An outlet reference is `{outlet id, outlet name}`. If the id matches an existing outlet in the
  tenant master → **linked** (real outlet). If not → **standalone** data point (no app access, no KYC,
  no owner record). No new outlet record is ever created by a scheme upload.

---

## 1. Data model

### 1.1 Scheme (existing `Scheme` table, trimmed to enrollment-only)
Keep: `code, name, description, status, startDate, endDate, imageUrl, metadata, createdByUserId, deletedAt`.
- **D5** — Trim the create form to the enrollment-only reality: drop reward-type / budget / holding-period /
  KPI / stackable / priority from the **UI** (columns may remain in the table as inert, but the admin never
  configures them). `name` is the label shown on the sales/outlet screens.
- **D6** — Real lifecycle from the UI (fixes today's bugs): create as **DRAFT** or **ACTIVE**; **edit in
  place** (no more "publish = duplicate"); **activate / pause** using valid `SchemeStatus` values
  (`DRAFT|ACTIVE|PAUSED|EXPIRED|CANCELLED` — the current "Archive→`ARCHIVED`" 400 bug is removed).
- **D7** — Config **round-trips** on reopen (campaign type, audience, tags, notifications, and the form are
  re-hydrated — today none are).

### 1.2 Scheme roster — **NEW** `SchemeOutlet` (the enrollment subject)
Each row is one enrollable subject for one scheme:
- `schemeId`
- `outletRef` (string — the supplied outlet id) · `outletName`
- `matchedOutletId?` / `matchedPartnerId?` — set when `outletRef` matches a tenant outlet (linked); null = standalone
- `taggedSalesUserId?` — from the Excel (Mode B); null in filter mode (reach falls back to the outlet's global assignment)
- `prefillValues Json?` — per-outlet variable values from the Excel
- `@@unique([schemeId, outletRef])` — **D8** roster is de-duplicated on outlet id within a scheme.

### 1.3 Enrollment submission — remodel `SchemeEnrollment`
- **D9** — A submission anchors to a **roster row** (`schemeOutletId`), **not** rigidly to a `ChannelPartner`.
  Keyed `@@unique([schemeId, schemeOutletId])` (one *current* submission per roster row per scheme).
- Stores: `formValues Json`, captured media refs (photos/docs on GCS), geo, `submittedByUserId` (audit),
  `formVersion`, `submissionVersion`, `status`, `rejectionReason?`.
- **D10 (lifecycle)** — No approval gate (live on submit). **No** withdraw/un-enroll. Captured data is
  **immutable**. Admin can **reject with a reason** → the outlet/rep **resubmits the whole form** → a new
  `submissionVersion` supersedes; **all prior versions are retained**.
- **D11 (form versioning)** — `SchemeEnrollmentForm` is **versioned**; each submission records the
  `formVersion` it was captured against, so editing a form after launch keeps old submissions coherent.
- **Migration risk: LOW** — the scheme feature is dormant and prod has **no real enrollments** to migrate.

---

## 2. The form builder

### 2.1 Field palette (**D12**)
text · number/decimal · email · date · dropdown (single) · **multi-select** · yes/no toggle ·
**phone (OTP-validated)** · document upload · **camera photo** · **geo/GPS capture** ·
**calculated (arithmetic)** · **lookup (dropdown option → mapped value)** · data-display · section/instruction header · signature.
- **D12a** — `calculated` (arithmetic, e.g. `A×B`) and `lookup` (map "Gold"→"5% slab") are **two distinct**
  field types. Today only a 2-operand arithmetic evaluator exists; `lookup` is new.
- **D12b** — Per field: required/optional, **conditional visibility** (`visibleWhen`), **conditional-required**,
  help text, placeholder, audience.

### 2.2 Prefill (**D13**)
- Admin marks fields as prefillable from the Excel variables (Mode B).
- **Per-field** the admin chooses **locked vs editable** (D13a). Exception: the phone-OTP consent field is
  **auto-locked** for approved matched outlets — see §3.
- **D13b** — Already-submitted enrollments stay **frozen** at their captured values even if the variables
  Excel is later re-uploaded.

### 2.3 Camera (**D14**) — kept simple
- Use the native capture affordance (`<input type="file" accept="image/*" capture="environment">`) — on the
  **field phones reps use (Android Chrome / iOS Safari) this opens the rear camera directly**, not the gallery.
- Integrity comes from **geo + a server-side watermark** (server timestamp + captured geo + outlet code
  burned into the image server-side) and a **cross-check of captured location vs. the outlet's registered
  coordinates** (`Outlet.latitude/longitude`), flagging outliers for the admin.
- **Not building** a locked-down `getUserMedia` in-app camera now. Reserve it as a future **per-field
  "strict capture" option** if a high-stakes scheme ever needs to eliminate even the desktop/edge-Android
  gallery path. Honest limit: no web capture defeats the analog hole (photographing a screen/print).

### 2.4 Geo (**D15**)
- Admin picks the **capture trigger**: on submit · bound-to-a-photo (geo-stamped) · manual "capture location"
  button per a chosen field. Reject low-accuracy fixes. Honest limit: a web/PWA **cannot fully prevent GPS
  spoofing** — bulletproof capture would require a native app (out of scope).

---

## 3. Phone-OTP field & consent (**D16** — the consolidated rule)

Phone-OTP is a **field type** the admin optionally adds. Its behavior adapts to the subject:
- **Matched, KYC-approved outlet with a verified owner number on file** → field is **pre-filled with the
  owner's number and LOCKED** (non-editable) → OTP is sent there. *This is the consent guarantee* — the rep
  cannot redirect it.
- **Everyone else** (standalone id+name rows, matched-but-not-yet-approved, no number on file) → field is
  **editable**; the filler (rep or self-enrolling owner) types a number and the OTP validates **that** number.
- **D16a** — This **retires** any separate scheme-level "consent OTP" toggle; consent = prefill+lock for
  approved outlets. Replaces today's **mock** sales OTP (which sends/verifies nothing — any 6 digits pass).
- **D16b** — Because the field is pinned for approved outlets, a *different* number for those outlets would
  need a second (non-pinned) phone field.

---

## 4. Audience (who the scheme is for) & Reach (who can enroll them)

**Two independent axes** — an outlet is enrollable only when it's in **both** the audience and a filler's reach.

### 4.1 Audience — two modes
- **Mode A — Filter (**D17**)**: filter tenant outlets by **outlet type / program name / program category /
  zone / state** (all present on the `Outlet` master). **Inclusions only** — no exclusions (D17a); higher
  customization → use Mode B. Admin picks **live-rule vs frozen snapshot** (D17b) and **KYC-approved-only vs
  all outlets** (D17c). Reach falls back to each outlet's **existing global sales assignment + up-hierarchy**.
- **Mode B — Excel (**D18**)**: one file supplies, per row, **outlet id + outlet name + tagged employee +
  prefill variable values**. Matched ids → linked real outlets; unmatched → standalone data points. Reach =
  the **tagged employee + their up-hierarchy**. (Per D4, standalone rows are needed because a scheme may
  cover outlets not yet in the master; they are captured as data, not created as outlets.)

### 4.2 Matched vs standalone (**D19**)
- **Standalone (unmatched) rows** = **rep-filled only** (tagged employee + up-hierarchy). No self-enroll and
  no owner-consent prefill (no login / owner number). A phone-OTP field still works — the rep types the
  number (§3). `KYC-approved-only` and `self-enroll` toggles are N/A for standalone rows.
- **Matched (linked) rows** = full behavior — self-enroll (if enabled), owner-consent prefill, KYC filter.

### 4.3 Reach model (**D20**)
- Reuses the existing sales-hierarchy "a manager sees their whole downline" model: the **tagged employee and
  everyone above them** can see & enroll the outlet. (Already built for KYC/targets — see `[[sales-hierarchy-scoping]]`.)
- Enrollment is roster-keyed; the filler (rep) is recorded only as an audit `submittedByUserId`.

### 4.4 Toggles & rules
- **D21** — Per-scheme **"self-enrollment allowed"** toggle (applies to matched real outlets only).
- **D22** — Remove the current hardcoded **MT/`SSS_TOT` exclusion** in the outlet portal — eligibility is
  governed by audience alone.
- **D23** — A **live-rule** audience never retroactively invalidates an existing enrollment (enrollment is a
  historical fact; the rule only governs who can *newly* enroll).
- **D24** — **Parents / owner-groups are not enrollable** (schemes target outlets/shops; a login-less parent
  isn't an audience member).

---

## 5. Surfaces

### 5.1 Admin — Scheme Management (**GIFSY_ADMIN only**, D2)
- Create / **edit-in-place** / activate / pause (D6); config round-trips (D7).
- Audience config (Mode A filter + Mode B Excel upload).
- Form builder (§2) with live preview.
- **Enrollments tab becomes real** (**D25**): the currently-empty per-scheme page becomes a list of roster
  rows + their captured data — field values, **photos with geo pins on a map**, uploaded documents, phone-OTP
  status, submission version/status — with filters (type/program/zone/state/date), **reject-with-reason**
  action, and Excel export. (Today: export-only, hardcoded `—` stats.)
- Notifications broadcast (§6).

### 5.2 Tenant admin — read-only Reports/Dashboard (**D26**)
Counts + coverage by zone/program/type, enrollment progress. No create/manage. Reports = aggregates + a
row list (not raw media inline).

### 5.2a Excel export with media links (**D30**)
Both the Gifsy Enrollments export (D25) and the tenant report export include, per captured document/photo,
a **link to access the file**. **Recommendation (security):** the link points at an **auth-gated app route**
that streams the file after checking the caller's session/RBAC — **not** a raw or long-lived signed GCS URL.
A signed URL embedded in an Excel that gets emailed/forwarded would leak captured PII (photos, docs) to
anyone who opens the sheet. The app-gated link means the media stays behind login + role checks even when
the spreadsheet travels. (If a truly offline/portable export is ever needed, that becomes a separate,
consciously-chosen short-TTL signed-URL export.)

### 5.3 Outlet portal (**D27**)
- Real **scheme list** (all eligible active schemes) + **"my enrolled schemes"** status view — replaces
  today's single dashboard banner.
- **Renders the enrollment form** (fetches the form; today it never does → required-form schemes are
  currently un-enrollable) and **self-enrolls** when D21 allows.
- Group-aware via the existing `x-active-partner-id` picker (a login-less sibling can self-enroll).

### 5.4 Sales app (**D28**)
- Enroll matched + standalone roster rows within the rep's subtree.
- **Real OTP** (§3) — retire the mock.
- **Renders the form + collects `formValues`** (today it always sends `{}` → required-form schemes 400).
- **Enrolled-status read-back** per outlet (today the badge is session-only).
- Reject → resubmit (D10).

---

## 6. Notifications (**D29**)
- An **ad-hoc broadcast tool inside Scheme Management** — the Gifsy admin can trigger messages **multiple
  times** during a scheme's life.
- Recipients configurable: **eligible outlets and/or the tagged sales team** (all, or a filtered subset).
- Channels: MSG91 WhatsApp/SMS templates (reuses the KYC-notification infra; the scheme-builder's old
  captured-then-dropped template IDs become real + reusable). **Send history/log** retained. Note: cost per
  message.

---

## 7. RBAC summary
| Action | Who |
|---|---|
| Create / edit / activate / pause / delete scheme | GIFSY_ADMIN only |
| Configure audience / form / notifications; send broadcasts | GIFSY_ADMIN only |
| View captured enrollment data + export (per scheme) | GIFSY_ADMIN |
| Read-only reports / dashboard | Tenant admin (CLIENT_ADMIN) |
| Enroll an outlet (self) | Outlet, if self-enroll enabled + eligible |
| Enroll an outlet (assisted) | Tagged sales employee + up-hierarchy |

---

## 8. Explicitly out of scope
Reward/points/compute/award engine · budget/`spentPaise` enforcement · scheme↔target linkage · audience
**exclusion** rules · locked-down `getUserMedia` "strict camera" (deferred as a future per-field option) ·
native-app anti-spoofing · scheme-upload creating real outlet records.

---

## 9. Owner sign-off — RESOLVED (2026-07-25)
1. **Excel export includes media links** — see **D30** (§5.2a). App-gated links recommended over signed URLs.
2. **DRAFT on create** — **yes** (D6).
3. **Notification cost/volume** — **yes**, accepted (admin-triggered MSG91 sends, D29).
4. **No change** to §1–§7. Design is **frozen as the build contract.**

---

## 10. Appendix — current state being replaced (from the 2026-07-25 audit)
Backend CRUD/RBAC/tenant-scoping, shop-keyed enrollment (`@@unique[schemeId,partnerId]`), campaign-audience
gating, and Wave-3 group threading are **real and tested**. Broken/missing today: admin **edit** (publish
duplicates), **activate/pause** (Archive 400s), **eligibility/targeting never persisted** (no
`SchemeEligibility` writer), notification template IDs dropped, config not round-tripped, **CLIENT_ADMIN
locked out of the menu**, enrollments **export-only** (no in-app view), outlet side is a **single banner**
with **no form rendering** (required-form schemes un-enrollable) and **MT excluded**, and the sales **OTP is
a mock**. This design closes all of the above under the enrollment-only, roster-based model.

---

## 11. Wave-0 implementation spec — schema (frozen contract for the build)

**New enum** `SchemeEnrollmentStatus { SUBMITTED, REJECTED }`.

**`Scheme`** — add `audienceConfig Json?`:
`{ mode:'FILTER'|'EXCEL', filter?:{ outletTypeIds?, programNames?, programCategories?, zones?, states?, kycApprovedOnly:boolean }, frozen:boolean, selfEnrollAllowed:boolean, notify?:{...} }`.
Add back-relations: `roster SchemeOutlet[]`, `submissions SchemeSubmission[]`, `formVersions SchemeEnrollmentFormVersion[]`, `broadcasts SchemeBroadcast[]` (`enrollments[]` already exists).

**NEW `SchemeOutlet`** (the roster / enrollment subject):
`id · clientId · schemeId · outletRef String · outletName String · matchedOutletId String? · matchedPartnerId String? · taggedSalesUserId String? · prefillValues Json? · createdAt · updatedAt`.
`@@unique([schemeId, outletRef])`; indexes: schemeId, matchedOutletId, matchedPartnerId, taggedSalesUserId, clientId.
Relations: `scheme`(Cascade), `matchedOutlet Outlet?`(SetNull), `matchedPartner ChannelPartner?`(SetNull), `taggedSalesUser SalesUser?`(SetNull), `enrollment SchemeEnrollment?`, `submissions SchemeSubmission[]`.
*Created by:* Excel upload (Mode B; matched or standalone), snapshot freeze (Mode A frozen), or lazily on first enroll (Mode A live-rule).

**Remodel `SchemeEnrollment`** (CURRENT state, one per roster row):
- **Remove** `partnerId` + its unique/fk/index (superseding the `20260723140000_scheme_enrollment_by_partner` anchor).
- **Add** `schemeOutletId String` · `status SchemeEnrollmentStatus @default(SUBMITTED)` · `currentVersion Int @default(1)` · `formVersion Int` · `rejectionReason String?` · `submittedByUserId String?` (renamed from `userId`, audit-only).
- **Keep** `id · schemeId · enrollmentMode(SELF/SALES) · formValues Json (latest snapshot) · enrolledAt · createdAt · updatedAt`.
- `@@unique([schemeId, schemeOutletId])`; indexes schemeId, schemeOutletId, submittedByUserId, status.
- Relations: `scheme`(Cascade), `schemeOutlet`(Cascade), `submittedBy User?`(SetNull).

**NEW `SchemeSubmission`** (append-only, IMMUTABLE history — implements D10/D11):
`id · schemeId · schemeOutletId · enrollmentId · version Int · status SchemeEnrollmentStatus · formValues Json (frozen snapshot) · formVersion Int · enrollmentMode String · submittedByUserId String? · rejectionReason String? · createdAt`.
`@@unique([enrollmentId, version])`; indexes schemeId, schemeOutletId, enrollmentId. Relations: scheme, schemeOutlet, `enrollment`(Cascade), `submittedBy User?`(SetNull).

**`SchemeEnrollmentForm`** — add `version Int @default(1)` (current). Keep `schemeId @unique` (1:1 current form).

**NEW `SchemeEnrollmentFormVersion`** (append-only form snapshots, so old submissions render coherently):
`id · schemeId · version Int · campaignType String · formSchema Json · createdAt`. `@@unique([schemeId, version])`; index schemeId. Relation `scheme`(Cascade).

**NEW `SchemeBroadcast`** (notification send-log, D29):
`id · clientId · schemeId · channel String · templateId String · recipientScope String(OUTLETS/SALES/BOTH) · recipientFilter Json? · sentCount Int · failedCount Int @default(0) · sentByUserId String? · createdAt`. Indexes schemeId, clientId. Relations `scheme`(Cascade), `sentBy User?`(SetNull).

**Back-relations to add on existing models:** `Outlet.schemeRosterEntries SchemeOutlet[]` · `ChannelPartner.schemeRosterEntries SchemeOutlet[]` · `SalesUser.schemeRosterTags SchemeOutlet[]` · `User.{schemeSubmissions, schemeEnrollmentsSubmitted, schemeBroadcasts}`.

**Media & geo** live INSIDE `formValues` per field (a media field's value = the stored GCS object key; a geo field's value = `{lat,lng,accuracy,capturedAt}`). No separate media table; the auth-gated media route (D30) resolves the key.

**Migration** — forward-only. No live enrollments exist (feature dormant; prod cleaned to 0 active partners at cutover #14), so the `scheme_enrollments` rework drops `partnerId` cleanly; still **guard with a row-count check that ABORTS if unexpected enrollment/roster data is present** (pattern from `20260723140000`). New tables are additive. **The SQL is shown to the owner for approval before it is applied to any database.**

---

## 12. Reuse map — build against these, do NOT reinvent (from the 2026-07-25 reuse audit)

| Need | Reuse | Location |
|---|---|---|
| **Send/verify consent OTP** to owner phone | `kyc.service.sendConsentOtp` + the verify block in `consent()` (OtpCode + attempts/maxAttempts lock). Add an `OtpPurpose` value (`SCHEME_ENROLL_CONSENT`) **[net-new enum]** and **bind `OtpCode.referenceId` = scheme/roster id** (redemption already does this) so concurrent outlets can't consume each other's OTP. | `api/src/kyc/kyc.service.ts:393,2861`; `common/otp.ts:12` |
| **FIXED_OTP staging** (free) | reusing `sendConsentOtp`/verify inherits it | `common/fixed-otp.ts:19` |
| **MSG91 send** (SMS OTP + WhatsApp template) | `msg91.sendOtp(phone,otp,'SMS',templateId)`, `msg91.sendWhatsappTemplate(phone,name,bodyValues[])` — call **directly** as KYC does; the NotificationQueue worker is **unbuilt** (seam only) | `api/src/notifications/msg91.service.ts:17,99` |
| **Media store + auth-gated serve** | `storage.service` `generateKey/uploadFile/downloadBytes`; upload guard (5MB + **magic-byte sniff**) = `kyc.service.uploadDocument`; auth-gated view = `signDocViewToken` + `viewDocument` + `StreamableFile` route. **D30 export links = mint per-row view tokens** (Outlet-Master export already does this). | `api/src/storage/storage.service.ts`; `kyc.service.ts:189,213,452`; `kyc.controller.ts:61` |
| **Sales reach / downline** | `descendantSalesUserIds(callerId, edges)`; assignment match = `SalesUserAssignment OR[{partnerId},{outletId}] where unassignedAt:null` | `api/src/sales/sales-hierarchy-access.helper.ts:69`; `schema.prisma:655` |
| **Active-partner (login-less sibling)** | `resolveActivePartnerId(db,{clientId,userSub,phone,requestedPartnerId})` + the `x-active-partner-id` header pattern already in schemes.controller | `api/src/common/partner-group.helper.ts:421` |
| **Excel import (chunked, tenant-scale)** | `parseTargetUploadBuffer` + `UPLOAD_CHUNK=100` `$transaction(slice)` loop (roster+variables shape) | `api/src/targets/targets.helpers.ts:369`; `targets.service.ts:92,498` |
| **Excel export (injection-safe)** | `buildXlsx(sheets)` / `cellSafe` | `api/src/common/xlsx.ts:29,57` |
| **Form engine (extend)** | `enrollment-form.helper` — add `LOOKUP` + `requiredWhen` (reuse `evaluateVisibleWhen` for conditional-required); `validateFormSchema`/`validateSubmittedValues`/`evaluateFormula` | `api/src/schemes/enrollment-form.helper.ts` |
| **RBAC** | `@Roles('GIFSY_ADMIN')` (RolesGuard is **always-on**, independent of the RBAC master-flag) on create/manage; `schemes:read`/`schemes:export` for tenant reports; GIFSY_ADMIN passes every check | `common/rbac/*`; `permissions.ts` group `SCHEMES` |

**Net-new (not reusable):** `SCHEME_ENROLL_CONSENT` OtpPurpose; `LOOKUP` + conditional-required field types; the roster/versioning models (§11); `SchemeBroadcast` send-log (the generic `NotificationDeliveryLog` is unused).

---

## 14. Wave-1 backend — build + dual independent audit (2026-07-25)

**Built:** 3 parallel streams (1A admin authoring · 1B enrollment engine · 1C notifications+reports), integrated (legacy reward-era routes retired; old `admin-programs` export retired; module wired; media link canonicalized on 1B's **session-gated** `/v1/schemes/:id/enrollments/media?key=` route — 1C's self-authenticating token was the leaky pattern D30 warns against, removed; the `:id/enrollments/export` route-shadow renamed to `:id/report/export`). **Gate GREEN: `nest build` 0 · jest 1799 passed.** `OtpPurpose.SCHEME_ENROLL_CONSENT` added to schema + migration (`ALTER TYPE … ADD VALUE`).

**Dual independent adversarial audit — both GO-WITH-FIXES; no HIGH, no security/data-integrity blocker.** RBAC (GIFSY-only create/manage, RBAC-flag-independent), tenant isolation/IDOR, chunking at ~2,261-outlet scale, cellSafe export, session-gated media links, and atomic form-versioning all independently confirmed correct.

**FIXED (post-audit pass):** A-MED-1 pin recorded phone-OTP value to the verified number (consent, D16) · B-MED-1 `FILTER` audience requires a non-empty filter (no silent all-tenant snapshot) · B-MED-2 live-rule coverage denominator = addressable filter count (not roster) · A-LOW-2 reject `requireOtp` form with no PHONE_OTP field · A-LOW-4 concurrent-submit P2002 → clean 409 · A-LOW-6 strip unknown `formValues` keys · B-LOW-2 broadcast up-hierarchy walks past soft-deleted managers · B-LOW-3 deep-validate broadcast `recipientFilter` DTO · B-LOW-4 drop redundant tenant-report query.

**DEFERRED — accepted, documented conscious decisions (not blockers):**
- **A-LOW-1** media-view binds to the tenant-folder, not enrollment-ownership — mitigated by random unguessable keys + role gate + tenant pin; a short-lived signed token (KYC-style) is a W3/future hardening candidate if ever needed.
- **A-LOW-3** `kycApprovedOnly` is not re-checked on an existing (materialized) roster row — the roster is the **source of truth** once materialized; live-rule audiences re-check at lazy-create. Intentional.
- **A-LOW-5** the consent OTP is **time-boxed (15 min)**, not single-use — accepted time-boxed consent.
- **B-LOW-1** an SMS broadcast is a **no-op in non-prod FIXED_OTP mode** — ⚠️ staging-verify note: a "sent" SMS broadcast on staging does not actually deliver (WhatsApp templates do).
- **B-LOW-5** the audience-snapshot partial-write window self-heals on idempotent re-save.

---

## 15. Wave 2 (frontend) + sales slice + Wave-3 audit — AS BUILT (2026-07-26)

**Frontend built (all on the gated-green shared layer):** **2A** shared `lib/schemes.ts` client + `SchemeFormRenderer` (renders every §13.1 field type incl. camera/geo/phone-OTP/lookup/conditional-visible+required/prefill-lock). **2B** admin — create + **real edit-in-place** + activate/pause (invalid `ARCHIVED` bug gone), versioned form-builder (new `SchemeFormBuilder` on the correct shared types), audience editor (filter + Excel roster), **real Enrollments view** (fields + photo thumbnails + geo mini-map + distance-outlier flag + reject-with-reason + export), broadcast UI + history, **tenant read-only Reports** page. **2C** outlet portal — real scheme list + "my enrolled" + self-enroll (incl. fixed-roster via `mySchemeOutletId`), MT exclusion removed. **2D** sales app — subtree targets via the sales slice, **real OTP** (mock retired), resubmit. Legacy compat shims + the reward-era builder chain + dead components DELETED.

**Sales slice (backend, gap I found + closed):** the sales flow rendered EMPTY at runtime because the enrollee listing methods resolve a *partner* (a rep isn't one). Added `getSalesEligibleSchemes` + `getSalesTargets` (reach-scoped roster rows incl. **standalone** id+name rows + live-rule outlets, each with enrollment status) + surfaced `mySchemeOutletId` on the partner eligible list (outlet self-enroll into a fixed roster).

**Wave-3 dual independent audit — both GO-WITH-FIXES; no HIGH, no reach-leak / cross-tenant IDOR / regression.** RBAC, tenant isolation, media auth-gate, OTP lock, sales-target/portal self-enroll subjects all confirmed correct. FIXED: A-MED-1 partner-only-assignment live-rule discovery · B-MED-1 GPS-on-submit fill (was silently discarded) · B-MED-2 stop persisting conditionally-hidden field values (FE + backend) · B-MED-3 `/admin/schemes` page-guard + false-comment (backend endpoints already GIFSY-only — defense-in-depth) · LOWs (deterministic `mySchemeOutletId`, n-ary CALCULATED formula both sides, `captureGpsOnSubmit`-requires-GPS validation, dead-component deletion, broadcast filter cleanup).

**GATE GREEN (2026-07-26):** api `nest build` 0 · jest **1826** · FE `tsc` 0 · vitest **1941**.

**Accepted / deferred (documented, not blockers):** the sales sheet + the portal show the phone-OTP field **editable before the backend pins it** — the D16 consent guarantee is server-enforced on send/verify/submit regardless; a `/me` returning KYC-approval + a masked owner phone would pre-pin the UI (polish). `getSalesEligibleSchemes` returns all active schemes tenant-wide (per-scheme reach is enforced in `getSalesTargets`; enroll re-authorizes — by design). `getSalesTargets` doesn't filter paused schemes (enroll still gated — harmless). The partner shell has **pre-existing fabricated notifications** (out of scope — the Notifications-Core thread).

**⚠️ NOT PUSHED — owner-gated remaining (Wave-3 cutover):** (1) **✅ DONE (2026-07-26)** — guarded staging pre-check + cleanup: `scheme_enrollments` held **1** `w3test-cpB` residue row (2026-07-23, login-less sibling, status ACTIVE; backup-logged in the `gifsy-oneoff-staging` job logs) → deleted (guarded: `current_database()='gifsy_staging'` + row-count cap) → **now 0, staging is push-ready** (the migration's abort-guard will pass); (2) push `develop` → staging auto-deploys + `migrate deploy` applies the destructive-but-guarded migration + the `OtpPurpose ADD VALUE`; (3) verify serving SHA + migration applied; (4) my staging runtime-verify (role matrix via FIXED_OTP; camera/geo via injected stream + mocked geolocation — the one device-level check is a ~10-min real-phone smoke); (5) prod cutover proposal (merge develop→main; prod `scheme_enrollments`-empty pre-check; the prod scheme feature was dormant + prod cleaned to 0 partners at cutover #14).

---

## 13. Frozen build contracts (W1/W2 code against these)

**Schema status:** §11 schema + migration `20260725120000_scheme_data_collection` are BUILT, `prisma validate`-clean, offline canonical-diff-verified faithful, and **independently audited GO** (2026-07-25). ⚠️ **Do NOT push the migration until the W1 backend that matches it is ready** — the running staging scheme code still references `scheme_enrollments.partnerId`, which this migration drops; they must deploy together.

### 13.1 Form field-type contract (extend `enrollment-form.helper.ts`)
Final `FORM_FIELD_TYPES` = existing (`TEXT, NUMBER, DROPDOWN, DATE, DOCUMENT, IMAGE, CAMERA, GPS_POINT, UPI_QR_SCAN, DATA_DISPLAY, CALCULATED`) **+ net-new** `EMAIL, MULTI_SELECT, TOGGLE, PHONE_OTP, LOOKUP, SECTION, SIGNATURE`. `FormField` additions: `requiredWhen?` (conditional-required — reuse `evaluateVisibleWhen`), `locked?` (per-field prefill lock, D13a), `prefillKey?` (Excel variable column, D13/Mode B). `LOOKUP`: `lookupSourceFieldId` + `lookupMap: Record<optionValue,shownValue>`. `PHONE_OTP`: `otpRequired` (verify before submit; auto-prefill+lock to owner's on-file number for KYC-approved matched outlets, D16). `CAMERA`: server-watermark (time+geo+outletCode), no gallery fallback (D14). `GPS_POINT`: `captureTrigger: 'ON_SUBMIT'|'ON_PHOTO'|'MANUAL'` (D15).

### 13.2 `Scheme.audienceConfig` JSON shape
`{ mode:'FILTER'|'EXCEL', selfEnrollAllowed:boolean, frozen:boolean, filter?:{ outletTypeIds?:string[], programNames?:string[], programCategories?:string[], zones?:string[], states?:string[], kycApprovedOnly:boolean } }`. EXCEL → roster from upload (filter unused). FILTER + `frozen:true` → snapshot roster at save; `frozen:false` → live-rule (lazy roster row on first enroll). `selfEnrollAllowed` applies to matched real outlets only.

### 13.3 Denormalization invariant (audit LOW-2 — the SERVICE must enforce; W3 code-review checkpoint)
`scheme_enrollments.schemeId` and `scheme_submissions.{schemeId,schemeOutletId,enrollmentId}` are denormalized and NOT DB-enforced. Every write path MUST keep them consistent: `enrollment.schemeId == schemeOutlet.schemeId`; each submission's `{schemeId,schemeOutletId}` == its enrollment's.

### 13.4 API surface (endpoint names frozen; each stream owns its payloads)
- **Admin (GIFSY_ADMIN, `@Roles('GIFSY_ADMIN')` — always-on guard):** `POST /v1/schemes` (create DRAFT/ACTIVE), `PATCH /v1/schemes/:id` (edit-in-place), `PATCH /v1/schemes/:id/status` (activate/pause), `PUT /v1/schemes/:id/enrollment-form` (versioned — also append `SchemeEnrollmentFormVersion`), `POST /v1/schemes/:id/audience` (filter config + materialize/snapshot), `POST /v1/schemes/:id/roster/upload` (Excel Mode B, CHUNKED per trap-#8), `GET /v1/schemes/:id/roster`, `GET /v1/schemes/:id/enrollments` (+ `/export` with auth-gated media links, D30), `POST /v1/schemes/:id/enrollments/:enrollmentId/reject` (reason → status REJECTED, D10), `POST /v1/schemes/:id/broadcast` (D29), `GET /v1/schemes/:id/report` (Gifsy) + tenant read-only report (`schemes:read`).
- **Enroll (outlet self + sales):** `GET /v1/schemes` (eligible list, `x-active-partner-id`), `GET /v1/schemes/:id/my-enrollment`, `POST /v1/schemes/:id/enroll` `{ enrollmentMode:'SELF'|'SALES', targetSchemeOutletId|targetOutletRef, formValues, otpToken? }`, phone-OTP send/verify sub-endpoints (reuse consent-OTP, referenceId-bound).

### 13.5 Resolved audit notes
- **LOW-1 (intentional):** `schemeOutletId` is single-col `@unique` (not the spec's composite `@@unique([schemeId,schemeOutletId])`) — functionally identical + stronger since a roster row belongs to one scheme. Do NOT "correct" it back.
- **⚠️ Pre-push operational:** the migration's abort-guard halts `migrate deploy` if a target DB holds ANY `scheme_enrollments` rows from the partner-keyed era. **Before this migration reaches staging/prod, confirm `scheme_enrollments` is empty** (guarded read; staging may hold rows from the W3 `w3test` scheme testing — clean first).
