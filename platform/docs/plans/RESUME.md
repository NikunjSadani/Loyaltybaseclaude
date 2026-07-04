# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-07-03.

🟢 CURRENT MODE — **GO-LIVE: prod live on `a2f5929`, DEOLEO TENANT CREATED + ACTIVE.** CUTOVER #2 was EXECUTED 2026-07-01
(owner-driven HYBRID; owner approved the `production` gate, I ran the reversible prep + in-VPC jobs on the owner's per-step go).
`main` == `develop` at cutover; both prod services serve `a2f5929`; prod `/health` = 200. Cutover #2 shipped the **onboard-slug
fix + per-tenant points-expiry + admin-users pagination/self-deactivate**; applied migration `20260630130000_point_expiry_default_unique`
(via `--wait`); pre-cutover backup **`1782886598428`**; created + ENABLED the **`expire-sweep-prod`** Cloud Scheduler (daily
00:30 IST; sweep smoke 403/201). **Deoleo is now CREATED + ACTIVE in prod** — onboarded via the fixed wizard (slug=`deoleo`,
internalName "Deoleo India", primaryColor #16a34a, invoicePrefix TGSL-DEO-, features 7/10 RBAC-OFF), then flipped `ONBOARDING→ACTIVE`
via a one-off guarded in-VPC job `gifsy-activate-deoleo` (`current_database()` guard). **Deoleo config = platform defaults:**
conversion rate **1:1 → value `1`**, points-expiry **NEVER → null** (default, nothing to set), visibility **OFF** (default). Keep
the fix-as-found loop available (owner reports a bug → diagnose → fix/delegate → INDEPENDENT audit → FULL gate → runtime-verify →
push to `develop`; prod follows on the next `main` deploy). **Remaining is owner-gated (Deoleo go-live):** owner assumes Deoleo (now
in "Work in brand") → **confirm conversion rate=1** + **create the first Deoleo CLIENT_ADMIN** (`/admin/users`, role **CLIENT_ADMIN
— NOT Gifsy Admin**) → **load real master data** via the app UIs when the client sends files (**#76**). Plus **#143** — WhatsApp
`deoleo_kyc_approval` template runtime-verify (MSG91 template not yet owner-verified). The recon'd **scale/ops plan** is now
**IN PROGRESS** (see the 🟡 SCALE/OPS paragraph below): pagination stream COMPLETE (W1+W2), observability O1+O2 done, security
log-leak fixed, KYC-submit-500 RESOLVED, ASM enrollment done, **KYC "Rejected / Re-upload" consolidation SHIPPED (`e970213`)**;
**NEXT = staging runtime-verify of this session's UAT fixes (Rejected/Re-upload, OTP-gates-routing, KYC-PDF-doc-view, not-interested) + resume the owner-gated Deoleo go-live items** (nothing else queued on the
scale/ops stream); notifications/P7 still PAUSED (build all events flag-OFF; **email provider still open** — ZeptoMail vs SES). **Required
onboarding-flow builds** are logged in POST-GO-LIVE-BACKLOG §A: **§A-DOMAIN** (decouple domain from slug) and
**§A-ONBOARDING** (client activate/edit endpoint — Deoleo was flipped via the one-off job — **plus the GIFSY_ADMIN-in-tenant-context
fix**: FE offers GIFSY_ADMIN only in platform context, backend `assertRoleAssignable` rejects GIFSY_ADMIN when `caller.clientId !== 'gifsy'`).

🔶 STANDING MODE — **YOU ARE THE ORCHESTRATOR (the owner should never have to remind you).** Default to orchestrating
substantial work, not hand-coding everything: decompose; **run independent workstreams as PARALLEL sub-agents** (give
each a precise spec; background sub-agents are DENIED shell → they WRITE code, YOU run the gates); fix the shared
contracts so parallel streams don't conflict; integrate the shared files yourself; and ALWAYS personally do the
security-critical review — an **INDEPENDENT adversarial audit** of every build item (it has caught a real defect on
money/auth paths every time), the **FULL gate**, and **runtime-verify** before claiming done. When the owner challenges
a recommendation ("are you sure?"), genuinely reconsider — don't defend (it flipped the redemption-gate + auth-refresh
calls this session). Also OWN doc/memory CONSISTENCY: when a fact changes, sweep EVERY doc + memory in the same pass.
[[default-to-orchestration]] [[own-consistency-no-micromanage]] [[audit-every-build-item]] [[verify-flows-at-runtime]]

🟡 SCALE/OPS + UAT-FIX BUILD (post-Deoleo, owner-driven, orchestrated — rides the NEXT cutover; **prod stays on `a2f5929`,
develop is now AHEAD (this scale/ops wave landed by `97c5089`; the develop tip has since advanced to `a4c6def`).** SHIPPED to `develop` + gate-green + each independently audited: **(1)** security
log-leak fix (`df47baf` — prod was logging live redemption OTPs + full phone numbers; removed/masked); **(2)** observability O1+O2
(`33543ec` — `nestjs-pino` structured JSON logs + a real `/health/ready` DB-ping probe, verified live; audit CAUGHT a HIGH `?token=`
query-log leak → custom PATH-only req serializer; O3/OpenTelemetry DEFERRED — needs monitoring-IAM + `deploy.yml` edit); **(3)** ✅
**pagination stream COMPLETE** — Wave 1 (`2d1a50e` — `/admin/outlets` + `/admin/credits/batches`/`/reversals`, `@Max(100)`; audit
CAUGHT a HIGH KYC-status-parity double-count bug → fixed) AND Wave 2 (`9e79e49` — `/admin/invoices` + `/admin/schemes`; audit CAUGHT +
fixed a MEDIUM scheme-visibility defect: `?status` wasn't admin-gated → a non-admin could `?status=DRAFT` to enumerate unpublished
schemes → non-admins forced to `ACTIVE`, runtime-verified; the tiny KPI/banner/partner-sales user-scoped lists were deliberately
SKIPPED, owner-agreed low value); **(4)** ✅ **KYC-submit 500 FIX — RESOLVED** (`2419ab6` — `POST /v1/kyc` `channelPartner.create()`
aborted the tx on `@@unique([clientId,gstNumber])`; the old P2002 guard retried on an aborted tx + branched on the
pg-adapter-unreliable `e.meta.target`. Fix pre-resolves uniqueness before the insert — pre-check `(clientId,gstNumber)` → clean 400,
pre-pick a free `partnerCode`, non-retrying P2002 safety net; applied on both create + re-KYC-update paths. Audit CLEAN; regression
test; deployed to staging. NOT an open blocker — final live confirm = owner re-tries the exact submit, but it's fixed); **(5)** ✅
**ASM enrollment** (`4bea680` — ASM now gets the "New Enrollment" button + KYC to-do tasks alongside XSR/SO; FE-only `canEnroll()`
helper `ENROLL_ROLES=['XSR','SO','ASM']`, backend needed nothing — `resolveInitialRouting` routes an ASM-initiated KYC to the ASM's
manager; blanket all tenants; audit CLEAN). **(6)** ✅ **KYC "Rejected / Re-upload" consolidation** (`e970213`) — owner resolved the
open decision with "the gifsy admin approval/rejection dashboard remains as is" → reviewer KEEPS all 3 actions (Approve/Reject/Request
Re-upload, still writes `RE_UPLOAD_REQUIRED`); the change is rep-facing + FE-enum only. Fixed the LIVE latent bug (backend writes
`RE_UPLOAD_REQUIRED` but the FE enum only had the dead alias `RESUBMISSION_REQUIRED` → re-upload rows crashed `kycBadge[status]`,
matched no filter, weren't resubmittable): added `RE_UPLOAD_REQUIRED` to the FE enum + every exhaustive `Record<KYCStatus>` badge map
(tsc caught partner/profile), single "Rejected" filter now covers `{REJECTED,RE_UPLOAD_REQUIRED,RESUBMISSION_REQUIRED}` (dropped the
separate Re-upload tab; filter/border/deep-link/tiles), RE_ENTRY sets (FE + backend `sales.service.ts:1009`) include it so re-uploads
resubmit. Backend submit already allowed it (`RE_UPLOAD_REQUIRED` ∉ `IN_FLIGHT_STATUSES`). Independent audit CLEAN; regression test
`reupload-consolidation.test.tsx`. **(6b)** owner follow-up (`bf5df38`): re-upload rows badge simply as **"Rejected"** (keep it simple)
across all rep + partner surfaces; admin reviewer untouched. **(7)** ✅ **PER-TENANT CONVERSION-RATE EDITOR** (`e1257f7`) on
`/admin/settings` (GIFSY-edit/CLIENT_ADMIN-read; floor 0.005 + centi-snap; staging-verified). **(8)** ✅ **DOWNLOAD-HELPER SWEEP**
(`01c253f` outlet-master + `d7b3952` class-wide) — every blob download (all 4 reports exports, KYC list/review-dump, payout/fund/credit
-status, enrollments, visibility, error-report) routed through one `src/lib/download.ts` `downloadBlob()` (DOM-append + deferred revoke);
a detached-anchor + sync-revoke after a `fetch` silently no-op'd the save. **(9)** ✅ **WHATSAPP POST-OTP** (`f8d5d22`) — the outlet
"KYC submitted" WhatsApp now fires at `consent()` (after the owner OTP verifies), not at `create()`. **(10)** ✅ **OTP GATES ROUTING**
(`eead7b9`) — the KYC reaches the approver ONLY after the outlet-owner consent OTP; reuses the unused `KycStatus.DRAFT` as the pre-OTP
state (NO new status/migration; `deriveKycStatus` already buckets DRAFT→IN_PROGRESS); create()→DRAFT+no-notify, consent()→route+notify
+WhatsApp (idempotent, gated on DRAFT); FE teaches DRAFT (label "Pending", PENDING_KYC filter, re-entry). **(11)** ✅ **KYC PDF DOC
RENDER** — admin reviewer (`b749f55`) + sales rep detail (`c1cbae6`): PDFs (GST cert/cheque/shop-est are application/pdf) rendered blank
in `<img>` → now render in `<iframe>` via a blob URL (Chrome blocks data: in iframes/new-tabs); photos keep `<img>`; XSS guard intact
(only image/* + pdf inline). Confirmed NOT a regression via a staging DB read (docs stored + inlined fine). **(12)** ✅ **NOT-INTERESTED
404 FIX** (`97c5089`) — `POST /v1/kyc/not-interested` looked the outlet up by `clientId_outletCode` but the FE sends the Outlet CUID
(`outletId=outlet.id`) → EVERY call 404'd (staging logs 4×) → 0 outlets ever marked → empty "Not Interested" filter; now `findFirst({id,
clientId})` like create(). **STILL PAUSED for owner:** Notifications Core go/no-go (drainer is PUSH-only so enqueued SMS/WhatsApp/email never
deliver + in-app inbox needs an `InAppNotification` migration; 2 of 3 events BLOCKED on missing upstream) · email provider (ZeptoMail
~$0.25/1k vs SES ~$0.10/1k). See POST-GO-LIVE-BACKLOG §B/§C + GO-LIVE-ISSUE-LIST 🔜 NEXT + 🟡 SCALE/OPS sections.

GATES (run the FULL suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`):
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` · `cd platform &&
npx tsc --noEmit`. **Latest green: api jest 1369 · nest 0 · FE vitest 1763 · tsc 0 (prod `main` HEAD `a2f5929`; develop HEAD `a4c6def`).** **Last pushed HEAD: run
`git -C C:\Users\nikun\Loyaltybaseclaude log --oneline -1`** (don't trust a hardcoded SHA). **Deploy ≠ pushed** — a
docs-only commit after a code push re-tags the serving image, so verify the serving SHA matches the CODE you mean to
test (`gcloud run services describe gifsy-api-staging|gifsy-frontend-staging --region asia-south1 --project
gifsy-platform --format='value(spec.template.spec.containers[0].image)'`). FE tsc gotcha: a stale `.next/types` can
surface a phantom error (a page exporting `RejectionModal` — a real but pre-existing webpack-only hygiene issue,
spawned-task'd); `rm -rf platform/.next` then re-run tsc to confirm your change is clean. REUSABLE TRAPS:
**(1)** NEVER use `isActive:true` as an "active outlet" denominator (outlets are created `isActive=false` until KYC
approval — use `deletedAt:null AND deactivatedAt:null`); **(2)** Prisma `{ not: X }` SILENTLY DROPS NULL rows →
OR-wrap `OR:[{col:null},{col:{not:X}}]`; **(3)** a partner's **Wallet row is created ONLY at KYC approval** — any
pre-KYC points path must `wallet.upsert` (get-or-create); **(4)** tokens are **bearer JWTs verified at the proxy with
NO refresh + NO revocation**, and the proxy prefers the `Authorization` header (localStorage) over the cookie — a
stale localStorage token fails even if a valid cookie exists (assume-tenant 8h vs login 7d desync);
**(5)** Cloud Run **throttles CPU between requests** (`cpu-throttling=true`), so a NestJS `@Interval`/`@Cron`
background worker does NOT tick reliably while the service is idle — `min-instances=1` alone does NOT fix it (the
instance is alive but CPU-starved). Drive such workers via **Cloud Scheduler → an internal HTTP endpoint** (the
request un-throttles the CPU), or set cpu-always-allocated (~$50/mo). This is why the push drain runs on a scheduler.
**(6)** THE FE's `outletId` EVERYWHERE = the **Outlet CUID** (`o.id`), NOT `outletCode` — any endpoint keyed on
`clientId_outletCode` from an FE-sent outletId is WRONG; use `findFirst({id, clientId})` (bit not-interested-404 + KPI/target
paths). **(7)** the sales **KYC LIST `/api/kyc` is SUBMITTER-scoped** (approval-queue: a rep sees only KYCs he/his-downline
FILED), but outlet **OWNERSHIP is ASSIGNMENT-scoped** (`buildOutlets`/`/api/sales/outlets`). So ALL rep-actionable re-entry
states (NOT_STARTED / NOT_INTERESTED / RE_KYC_REQUIRED / REJECTED / RE_UPLOAD_REQUIRED / RESUBMISSION_REQUIRED) MUST be
synthesised from `/api/sales/outlets` (assignment) and merged with the submitter-scoped submissions **deduped by outletCode,
synth-wins** — else a REASSIGNED outlet whose original KYC was filed by another rep is invisible in list/dashboard/tasks.
(`kyc.service.list()` stays submitter-scoped by design; `getOne` is assignee-aware via `partnerId`.) **UPDATE 2026-07-03
(`e9b3a21`): the sales /sales/kyc LIST is now fully ASSIGNMENT-DRIVEN** — the FE synthesises EVERY subtree outlet's derived KYC
state from `/api/sales/outlets` (ALL states, not just re-entry), so an UPLINE-submitted outlet (e.g. an ASM enrolling an XSR's
outlet) shows to the assignee XSR + SO too; the submitter-scoped `/api/kyc` now only supplements outlets NOT in the caller's
subtree (reassignment edge). buildOutlets returns `assignedUserId` (assigned rep) so the branch member-filter matches
not-started/approved outlets. So "the LIST is submitter-scoped" above is HISTORICAL — the raw endpoint still is, the rendered
list is not. **(8)** any
**bulk-upload loop of awaited writes inside ONE interactive `$transaction` 500s at tenant scale** — default timeout 5s,
Deoleo ~2,261 outlets (`PrismaClientKnownRequestError: query cannot be executed on an expired transaction`). Fix = **chunk**
into `$transaction([...])` batches of ~100 for idempotent paths (targets/achievements upserts), or **raise
`{ timeout: 180_000, maxWait: 20_000 }`** for MONEY paths that must stay atomic (credits confirm/UTR, payouts process/UTR —
chunking them risks partial/double credit). **(9)** **re-KYC has TWO entry paths** — the in-app admin action flips the
submission status → `RE_KYC_REQUIRED`, but the **bulk re-KYC-flag upload sets ONLY `Outlet.reKycFlags`** (submission stays
APPROVED). `reKycFlags` (a non-empty object) is the source of truth: any surface showing KYC status MUST check it via
`isReKycPending()` (`common/kyc-rekyc.helper.ts`, shared by admin `deriveKycStatus` + sales `buildOutlets` +
`kyc.service.list`), or a bulk-re-KYC'd outlet reads as Approved. **(10)** `isActive:true` is the platform's denormalised
**"approved + active" predicate** (no `kycStatus` column on Outlet; created `isActive:false`, only KYC approval sets it
true) — the targets/KPI change keys the primary-performance KPI on it (upload accepts ALL outlets; KPI counts only
`isActive`). **(11)** a FE **response-merge must match the service's ACTUAL projection shape** — the Gifsy client editor read
`updated.branding.x` (nested) while the service returns it FLAT, so branding edits silently REVERTED after "Saved" (DB was
correct). **(12)** a spec's `$transaction` mock typed `(cb) => cb(tx)` (1 param) makes `.mock.calls[0][1]` (the options arg)
a TS compile error — widen to `(cb, _opts?) => cb(tx)` when asserting the timeout option.

**META-LESSON (the owner had to remind me — bake it in): a fix is DONE only when EVERY consumer + alternate data path +
scale case is traced, not just the visible one.** The re-KYC fix took THREE rounds (derivation → the submitter-scoped list
path → the whole REJECTED family + dashboard/tasks) because I fixed the obvious path and shipped. Before calling any fix
done: (a) grep EVERY consumer of the changed data/endpoint (the KYC list reads a DIFFERENT endpoint than the dashboard);
(b) check the SCALE case (correct at 10 rows, 500s at 2,261); (c) check the ALTERNATE entry path (bulk upload vs in-app
action produce different DB states). When the owner reports a UAT bug, spend the extra pass to verify the WHOLE class
end-to-end — it's cheaper than the re-report. NEWEST-40 ran 3 parallel adversarial verifications over the session's work +
found 3 real gaps (rejected-family visibility, 4 money-path scale bugs, onboarding-save revert).

**META-LESSON 2 — CLARIFY BEFORE AN IMPERFECT BUILD ([[clarify-before-imperfect-build]], owner had to remind me 2026-07-03):**
if I recognize an approach is NOT the ideal/complete solution, ASK & clarify BEFORE building — do NOT ship a caveated partial and
iterate. The sales KYC page took THREE turns (branch member-filter → assigned-rep match → fully assignment-driven list) because
each turn I shipped a knowingly-incomplete fix flagged with an "honest caveat" instead of naming the real design question up
front. The tell: about to write "one honest caveat remains…" / "rare edge…" / "good enough for the common case" about a gap I
already understand → STOP, present the ideal vs the shortcut, and let the owner choose. Caveats are for TRULY rare/unknowable
edges (and even then, say why closing them isn't worth it), never for a gap I could design correctly now.

DONE THIS SESSION (all gate-green + independently audited + pushed to `develop`; runtime-verified where an API/edge check was possible):
- **🆕 2026-07-02/03 — owner-driven UAT fix-as-found + a full completeness verification (NEWEST-36→40; develop `a8a8efa`→`97c5089`, 7 commits):**
  · **(NEWEST-36 `a8a8efa`)** Sales KYC list: "Outlet Types" filter label + tapping a NOT_STARTED row deep-links
    `/sales/kyc/new?outletId=<CUID>` so the wizard's existing `?outletId` auto-select pre-fills the outlet. Diagnosed
    DAMD0638 "not-interested reappeared" as the PRE-`db5f5ab`-404 artifact (now persists; fix live), not a new bug.
  · **(NEWEST-37 `7dba419`)** TARGETS/ACHIEVEMENTS: admin can upload against **ALL** outlets (dropped `isActive:true` from the
    4 roster queries), sales SEE all outlets' numbers, but every primary-performance KPI (hero/leaderboard/pace/team%) counts
    **approved+active only** (`subtreeOutletCodes()`→`{all,active}`; buildTeamRollups keeps counts over all, % over active).
    Owner decisions: "approved+active"==`isActive:true`; Team-Total footnote; include not-interested. Audit CLEAN.
  · **(NEWEST-38 `e03e2ac`)** TARGETS-UPLOAD 500 FIX — the WS1 all-outlets roster (~2,261) blew the 5s interactive-tx limit;
    chunked the upserts into `$transaction([...])` batches of 100 (trap #8). **+ (`cb8f15d`) §A-ONBOARDING**: `PATCH
    /v1/gifsy/clients/:slug` + `updateClient` (branding+nested-partnerApp deep-merge) + assume-ONBOARDING + Gifsy-console
    activate/edit; **closed the GIFSY_ADMIN-in-tenant footgun** (`assertRoleAssignable` gates GIFSY_ADMIN to `clientId==='gifsy'`
    on create+update; FE `assignableRoles` hides it in a tenant). Audit found+fixed F1 (nested features merge) + F2 (reserve
    the `gifsy` slug). Prod CLIENT_ADMIN verified clean (Khushi Agarwal=CLIENT_ADMIN/deoleo; 0 mis-scoped GIFSY_ADMINs).
  · **(NEWEST-39 `c3859f4`+`e434bca`)** RE-KYC INVISIBLE-TO-SALES — a bulk re-KYC'd outlet (reKycFlags set, submission APPROVED)
    didn't show under the rep's Re-KYC filter/tasks. Shared `isReKycPending()` helper (trap #9) surfaces it in buildOutlets +
    kyc.list; then the follow-up added the assignment-scoped synth to the KYC LIST because `/api/kyc` is submitter-scoped and
    the outlet's original KYC was filed by the rep's SO (trap #7). Diagnosed via staging DB reads (submitter=Praveen SO, assignee=Lalit ISR).
  · **(NEWEST-40 `97c5089`)** END-TO-END COMPLETENESS PASS (owner: "this should have been one shot — check the session's other
    work is correct"). 3 parallel adversarial verifications → 3 REAL gaps FIXED: **(a)** the re-KYC fix was incomplete for the
    REJECTED family — generalised the sales/kyc synth bucket to the whole re-entry set + fixed the dashboard + tasks "Rejected
    KYC" groups (assignment-scoped + no-outlet-sub merge, deduped); **(b)** 4 latent money-path scale bugs (credits confirm/UTR,
    payouts process/UTR) = same class as the targets 500 → raised the tx timeout, kept atomic (trap #8); **(c)** §A-ONBOARDING
    Save silently reverted branding edits — FE read nested, service returns flat → fixed FE + updateClient/create/list return
    supportPhone+invoicePrefix (trap #11). Verified CLEAN: targets chunking, the synth/subs merge, deep-link auto-select,
    §A-ONBOARDING proxy/assume/brand-switcher, all single-entity KYC/wallet/TDS/reward txns.
- **🆕 2026-06-30 — go-live builds + execution prep (newest first):**
- **🆕 2026-06-30 — go-live builds + execution prep (newest first):**
  · **WHATSAPP KYC NOTIFICATIONS** (`3900af3`, audit SHIP) — WhatsApp to the **outlet owner** on KYC submit + approve via MSG91 (Deoleo).
    `Msg91Service.sendWhatsappTemplate` (v5 bulk `…/whatsapp-outbound-message/bulk/`, integrated # **917003202293**, lang `en`, 10-digit recipient
    guard) + `kyc.service.sendKycWhatsapp` **fire-and-forget POST-COMMIT** (fully try/catch — can NEVER throw into/block/rollback the KYC tx) wired
    at SUBMIT (`deoleo_kyc_submission`: owner·date·program) + the single canonical `KYC_APPROVED` hook in `notify()` (`deoleo_kyc_approval`:
    owner·program). Recipient = `ChannelPartner.phone` (KYC contact), NOT the rep. Per-tenant config-gated via `notifications/whatsapp-kyc.config.ts`
    (only `deoleo`). **SUBMIT trigger RUNTIME-VERIFIED — a real WhatsApp was delivered to a test phone (9830011252) on staging.** APPROVAL trigger
    runtime-verify DEFERRED (the `deoleo_kyc_approval` MSG91 template isn't owner-verified yet — task #143). `MSG91_WHATSAPP_NUMBER` defaults to the
    number in code; add explicitly to prod env at cutover. **Pattern for a NEW transactional WhatsApp/SMS: add to `whatsapp-kyc.config.ts` + call
    `sendWhatsappTemplate` fire-and-forget post-commit; success logs nothing → confirm on a real phone.**
  · **ADMIN-CREATION UI** (`d306129`, audit SHIP) — closed an owner-found gap: there was NO UI to create admins (backend `POST /v1/admin/users`
    existed + secured, but the only FE consumer was a read-only "Phase 2" stub). New **`/admin/users`** (list + role-gated Create + deactivate),
    FE-only (`createUser` scopes to the JWT clientId, **assumed-tenant-aware**; `assertRoleAssignable` is the real gate). A GIFSY operator ASSUMES
    Deoleo → creates the Deoleo CLIENT_ADMIN; platform-context → more GIFSY_ADMINs; CLIENT_ADMIN → MIS_USER. **Runtime-verified end-to-end on
    staging** (assume-deoleo → create CLIENT_ADMIN(clientId=deoleo) → it logs in → escalation BLOCKED). Outlet types: the 4 are bootstrap-defined
    (no owner input); master list not portal-editable by design; per-tenant enable/rename + POINTS/PAYOUT award maps ARE wired.
  · **SESSION REPORT** (`7021c58`, audit SHIP-with-fixes) — per-user portal-usage report `/admin/reports/session`: last-login + active-days/month
    for 13 months (IST). "Active day" = ≥1 authenticated request that day (NOT a login), stamped fire-and-forget from `JwtStrategy.validate` into
    new `UserActivityDay` (additive migration `20260630120000`, no backfill). Replaced 3 fake engagement cards. Runtime-verified (607 users).
  · **AF-3 FABRICATED-BANK FIX** (`e843b0b`) + **STALE-DOC RECONCILIATION** (`f7c30c2`) — partner Profile rendered a hardcoded fake bank
    (`HDFC/…3456`) even on `/auth/me` success → fixed to the real beneficiary or an honest empty state. The owner challenged my go-live gap list
    ("did you analyze ALL docs") → I'd skipped the master tracker; reconciled the stale in-repo go-live docs to reality. **LESSON: the master
    tracker + this memory are the go-live source of truth; verify any "open" item in CODE.**
  · **GO-LIVE EXEC PREP** (`e0b8655` + branch `762251e`) — prod env verified CLEAN (NODE_ENV=production, no FIXED_OTP/DEMO_MODE); CUTOVER-RUNBOOK
    REWRITTEN to the hybrid 0–7 sequence; **prod-PWA staged on `prep/prod-pwa-activation` (UNMERGED — merge into develop only AFTER creating the 3
    prod secrets; cmds in `runbooks/prod-pwa-activation.sh`)**; bootstrap-in-image verified.
- **🗄️ 2026-06-29 — GO-LIVE PREP + PWA ACTIVATION (prior session — historical):**
  · **Phase-0 runbooks** (`c998267`) — `docs/plans/runbooks/{OWNER-OPS,CUTOVER,PROD-DATA-LOAD,DEOLEO-GO-LIVE-CONFIG-CHECKLIST}.md`;
    live gcloud recon CORRECTED stale facts (prod live · backups/PITR ON · deploy.yml auto-migrates behind a `production` gate).
  · **PROD BOOTSTRAP SCRIPT BUILT** (`262027a`) — `api/prisma/bootstrap.ts` (first GIFSY_ADMIN = **Nikunj/9830011252** + 4 OutletType rows;
    idempotent, double-guard `BOOTSTRAP_CONFIRM===current_database()`, compiles to `prisma/bootstrap.js` in the prod image). Audit SHIP;
    **dry-run-verified on real infra** (ran as a Cloud Run Job vs `gifsy_staging` → clean idempotent no-op). Closes the bootstrap blocker.
  · **Lane-4 minors** (`62e3b8e`) — GLm-3 tenant-scope the slaMetrics rejection histogram; S3 logger.warn before RE_UPLOAD 409;
    GLm-2 was already fixed (#86). 
  · **MONITORING LIVE** (`b75b630`) — 2 email channels (`nikunj.sadani@gifsy.in` + `nikita@gifsy.in`) + 5xx + uptime alert policies on
    prod `gifsy-api` (alert→resolve email confirmed end-to-end). #74 monitoring DONE; **backups/PITR already ON**; secret rotation = optional.
  · **PWA PUSH FE-SUBSCRIBE (E)** (`c1b70dd`) — `lib/pwa/push.ts` + `PushSubscriptionManager` (gated `NEXT_PUBLIC_PWA_PUSH_ENABLED`,
    permission only on user gesture) + logout best-effort unsubscribe (raced 1.5s timeout). Audit caught a HIGH (unsubscribe must use
    `getRegistration()` NOT `serviceWorker.ready` — `.ready` never resolves with no SW → would hang logout); fixed + regression test; re-audit SHIP.
  · **PWA ACTIVATED ON STAGING** (`d6f91de`+`0027a34`+`ce95a83`) — VAPID keypair → secrets `VAPID_{PUBLIC,PRIVATE}_KEY_STAGING`
    (+`PUSH_WORKER_ENABLED=true`,`VAPID_SUBJECT`); `build:sw` emits `/sw.js` via **esbuild** (added as devDep); the 3 `NEXT_PUBLIC_PWA_*`
    flags = `true` **on the staging build ONLY** (prod deploy.yml untouched = OFF). Two runtime bugs caught+fixed: `/sw.js` was 307'd by the
    auth middleware (added `sw.js|offline.html` to the `proxy.ts` matcher); manifest `start_url=/partner` 404'd (no bare-route page → set to
    `/{portal}/dashboard`). **Runtime-verified on the live Deoleo edge:** `/sw.js` 200 (37kb, push+notificationclick handlers) · vapid-public-key
    served · manifests 200 · push-worker drained + dispatched a real test push (`[push-worker] processed 1 PUSH row(s)`). VAPID public key
    (safe to show): `BIMw2jJrSRKraaCqcjyBWuUEFwhKA-wG3SpLzniRHnNCeXtV1ySZsMn5ptmQzLkQOZbLV7A2-ZDWSw-AD_jVgDI`.
    **✅ DEVICE-TEST RESOLVED:** owner on **Android**, subscribed as SALES_ISR; a scheduler-driven push was **delivered** (queue row SENT,
    `endpointsSent:2`). To fire a test push: enqueue a `NotificationQueue` PUSH row for a subscribed user via the `gifsy-oneoff-staging` job,
    then `gcloud scheduler jobs run push-drain-staging` (or wait ≤60s). Confirm POST to the edge needs `-H 'Content-Length: 0'` (411).
  · **SALES PUSH NOTIFICATIONS** (`f11d5d1`, audit SHIP) — new global `SalesNotificationsService` enqueues PUSH to the SALES team on 4 triggers,
    wired POST-COMMIT (fire-and-forget; tenant-scoped recipient resolution = the cross-tenant-leak guard): **new KYC assigned** → the assigned
    rep (aggregated one-push-per-rep: admin-outlets CREATE rows + admin-core reassign) + the routed approver on submit; **rejected / RE_UPLOAD**
    → the responsible rep (`kyc.reject`; clientId sourced from `submission.user.clientId` so a non-assume GIFSY reject still reaches the rep);
    **targets uploaded** → the assigned XSR + their first active manager (SO) per outlet, de-duplicated. Recipients via `SalesUserAssignment` +
    `firstActiveApproverId`. (Owner decision: KYC=BOTH rep+approver; targets=XSR+SO.)
  · **RELIABLE DELIVERY — CLOUD SCHEDULER (Option A, ~free)** (`f11d5d1`) — see TRAP #5. Added `@Public POST /v1/push/drain` (FAIL-CLOSED,
    `PUSH_DRAIN_SECRET` header, constant-time compare) pinged every 60s by Cloud Scheduler job **`push-drain-staging`**. Secret =
    `PUSH_DRAIN_SECRET_STAGING` (Secret Manager, granted to `gifsy-api-sa`, wired into `deploy-staging.yml`). Runtime-verified end-to-end
    (403 without secret / 201 with; scheduler run delivered a real push). **Prod = CUTOVER-COUPLED** (see CUTOVER-RUNBOOK PWA section).
  · **PWA ADOPTION TRACKING** (`c6dd001` BE + `cf14992` FE) — new **`pwa_install`** table (additive migration `20260629120000`, auto-applies on
    deploy); `POST /v1/push/installed` beacon (`InstallBeacon` fires when the app runs standalone, platform Android/iOS/Desktop); `GET
    /v1/push/adoption` (tenant-scoped: notifications-enabled by role/OS + installed by platform). New admin **"App Adoption"** page, visible to
    **CLIENT_ADMIN + GIFSY_ADMIN**. Runtime-verified on staging (install write→read confirmed; deoleo shows 2 subscribed sales users).
  · **REAL DEOLEO ICON** (`a468b93`) — owner's white wordmark composited on the `#16a34a` brand-green tile via `scripts/generate-pwa-icons.ts`
    (source `public/logos/deoleo.png`, gitignored — only generated `/icons/deoleo/*` are committed). Replaces the "D" monogram; white-on-solid =
    visible on any home screen + avoids iOS transparent→black. To SEE it, re-install the home-screen icon (cached at install time).
  · **PWA PROMPT SNOOZE + PROFILE ENTRY POINT** (`449d510`) — install/notification banners now **snooze 3 days** instead of permanent dismissal
    (a one-time "Not now" no longer locks the user out forever); shared `lib/pwa/install-prompt-store.ts` + new **`PwaAppSettings`** card in the
    partner+sales Profile pages (Install button / iOS instructions + Notifications enable/on+turn-off/"blocked → re-enable in browser settings").
    KEY UX FACT: after a browser **hard-block** of notifications we can NEVER re-prompt programmatically — only the settings path recovers it.
  · **REAL DEOLEO LOGO IN THE APP HEADERS** (`24f8673` + `488fc31`) — replaced the hex brand mark with the real Deoleo wordmark, PER-TENANT +
    non-breaking via two new optional `BrandingConfig` fields (set for deoleo only; clientb/gifsy keep the hex + display-name): **`wordmarkWhiteUrl`**
    (`/brand/deoleo-wordmark-white.png`) on the DARK surfaces — sales navy header (`#1A1A2E`) + desktop `Sidebar`; **`wordmarkColorUrl`**
    (`/brand/deoleo-wordmark-color.png`) on the LIGHT surface — the white partner/outlet header (mobile, `lg:hidden` so desktop uses the sidebar
    logo, no double-logo). Both = the owner's logo auto-cropped (`sharp .trim()` → ~2.95:1) to a tight wordmark; **committed art lives in `public/brand/`
    (NOT gitignored), source art in `public/logos/` (gitignored)**. Layout: `[logo] [name]` on both portals (sales = rep name/empId; partner = outlet
    name/owner name). Verified good via faithful header mocks (white-on-navy + colour-on-white). Gate FE vitest 1694 / tsc 0.
- **PWA WAVE 1 + F4 + LOCAL PUSH DRY-RUN ✅** (`185c548`→`40d0934`) — installable per-tenant shell (manifest Route
  Handlers + iOS meta), sharp icon pipeline, Serwist SW (flag-OFF, with `push`+`notificationclick` handlers), install
  prompt, full Web Push backend; ships DISABLED behind 3 flags (all default OFF). Per-tenant manifests runtime-verified
  on the live Deoleo edge; push SEND path dry-run-proven (real web-push lib). **Remaining = CUTOVER-COUPLED, NOT during
  UAT.** Canonical = **`PWA-PLAN.md`** (read its Status + dry-run blocks; cutover SW-emit is **esbuild**, not webpack).
- **CREDIT-FIELD AWARD CONFIG + SELF-EXPLAINING SKIPS ✅** (`2d2be25`) — root cause of "upload credited nothing, report
  gave no reason": credit fields shipped with an EMPTY `outletTypeAwards` map, so every row resolved to `NA` and was
  silently SKIP'd with a blank Errors column; there was no UI to set the map (PATCH only did activate/deactivate). Fix:
  `PATCH /admin/credits/fields/:id` now also accepts an `outletTypeAwards` map (POINTS/PAYOUT/NA, strictly value-validated
  so a malformed map can't misroute money; activate/deactivate unchanged; empty body rejected); new per-field award editor
  (drill-in on the Field Configuration page) with a money-path confirm on any POINTS↔PAYOUT flip; SKIP rows now carry a
  `skipReason` (NA-for-type / blank-zero) surfaced in the upload report's Errors column + on-screen preview. Award type is
  resolved per outlet type from ONE uploaded file and **frozen at upload** (confirmBatch reads the stored awardType, never
  re-resolves). Deoleo rule: **WHOLESALER=POINTS, all other types=PAYOUT** (same numeric column → whole points for
  WHOLESALER, ₹ for PAYOUT types). No DB migration (`outletTypeAwards` already JSON). Audit SHIP (all failure modes fail
  closed). Runtime-verified on live staging: maps persist + bad value 400s; a WHOLESALER POINTS row credited the wallet
  (Ravi Kumar/O001 50000→**51234**) while the SSS row created a PAYOUT entry, `skipped: []`. ⚠️ **Deoleo's staging award
  maps are now SET (all 3 fields)** — a re-upload now credits. **GO-LIVE: prod fields are created with an empty map, so the
  Monthly/Visibility/Consistency award maps MUST be set once on prod (via the editor) before the first credit upload, or
  prod repeats this exact silent-skip.** **Follow-up `6c563ca`: the editor's outlet-type list is now DYNAMIC** — new
  `GET /admin/credits/outlet-types` (tenant-scoped, keyed on `OutletType.code` = the parser's resolution key) replaces the
  hardcoded four, so adding a new outlet type to a tenant needs no code change (adding a new *field* never did); save
  MERGES the map so a since-disabled type's award is preserved. Audit SHIP; gate api jest 1220.
- **CREDIT-UPLOAD FIX ✅** (`2e1b5be`) — points were silently skipped for pre-KYC partners (no Wallet) and the FE
  ignored the confirm response (showed "success", nothing credited, blank report). Fix: `wallet.upsert` at credit time
  (points accrue pre-KYC; payout still gated); unresolvable rows now skip WITH a reason; FE surfaces actual-credited +
  a "Skipped (Not Credited)" report sheet. (Trap #3 above.)
- **REDEMPTION KYC GATE — ALL MODES ✅** (`7d74936`, owner decision) — since pre-KYC outlets can now hold a funded
  wallet, the audit found they could redeem a VOUCHER/physical gift (cash was already gated). `confirmRedeem` +
  `confirmRedeemForOutlet` now require KYC-APPROVED+active for **every** mode (pre-tx + in-tx TOCTOU).
- **SESSION-EXPIRY GUARD ✅** (`db89542`, owner decision) — an expired token showed a cryptic "Invalid token" with no
  recovery (no FE refresh; refresh token discarded at login). `SessionExpiryGuard` (root layout) bounces any `/api`
  **401** to `/auth/login?expired=1` (401 only — 403 left alone; excludes `/api/auth/*`; loop-guarded). Proper
  httpOnly-cookie auto-refresh is the AF-6 hardening — deliberately NOT done (localStorage refresh token = worse XSS).
- **ADMIN DASHBOARDS (4 REAL) + TICKET SLA ✅** — earlier this session; see [[admin-dashboard-consolidation]] + traps
  #1/#2. (Prior UAT batches in GO-LIVE-ISSUE-LIST.md + [[deoleo-go-live-bundle]].)

🚀 CUTOVER STATE — **✅ CUTOVER #2 EXECUTED 2026-07-01. Prod `main` HEAD = `a2f5929` (unchanged since); develop has SINCE advanced to `a4c6def` (scale/ops + KYC + UAT fix-as-found + C-batch + sales-KYC/UX work; rides the NEXT cutover).** Cutover #2 shipped
the **onboard-slug fix + per-tenant points-expiry + admin-users pagination/self-deactivate**; applied migration
`20260630130000_point_expiry_default_unique` (via `--wait`); pre-cutover backup **`1782886598428`**; created + ENABLED the
**`expire-sweep-prod`** Cloud Scheduler (daily 00:30 IST; sweep smoke 403/201). Both prod services healthy `/health` 200.
**Deoleo tenant is now CREATED + ACTIVE in prod** (onboarded via the fixed wizard slug=`deoleo`; flipped `ONBOARDING→ACTIVE`
via one-off job `gifsy-activate-deoleo`; config = platform defaults: conversion `1`, expiry null, visibility OFF). Gate at
cutover #2: api jest 1289 · nest 0 · FE vitest 1698 · tsc 0.

**CUTOVER #1 (2026-06-30) — historical:** prod `main` moved **`b3ab2e0` → `2fa020c`**
(213-commit + 8-migration jump); both prod services (`gifsy-api`, `gifsy-frontend`) served **`2fa020c`**;
prod `/health` = 200. As-run summary:
- **8 additive migrations APPLIED** via the in-VPC `gifsy-migrate` job (`migrate deploy --wait`) before the new revision
  served (constraints + new status enum value + `add_push_subscription` + `add_pwa_install` + `add_user_activity_day`) —
  proven by the healthy roll + bootstrap writes to the new tables.
- **BOOTSTRAP DONE** — `gifsy-bootstrap` job (double-guarded `BOOTSTRAP_CONFIRM=gifsy_prod`) created the **first GIFSY_ADMIN
  (Nikunj/9830011252)** + **4 OutletTypes** (SSS/WHOLESALER/SUB_STOCKIST/SSS_TOT). The bootstrap chicken-egg gap is CLOSED.
- **PROD PWA LIVE** — 3 prod secrets created (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`PUSH_DRAIN_SECRET`; prod VAPID public
  key `BDa-41v-qzwle4dHG0PEF046WVanmr-Wr5-Ff-ChDBJZLHD2OSipmyGt-1cmhSSA5v3sNNiaWj3TadmIkNuaWzY`); the `deploy.yml` prod-PWA
  wiring landed on `develop` via a **cherry-pick of `762251e` (→`dd04570`)**, NOT a merge (the stale `prep/prod-pwa-activation`
  branch was 213 commits behind → merging would have *appeared to delete* recent work; the branch was then DELETED).
  `MSG91_WHATSAPP_NUMBER=917003202293` baked into prod env. **`push-drain-prod` Cloud Scheduler ENABLED** (every-minute,
  `x-drain-secret`); drain smoke verified (no-secret → 403, with-secret → 201).
- **Pre-cutover backup** id **`1782824807740`** (2026-06-30T13:06:47Z, SUCCESSFUL); PITR ON.
- **Gate at cutover:** api jest 1271 · nest 0 · FE vitest 1692 · tsc 0.
Full as-run record = **`docs/plans/runbooks/PROD-CUTOVER-RECORD.md`** (§ 2026-06-30); runbook (now banner-marked COMPLETE) =
**`docs/plans/runbooks/CUTOVER-RUNBOOK.md`**.

OPEN GO-LIVE THREADS (see GO-LIVE-READINESS §3): **#76** load real Deoleo master data into prod — **UNBLOCKED** (bootstrap DONE
at cutover; prod is bootstrapped + ready; Deoleo tenant context; outlet types `SSS/SSS_TOT/SUB_STOCKIST/WHOLESALER`; XSR-ID
column = real `XSR-*` IDs). **Waits only on the client's files.** **#74 owner ops — monitoring ✅ DONE (2 email channels live, no
click-to-verify needed) + backups/PITR ✅ ON**; only **secret rotation (optional)** + **real prod MSG91** remain. **AF-6** JWT-in-localStorage 🔴 — the
session-expiry redirect landed. **AF-6 FULLY DONE** (`2f8a343`+`abc43f6`+`35ddaf9`, 2026-06-28 — token httpOnly-cookie-only, proxy
injects Bearer from cookie, assume/exit/logout server actions, ~80 dead-localStorage reads swept, **refresh-on-401 silent
single-flight refresh**; runtime-verified local echo + real staging edge; audits SHIP, CSRF-safe). **EVERY `AF-*` security item is
DONE except AF-12** (AF-5/6/7/8/9 + **AF-10 fully done** — CSPRNG+upload `d91ee1b`, windowed per-phone OTP throttle `8301e3f`,
otp_codes cleanup `58f5f55`; access-TTL kept 7d deliberately). **AF-12** RBAC
fail-open — keep OFF (`RBAC-ENABLEMENT.md`). **PWA: FULLY ACTIVATED + DEVICE-VERIFIED ON STAGING** (SW+install+push live; Android push delivered
via scheduler — see the 2026-06-29 block; real Deoleo icon shipped; sales notifications + adoption tracking + prompt-snooze/Profile-entry all
live). **PROD PWA activation ✅ DONE at the 2026-06-30 cutover** — 3 prod secrets created + accessor granted, `deploy.yml` prod-PWA
wiring on `main` (via the cherry-pick), `pwa_install`/other migrations applied, and **`push-drain-prod` Cloud Scheduler ENABLED**
(every-minute → prod `/v1/push/drain`; drain 403/201 verified). The admin sub-dashboard "fake data" pre-UAT blocker is CLOSED.

SESSION/AUTH MODEL (post-AF-6, the owner asked — answer precisely if asked again): access token = httpOnly `token` cookie,
**7-day** JWT (configurable `JWT_EXPIRES_IN`; operator assume-tenant = **8h**); refresh token = httpOnly `refresh_token` cookie,
**30-day** single-use rotating; the edge proxy reads the cookie + injects the backend Bearer; SessionExpiryGuard does single-flight
**refresh-on-401** + retry. PRACTICAL re-login rule: a user stays logged in as long as they open the app **at least once every ~7
days** (the access token silently refreshes mid-session); a **cold return after >7 days** lands on the login screen (a page
navigation is redirected at the edge BEFORE the client-side refresh can run — the 30d refresh only saves an actively-open session,
not a cold return). Optional enhancement if "30-day inactivity" is wanted: have the proxy refresh on page-nav too. **Phone-change →
logout:** sessions are tied to the USER account (revocable row), not the phone string. SALES/admin users — admin user-edit revokes
all sessions on login-phone change (existing). PARTNERS — **now** (`a5de6f0`): at **Gifsy approval**, if a re-KYC changed the
contact phone, the LOGIN `User.phone` is synced + the owner's sessions revoked (clash-guarded; first-approval/unchanged = no-op;
revokes the OWNER not the rep). All KYC mobiles are validated `^[6-9]\d{9}$` (exactly 10 digits) so the exact-compare is reliable —
the `endsWith` in `assertPhoneAvailable` is only belt-and-suspenders for legacy/non-KYC rows.

CONSTRAINTS: work on `develop`; **NEVER `prisma migrate dev`**; any prod/staging DB op = double-guard
`current_database()` + backup + show SQL + WAIT (staging+prod share the private-IP `gifsy-db`); never expose secrets;
commit footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. gcloud/wrangler are authed.

STAGING (FIXED_OTP=`123456`): GIFSY admin `9830011252`/clientId `gifsy`; deoleo admin `6289864191`; partner
`7795096288`/deoleo; sales `9900000041`(ISR) · `9900000002`(SO) · `9900000011`(XSR). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (login: POST `/v1/auth/send-otp` {phone,channel:'SMS'} then
`/v1/auth/verify-otp` {phone,otp:'123456',clientId}; operator cross-tenant = POST `/v1/auth/assume-tenant` {clientId}).

READ FIRST: **`GO-LIVE-ISSUE-LIST.md` (⭐ master tracker)** · `GO-LIVE-READINESS.md` · `PWA-PLAN.md` (PWA status +
cutover-coupled remainder) · memories [[deoleo-go-live-bundle]] (read FIRST for any launch/UAT/staging work)
[[admin-dashboard-consolidation]] [[default-to-orchestration]] [[global-settings-wiring]] [[sales-hierarchy-scoping]]
[[migration-model]] [[staging-deploy-gate]] [[audit-every-build-item]].

▶ **THINGS TO BE DONE — START HERE (present this list first; ask the owner which to pick up).** All of develop (`a4c6def`,
code) is on staging and rides the NEXT owner-triggered cutover; **prod is unchanged at `a2f5929`.** Gate: api jest 1369 · nest 0 ·
FE vitest 1763 · tsc 0. **NO new migrations across this whole develop batch → the next cutover is CODE-ONLY.**
**A. Owner-gated Deoleo go-live (owner or client-files):**
  1. **Owner UAT-tests the accumulated staging batch** (`staging-a4c6def`) — the big new area is the **sales-KYC/UX** work (see
     the closing summary): assignment-driven KYC list, branch member-filter (emp-code·name labels + "All XSR/SO" placeholder),
     KYC-list order Re-KYC→Rejected→Pending→Approved→Not-Interested, Outlets targets-for-all + Approved badge, XSR-no-Approval-Pending,
     profile Visibility-tile removed, Program-Category-optional upload; plus the PWA status-bar/favicon and the C-batch.
  2. **#76 — load real Deoleo master data** (outlets/hierarchy/catalog/schemes via the app UIs) — **THE LAST HARD BLOCKER**, waits on the client's files.
  3. **#143 — WhatsApp `deoleo_kyc_approval` runtime-verify** (template APPROVED; needs a real approval to a real phone).
  4. **Trigger the develop→main CUTOVER when owner is ready** — CODE-ONLY (backup → merge → in-VPC `migrate deploy` no-op → verify serving SHA).
**B. Blocked on an owner DECISION:** 5. **Notifications Core** go/no-go (drainer is push-only; in-app inbox needs a migration; 2/3
  events blocked upstream). 6. **Email provider** — ZeptoMail (~$0.25/1k) vs SES (~$0.10/1k).
**C. Buildable now — C-batch SHIPPED** (`873a2ec`): ✅ C7 `/admin/outlets/ids` lite endpoint · ✅ C9 GIFSY read-only "Security &
  Platform Config" (#101, `auth.constants.ts` single-source-of-truth) · ✅ C10 force-logout (self `/v1/auth/logout-all` + admin
  per-user `/admin/users/:id/revoke-sessions`). **8. §A-DOMAIN still PULLED** — needs a `Client.domains` Prisma migration +
  tenant-resolver rewrite (pure-map→cached DB lookup; 4–7 days/Medium) → does NOT fit a code-only cutover; owner to schedule as its
  own migration-bearing build **before client #2**.
**D. LATER (POST-GO-LIVE-BACKLOG):** multi-tenant SSR branding, configurable RBAC (AF-12 OFF), WhatsApp per-tenant generalization,
  OTel O3, DB-RLS, invoice-PDF/email, TDS filing, DPDP, analytics/trends, D1 tech-debt residuals.
**RESOLVED OWNER DECISIONS (2026-07-03 — do NOT re-raise):** (a) the Sales KYC list showing ALL states incl. approved is CORRECT —
  keep as-is, do NOT hide approved. (b) "Vacant" hierarchy seats SHOULD be SHOWN in the member filter (with emp-code) — keep them.
  (c) the earlier "member-filter edge" is CLOSED — an upline-submitted approved outlet DOES match its member, via the assigned-rep
  (the assignment-driven synth carries `assignedUserId` on every subtree outlet); that caveat was stale (pre-`e9b3a21`) and is dropped.
**KNOWN OPEN POINTS / GAPS:**
  - **§A-DOMAIN** (tenant domain hard-coded from slug) — needs a `Client.domains` migration before client #2 (see C-8). This is the
    only real open item; the rest of the sales-KYC/UX batch is owner-approved as shipped.
**HOUSEKEEPING:** #90–95 already pruned; #74 (owner ops) mostly done (monitoring + backups/PITR ON; only optional cred-rotation left).

Now: greet the owner. **🚀 CUTOVER #2 IS DONE (2026-07-01) — prod is live on `a2f5929`, and the DEOLEO TENANT is CREATED + ACTIVE.**
Cutover #2 shipped the onboard-slug fix + per-tenant points-expiry + admin-users pagination/self-deactivate; applied migration
`20260630130000_point_expiry_default_unique`; pre-cutover backup **`1782886598428`**; `expire-sweep-prod` scheduler ENABLED. Deoleo
was onboarded via the fixed wizard (slug=`deoleo`) then flipped `ONBOARDING→ACTIVE` via the one-off job `gifsy-activate-deoleo`;
its config = platform defaults (conversion `1`, expiry null, visibility OFF). **Owner-gated Deoleo go-live: ✅ conversion rate=1
(verified backend) · ✅ first CLIENT_ADMIN created (Khushi Agarwal, prod-verified CLIENT_ADMIN/deoleo) · ⏳ load real master data
(#76 — the LAST hard blocker, waits on the client's files) · ⏳ #143 WhatsApp `deoleo_kyc_approval` runtime-verify (code-ready,
template APPROVED — needs a real approval+phone).** **develop is AHEAD at `a4c6def` (code, ALL on staging now — both
`gifsy-api-staging` + `gifsy-frontend-staging` serve `staging-a4c6def`), riding the NEXT owner-triggered cutover; prod unchanged at
`a2f5929`.** Scale/ops COMPLETE on develop (pagination, observability O1+O2, log-leak fix, KYC-submit-500, ASM enrollment,
conversion-rate editor, Rejected/Re-upload, download-helper sweep, WhatsApp-post-OTP, OTP-gates-routing, KYC-PDF render,
not-interested-404). **This session (NEWEST-36→40, see DONE-THIS-SESSION):** Outlet-Types+deep-link, targets-all-outlets+KPI-gate,
targets-500 chunk fix, §A-ONBOARDING client activate/edit+footgun, re-KYC visibility (derivation+list+dashboard+tasks for the whole
re-entry family), 4 money-path scale-bug fixes, onboarding-save-revert fix — all gate-green + adversarially verified. **The
re-KYC/rejected-family + onboarding-save fixes are FE — a frontend staging redeploy already landed (that batch = `97c5089`).**
**PLUS the LATER 2026-07-03 batch (`873a2ec`→`a4c6def`, on `staging-a4c6def`, gate 1369/1763 + independently audited):** the
buildable-now **C-batch** (C7 `/admin/outlets/ids` · C9 GIFSY security-config #101 via `auth.constants.ts` · C10 force-logout) +
the **sales-KYC/UX batch** — the KYC list is now **ASSIGNMENT-DRIVEN** (an outlet shows to its assignee XSR + SO + ASM regardless
of who filed it; supersedes the "submitter-scoped list" model, RESUME trap #7 UPDATE); branch member-filter (getTeam
`submitterUserIds` + buildOutlets `assignedUserId`) with emp-code·name labels + role-contextual "All XSR/SO" placeholder
(`childRole`); KYC-list order Re-KYC→Rejected→Pending→Approved→Not-Interested (`kycSubmissionOrderRank`, ≠ Outlets `kycOrderRank`);
Outlets targets-for-ALL + Approved badge; XSR-no-Approval-Pending; profile Visibility-tile removed; Program-Category-OPTIONAL on
outlet upload — **plus** iOS PWA status-bar safe-area (sales navy-immersive / partner brand-tinted strip = Option C; Android needs
none) + per-tenant browser favicon. **Learning baked in: META-LESSON 2 ([[clarify-before-imperfect-build]]) — ask before shipping
a knowingly-imperfect fix.**
**NEXT = owner UAT-tests this batch on staging, then triggers the cutover; + master data #76 when files arrive** (nothing else queued);
notifications/P7 still PAUSED (events flag-OFF; email provider TBD, ZeptoMail vs SES). Required onboarding-flow builds logged in
POST-GO-LIVE-BACKLOG §A-DOMAIN + §A-ONBOARDING (incl. the GIFSY_ADMIN-in-tenant-context
fix). Keep the fix-as-found loop available (fixes push to `develop` → reach prod on the next `main` deploy). Full as-run record =
**`runbooks/PROD-CUTOVER-RECORD.md`**; runbook (banner-marked COMPLETE) = **`runbooks/CUTOVER-RUNBOOK.md`**. If a NEW transactional
notification is requested: PUSH → enqueue post-commit via
`SalesNotificationsService`; WhatsApp/SMS → `whatsapp-kyc.config.ts` + `Msg91Service.sendWhatsappTemplate` fire-and-forget post-commit.

**START THE SESSION by presenting the ▶ THINGS TO BE DONE list above** (A owner-gated go-live · B owner-decision · C
buildable-now · D later) and **ask the owner which to pick up** — do NOT silently begin work. Default recommendation if the
owner is open-ended: since the batch is on staging, offer to (i) help verify this session's fixes on staging, or (ii) pick a
buildable-now item (C) while master data (#76) and the cutover remain owner-gated.
```
