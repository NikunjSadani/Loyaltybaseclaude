# Scheme Data-Collection — UX Hardening Plan (2026-07-30)

> ✅ **LIVE IN PROD — cutover #20 `8c08af3` (2026-07-30), verified. Code-only, no migration. Additive + dormant.**
> prod = main = develop = `8c08af3` (both services verified; `/health/ready` db:up; new reads `/v1/schemes/:id/prefill-sources`
> + `/facet-values` + `/broadcast/preview` + outlet-master export with Parent ID all 401-wired; deoleo login 200). Commits:
> c43304e (W0 backend) · 0da1859 (W0 audit fixes + FE contract) · ed4a577 (Parent ID export) · 16358a7 (W1 FE) ·
> 273a4b2 (W1 FE audit fixes) — FF-merged develop→main. Dual-audited (BE + FE) + staging-verified 21/21. Gate green:
> api jest 2104 · nest 0 · FE tsc 0 · vitest 2049. Rollback ref daa4f3f (#19). Remaining: owner ~5–10 min real-phone smoke
> (signature canvas, camera/geo, dual-source locked prefill on a live enroll). Row/phase annotations below mark what shipped.

Consolidated from a full 4-slice review of the LIVE scheme feature (admin authoring, form builder,
enrollment/capture, reporting/lifecycle) against the frozen design (`SCHEME-DATA-COLLECTION-DESIGN.md`
D1–D30 + §16) + everything discussed (prefill Editable/Locked, roster report, hierarchy).

**Property:** everything below is **CODE-ONLY — no DB migration** (all new config lives in the form JSON /
read endpoints; reject-audit reuses the existing `SchemeSubmission` table).

## Owner decisions (locked 2026-07-30)
1. **Camera server-side watermark (D14) → DROPPED.** Keep rear-camera capture + captured-vs-registered geo
   cross-check; no server image compositing. → update design doc §D14 + memory.
2. **Per-field audience (D12b) → DROPPED.** Remove `FormField.audience` from the model + validator; audience
   stays at scheme level; conditional "Show only when…" covers field hiding.
3. **Dual prefill SOURCE → ADD.** A field's prefill can come from an **Outlet field** (auto-fills matched
   loyalty outlets from their existing record) OR an **Excel column** (standalone / non-loyalty) — see §Dual-Source.
4. **Scope = everything in one push** (all severities), one cutover.
5. Multiple independent phone-OTP fields → **defer** (rare edge; noted).

