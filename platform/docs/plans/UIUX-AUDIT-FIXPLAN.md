# UI/UX audit — consolidated fix plan (recently-shipped frontend)

**Generated 2026-08-01** from the new mandatory **UI/UX audit lane** ([[audit-every-build-item]]) run retroactively over
recently-shipped FE: sales KYC wizard, scheme authoring + roster, scheme enrollment capture + edit/delete, admin settings +
owner-group grouping. Four independent UX auditors; findings deduped + triaged below.

**Deployment state legend:** `PROD` = live in prod (fix rides a future cutover) · `#23` = on develop, not yet in prod
(fix rides the pending cutover #23, no extra cutover) · `GEOTAG` = per-photo-geotag optional polish (on develop `ee00dd2`).

Estimates are orchestrated build time (code) and EXCLUDE the per-batch gate + independent audit + staging-verify (add ~0.5d
per batch). "d" = ideal engineer-day.

---

## Phased plan (recommended order)

| Phase | Scope | Items | Build est. | +gate/audit/verify | Notes |
|---|---|---|---|---|---|
| **P1** | Roster-remove polish (before #23) | 8 | ~1.3d | +0.5d | Not yet prod → cleanest; rides #23, no extra cutover |
| **P2** | Prod-live HIGH bugs | 10 | ~2.6d | +0.7d (dual-audit KYC/consent) | Own cutover; several real bugs |
| **P3** | Prod-live MED | 14 | ~2.3d | +0.5d | Fold into P2 cutover or a follow-up |
| **P4** | LOW polish + a11y | 16 | ~2.0d | +0.5d | Batch opportunistically |
| **D1** | Geo hard-block POLICY decision | 1 | ~0.25d | — | **Owner decision first** (keep block vs flag-and-allow) |
| **G1** | Geotag optional polish | 3 | ~0.4d | +0.3d | Fold into the geotag cutover |
| | **TOTAL** | **52** | **~8.9d** | **~3d** | **≈ 12 engineer-days end-to-end, orchestrated** |

---

## P1 — Roster-remove (SchemeAudienceEditor.tsx / SchemeFormBuilder.tsx / SchemeManager.tsx) — `#23`

| ID | Sev | Bug | Fix | Est. |
|---|---|---|---|---|
| RST-H1 | HIGH | Remove-confirm shows a generic "enrollments hidden" warning, not the actual affected-row count | Cross-ref `confirmIds` vs `rows`, show "N of M have a filled enrollment"; red banner when N>0 | 0.3d |
| RST-H2 | HIGH | "Removed stays removed" (re-upload won't resurrect) never explained | One line in confirm + removed-panel header | 0.1d |
| RST-M1 | MED | Removed-rows restore panel has NO pagination → rows past 25 unrecoverable | Prev/Next pager (mirror main roster) or search-by-id | 0.25d |
| RST-M2 | MED | Double-upload race — dropzone live during in-flight upload | Guard onClick/onDrop + re-entrancy guard + pointer-events-none | 0.15d |
| RST-L1 | LOW | Bulk selection bar + confirm banner stack simultaneously | Hide selection bar while confirming | 0.1d |
| RST-L2 | LOW | Cross-page bulk selection silently drops on page change | Note, or true cross-page selection | 0.2d |
| RST-L3 | LOW | Removed table lacks `overflow-x-auto` wrapper | Add wrapper | 0.05d |
| RST-L4 | LOW | Destructive confirm doesn't take focus or bind Escape | Focus + Escape-to-cancel | 0.15d |

## P2 — Prod-live HIGH bugs

| ID | Sev | Surface | Bug | Fix | Est. |
|---|---|---|---|---|---|
| SIG-1 | HIGH | KYC `page.tsx:1080` | Signature pad draws OFFSET from finger on phone (canvas not scaled to CSS width) | Scale `getSigPos` by `canvas.width/rect.width` (+ height / DPR) | 0.25d |
| SIG-2 | HIGH | Enroll `SchemeFormRenderer.tsx:1017-1056` | Signature requires separate "Save signature" tap → draw→Submit silently loses it; empty "Save" no-ops | Auto-upload on pointer-up when dirty, or block Submit w/ "Tap Save signature"; `dirty` as state | 0.35d |
| SET-H2 | HIGH | `admin/settings/page.tsx:446-472` | Stale-cache + REPLACE-WHOLE save can silently flip a SIBLING uniqueness toggle off (KYC-enforcement money path) | Drive card from reactive `useGifsySettings()`; merge, don't replace-from-stale | 0.3d |
| ENR-H3 | HIGH | `SchemeFormRenderer.tsx:1199` | Phone editable AFTER OTP sent → verify submits number B with code issued for A (consent mismatch) | Lock phone on `sent`; add "Change number" reset | 0.2d |
| ENR-H4 | HIGH | `SchemeEnrollSheet.tsx:160` | Transient form-fetch error → "formless" enroll capturing ZERO fields, rep thinks done | Distinguish 404/empty-form vs fetch error → inline Retry, stay on form | 0.25d |
| KYC-H1 | HIGH | `page.tsx:2087+` | Disabled "Continue" gives no visible reason (the "stuck" trap) | Per-step "to continue…" checklist / on-press per-field errors | 0.5d |
| KYC-H4 | HIGH | `page.tsx:2157,2413` | Consent checkboxes are non-semantic divs — 20px-only tap target, not kb/SR operable | Real inputs or role=checkbox+aria+full-row tap | 0.25d |
| ENR-M1 | HIGH* | `SchemeFormRenderer.tsx:338` | Submit not blocked while a media upload is in flight → silent loss / false "required" | `disabled` on any uploading; show "waiting for upload…" | 0.15d |
| KYC-up | HIGH* | `page.tsx:2076+` | Same submit/continue-while-uploading race on the KYC wizard | Reflect in-flight upload in the Continue gate | 0.15d |
| KYC-H2 | HIGH | `page.tsx:2256-2264` | Geo capture is a hard block, no Retry, no fallback → location-off rep can't submit | **D1 DECIDED: keep hard-block + add "Retry location" button + guidance** (no flag-and-allow) | 0.2d |

\* filed HIGH-adjacent (MED severity, HIGH impact — data loss).

## P3 — Prod-live MED

| ID | Sev | Surface | Bug | Fix | Est. |
|---|---|---|---|---|---|
| KYC-M1 | MED | KYC | Required-`*` fields (State, Account Holder) not in the Continue gate → late backend reject | Add to gates | 0.1d |
| KYC-M2 | MED | KYC | No pincode/IFSC format validation | 6-digit pincode + IFSC pattern (mirror GST) | 0.2d |
| KYC-M3 | MED | KYC | Inherited-doc note contradicts the card's own red `*` + empty dropzone | Soften asterisk + "Optional — group doc will be used" while inherited | 0.15d |
| KYC-M4 | MED | KYC | False "no outlets" empty state during load; no spinners | Loading flags + "Loading…"/"Restoring…" | 0.3d |
| KYC-M5 | MED | KYC | OTP-screen Back re-enters submitted form → risk duplicate submit | Resume existing submission / disable resubmit once submissionId set | 0.2d |
| KYC-M6 | MED | KYC | Locked-field visual inconsistent (green group-PAN vs grey re-KYC); no reason | Unify locked style + one-line reason | 0.15d |
| ENR-M2 | MED | Enroll | Media/camera/signature upload errors surface only in the global box, not field-tied | Per-field upload error | 0.25d |
| ENR-M3 | MED | Enroll | "OTP not verified" submit error doesn't scroll to the field | Give it a field id / quoted label | 0.1d |
| ENR-M4 | MED | Enroll | No OTP resend cooldown / no "code sent" confirmation / no expiry state | Countdown + sent line + expiry handling | 0.25d |
| ENR-M5 | MED | Enroll | Camera "open" re-entrant → orphaned streams on repeat taps | `opening` state, guard getUserMedia | 0.15d |
| ENR-M6 | MED | Enroll | Sales sees "Enrolled" with no fix affordance/explanation (self-edit disabled) | "Submitted — contact admin to correct" line | 0.1d |
| ENR-M7 | MED | Admin edit | MULTI_SELECT rendered as raw comma text box | Render `options` as checkboxes | 0.2d |
| BLD-M4 | MED | Builder | Validation errors rendered twice (builder + FormTab) | Dedupe: inline in builder, summary in FormTab | 0.15d |
| GRP-M4 | MED | Grouping | Un-group is one-click, no confirm (Deactivate has a modal) | Add confirm/2-step w/ "reverts to standalone" note | 0.15d |

## P4 — LOW polish + a11y

| ID | Sev | Surface | Bug | Fix | Est. |
|---|---|---|---|---|---|
| BLD-M3 | MED | Builder | Dual-source prefill (Excel col + outlet field) precedence not shown | One-line precedence helper / mutually-exclusive | 0.1d |
| BLD-M5 | MED | Builder | Validation errors say "Field 3", no jump-to-field | Clickable → expand+scroll, or error dot on collapsed header | 0.25d |
| SET-H1 | MED | Settings | Uniqueness card never states the CONSEQUENCE (rejects new KYC; not retroactive) | Per-row consequence line + card banner | 0.15d |
| SET-M3 | MED | Settings | Uniqueness toggles have no in-flight lock → rapid multi-field clicks race | `savingUniq` flag + spinner (mirror capture-mode) | 0.15d |
| GRP-M5 | MED | Grouping | Approve error only in a 3.5s toast (long backend msgs vanish) | Persistent inline banner | 0.15d |
| GRP-M6 | MED | Grouping | Create-Parent "needs Gifsy approval" under-explained for CLIENT_ADMIN | Standing note on page / pending badge | 0.1d |
| RST-L5 | LOW | Roster | Two similar downloads ("Download report" vs "Download roster") confusing | Clarify labels | 0.1d |
| RST-L7 | LOW | Roster | "Standalone"/"Linkage" jargon, no tooltip | Tooltip/gloss | 0.1d |
| ENR-L1 | LOW | Admin del | Undo toast auto-dismisses mid-restore request | Hold toast while restoring | 0.1d |
| ENR-L2 | LOW | Enroll | Only first invalid field highlighted on multi-error | Mark all invalid | 0.15d |
| ENR-L3 | LOW | Enroll | Tiny (text-[10px]) tap targets: resend/replace/retake/re-sign | Enlarge on mobile | 0.15d |
| ENR-L6 | LOW | Enroll | PHONE_OTP copy doesn't say the OTP goes to the OWNER's phone | Copy | 0.1d |
| KYC-L1 | LOW | KYC | Mobile-check fake 400ms delay + no request/abort guard | Abort guard | 0.2d |
| KYC-L2/L3 | LOW | KYC | Missing aria labels (camera/canvas), listbox roles; StepBar hides step name on mobile | a11y + show current step name | 0.3d |
| SET-L7/L10 | LOW | Settings | Segmented toggles no arrow-key nav; uniqueness card hard to discover | radiogroup keys / section nav | 0.35d |
| GRP-L8/L9/L11 | LOW | Grouping | Modals no Escape/focus-trap; child table no overflow wrapper; blocked un-group null-reason invisible | Escape+trap, wrapper, fallback text | 0.35d |

## D1 — Geo hard-block POLICY — ✅ OWNER-DECIDED 2026-08-02: **KEEP HARD-BLOCK + add "Retry location"** (option a)
KYC board-photo + payment geo are a **hard block** — a rep with device location off / no indoor fix cannot submit. Owner
chose **(a) keep the hard block + add a "Retry location" button + guidance** (KYC-H2), NOT (b) flag-and-allow. This is a
**deliberate divergence** from the per-photo-geotag `GEO_UNVERIFIABLE` flag-and-allow direction: KYC keeps strongest
at-source geo integrity (every KYC photo genuinely geo-verified) even though a rep in a true no-fix spot still cannot onboard
that outlet. So KYC-H2 = add Retry + clear guidance ONLY; the hard block stays.

## G1 — Geotag optional polish (`GEOTAG`, on develop `ee00dd2`)
| ID | Sev | Bug | Fix | Est. |
|---|---|---|---|---|
| GEO-M6 | MED | Reviewer shows raw lat/lng, no map link | Wrap coords in a maps link | 0.15d |
| GEO-L9 | LOW | "geo-fence"/"unverifiable" jargon unglossed | One-line plain hint on first use | 0.1d |
| GEO-L10 | LOW | Tiny tap/read targets on the mobile "location tagged" line | text-xs | 0.1d |

---

## Notes
- **Do NOT regress** (auditor-praised): scheme activation gate + tooltip; delete→undo→"Show deleted" restore; "creates a
  new version" edit banner; prefill "Locked" pill gated on a resolved source; camera denied/no-device inline+Retry states.
- Each phase = orchestrated build → full gate (api jest / nest / FE tsc / vitest) → independent audit (dual for KYC/consent/
  money-settings paths) → staging runtime-verify (+ owner device smoke for camera/GPS/signature) before merge.
- P2's SIG-1/SIG-2 + KYC-H2 + KYC-H4 touch the KYC/consent path → mandatory dual audit.
