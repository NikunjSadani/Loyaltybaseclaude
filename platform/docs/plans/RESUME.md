# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-07-06.

🟢 CURRENT MODE — **GO-LIVE: ✅ CUTOVER #9 IS LIVE (prod `ebd474b`, 2026-07-08) — the PAYOUT UTR "APPLY" FIX is IN PROD** (verified live:
`deoleoloyalty.gifsy.in` login 200, /api/health 401=edge gate; both prod services on `ebd474b`). `main` fast-forwarded `4b33e4c` → `ebd474b`
(2 commits = 1 code fix + 1 doc, CODE-ONLY 0 migrations; pre-cutover backup **`1783479870311`** `pre-cutover9-develop-ebd474b`; rollback =
redeploy `4b33e4c`). **prod == main == `ebd474b`** — verify the live HEAD via `git log`, do NOT pin HEAD to a single SHA. **⚠️ FLAKY-CI TRAP (hit at
cutover #9): the CI + the prod-deploy test job can FLAKE (a 25s fast-fail; the exact `NODE_ENV=test npm test -- --forceExit --no-coverage` command
passes clean locally + in the staging deploy on the same code — likely a runner hiccup / dangling fire-and-forget async cut by `--forceExit`). The prod
deploy (`deploy.yml`) gates the approval on `needs: test == success`, so a flaked test job means NO "Review deployments" gate appears (looks like
"there's no approve option"). FIX: on the "Deploy — Production (main)" run for the SHA, click "Re-run failed jobs" → tests pass → gate appears → approve.
`deploy.yml` also has an emergency `skip_tests` workflow_dispatch input as a last resort.** **The fix (`ebd474b`):** the admin credit-payout
**UTR "Apply" never committed** — the FE sent `apply=true` in the multipart BODY but the endpoint reads it via `@Query` (`credits.controller`
`uploadUtr`), so EVERY Apply silently ran as a PREVIEW: nothing persisted, entries stayed `PROCESSING`, the `CreditPayoutDownload` stayed `OPEN`,
and the FE printed "Applied: **undefined** paid/failed/skipped" (the preview response has no counts). Diagnosed from the owner's screenshot + a guarded
prod read (both recent Deoleo downloads OPEN, entries PROCESSING, no utr/paidAt, 0 PayoutTransactions). Fix: FE sends `?apply=true` in the QUERY string
+ backend `uploadUtr` now reads `apply` from EITHER `@Query` OR `@Body` (so a FormData field can't be silently ignored again). No money-logic change —
the apply tx was already correct, it just never ran. Gate `ebd474b`: api jest 1484 · nest 0 · FE vitest 1796 · tsc 0. **REUSABLE TRAP: a `fetch` with
a `FormData` body puts fields in the BODY, not the query string — an endpoint reading a flag via `@Query` will silently ignore it. Match the send
mechanism to how the controller reads it (or read both).**

▶ **NEXT = THE NEXT (owner-gated) CUTOVER (`ebd474b` → `186c92e`).** ✅ **The WALLET-SURFACING FIX is BUILT + on `develop` `186c92e`** (2026-07-18,
gate api jest 1485 · nest 0 · FE vitest 1798 · tsc 0; owner-approved, staging-verify then cutover). `partner.service.getPayouts` now UNIONS
`CreditPayoutEntry` (PENDING/PROCESSING/PAID; FAILED/REVERSED excluded) into the wallet payout history alongside the redemption `PayoutTransaction`
rail — one row per entry, merged + sorted by effective date (`paidAt ?? createdAt`) newest-first, cap 100; `period` = the credit month `'YYYY-MM'` used
verbatim. `resolvePartnerActivity` (the `hasPayoutActivity` card flag) aligned to the SAME status set so the card & the statement can't disagree (that
was the "card shows, empty list" bug). FE: pending payout rows now show with a "Payout pending" amber badge + muted amount + added-date; the
lifetime-received CARD still counts PAID only; Excel export marks pending rows. **Independent adversarial audit (money path) caught + fixed 2 HIGH + 1
MED before ship:** (HIGH-1) `CreditPayoutEntry.outletId` stores the outlet **CODE**, not the Outlet PK — the first cut keyed the query on the PK cuid and
matched NOTHING (feature dead; the pre-existing presence probe was dead the same way since cutover #8); now keyed on `outletCode`, consistent with
`invoices.service`/`tds.service` (both join via `outletCode`). (HIGH-2) `mapPayoutStatus` never handled `'SUCCESS'` — the REAL completed value in the
`PayoutStatus` enum (no `PAID`/`COMPLETED`; `payouts.service:723` writes `SUCCESS`) → every completed redemption mapped to PENDING; now `SUCCESS`→PAID.
(MED-1) presence probe counted FAILED/REVERSED redemptions the list hides → card-vs-list mismatch; both rails now exclude FAILED/REVERSED at the query.
**REUSABLE TRAPS: (a) `CreditPayoutEntry.outletId` == the outlet CODE everywhere (no FK — join via `Outlet.outletCode`); keying it by the Outlet PK
matches nothing. (b) a "completed" `PayoutTransaction` is `status='SUCCESS'` (the enum has no PAID/COMPLETED) — any status mapper MUST handle SUCCESS.**
Owner's residual = staging runtime-verify (a real credit-payout PAID + a real redemption on ONE partner both appearing in the wallet), then it rolls
into the next cutover.

**PRIOR — CUTOVER #8 (prod `4b33e4c`, 2026-07-07) — a 4-fix UX/parity batch. The 4 cutover-#8 code fixes:** **(A)** `4be63f3` — **PRESENCE-BASED partner-wallet reward-track**
(the partner app's points-vs-payout wallet/rewards was DEMO-driven via `partner-session.ts` `REWARD_TRACK`; NOT a money bug — the credit award is
config-driven/correct — but a display gap; presence-based: points card if points activity, payout card if payout activity, both if both, full
combined history always; backend `/partner/me` returns real `outletType`+`hasPointsActivity`+`hasPayoutActivity`+a `loading` flag; demo
`REWARD_TRACK`/`usePartnerSession` retired). **(B)** `f1907dc` — **sales outlet ledger: credit rows lead with the FIELD NAME** (resolved read-time
from the CreditBatch `rows` JSON) + narration sub-line + raw batch CUID dropped + KPI filter wired. **(C)** `33ca0f8` — **pre-OTP submit copy**:
the sales KYC "Submit KYC" button (which only saves a DRAFT + sends the consent OTP) relabelled **"Send OTP to Outlet Owner"** + a helper line — it
was confusing users into thinking the KYC was enrolled before OTP (investigated `OUT-2026-001` via a guarded prod read: NOT a bug, routing is
OTP-gated in `consent()`; it was pure copy perception). **(D)** `4b33e4c` — **partner-wallet field-name parity** via a NEW shared resolver
`api/src/common/credit-field-name.helper.ts` (EXTRACTED from the sales ledger; kyc.service + wallet.service both call it now — no drift); partner
wallet credit rows now show field-name header + narration + a working KPI filter (was a generic "Points earned" + dead filter); pagination-robust
(resolves over the full credit-txn set). Money path untouched in all 4. Gate at `4b33e4c`: **api jest 1484 · nest 0 · FE vitest 1796 · tsc 0.**
**NEW REUSABLE: the credit FIELD NAME is resolved READ-TIME from `CreditBatch.rows` JSON (WalletTransaction stores only the batch id + narration) via
`resolveCreditFieldNames` — POINTS-only pool, tenant-scoped, 1:1 consumption match; shared by the sales ledger + partner wallet.** **The 7 cutover-#7 fixes (oldest→newest, now historical):**
**(1)** `36a4325` — targets push 404: "New targets uploaded" deep-linked `/sales/targets` (no such route) → tap 404; now `/sales/dashboard`.
**(2)** `ea227c0` — approval-WhatsApp blank program name: read `programName` from the `isPrimary` outlet, but every real outlet is
`isPrimary=false` (all 2,907) → blank. **(3)** `2d5b715` — 4 pushes had no click URL → the SW opens `data.url || '/'` and root `/` redirects
to `/auth/login`, so a signed-in user tapping the push bounced to login; added deep-links (points→/partner/wallet, redemption ×2→/partner/rewards,
KYC-approved→/sales/kyc). **(4)** `a685e2d` — swept the whole `isPrimary` blank-outlet class: `Outlet.isPrimary` is never set true on real
outlets, so every `where:{isPrimary:true}` load returns empty; fixed 9 loads (bulk approval blank program [the single-record `ea227c0` MISSED
the bulk path], re-KYC field-flag 409, blank outlet code on KYC detail + wallet ledger, blank outlet columns in both KYC Excel exports) to
`where:{deletedAt:null}, orderBy:[{isPrimary:'desc'},{createdAt:'asc'}], take:1` — CODE fix, NO data backfill. **(5)** `08734ce` — the KYC-SLA
setting was dead (FE keyed `kycSlaHours`, backend stored `slaTargetHours`, the metric read env) so the owner's change to 96 reverted to 48;
now wired end-to-end (persists + drives the metric). **(6)** `58a302c` — feat(whatsapp) `deoleo_points_credit` + `deoleo_payout_credit`: two
per-tenant money WhatsApps, direct MSG91 fire-and-forget post-commit — points_credit fires at credit-batch confirm to POINTS outlets
`[owner,points,redeemable balance,credit month,date]`; payout_credit fires on Flow A (credit-based payout UTR upload — REPLACES the
previously-dead queued WhatsApp) AND Flow B (redemption cash-out UTR) `[owner,points,UTR,payment date,month]`; both templates must be APPROVED
in MSG91 to deliver — **✅ BOTH templates APPROVED (owner-confirmed 2026-07-06).** **(7)** `6d25c10` — **money-path WhatsApp AUDIT FIXES**
(2 independent adversarial auditors + own trace found 4 real defects, all fixed): **A (HIGH)** payouts Flow B gathered the WhatsApp payload with
reads INSIDE the money `$transaction` (a notification read failure could roll back a committed bulk payout) → now pushes only ids in-tx,
batch-reads partner/order POST-COMMIT, whole block try/catch-wrapped; **B (HIGH)** all dates/months used `new Date().getDate()/.getMonth()` =
server-LOCAL but prod runs UTC → wrong day (00:00–05:30 IST window) + wrong MONTH at boundaries on a money notice → new shared
`api/src/common/ist-date.ts` (`monthYearIST`/`formatDateIST`, shift by IST offset + read `getUTC*`); **C (MED)** credits Flow A used the nullable
master-file `outlet.phone` → now the KYC-verified `partner.phone`; **D (LOW)** Flow B could send "{{2}}=0" → now only sends when `points>0`. The
high-risk class (variable order/count, idempotency, double-send, cross-tenant) audited CLEAN. Plus 2 doc commits (`2d0d983` cutover-#6 record +
`fb41be8` OTP-template login runtime-verified). Gate at `6d25c10`:
**api jest 1471 · nest 0 · FE vitest 1790 · tsc 0**. **NOT-bugs / decisions this sweep:** the "submitted WhatsApp before OTP" report was
verified NOT-a-bug (prod OTP-timeline read: the consent OTP was verified BEFORE the submission routed; the WhatsApp fires post-OTP) · owner
decided a KYC rejected/re-upload OWNER notification is NOT needed · the `isPrimary` fixes used a CODE sweep — the alternative (setting
`isPrimary=true` per partner + backfilling all 2,907 rows) was deliberately NOT taken. **Notification-delivery audit finding (OPEN GAP):** the
queue drainer is PUSH-only, so `enqueue({channel:'SMS'|'EMAIL'|'WHATSAPP'})` never delivers — genuinely-dead-with-no-fallback are the
credit-batch EMAIL, the KYC owner SMS for UNDER_REVIEW (+ the now-dropped REJECTED/RE_UPLOAD/RE_KYC), and the redemption-fulfilment SMS
(DISPATCHED/DELIVERED/CANCELLED); these need Notifications-Core (SMS/email worker) or channel conversion — owner decision pending.

**OPEN POINTS (start here next session):**
- **(a)** ✅ DONE — the **INDEPENDENT adversarial audit** of the money-path WhatsApp build ran (2 auditors + own trace); found 4 real defects, all FIXED + gate-green + pushed (`6d25c10`): Flow B gather moved out of the money tx, IST-aware date util (prod is UTC), Flow A recipient → KYC `partner.phone`, Flow B `points>0` guard. Gate api jest 1471 · nest 0 · FE vitest 1790 · tsc 0.
- **(b)** the **NEXT cutover** of the now-7-fix batch (`c36f6c8` → `6d25c10`) — owner-gated. **← the immediate next step.**
- **(c)** ✅ DONE — **BOTH `deoleo_points_credit` + `deoleo_payout_credit` APPROVED in MSG91** (owner-confirmed 2026-07-06) → they deliver once the sweep ships.
- **(d)** **#74 owner ops** — credential rotation + click the 2 GCP alert-email verification links (monitoring + backups/PITR already done).
- **(e)** the **Notifications-Core decision** for the still-dead SMS/email notifications (credit-batch email, KYC owner SMS, redemption-fulfilment SMS).
- **(f)** the **live end-to-end prod smoke** (a real KYC→wallet, a credit upload moving a wallet, a redemption per channel, prod OTP).
- **(g)** OPTIONAL: the `isPrimary` **data-backfill** (not taken — the code sweep covers it; backfill would set `isPrimary=true` per partner across 2,907 rows).

**PRIOR — CUTOVER #6 EXECUTED 2026-07-06 — prod moved to `c36f6c8`; DEOLEO TENANT CREATED + ACTIVE + LIVE on the
real domain.** Cutover #6 moved prod `main` **5c2bb65 → c36f6c8** (7 commits, **CODE-ONLY — 0 migrations**, so the in-VPC migrate step was a
no-op). Owner approved the `production` gate; both prod Cloud Run services (`gifsy-api-00019-ms7` + `gifsy-frontend-00015-sr8`) are Ready=True
@ 100% traffic on `c36f6c8`; pre-cutover backup **`pre-cutover6-develop-c36f6c8`** (ON_DEMAND, gifsy-db; rollback = redeploy `5c2bb65`).
Live-verified on `deoleoloyalty.gifsy.in` (`/auth/login` 200; `/brand/deoleo-wordmark-white.png` 200 image/png; `/api/health` 401 = the edge
proxy auth gate, not a fault). **Cutover #6 payload (7 commits):** **(1)** the headline — **per-tenant, per-purpose OTP template selection**
(`TenantSettingsService.otpTemplates` `{login / redemptionSelf / kycConsent / redemptionSales}` + a `getOtpTemplateId` resolver, threaded to
`Msg91Service.sendOtp(…, templateId?)` at all 4 send sites; **unset → the global env template, byte-identical to before**; independent adversarial
audit CLEAN; no migration); **(2)** sales re-KYC wizard **auto-skips Step 1 (Select Outlet) on a deep-link** for `RE_KYC_REQUIRED` outlets
(`fa8e534`); **(3)** the **assumed-tenant session TTL raised 8h → 24h** (`66ac21e` — `ASSUMED_SESSION_TTL_HOURS=24`, single source now drives
access + refresh TTL + the admin Security-config display; normal 7d/30d sessions unchanged); **(4)** doc reframes (credit-batch email folded into
Notifications-Core; WhatsApp KYC templates verified-working-on-staging). Gate at cutover #6: **api jest 1446 · nest 0 · FE vitest 1786 · tsc 0**.
**At cutover, prod == main == `c36f6c8`** (develop has since advanced 6 code fixes + docs ahead — the post-cutover-#6 sweep above, whose last CODE commit is `6d25c10`; verify the live HEAD via `git log`, PENDING the next cutover).
**Post-cutover config-write applied:** the Deoleo `program_settings.otpTemplates` row was written via
the guarded `gifsy-oneoff-prodcheck` Cloud Run Job (`current_database()='gifsy_prod'` guard; no row → the 4-template map, exactly 1 row, job reset
to no-op after; `login`+`redemptionSelf`=`6a391d466b4d90893904e1d2`, `kycConsent`+`redemptionSales`=`6a391cf2d011d41f630a1364`; effective ≤5 min
via the 5-min cache TTL). Owner's residual = a **real-phone prod login-OTP arrives on the new template**. *(Prior: cutover #5 at `5c2bb65` —
sales-KYC UAT fixes: per-document "Pending" tag removal, re-KYC amber badges, approval-stepper current-submission + reviewer-level label.)*

