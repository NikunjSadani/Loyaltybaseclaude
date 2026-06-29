# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-06-29.

🟢 CURRENT MODE — **OWNER-DRIVEN UAT on staging: fix-as-the-owner-finds.** The owner reports a bug (often a screenshot);
you diagnose → fix (delegate substantial builds to sub-agents) → INDEPENDENT adversarial audit → FULL gate →
runtime-verify (prefer live Deoleo staging) → push to `develop` (auto-deploys staging). Each push deploys; advise the
owner to re-test with their real UAT data. **DO NOT merge to main during UAT** (cutover is deliberate — see below).

🔶 STANDING MODE — **YOU ARE THE ORCHESTRATOR (the owner should never have to remind you).** Default to orchestrating
substantial work, not hand-coding everything: decompose; **run independent workstreams as PARALLEL sub-agents** (give
each a precise spec; background sub-agents are DENIED shell → they WRITE code, YOU run the gates); fix the shared
contracts so parallel streams don't conflict; integrate the shared files yourself; and ALWAYS personally do the
security-critical review — an **INDEPENDENT adversarial audit** of every build item (it has caught a real defect on
money/auth paths every time), the **FULL gate**, and **runtime-verify** before claiming done. When the owner challenges
a recommendation ("are you sure?"), genuinely reconsider — don't defend (it flipped the redemption-gate + auth-refresh
calls this session). Also OWN doc/memory CONSISTENCY: when a fact changes, sweep EVERY doc + memory in the same pass.
[[default-to-orchestration]] [[own-consistency-no-micromanage]] [[audit-every-build-item]] [[verify-flows-at-runtime]]

