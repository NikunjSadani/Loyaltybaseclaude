# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-06-28.

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
npx tsc --noEmit`. **Latest green: api jest 1193 · nest 0 · FE vitest 1637 · tsc 0.** **Last pushed HEAD: run
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
- **PWA WAVE 1 + F4 + LOCAL PUSH DRY-RUN ✅** (`185c548`→`40d0934`) — installable per-tenant shell (manifest Route
  Handlers + iOS meta), sharp icon pipeline, Serwist SW (flag-OFF, with `push`+`notificationclick` handlers), install
  prompt, full Web Push backend; ships DISABLED behind 3 flags (all default OFF). Per-tenant manifests runtime-verified
  on the live Deoleo edge; push SEND path dry-run-proven (real web-push lib). **Remaining = CUTOVER-COUPLED, NOT during
  UAT.** Canonical = **`PWA-PLAN.md`** (read its Status + dry-run blocks; cutover SW-emit is **esbuild**, not webpack).
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

🚀 CUTOVER STATE (develop→main = prod, verified 2026-06-28): `main` is **168 commits behind** `develop` (main last
`2026-06-21` `b3ab2e0`), incl. **5 Prisma migrations** prod lacks (the PWA `push_subscription` migration will be a 6th,
still UNAPPLIED anywhere); no `gifsy-*-prod` Cloud Run services in asia-south1 → first `main` merge ≈ first prod app
deploy. Promoting to `main` is a DELIBERATE cutover: freeze develop → **backup prod DB** → apply migrations via the
in-VPC Cloud Run Job ([[migration-model]]) → merge=deploy → load #76 data → #74 ops → smoke test. **DO NOT merge to
main during UAT.**

OPEN GO-LIVE THREADS (see GO-LIVE-READINESS §3): **#76** load real Deoleo master data into empty prod (Deoleo tenant
context; outlet types `SSS/SSS_TOT/SUB_STOCKIST/WHOLESALER`; XSR-ID column = real `XSR-*` IDs). **#74** owner ops
(monitoring alert · backups/PITR · secret rotation · real prod MSG91). **AF-6** JWT-in-localStorage 🔴 — the
session-expiry redirect landed; the proper fix (httpOnly-cookie refresh token + refresh-on-401, single-flight) is still
open — this is now the **lone open AF item** (AF-7 GSTIN, **AF-8 invoice-number retry**, **AF-9 brand-CSS sink** all DONE;
AF-8/AF-9 = `8a96808`, 2026-06-28, both independently audited SHIP). **AF-12** RBAC fail-open — keep OFF (`RBAC-ENABLEMENT.md`). **PWA push activation** (FE subscribe + migration +
VAPID + flag flips) is cutover-coupled. The admin sub-dashboard "fake data" pre-UAT blocker is CLOSED.

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

Now: greet the owner and wait for the next UAT finding (or instruction). When one arrives, diagnose →
fix/delegate → audit → gate → runtime-verify → push. Do NOT auto-start tangential work; PWA is built (cutover-coupled
remainder only) and no build is mid-flight.
```