**PRIOR — CUTOVER #4 (2026-07-04→05) — prod was serving `824eac0`.** Cutover #4 moved prod `main` **eb841e9 → 824eac0** (3 commits,
**CODE-ONLY — 0 migrations**, so the in-VPC migrate step was a no-op). Owner approved the `production` gate; both prod Cloud Run services were
**Ready=True @ 100% traffic** on `824eac0` (`gifsy-api` rev `gifsy-api-00017-sd5`, `gifsy-frontend` rev `gifsy-frontend-00013-kr2`);
pre-cutover backup **`pre-cutover4-develop-824eac0`** (ON_DEMAND, gifsy-db). **VERIFIED LIVE on `deoleoloyalty.gifsy.in`:** `/auth/login` = 200;
`/brand/deoleo-wordmark-white.png` = 200 image/png (no regression). **Cutover #4 payload (2 items):** **(1)** rewards **FREE_AMOUNT blank-Max
fix** (`5dbf641`) — a free-amount voucher (`pointsCost 0`) saved with the "Max points" field blank persisted `maxRedemptionPoints=null` →
treated as a FIXED cost-0 reward → every redeem threw "must cost a positive number of points" (un-redeemable); backend
`assertFreeAmountComplete` guard on create+update + DTO `@Min(1)` on `minRedemptionPoints` + FREE→FIXED clears the stale bounds; the FE makes
"Max points" required; independently audited (no live money defect). **(2)** **Credits & Payouts Config settings card** (`824eac0`) — a
GIFSY_ADMIN-only card on `/admin/settings` (month cutoff / per-row safety caps / notify emails); seeds from `GET /api/admin/settings` (the
`/me` endpoint strips `creditsPayouts`); whole-object save; backend floors the caps at ≥1 so a stored `0` can't freeze credit uploads;
independently audited. Gate at cutover #4: **api jest 1427 · nest 0 · FE vitest 1776 · tsc 0**.