GATES (run the FULL suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`):
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` · `cd platform &&
npx tsc --noEmit`. **Latest green: api jest 1220 · nest 0 · FE vitest 1664 · tsc 0.** **Last pushed HEAD: run
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
stale localStorage token fails even if a valid cookie exists (assume-tenant 8h vs login 7d desync).

DONE THIS SESSION (all gate-green + independently audited + pushed to `develop`; runtime-verified where an API/edge check was possible):
- **🆕 2026-06-29 — GO-LIVE PREP + PWA ACTIVATION (this session):**
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
    **🔶 MID-FLIGHT:** owner is device-testing — push dispatched server-side; AWAITING owner confirm it arrived on their phone + **which OS**
    (Android in-browser sub works; **iOS needs the installed-to-home-screen app** which the now-fixed 404 was blocking). Owner also asked to
    **change the PWA icon** → AWAITING their source logo (≥512² PNG) to regenerate `/icons/deoleo/icon-{192,512,maskable-512}.png`. To fire a
    fresh test push: credit O001 (WHOLESALER→POINTS) → confirm (enqueues PUSH) → reverse. Confirm POST needs `-H 'Content-Length: 0'` (edge 411).
    The earlier 500-pt test credit was already reversed (wallet clean).
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

🚀 CUTOVER STATE (develop→main = prod; **CORRECTED 2026-06-29 by live gcloud recon — prior "no prod services / first deploy"
framing was STALE/WRONG**): `main` is **185 commits behind** `develop` (main last `2026-06-21` `b3ab2e0`), incl. **6 Prisma
migrations** prod's DB lacks (5 + `add_push_subscription`). **PROD IS ALREADY LIVE** — Cloud Run services `gifsy-api` +
`gifsy-frontend` (NOT `-prod`-suffixed; that's why the old check missed them) serve image `b3ab2e0`, `NODE_ENV=production`,
prod DB/JWT/MSG91 from Secret Manager. So the cutover is an **UPDATE of running prod, not a first deploy**. **`deploy.yml`
(main→prod) AUTO-RUNS the 6 migrations** via the in-VPC `gifsy-migrate` Cloud Run Job (`migrate deploy --execute-now --wait`;
`--wait` fails the deploy on migration error) AFTER a **`production` manual-approval gate**; `deploy-staging.yml` = develop→staging.
**Backups + PITR are ALREADY ON** for `gifsy-db` (enabled, 14 retained, PITR + 7-day txn-log). So promoting = freeze develop →
(optional pre-backup; PITR already covers it) → **merge develop→main → approve the prod gate → pipeline migrates+deploys** →
smoke. Full step-by-step = **`docs/plans/runbooks/CUTOVER-RUNBOOK.md`**. **DO NOT merge to main during UAT.**
🔴 **NEW BLOCKER (Phase-0 recon, 2026-06-29) — PROD BOOTSTRAP GAP:** prod has **zero users + zero OutletType master rows**, and
there is **NO app/API path** to create the first GIFSY_ADMIN (`assertRoleAssignable` needs an existing GIFSY_ADMIN → chicken-egg)
OR the 4 OutletType rows (`createClient` only upserts per-type *config* for already-existing types; the seed is prod-firewalled).
→ **#76 cannot start until a one-time in-VPC bootstrap script (first GIFSY_ADMIN + 4 OutletType rows) runs — ✅ NOW BUILT +
staging-dry-run-verified** (`api/prisma/bootstrap.ts`, `262027a`; run it post-cutover via a Cloud Run Job using the new prod `api` image —
exact command in `runbooks/PROD-DATA-LOAD.md`). Everything else (client, CLIENT_ADMIN, hierarchy, outlets) then flows via the app.

OPEN GO-LIVE THREADS (see GO-LIVE-READINESS §3): **#76** load real Deoleo master data into empty prod (after bootstrap; Deoleo tenant
context; outlet types `SSS/SSS_TOT/SUB_STOCKIST/WHOLESALER`; XSR-ID column = real `XSR-*` IDs). **#74 owner ops — monitoring ✅ DONE +
backups/PITR ✅ already ON**; only **secret rotation (optional)** + **real prod MSG91** remain. **AF-6** JWT-in-localStorage 🔴 — the
session-expiry redirect landed. **AF-6 FULLY DONE** (`2f8a343`+`abc43f6`+`35ddaf9`, 2026-06-28 — token httpOnly-cookie-only, proxy
injects Bearer from cookie, assume/exit/logout server actions, ~80 dead-localStorage reads swept, **refresh-on-401 silent
single-flight refresh**; runtime-verified local echo + real staging edge; audits SHIP, CSRF-safe). **EVERY `AF-*` security item is
DONE except AF-12** (AF-5/6/7/8/9 + **AF-10 fully done** — CSPRNG+upload `d91ee1b`, windowed per-phone OTP throttle `8301e3f`,
otp_codes cleanup `58f5f55`; access-TTL kept 7d deliberately). **AF-12** RBAC
fail-open — keep OFF (`RBAC-ENABLEMENT.md`). **PWA: FE-subscribe (E) BUILT + FULLY ACTIVATED ON STAGING** (SW+install+push live, device-test
mid-flight — see the 2026-06-29 block); **PROD PWA activation is cutover-coupled** — replicate the staging wiring on `deploy.yml` (the 3
`NEXT_PUBLIC_PWA_*` build-args + the VAPID/`PUSH_WORKER_ENABLED` env/secrets) so prod lights up at/after cutover. The admin sub-dashboard
"fake data" pre-UAT blocker is CLOSED.

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

Now: greet the owner and pick up the **PWA staging device-test (mid-flight)**: ask whether the test push arrived on their phone + **which OS**
(Android should work from the in-browser sub; iOS needs the installed app, which the just-fixed `start_url` 404 was blocking → owner should
delete the old home-screen icon, re-open `uat.deoleoloyalty.gifsy.in`, re-install, re-allow notifications, then say "subscribed" → fire a fresh
test push). Also pending from the owner: the **PWA icon source image** (to regenerate `/icons/deoleo/*`). Standing context: UAT ~90% done (minor
changes likely); **cutover held until UAT signs off** (then: merge→approve `production` gate→pipeline migrates+deploys→run bootstrap job→load #76
data→set Deoleo config→smoke; prod PWA activation rides this). Otherwise resume OWNER-DRIVEN UAT fix-as-found: diagnose → fix/delegate → audit →
gate → runtime-verify → push.
```