## The confirmed-correct core (no change)
All 18 field types author+render+capture; §16 Editable/Locked is faithful (server-pinned, blank-cell→editable,
no brick); PHONE_OTP consent server-enforced (rep can't substitute a pinned number); reject-with-reason,
broadcast (D29), tenant read-only (D26, no cross-tenant leak, no PII), auth-gated media (D30), versioned form,
chunked roster upload + disposition report — all correct.

---

## Dual-Source Prefill (new capability — the MIXED auto-fill)

**Contract (back-compatible):** keep `FormField.prefillKey` = Excel column. Add `FormField.outletField?: string`
= an Outlet-master field key. Resolution order at enroll:
- `outletField` set AND the enrolling outlet is **matched** (loyalty) → prefill from that outlet's DB field.
- else `prefillKey` set → prefill from the Excel roster column.
- both set = "Outlet field for matched, else Excel column" (the MIXED case, one field).
Editable/Locked applies identically; a **Locked outlet-field** pins to the outlet's DB value (server-authoritative).

**Outlet fields exposed** (curated, PII-appropriate, GIFSY-admin authoring): businessName, ownerName, phone,
addressLine1/2, city, state, pincode, panNumber, gstNumber, programName, programCategory, zone, outletCode.

**Backend:** enroll payloads (`getEligibleSchemes` / `getMyEnrollment` / `getSalesTargets`) add
`outletFieldValues: Record<string,string> | null` for the matched outlet (null for standalone), projected to
ONLY the outlet fields the form binds (same data-minimisation as `pickBoundPrefill`). `applyPrefillPins` +
`resolveInitialValues` resolve outletField before/alongside Excel. `validateFormSchema` validates the source config.

**Builder:** the field's prefill block becomes a **source picker** — `Prefill from: [ Excel column ▾ | Outlet field ▾ ]`
— each a dropdown of REAL values (roster columns / outlet fields), not free text. Editable/Locked unchanged.

---

## Findings → fixes (consolidated, deduped)

### 🔴 Must-fix
| id | gap | fix | layer | status |
|----|-----|-----|-------|--------|
| H1 | Prefill link is blind free-text; typo on a Locked field silently unlocks it | Dropdown of real roster columns + outlet fields (see Dual-Source) + amber "column not in current roster" warning; fold a soft-warning into `validateSchemeFormSchema` | BE+FE | ✅ done — Excel-column + Outlet-field dropdown + validator parity |
| H2 | DATA_DISPLAY value stripped (`collectPrefillKeys` ignores `dataDisplayKey`) → always "—" | Include `dataDisplayKey` in `collectPrefillKeys` (+ unit test) | BE | ✅ done — no longer stripped |
| H3 | Scheme activatable with no audience + no form | Guard ACTIVE in `setStatus`/`create` (needs audience + form) → 400; FE disables Activate + tooltip | BE+FE | ✅ done — activation requires audience + non-empty form (FE gate reads PERSISTED form, not draft) |
| H4 | Save not gated on builder validation → caught errors round-trip to 400 | Lift `validateSchemeFormSchema` to gate Save (`disabled` + skip network) | FE | ✅ done — gate-save |
| H5 | Admin detail drawer reads wrong shape → outlet name/code blank, geo cross-check inert | Read `outlet.outletName` / `matchedOutlet.{outletCode,lat,lng}`; fix `AdminEnrollmentDetail` type | FE+type | ✅ done — adminGet returns field id→label map; drawer nested outlet/geo reads |
| H6 | Signature capture distorted (canvas coords unscaled) | Scale pointer by canvas/rect ratio (or size buffer to rect) | FE | ✅ done — signature-canvas scaling fix |

### 🟡 Should-fix  — ✅ all done (see W0/W1 annotations)
- Client-validator parity (one function): LOOKUP empty-map · `requireOtp`+`otpRequired` · §16 locked-phone-otpRequired — all currently silent→400. (FE)
- "Locked" badge shows on an editable input → gate the pill on `hasPrefill`. (FE)
- Approved-outlet phone forces typing a discarded number → surface `outletApproved`+`ownerPhoneMasked` on enroll payloads → pre-pin. (BE+FE)
- Captured values shown as raw field-IDs in the drawer → return field id→label map from `adminGetEnrollment`; FE maps. (BE+FE)
- Reject→resubmit loses the rejection audit trail → append a `REJECTED` `SchemeSubmission` on reject; stop nulling reason. (BE)
- Report/export/broadcast scoping inconsistent with the list (un-assumed GIFSY → tiles vanish) → unify `platformWide`/`schemeTenant`. (BE)
- Broadcast fires with no recipient count/confirm (billable) → dry-run count endpoint + confirm dialog. (BE+FE)
- Filter facets blind free-text → facet-values endpoint + multi-select (mirrors H1). (BE+FE)
- Authoring sequence undiscoverable → tab completion badges + "set audience/roster first" banner on the Form tab. (FE)
- Mode-switch (FILTER↔EXCEL) strands roster rows unwarned → confirm/warning (+opt explicit reset). (FE, opt BE)
- No roster **template** download → "Download template (.xlsx)" next to the drop zone. (FE)
- Export media links unusable (wrong prefix/no host) → absolute `/api/…` URL + real xlsx hyperlink. (BE, needs public-base-URL config)
- CALCULATED: no grammar check / no compute preview → validate via `evaluateFormula` at author time + live sample. (FE)
- Low-accuracy GPS not rejected (D15) → accuracy threshold client + server. (BE+FE)

### ⚪ Low polish (batch)
Live-rule filter match-count · orphan roster row on abandoned OTP · inline error highlight/scroll · LOOKUP-map
orphan on option rename · duplicate-field button · options trim/dedupe · client dup-id guard · prior-version
value viewer · export TOGGLE→Yes/No · stale TEXTAREA doc note · DATA_DISPLAY key gated to Excel schemes.

### 🟢 Drops / doc updates  — ✅ done
- Remove `FormField.audience` (contract + validator + any refs); design §D12b → "dropped".
- Design §D14 → "server watermark dropped; rear-camera + geo cross-check retained".

---

## Execution — parallelized (one cutover)  — ✅ BUILT (develop 273a4b2)

**Wave 0 — backend contracts (unblocks the FE pickers):**  ✅ done (c43304e + audit fixes 0da1859)
> As-built note: the new reads shipped as `GET :id/prefill-sources` (real Excel roster columns + 15 outlet fields) +
> `:id/facet-values` + broadcast dry-run `:id/broadcast/preview`. Reject-audit appends an immutable REJECTED
> `SchemeSubmission` so the trail survives resubmit; approved-owner phone pre-pin; GPS-accuracy cap (D15, a
> data-quality filter, not anti-fraud); report/notify scoping unified via `platformWide` (fixes un-assumed-GIFSY 404,
> tenant isolation kept); export TOGGLE→Yes/No + app-proxy media URL. Audit fixes: concurrent-reject 409, rep PAN/GST
> bulk-enum guard, tighter activation guard, GPS-comment honesty; dual-source merge lets outlet-field WIN over a
> same-named Excel column.
- new reads: `GET :id/roster/columns`, facet-values, outlet-field catalog, broadcast dry-run count
- dual-source prefill backend (contract + `outletFieldValues` on 3 enroll payloads + resolve + validate)
- H2 `collectPrefillKeys(+dataDisplayKey)` · H3 activation guard · H5 field-label map + drawer shape
- reject-appends-submission · scoping unify · `outletApproved`/`ownerPhoneMasked` · GPS-accuracy · export-media-URL + TOGGLE
- drops: remove `FormField.audience`

**Wave 1 — 4 parallel FE streams (file-disjoint):**  ✅ done (16358a7 + audit fixes 273a4b2)
- **Builder** — source-picker dropdowns (H1) + gate-save + validator parity (H4) + calculated preview + options/dup-id polish  ✅ Excel-column + Outlet-field DROPDOWN + GPS-cap authoring + calculated preview
- **Renderer/capture** — signature fix (H6) + locked-badge + inline validation + approved-phone pre-pin + GPS accuracy  ✅ + dual-source consumption + locked-pill gated on real prefill + client GPS mirror + scroll-to-first-error
- **Authoring flow** — completion badges + activation gate + mode-switch warning + roster template + facet multi-select + live match-count  ✅ FE activation gate reads PERSISTED form + tab completion badges + roster template download + facet multi-select
- **Reports** — drawer shape+labels (H5) + reject-trail + prior-version viewer + broadcast confirm + scoping error surfacing  ✅ admin drawer nested outlet/geo reads + id→label map + reject-trail + billable-broadcast confirm dialog

**Then:** integrate → full gate (jest/nest/tsc/vitest) → **dual adversarial audit** (prefill/consent-adjacent) →
staging runtime-verify (incl. a MIXED matched+standalone roster proving dual-source prefill + lock) →
docs/memory sweep → owner-gated cutover.

> ✅ **As-built completion (all done):**
> - **Gate green:** api jest 2104 · nest build 0 · FE tsc 0 · vitest 2049.
> - **Dual adversarial audit:** backend (tenant-isolation/consent/prefill CLEAN + 4 lower-sev fixes) AND FE (no HIGH; 2
>   fixes: activation gate reads PERSISTED form not draft, dual-source merge lets outlet-field WIN over a same-named Excel
>   column). Accepted edges (documented, no functional harm): multi-phone-OTP force-pin, error-scroll for GPS/media fields,
>   FE-stricter LOOKUP/options.
> - **STAGING RUNTIME-VERIFIED 21/21** (synthetic MIXED matched+standalone roster, then guarded soft-deleted): prefill-sources
>   (real Excel cols + 15 outlet fields), facet-values, activation gate blocks form-less + allows configured, **dual-source PIN
>   proven** (rep sent f_owner="HACKED-BY-REP" → server stored the DB owner name), editable prefill kept rep value, rep payload
>   no PAN/GST leak, H5 field-label map, reject-trail REJECTED:v2 after SUBMITTED:v1, broadcast preview count.
> - **REMAINING = owner-gated prod cutover (merge develop→main + approve prod gate) + a ~5–10 min real-phone smoke** (signature
>   canvas, camera/geo, dual-source locked prefill on a live enroll).
> - **Separately shipped in the same push (ed4a577):** PARENT ID column added to the outlet-master **DOWNLOAD** export
>   (backend `reports.service.outletMaster`, now 57 columns, emits the outlet's parent ChannelPartner partnerCode → round-trips
>   the upload's "Parent ID"). The FE `lib/outlet-master-export.ts` the backlog named is DEAD/unused demo code; the real export
>   is the backend path (now fixed).