**PRIOR — CUTOVER #3 (2026-07-04) + LOGIN-LOGO/BRAND-FIX — prod was serving `eb841e9`; DEOLEO TENANT CREATED + ACTIVE + LIVE on the real
domain.** Cutover #3 moved prod `main` **a2f5929 → 9d366f9** (60-commit jump, **CODE-ONLY — 0 migrations**,
so the in-VPC migrate step was a no-op). **Then (later 2026-07-04) the owner approved the `production` gate for the login-logo + `/brand/*`
middleware fix run → prod moved `9d366f9` → `eb841e9` (= 9d366f9 + the Deoleo login logo `0780d1f` + the `/brand/*` matcher fix `eb841e9`).**
Both prod Cloud Run services (`gifsy-api` + `gifsy-frontend`) now serve `eb841e9`; pre-cutover backup **`1783158625082`** (ON_DEMAND,
SUCCESSFUL, "pre-cutover3-develop-9d366f9"). **VERIFIED LIVE on the real domain `deoleoloyalty.gifsy.in`:** `/brand/deoleo-wordmark-white.png`
= 200 image/png (the Deoleo wordmark renders on the login page, placeholder gone), `/auth/login` = 200, tenant branding resolving, API
`/health` = 200, both services on the `eb841e9` image. (The raw `*.run.app` frontend URL 404s on routes — that's host-based tenant routing
via Cloudflare, NOT a fault; the real domain is authoritative.) **develop HEAD = `eb841e9` == main HEAD = `eb841e9`** — the Deoleo login logo
(`0780d1f`) is now **LIVE** (was ARMED), and the follow-up **`/brand/*` middleware fix (`eb841e9`)** shipped in the SAME prod deploy: the
login wordmark first rendered as a BROKEN IMAGE because `/brand/*.png` was 307-redirected to `/auth/login` (the `platform/src/proxy.ts`
auth-middleware `config.matcher` excluded `logos/`/`favicons/`/`icons/`/`images/`/`sw.js`/`offline.html` but **not `brand/`**); the fix added
`brand/` to the matcher exclusion. Cutover #3 shipped the **field-level re-KYC + re-KYC in-flight display fix + program-name/category
case-insensitive upload + hierarchy phone-correction orphan fix + redeem-button KYC gate** (details in DONE-THIS-SESSION).
Keep the fix-as-found loop available (owner reports a bug → diagnose → fix/delegate → INDEPENDENT audit → FULL gate → runtime-verify →
push to `develop`; prod follows on the next `main` deploy). **Remaining is owner-gated (Deoleo go-live):** ✅ conversion rate=1 (verified
backend) · ✅ first Deoleo CLIENT_ADMIN created (2026-07-02) · ✅ login logo + `/brand/*` fix LIVE (prod `eb841e9`) → **load real master data**
via the app UIs when the client sends files (**#76 — DONE: outlets + hierarchy loaded, no rewards data pending**). **#143 — WhatsApp
`deoleo_kyc_approval` — DONE: BOTH KYC WhatsApp templates (submit + approval) verified WORKING ON STAGING (owner-confirmed 2026-07-06).** The recon'd
**scale/ops plan** is COMPLETE on develop (now all in prod via `9d366f9`): pagination stream (W1+W2), observability O1+O2, security
log-leak fixed, KYC-submit-500 RESOLVED, ASM enrollment, KYC "Rejected/Re-upload" consolidation; notifications/P7 still PAUSED (build all
events flag-OFF; **email provider still open** — ZeptoMail vs SES). **Required onboarding-flow builds** are logged in POST-GO-LIVE-BACKLOG
§A: **§A-DOMAIN** (decouple domain from slug — needs a `Client.domains` migration; schedule before client #2) and **§A-ONBOARDING** (client
activate/edit endpoint — SHIPPED — **plus the GIFSY_ADMIN-in-tenant-context fix**: FE offers GIFSY_ADMIN only in platform context, backend
`assertRoleAssignable` rejects GIFSY_ADMIN when `caller.clientId !== 'gifsy'`).

🔶 STANDING MODE — **YOU ARE THE ORCHESTRATOR (the owner should never have to remind you).** Default to orchestrating
substantial work, not hand-coding everything: decompose; **run independent workstreams as PARALLEL sub-agents** (give
each a precise spec; background sub-agents are DENIED shell → they WRITE code, YOU run the gates); fix the shared
contracts so parallel streams don't conflict; integrate the shared files yourself; and ALWAYS personally do the
security-critical review — an **INDEPENDENT adversarial audit** of every build item (it has caught a real defect on
money/auth paths every time), the **FULL gate**, and **runtime-verify** before claiming done. When the owner challenges
a recommendation ("are you sure?"), genuinely reconsider — don't defend (it flipped the redemption-gate + auth-refresh
calls this session). Also OWN doc/memory CONSISTENCY: when a fact changes, sweep EVERY doc + memory in the same pass.
[[default-to-orchestration]] [[own-consistency-no-micromanage]] [[audit-every-build-item]] [[verify-flows-at-runtime]]

🟡 SCALE/OPS + UAT-FIX BUILD (post-Deoleo, owner-driven, orchestrated — **✅ ALL now in prod via cutover #3 `9d366f9`.** develop == main
== `eb841e9`.) SHIPPED to `develop` + gate-green + each independently audited: **(1)** security
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
npx tsc --noEmit`. **Latest green: api jest 1471 · nest 0 · FE vitest 1790 · tsc 0 (the post-cutover-#6 sweep — gate ran at develop's last CODE commit `6d25c10`; prod serves `c36f6c8` [cutover-#6 gate api jest 1446 · nest 0 · FE vitest 1786 · tsc 0] and develop is 7 code fixes + docs AHEAD of prod pending the next cutover — verify the live HEAD via `git log`).** **Last pushed HEAD: run
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
`kyc.service.list`), or a bulk-re-KYC'd outlet reads as Approved. **UPDATE (trap #15 below): once a re-KYC is RESUBMITTED,
gate DISPLAY/actionability on `isReKycActionable` (flags AND not-in-flight), NOT bare `isReKycPending` — flags persist until
approval clears them.** **(10)** `isActive:true` is the platform's denormalised
**"approved + active" predicate** (no `kycStatus` column on Outlet; created `isActive:false`, only KYC approval sets it
true) — the targets/KPI change keys the primary-performance KPI on it (upload accepts ALL outlets; KPI counts only
`isActive`). **(11)** a FE **response-merge must match the service's ACTUAL projection shape** — the Gifsy client editor read
`updated.branding.x` (nested) while the service returns it FLAT, so branding edits silently REVERTED after "Saved" (DB was
correct). **(12)** a spec's `$transaction` mock typed `(cb) => cb(tx)` (1 param) makes `.mock.calls[0][1]` (the options arg)
a TS compile error — widen to `(cb, _opts?) => cb(tx)` when asserting the timeout option.
**(13)** the **Employee Hierarchy upload keys User by `(clientId, phone)` but SalesUser by `(clientId, employeeCode)`** — so
correcting an employee's phone on a re-upload CREATED a new User and ORPHANED the old one (old phone stayed reserved in the
`users` `@@unique([clientId, phone])` index, invisible in the sales UI). **FIXED `e83e63d`:** resolve the existing User via
`SalesUser(clientId, employeeCode).userId` and UPDATE that row's phone in place. **(14)** the `users` table
`@@unique([clientId, phone])` is the **phone-uniqueness blocker across ALL roles AND soft-deleted rows** — a "number already in
use" that isn't in the sales-team or outlet lists is an orphaned/other-role `users` row → debug by querying the `users` table
(NOT sales/outlets). **(15)** **reKycFlags PERSIST until approval clears them** (the approver highlight needs them), so
DISPLAY/actionability must gate on **`isReKycActionable(flags, latestStatus)`** (flags set AND latest submission NOT in-flight —
`KYC_IN_FLIGHT_STATUSES` in `api/src/common/kyc-rekyc.helper.ts` + mirror in `platform/src/lib/rekyc-fields.ts`), NOT bare
`isReKycPending` — else a RESUBMITTED re-KYC still reads "Re-KYC Required" instead of "Under Review". The approver highlight keeps
using the RAW flags so it still shows during review. A re-KYC of an already-approved outlet legitimately KEEPS the access it earned
(login only blocks `PENDING_VERIFICATION`). **(16)** guarded staging/prod one-off DB reads/writes run via the
**`gifsy-oneoff-staging` Cloud Run Job** — override its `--args` with a base64'd node script
(`node -e eval(Buffer.from('<b64>','base64').toString())`) that guards `current_database()==='gifsy_staging'` FIRST; reset the
args to a no-op afterward (used to find + free the orphaned phone numbers). **(17)** a **static asset under a NEW `public/`
subdir needs the `platform/src/proxy.ts` auth-middleware `config.matcher` exclusion** — else on a no-token page (e.g. `/auth/login`)
the asset request gets the auth **307 → `/auth/login`** and renders as a BROKEN IMAGE. The login-wordmark `/brand/*.png` first broke this
way (`brand/` wasn't in the matcher exclusion alongside `logos/`/`favicons/`/`icons/`/`images/`/`sw.js`/`offline.html`); fix = add the new
subdir to the exclusion (`eb841e9`). **Local `npm run dev` does NOT reproduce the edge 307 — curl the asset on the REAL staging edge**
(same class as the earlier `sw.js` 307).

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
- **🆕 2026-07-06 — POST-CUTOVER-#6 BUG-FIX SWEEP (develop `c36f6c8` → `6d25c10`; 7 code fixes + 2 docs; PENDING NEXT CUTOVER, prod still `c36f6c8`):**
  · **TARGETS-PUSH 404** (`36a4325`) — the "New targets uploaded" push deep-linked `/sales/targets` (no such route) → tap 404; now `/sales/dashboard`.
  · **APPROVAL-WHATSAPP BLANK PROGRAM NAME** (`ea227c0`) — read `programName` from the `isPrimary` outlet, but every real outlet is `isPrimary=false`
    (all 2,907) → the name came through blank.
  · **4 PUSHES HAD NO CLICK URL** (`2d5b715`) — the SW opens `data.url || '/'` and root `/` unconditionally redirects to `/auth/login`, so a signed-in
    user tapping the push bounced to login; added deep-links (points→/partner/wallet, redemption ×2→/partner/rewards, KYC-approved→/sales/kyc).
  · **`isPrimary` BLANK-OUTLET CLASS SWEPT** (`a685e2d`) — root cause: `Outlet.isPrimary` is never set true on real outlets, so every
    `where:{isPrimary:true}` outlet load returns empty; fixed 9 loads (bulk approval blank program [the single-record `ea227c0` MISSED the bulk path],
    re-KYC field-flag 409, blank outlet code on KYC detail + wallet ledger, blank outlet columns in both KYC Excel exports) to
    `where:{deletedAt:null}, orderBy:[{isPrimary:'desc'},{createdAt:'asc'}], take:1`. **CODE fix, NO data backfill** (setting `isPrimary=true` +
    backfilling all 2,907 rows was deliberately NOT taken).
  · **KYC-SLA SETTING NOW PERSISTS + DRIVES THE METRIC** (`08734ce`) — it was a dead setting (FE keyed `kycSlaHours`, backend stored `slaTargetHours`,
    the metric read env) so the owner's change to 96 reverted to 48; now wired end-to-end.
  · **`deoleo_points_credit` + `deoleo_payout_credit` MONEY WHATSAPPS** (`58a302c`) — two per-tenant money WhatsApps, direct MSG91 fire-and-forget
    post-commit. points_credit fires at credit-batch confirm to POINTS outlets `[owner,points,redeemable balance,credit month,date]`; payout_credit
    fires on Flow A (credit-based payout UTR upload — REPLACES the previously-dead queued WhatsApp) AND Flow B (redemption cash-out UTR)
    `[owner,points,UTR,payment date,month]`. Both templates **✅ APPROVED in MSG91 (owner-confirmed 2026-07-06)**.
  · **MONEY-PATH WHATSAPP AUDIT FIXES** (`6d25c10`, fix #7) — 2 independent adversarial auditors + own trace found 4 real defects, all fixed:
    **A (HIGH)** payouts Flow B gathered the WhatsApp payload with reads INSIDE the money `$transaction` (a notification read failure could roll back
    a committed bulk payout) → now pushes only ids in-tx, batch-reads partner/order POST-COMMIT, whole block try/catch-wrapped; **B (HIGH)** all
    dates/months used `new Date().getDate()/.getMonth()` = server-LOCAL but prod runs UTC (no TZ) → wrong day (00:00–05:30 IST window) + wrong MONTH
    at boundaries → new shared `api/src/common/ist-date.ts` (`monthYearIST`/`formatDateIST`, shift by IST offset + read `getUTC*`, mirrors
    `ActivityTrackingService.istDateKey`); both services' duplicated private helpers deleted; **C (MED)** credits Flow A used the nullable master-file
    `outlet.phone` → now the KYC-verified `partner.phone` (matches the other 2 sends); **D (LOW)** Flow B could send "{{2}}=0" → now only when
    `points>0`. The high-risk class (variable order/count, idempotency, double-send, cross-tenant) audited CLEAN. **NEW TRAP: server-local `Date`
    getters read UTC in prod — user-facing IST dates MUST go through `ist-date.ts` (or shift by `IST_OFFSET_MIN` then read `getUTC*`).**
  · **Docs** (`2d0d983` cutover-#6 record + `fb41be8` OTP-template login runtime-verified). Gate at `6d25c10`: **api jest 1471 · nest 0 · FE vitest 1790 · tsc 0**.
  · **NOT-bugs / decisions:** "submitted WhatsApp before OTP" verified NOT-a-bug (prod OTP-timeline: consent OTP verified BEFORE the submission routed;
    fires post-OTP) · owner decided a KYC rejected/re-upload OWNER notification is NOT needed.
  · **OPEN GAP (notification-delivery audit):** the queue drainer is PUSH-only, so `enqueue({channel:'SMS'|'EMAIL'|'WHATSAPP'})` never delivers —
    genuinely-dead-with-no-fallback = credit-batch EMAIL, KYC owner SMS for UNDER_REVIEW (+ the now-dropped REJECTED/RE_UPLOAD/RE_KYC), redemption-fulfilment
    SMS (DISPATCHED/DELIVERED/CANCELLED). Needs Notifications-Core (SMS/email worker) or channel conversion — owner decision pending.
- **🆕 2026-07-05 — CUTOVER #5 EXECUTED (prod moved `824eac0` → `5c2bb65`; CODE-ONLY, 0 migrations — sales-KYC UAT fixes):**
  · **CUTOVER #5 EXECUTED** — prod `main` **824eac0 → 5c2bb65** (5 commits, **CODE-ONLY — 0 migrations**, in-VPC migrate = no-op);
    owner approved the `production` gate; both prod services serve `5c2bb65`; pre-cutover backup **`pre-cutover5-develop-5c2bb65`**
    (ON_DEMAND, gifsy-db; rollback = redeploy `824eac0`). Gate: api jest 1427 · nest 0 · FE vitest 1784 · tsc 0. **prod == develop == main == 5c2bb65.**
  · **PER-DOC "PENDING" STATUS TAG REMOVED** (`6ad4d62`) — the misleading per-document "Pending" status tag was removed from the sales
    KYC store-info view; `KycDocument.status` is never advanced off PENDING, so it read as a false hold on already-approved outlets.
  · **RE-KYC AMBER DOC/PHOTO BADGES** (`6e96d5b`) — re-KYC flagged documents + photos now show an amber badge ("Needs re-capture") on the
    sales-senior KYC detail, parity with the Gifsy reviewer (driven by `flaggedDocTypes`).
  · **APPROVAL-STATUS STEPPER — CURRENT SUBMISSION** (`12d781f`) — a re-KYC rejected by the ASM now shows first-approver = Rejected +
    Gifsy = pending (was a stale "Approved" + "Queued for Gifsy"); uses latest-event-per-stage + keys the Gifsy step off `kyc.status`.
  · **FIRST-APPROVER STEP LABEL — REAL REVIEWER LEVEL** (`5c2bb65`) — the label was hardcoded from a bad `submittedByRole==='XSR'` cast →
    always "ASM Review"; now derived from the PENDING_*_APPROVAL status (awaiting) or the approver's role (acted), correct under vacant-level skipping.
  · **(`0028a07`)** cutover #4 doc updates (already recorded; part of this 5-commit batch reaching prod).
- **🆕 2026-07-04→05 — CUTOVER #4 EXECUTED (prod moved `eb841e9` → `824eac0`; CODE-ONLY, 0 migrations):**
  · **CUTOVER #4 EXECUTED** — prod `main` **eb841e9 → 824eac0** (3 commits, **CODE-ONLY — 0 migrations**, in-VPC migrate = no-op);
    owner approved the `production` gate; both prod services **Ready=True @ 100% traffic** on `824eac0` (`gifsy-api` rev `gifsy-api-00017-sd5`,
    `gifsy-frontend` rev `gifsy-frontend-00013-kr2`); pre-cutover backup **`pre-cutover4-develop-824eac0`** (ON_DEMAND, gifsy-db; rollback =
    redeploy `eb841e9`). **Verified LIVE on `deoleoloyalty.gifsy.in`** (`/auth/login` 200; `/brand/deoleo-wordmark-white.png` 200 image/png,
    no regression). Gate: api jest 1427 · nest 0 · FE vitest 1776 · tsc 0. At cutover `prod == develop == main == 824eac0` (develop may now be
    ahead by post-cutover follow-ups — e.g. the per-doc "Pending" tag removed from the sales KYC store-information view, NOT yet in prod).
  · **REWARDS FREE_AMOUNT BLANK-MAX FIX** (`5dbf641`) — a free-amount voucher (`pointsCost 0`) saved with the "Max points" field BLANK
    persisted `maxRedemptionPoints=null` → treated as a **FIXED cost-0** reward → every redeem threw "must cost a positive number of points"
    (the voucher was un-redeemable). Fix: backend `assertFreeAmountComplete` guard on create + update + a DTO `@Min(1)` on `minRedemptionPoints`
    + a FREE→FIXED switch clears the stale bounds; the FE makes "Max points" required. Independently audited (no live money defect — the guard
    fails closed).
  · **CREDITS & PAYOUTS CONFIG SETTINGS CARD** (`824eac0`) — a **GIFSY_ADMIN-only** card on `/admin/settings` (month cutoff / per-row safety
    caps / notify emails). Seeds from `GET /api/admin/settings` (the `/me` endpoint STRIPS `creditsPayouts`); whole-object save; the backend
    FLOORS the caps at ≥1 so a stored `0` can't freeze credit uploads. Independently audited (ship it).
- **🆕 2026-07-04 — CUTOVER #3 + re-KYC UAT batch + LOGIN-LOGO/BRAND-FIX DEPLOY (all now in prod; prod moved `9d366f9` → `eb841e9`):**
  · **CUTOVER #3 EXECUTED** — prod `main` **a2f5929 → 9d366f9** (60-commit, **CODE-ONLY — 0 migrations**, in-VPC migrate = no-op);
    owner approved the `production` gate; both prod services serve `9d366f9`; pre-cutover backup **`1783158625082`** (rollback =
    redeploy a2f5929). **Verified LIVE on `deoleoloyalty.gifsy.in`** (login 200, branding resolving, API /health 200).
  · **LOGIN-LOGO + `/brand/*` FIX DEPLOYED (later 2026-07-04)** — the owner approved the `production` gate for the login-logo run →
    prod moved **`9d366f9` → `eb841e9`** (= 9d366f9 + login logo `0780d1f` + the `/brand/*` matcher fix `eb841e9`); both prod services
    now serve `eb841e9`. The login wordmark first rendered as a BROKEN IMAGE because `/brand/*.png` was **307-redirected to
    `/auth/login`** — the `platform/src/proxy.ts` auth-middleware `config.matcher` excluded `logos/`/`favicons/`/`icons/`/`images/`/
    `sw.js`/`offline.html` but **not `brand/`** (the login page has no token → the asset request got the auth redirect). Fix: added
    `brand/` to the matcher exclusion; bundled into the SAME prod deploy as the logo (`eb841e9`). **VERIFIED LIVE:**
    `/brand/deoleo-wordmark-white.png` → 200 image/png, the Deoleo wordmark renders on the login page (placeholder gone), `/auth/login`
    200, API `/health` 200. Gate FE vitest 1769 · tsc 0. (Trap #17 — a new `public/` subdir needs the matcher exclusion; local
    `npm run dev` does NOT reproduce the edge 307 → curl the real staging edge.)
  · **FIELD-LEVEL RE-KYC** (`267da65`, `e1e4ba5`) — the re-KYC resubmit reuses the 4-step wizard with NON-flagged fields **LOCKED**
    (flagged fields pre-filled + editable); **BACKEND-ENFORCED lock** (non-flagged text pinned to stored values; non-flagged documents
    carried forward from the PRIOR submission — server-authoritative); approver **HIGHLIGHT** of the flagged fields + admin remark on
    the sales-senior detail AND the Gifsy reviewer. Shared canonical field map `platform/src/lib/rekyc-fields.ts` + `api/src/common/rekyc-fields.ts`.
    Bug fix: `isReEntry`/wizard also fire on non-empty `reKycFlags` even when the submission is APPROVED (the bulk-flag case).
    Adversarial-audit fixes: **F1** approval clears `reKycFlags` (else locked forever), **F2** non-flagged docs carried forward (else
    the new submission had zero docs), **F3** `getOne` prefers the flagged outlet over the primary, **F4** upiId UI lock.
  · **RE-KYC IN-FLIGHT DISPLAY FIX** (`2b7f44b`) — a RESUBMITTED re-KYC now shows "Under Review", not "Re-KYC Required".
    `reKycFlags` persist until approval (needed for the approver highlight), so a new shared helper **`isReKycActionable(flags, latestStatus)`**
    = flags set AND latest submission NOT in-flight (`KYC_IN_FLIGHT_STATUSES` in `api/src/common/kyc-rekyc.helper.ts` + mirror in
    `platform/src/lib/rekyc-fields.ts`) now gates every DISPLAY/actionability site: sales `buildOutlets`, `kyc.service.list` override,
    admin `deriveKycStatus` + the filter's `reKycOutletIds`, FE detail `isReEntry`, wizard `isReKYC`/`isStartable`. The approver
    highlight keeps using the raw flags so it still shows during review. (Trap #15.)
  · **PROGRAM NAME/CATEGORY UPLOAD case-insensitive + canonicalised** (`1be7119`) — `outlet-upload.ts` matches these two fields
    case-insensitively and rewrites the cell to the configured spelling (Outlet Type was already case-insensitive). FE-only (the upsert
    route carries the parsed rows straight through).
  · **HIERARCHY PHONE-CORRECTION ORPHAN FIX** (`e83e63d`) — the Employee Hierarchy upload keyed User by `(clientId, phone)` but SalesUser
    by `(clientId, employeeCode)` → correcting an employee's phone on a re-upload CREATED a new User + orphaned the old one (old phone
    stayed reserved in the `users` `@@unique([clientId, phone])` index, invisible in the sales UI). Fix: resolve the existing User via
    `SalesUser(clientId, employeeCode).userId` and UPDATE that row's phone in place. Also cleaned 8 leftover orphan users on staging
    (freed numbers incl. 9113145451) via the `gifsy-oneoff-staging` job. (Traps #13/#14/#16.)
  · **REDEEM-BUTTON GATE** (in `9d366f9`) — the sales "Redeem for Outlet" button now shows only when the outlet's KYC `isApproved`
    (was showing for submitted-but-unapproved outlets; the backend already blocked the actual redeem).
  · **DEOLEO LOGIN LOGO** (`0780d1f`, **✅ LIVE — deployed to prod in `eb841e9` after the owner approved the `production` gate**) — the
    real Deoleo white wordmark on the login brand panel + mobile strip (replaced the generic placeholder); rendering fixed by the
    `/brand/*` matcher fix bundled into the same `eb841e9` deploy (see the LOGIN-LOGO + `/brand/*` FIX entry above).
  · **INVESTIGATION RESOLVED (NOT a bug):** "outlet logged in before KYC approval" — traced live: the reported outlet (Charan Trading /
    prakhar / 8977097868) was genuinely APPROVED 2026-07-02 (full `kyc_status_history` chain), logged in 07-03 (AFTER approval), and is
    now mid-re-KYC (a 2nd submission), which by design KEEPS the access it already earned. Login correctly blocks `PENDING_VERIFICATION`
    (`auth.service.ts`) — every never-approved outlet has a `PENDING_VERIFICATION` owner. Optional future design choice (NOT scheduled):
    whether a re-KYC should SUSPEND access until re-approval.
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
    (only `deoleo`). **BOTH KYC WhatsApp templates RUNTIME-VERIFIED WORKING ON STAGING (owner-confirmed 2026-07-06):** SUBMIT (`deoleo_kyc_submission`)
    AND APPROVAL (`deoleo_kyc_approval`) — real WhatsApp delivered. #143 CLOSED; residual is only to eyeball the first real PROD approval (not a blocker). `MSG91_WHATSAPP_NUMBER` defaults to the
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

🚀 CUTOVER STATE — **✅ CUTOVER #6 IS LIVE (2026-07-06). Prod serving `c36f6c8` (unchanged until the next cutover); develop is 7 code fixes + docs AHEAD (post-cutover-#6
sweep whose last CODE commit is `6d25c10`; verify the live HEAD via `git log`), PENDING the next cutover; prod == main == `c36f6c8`.** *(Latest gate ran at develop's last CODE commit `6d25c10`: api jest 1471 · nest 0 · FE vitest 1790 · tsc 0.)*
**PRIOR — CUTOVER #5 (2026-07-05) — prod was serving `5c2bb65`.**
Cutover #5 moved prod `main` **`824eac0` → `5c2bb65`** (5 commits, **CODE-ONLY — 0 migrations**, so the in-VPC `migrate deploy` was a no-op).
Owner approved the `production` gate; both prod Cloud Run services serve `5c2bb65`; pre-cutover backup **`pre-cutover5-develop-5c2bb65`**
(ON_DEMAND, gifsy-db; rollback = redeploy `824eac0`). **Payload (5 items — the sales-KYC UAT fixes + follow-ups):** per-doc **"Pending" status
tag removed** from the sales KYC store-info (`6ad4d62` — `KycDocument.status` never advances off PENDING, false hold on approved outlets) ·
`0028a07` cutover #4 doc updates · re-KYC flagged docs + photos **amber-badged ("Needs re-capture")** on the sales-senior KYC detail (`6e96d5b`,
parity with the Gifsy reviewer, driven by `flaggedDocTypes`) · **Approval-Status stepper reflects the CURRENT submission** (`12d781f` — a re-KYC
rejected by the ASM shows first-approver = Rejected + Gifsy = pending; latest-event-per-stage + keys the Gifsy step off `kyc.status`) ·
**first-approver step LABEL reflects the real reviewer level** (`5c2bb65` — was hardcoded "ASM Review" from a bad `submittedByRole==='XSR'`
cast; now derived from PENDING_*_APPROVAL / the approver's role, correct under vacant-level skipping). Gate at cutover #5:
api jest 1427 · nest 0 · FE vitest 1784 · tsc 0.

**PRIOR — CUTOVER #4 (2026-07-04→05) — prod was serving `824eac0`.**
Cutover #4 moved prod `main` **`eb841e9` → `824eac0`** (3 commits, **CODE-ONLY — 0 migrations**, so the in-VPC `migrate deploy` was a no-op).
Owner approved the `production` gate; both prod Cloud Run services were **Ready=True @ 100% traffic** on `824eac0` (`gifsy-api` rev
`gifsy-api-00017-sd5`, `gifsy-frontend` rev `gifsy-frontend-00013-kr2`); pre-cutover backup **`pre-cutover4-develop-824eac0`** (ON_DEMAND,
gifsy-db; rollback = redeploy `eb841e9`). **VERIFIED LIVE on `deoleoloyalty.gifsy.in`** (`/auth/login` 200; `/brand/deoleo-wordmark-white.png`
200 image/png — no regression). **Payload (2 items):** rewards **FREE_AMOUNT blank-Max fix** (`5dbf641` — a free-amount voucher saved with Max
blank persisted `maxRedemptionPoints=null` → treated as FIXED cost-0 → every redeem threw "must cost a positive number of points"; backend
`assertFreeAmountComplete` guard on create+update + DTO `@Min(1)` on `minRedemptionPoints` + FREE→FIXED clears stale bounds; FE makes Max
required; independently audited) · **Credits & Payouts Config settings card** (`824eac0` — GIFSY_ADMIN-only card on `/admin/settings`: month
cutoff / per-row safety caps / notify emails; seeds from `GET /api/admin/settings` since the `/me` endpoint strips `creditsPayouts`;
whole-object save; backend floors the caps at ≥1 so a stored `0` can't freeze credit uploads; independently audited). Gate at cutover #4:
api jest 1427 · nest 0 · FE vitest 1776 · tsc 0.

**CUTOVER #3 (2026-07-04) + LOGIN-LOGO/BRAND-FIX — historical:** prod served `eb841e9`; main HEAD `eb841e9` == develop HEAD `eb841e9`.
Cutover #3 moved prod `main` **`a2f5929` → `9d366f9`** (60-commit jump, **CODE-ONLY — 0 migrations**, so the in-VPC `migrate deploy`
was a no-op). Owner approved the `production` gate; both prod Cloud Run services (`gifsy-api` + `gifsy-frontend`) served `9d366f9`;
pre-cutover backup **`1783158625082`** (ON_DEMAND, SUCCESSFUL, "pre-cutover3-develop-9d366f9"; rollback = redeploy `a2f5929`).
**Then (later 2026-07-04) the owner approved the `production` gate for the login-logo + `/brand/*` middleware fix run → prod moved
`9d366f9` → `eb841e9`** (= 9d366f9 + the Deoleo login logo `0780d1f` + the `/brand/*` matcher fix `eb841e9`); both prod services now
serve `eb841e9`. **VERIFIED LIVE on the real domain `deoleoloyalty.gifsy.in`** (`/brand/deoleo-wordmark-white.png` 200 image/png +
the wordmark renders on the login page, `/auth/login` 200, tenant branding resolving, API `/health` 200, both services on `eb841e9`).
The login logo (`0780d1f`) is now **LIVE**; the `/brand/*` fix (`eb841e9`) resolved a 307-redirect that first broke the wordmark image
(the auth-middleware `config.matcher` in `platform/src/proxy.ts` didn't exclude `brand/` → the no-token login page 307'd the asset to
`/auth/login`). Cutover #3 shipped field-level re-KYC + re-KYC in-flight display fix + program-name/category case-insensitive upload +
hierarchy phone-orphan fix + redeem-button KYC gate. Gate at cutover #3: api jest 1419 · nest 0 · FE vitest 1769 · tsc 0; `/brand/*` fix gate FE vitest 1769 · tsc 0.

**CUTOVER #2 (2026-07-01) — historical:** prod `main` HEAD moved to `a2f5929`. Cutover #2 shipped
the **onboard-slug fix + per-tenant points-expiry + admin-users pagination/self-deactivate**; applied migration
`20260630130000_point_expiry_default_unique` (via `--wait`); pre-cutover backup **`1782886598428`**; created + ENABLED the
**`expire-sweep-prod`** Cloud Scheduler (daily 00:30 IST; sweep smoke 403/201). Both prod services healthy `/health` 200.
**Deoleo tenant CREATED + ACTIVE in prod** (onboarded via the fixed wizard slug=`deoleo`; flipped `ONBOARDING→ACTIVE`
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

▶ **THINGS TO BE DONE — START HERE (present this list first; ask the owner which to pick up).** ✅ Cutover #5 is DONE — prod serves
`5c2bb65` (sales-KYC UAT fixes — status-tag removal, re-KYC amber badges, approval-stepper current-submission + reviewer-level label);
**prod == develop == main == `5c2bb65`**. Gate: api jest 1427 · nest 0 · FE vitest 1784 · tsc 0. *(Prior: cutover #4 at `824eac0` — rewards FREE_AMOUNT fix + Credits/Payouts Config card.)*
**A. Owner-gated Deoleo go-live — ✅ ALL CLEARED (2026-07-05/06):**
  1. ✅ **#76 — master data** — outlets + sales hierarchy loaded in prod; owner confirmed no rewards data pending.
  2. ✅ **#143 — WhatsApp `deoleo_kyc_approval`** — owner confirms it worked on staging → code path + approved template proven (residual: eyeball the first real prod approval).
  3. ✅ **Two reward catalog items** — owner set min/max in prod; both free-amount **min 250 · max 50,000**, ACTIVE, prod-verified → redeemable.
  4. ~~Set `creditsPayouts.notifyEmails`~~ — **NOT a config toggle → FOLDED into B5 (Notifications Core).** Enqueued EMAIL rows never deliver (the queue drainer is PUSH-only — `notifications.enqueue` writes a QUEUED row, only `push-delivery.worker` drains). Recipients recorded (nikunj.sadani@ / payel.ghosh@ / nikita@gifsy.in) for when the email worker ships. **Only remaining owner step = the live end-to-end smoke** (a real KYC→wallet, a credit upload moving a wallet, a redemption per channel, prod OTP).
**B. Blocked on an owner DECISION:** 5. **Notifications Core** go/no-go (drainer is push-only; in-app inbox needs a migration; 2/3
  events blocked upstream). **Scope now explicitly INCLUDES the credit-batch confirmation email** (folded from A4 — enqueued today but never sent until the email worker exists; recipients above). 6. **Email provider** — ZeptoMail (~$0.25/1k) vs SES (~$0.10/1k).
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

Now: greet the owner. **🚀 CUTOVER #6 IS LIVE (2026-07-06) — prod serves `c36f6c8`; the DEOLEO TENANT is CREATED + ACTIVE + LIVE on
`deoleoloyalty.gifsy.in`. develop has since advanced 7 code fixes + docs AHEAD of prod `c36f6c8` (a post-cutover-#6 bug-fix sweep whose last CODE commit is `6d25c10`; verify the live HEAD via `git log`), PENDING
the NEXT (owner-gated) cutover** — targets-push 404 (`36a4325`) · approval-WhatsApp blank program name (`ea227c0`) · 4 pushes with no click
URL bounced to login (`2d5b715`) · the whole `isPrimary` blank-outlet class swept, 9 loads (`a685e2d`, CODE-only, no backfill) · KYC-SLA
setting now persists + drives the metric (`08734ce`) · the `deoleo_points_credit` + `deoleo_payout_credit` money WhatsApps (`58a302c`) · **the
money-path WhatsApp AUDIT FIXES (`6d25c10`, fix #7 — Flow B gather moved out of the money tx, IST-aware date util, Flow A recipient → KYC
`partner.phone`, Flow B `points>0` guard).** Gate at `6d25c10`: **api jest 1471 · nest 0 · FE vitest 1790 · tsc 0**. **✅ The money-path audit
is DONE and ✅ both MSG91 templates are APPROVED — the immediate next step is the NEXT (owner-gated) cutover** (`c36f6c8` → `6d25c10`). See the
**OPEN POINTS** list near the top of this prompt.
**PRIOR — CUTOVER #5 (2026-07-05) — prod was serving `5c2bb65`.** Cutover #5 moved prod `main` **`824eac0` → `5c2bb65`** (5 commits, CODE-ONLY — 0 migrations,
in-VPC migrate = no-op); owner approved the `production` gate; both prod services serve `5c2bb65`; pre-cutover backup
**`pre-cutover5-develop-5c2bb65`** (rollback = redeploy `824eac0`). Cutover #5 payload (5 items — the sales-KYC UAT fixes + follow-ups):
per-doc **"Pending" status tag removed** from the sales KYC store-info (`6ad4d62`) + `0028a07` cutover #4 doc updates + re-KYC flagged docs
+ photos **amber-badged ("Needs re-capture")** on the sales-senior KYC detail (`6e96d5b`, parity with the Gifsy reviewer) + the
**Approval-Status stepper reflects the CURRENT submission** (`12d781f` — a re-KYC rejected by the ASM shows first-approver = Rejected + Gifsy
= pending; latest-event-per-stage + keys the Gifsy step off `kyc.status`) + the **first-approver step LABEL reflects the real reviewer level**
(`5c2bb65` — was hardcoded "ASM Review"; now derived from PENDING_*_APPROVAL / the approver's role, correct under vacant-level skipping).
Gate: api jest 1427 · nest 0 · FE vitest 1784 · tsc 0. **prod == develop == main == `5c2bb65`.**
**PRIOR — CUTOVER #4 (2026-07-04→05) — prod was serving `824eac0`.** Cutover #4 moved prod `main` **`eb841e9` → `824eac0`** (3 commits,
CODE-ONLY — 0 migrations, in-VPC migrate = no-op); both prod services were Ready=True @ 100% traffic on `824eac0` (`gifsy-api` rev
`gifsy-api-00017-sd5`, `gifsy-frontend` rev `gifsy-frontend-00013-kr2`); pre-cutover backup **`pre-cutover4-develop-824eac0`** (rollback =
redeploy `eb841e9`). Payload: **rewards FREE_AMOUNT blank-Max fix** (`5dbf641`) + **Credits & Payouts Config settings card** (`824eac0`).
Gate: api jest 1427 · nest 0 · FE vitest 1776 · tsc 0.
**PRIOR — CUTOVER #3 (2026-07-04) + LOGIN LOGO & `/brand/*` FIX — prod was serving `eb841e9`.**
Cutover #3 moved prod `main` **`a2f5929` → `9d366f9`** (60-commit, CODE-ONLY — 0 migrations, in-VPC migrate = no-op); owner approved the
`production` gate; then (later 2026-07-04) the owner approved the login-logo gate → **prod moved `9d366f9` → `eb841e9`** (= 9d366f9 + login
logo `0780d1f` + the `/brand/*` matcher fix `eb841e9`). Both prod services serve `eb841e9`; pre-cutover backup **`1783158625082`** (rollback
= redeploy `a2f5929`). **develop == main == `eb841e9`.** The login logo (`0780d1f`) is now LIVE (was ARMED); the `/brand/*` fix (`eb841e9`)
resolved a 307 that first rendered the wordmark as a broken image (the auth-middleware matcher in `platform/src/proxy.ts` didn't exclude
`brand/`). Cutover #3 shipped the re-KYC batch (see DONE-THIS-SESSION): **field-level re-KYC** (non-flagged fields locked, backend-enforced;
approver highlight), **re-KYC in-flight display fix** (`isReKycActionable`), **program-name/category case-insensitive upload**, **hierarchy
phone-correction orphan fix** (+ 8 staging orphans cleaned), **redeem-button KYC gate**. **Owner-gated Deoleo go-live: ✅ conversion rate=1
(verified backend) · ✅ first CLIENT_ADMIN created (2026-07-02) · ✅ login logo + `/brand/*` fix LIVE (prod `eb841e9`) · ✅ #76 master
data DONE (outlets + hierarchy loaded, no rewards data pending) · ✅ #143 WhatsApp `deoleo_kyc_approval` DONE — BOTH KYC WhatsApp templates
(submit + approval) verified WORKING ON STAGING (owner-confirmed 2026-07-06).** Scale/ops COMPLETE + now in prod (pagination, observability O1+O2, log-leak fix,
KYC-submit-500, ASM enrollment, conversion-rate editor, Rejected/Re-upload, download-helper sweep, WhatsApp-post-OTP, OTP-gates-routing,
KYC-PDF render, not-interested-404), as is the earlier C-batch (C7 `/admin/outlets/ids` · C9 GIFSY security-config #101 via
`auth.constants.ts` · C10 force-logout) and the sales-KYC/UX batch (assignment-driven KYC list, branch member-filter, etc.).
**INVESTIGATION RESOLVED (record, not a bug):** "outlet logged in before KYC approval" — the reported outlet was genuinely APPROVED
2026-07-02, logged in AFTER approval, and is now mid-re-KYC (keeps earned access by design); login correctly blocks
`PENDING_VERIFICATION`. **NEXT = master data #76 when files arrive** (nothing else queued);
notifications/P7 still PAUSED (events flag-OFF; email provider TBD, ZeptoMail vs SES) — **and the credit-batch confirmation email is
now folded INTO this Notifications-Core build** (it's enqueued today but never sent because only PUSH drains; `notifyEmails` is a
no-op until the email worker ships; recipients nikunj.sadani@/payel.ghosh@/nikita@gifsy.in recorded). Required onboarding-flow builds logged in
POST-GO-LIVE-BACKLOG §A-DOMAIN (needs a `Client.domains` migration — schedule before client #2) + §A-ONBOARDING (incl. the
GIFSY_ADMIN-in-tenant-context fix, SHIPPED). **✅ THE PRIOR TWO OWNER-ACTION ITEMS ARE CLEARED (2026-07-05/06):** the two broken
reward catalog items are FIXED in prod (owner set min 250 · max 50,000 on both → ACTIVE + redeemable, prod-verified); and
`creditsPayouts.notifyEmails` is reframed as part of Notifications-Core (above), not a standalone config action. Keep the fix-as-found loop available (fixes push to `develop`
→ reach prod on the next `main` deploy). Full as-run record = **`runbooks/PROD-CUTOVER-RECORD.md`** (§ 2026-07-05 — CUTOVER #5); runbook (banner-marked COMPLETE) =
**`runbooks/CUTOVER-RUNBOOK.md`**. If a NEW transactional notification is requested: PUSH → enqueue post-commit via
`SalesNotificationsService`; WhatsApp/SMS → `whatsapp-kyc.config.ts` + `Msg91Service.sendWhatsappTemplate` fire-and-forget post-commit.

**START THE SESSION by presenting the ▶ THINGS TO BE DONE list above** (A owner-gated go-live · B owner-decision · C
buildable-now · D later) and **ask the owner which to pick up** — do NOT silently begin work. Default recommendation if the
owner is open-ended: since cutover #6 is live (prod `c36f6c8`) and develop carries a 7-fix post-cutover sweep (last CODE commit `6d25c10`; verify the live HEAD via `git log`) pending the next
cutover, and the money-path audit + MSG91 template approvals are BOTH DONE, lead with **the NEXT cutover** (owner-gated, `c36f6c8` → `6d25c10`) —
that is the immediate next step; master data (#76) is done.
```
