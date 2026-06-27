# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-06-27.

🟢 FIRST: **START THE PWA WORK — you are the ORCHESTRATOR, and the execution plan must be followed running MULTIPLE
WORKSTREAMS SIMULTANEOUSLY.** The owner has approved building the **full per-tenant PWA** (installable sales+partner
apps + Web Push) per **`platform/docs/plans/PWA-PLAN.md`** (read it first — it has the phases, security rules, and the
exact orchestration). Kick off **Wave 1 = 4 PARALLEL streams** (one sub-agent each, launched together):
  • **A — FE shell (F1):** per-tenant manifest routes `app/sales/manifest.ts` + `app/partner/manifest.ts` (read
    `x-tenant-slug`) + iOS meta; YOU wire the root `app/layout.tsx` + the `proxy.ts` `x-pathname` injection.
  • **B — icon pipeline (F2):** sharp-based per-tenant icon/splash generator → `public/icons/<slug>/` + onboarding
    hook + **monogram placeholder** (owner will supply real Deoleo+Gifsy logo art later — swap in via same pipeline).
  • **C — service worker (F3):** Serwist, **network-first navigations · NEVER cache `/api/*` or any authed/tenant
    response** · versioned precache · "new version → refresh" prompt; **registered behind a runtime flag, default OFF**
    (flip ON only AFTER the develop→main cutover).
  • **D — push backend (F5):** `PushSubscription` model + migration (**joins the cutover migration batch**), **single
    platform-wide VAPID keypair** (owner-decided; tenant isolation = scoped subscription query, NOT the key), a
    `web-push` sender consuming `NotificationQueue` (channel `PUSH` already in the enum), triggers at wallet-credit /
    redeem-confirm / KYC-approve.
THE 3 SHARED CONTRACTS THE ORCHESTRATOR FIXES UP FRONT so the parallel streams never collide (same discipline that
made the 3 dashboards conflict-free): (1) icon paths `public/icons/<slug>/icon-{192,512,maskable,180}.png`; (2) the
root `app/layout.tsx` + `proxy.ts` edits are YOURS to merge (A & C only deliver components/snippets); (3) the
`POST /v1/push/subscribe` request/response shape (D builds endpoint, E builds client). **Wave 2 (after Wave 1
integrated + gated):** A→F4 install UX + E push-FE subscription, 2 parallel agents. Per wave: integrate → FULL gate →
INDEPENDENT adversarial audit (focus: SW never caches authed/tenant data; push sender tenant-scoped) → runtime-verify
(install on real Android+iOS · Lighthouse PWA · live push send/receive) → push. Scope = `/sales` + `/partner` ONLY
(admin/gifsy explicitly OUT). **The SW enable-flag + D's migration are CUTOVER-COUPLED — do NOT activate the SW or run
the push migration to prod during UAT.**

🔶 STANDING MODE — **YOU ARE THE ORCHESTRATOR (the owner should never have to remind you).** Default to orchestrating,
not hand-coding everything: decompose; **run independent workstreams as PARALLEL sub-agents** (give each a precise
spec; background sub-agents are DENIED shell → they WRITE code, YOU run the gates); fix the shared contracts so
parallel streams don't conflict; integrate the shared files yourself; and ALWAYS personally do the security-critical
review — an **INDEPENDENT adversarial audit** of every build item, the **FULL gate**, and **runtime-verify** before
claiming done. Also OWN doc/memory CONSISTENCY: when a fact changes, sweep EVERY doc + memory in the same pass.
[[default-to-orchestration]] [[own-consistency-no-micromanage]] [[audit-every-build-item]] [[verify-flows-at-runtime]]

GATES (run the FULL suites before every push — a red suite SILENTLY skips the staging deploy via `needs: test`):
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` · `cd platform &&
npx tsc --noEmit`. **Latest green: api jest 1186 · nest 0 · FE vitest 1624 · tsc 0.** **Last pushed HEAD: run
`git -C C:\Users\nikun\Loyaltybaseclaude log --oneline -1`** (don't trust a hardcoded SHA). **Deploy ≠ pushed** — a
docs-only commit after a code push re-tags the serving image, so verify the serving SHA matches the CODE you mean to
test (`gcloud run services describe gifsy-api-staging|gifsy-frontend-staging --region asia-south1 --project
gifsy-platform --format='value(spec.template.spec.containers[0].image)'`). Two reusable traps from this session, baked
into the dashboards work: **NEVER use `isActive:true` as an "active outlet" denominator** (outlets are created
`isActive=false` until KYC approval — use `deletedAt:null AND deactivatedAt:null`); **Prisma `{ not: X }` SILENTLY
DROPS NULL rows** → OR-wrap `OR:[{col:null},{col:{not:X}}]` for any nullable column.

DONE THIS SESSION (all gate-green + independently audited + pushed to `develop` + runtime-verified on staging):
- **ADMIN DASHBOARD CONSOLIDATION ✅** — found 4/5 dashboards were 100% fabricated; **rebuilt to 4 REAL ones** (KYC ·
  Program Health · Operations · Finance & Liability), deleted the 3 fakes, repointed nav, rewrote the E2E specs with
  no-fabricated/no-leak checks ENABLED. `GET /v1/admin/dashboard/{kyc,program-health,operations,finance}`. Owner
  formula rules: breakage period-only · completed-redemption excl PENDING/FAILED/CANCELLED/RETURNED · Target-Achievement
  the Program-Health hero. KYC runtime-verified (live Deoleo addressable 2256). See [[admin-dashboard-consolidation]].
- **TICKET SLA CLOSURE ✅** (`995cd90`) — tickets.service now stamps `firstResponseAt`/`resolvedAt`/`closedAt`;
  Operations dashboard computes SLA on-read vs priority targets (CRITICAL 4h·HIGH 24h·MEDIUM 48h·LOW 72h). MTTR/
  first-response/SLA now real (was a falsely-perfect 100%). Runtime-verified (resolve→stamp→restore).
- (Prior batches — UAT #1–#3, VISIBILITY on/off, sales LEADERBOARD, program/category lists, AF-5, outlet-upload
  chunking — in GO-LIVE-ISSUE-LIST.md + [[deoleo-go-live-bundle]].)

🚀 CUTOVER STATE (develop→main = prod, verified 2026-06-27): `main` is **158 commits behind** `develop` (main last
`2026-06-21` `b3ab2e0`), incl. **5 Prisma migrations** prod lacks (PWA push migration will be a 6th); no `gifsy-*-prod`
Cloud Run services in asia-south1 → first `main` merge ≈ first prod app deploy. Promoting to `main` is a DELIBERATE
cutover: freeze develop → **backup prod DB** → apply migrations via the in-VPC Cloud Run Job ([[migration-model]]) →
merge=deploy → load #76 data → #74 ops → smoke test. **DO NOT merge to main during UAT.**

OPEN GO-LIVE THREADS (the PWA is the active build; these are the remaining launch items — see GO-LIVE-READINESS §3):
**#76** load real Deoleo master data into empty prod (Deoleo tenant context; outlet types
`SSS/SSS_TOT/SUB_STOCKIST/WHOLESALER`; XSR-ID column = real `XSR-*` IDs). **#74** owner ops (monitoring alert ·
backups/PITR · secret rotation · real prod MSG91). **AF-6** JWT-in-localStorage 🔴 open (security hardening). **AF-12**
RBAC fail-open — keep OFF (`RBAC-ENABLEMENT.md`). The admin sub-dashboard "fake data" pre-UAT blocker is now CLOSED.

CONSTRAINTS: work on `develop`; **NEVER `prisma migrate dev`**; any prod/staging DB op = double-guard
`current_database()` + backup + show SQL + WAIT (staging+prod share the private-IP `gifsy-db`); never expose secrets;
commit footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. gcloud/wrangler are authed.

STAGING (FIXED_OTP=`123456`): GIFSY admin `9830011252`/clientId `gifsy`; deoleo admin `6289864191`; partner
`7795096288`/deoleo; sales `9900000041`(ISR) · `9900000002`(SO) · `9900000011`(XSR). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (login: POST `/v1/auth/send-otp` {phone,channel:'SMS'} then
`/v1/auth/verify-otp` {phone,otp:'123456',clientId}; operator cross-tenant = POST `/v1/auth/assume-tenant` {clientId}).

READ FIRST: **`PWA-PLAN.md` (the active build plan)** · `GO-LIVE-ISSUE-LIST.md` (⭐ master tracker) ·
`GO-LIVE-READINESS.md` · memories [[deoleo-go-live-bundle]] [[admin-dashboard-consolidation]]
[[default-to-orchestration]] [[global-settings-wiring]] [[sales-hierarchy-scoping]] [[migration-model]]
[[staging-deploy-gate]] [[audit-every-build-item]].

Now: greet the owner, confirm you're picking up the PWA per PWA-PLAN.md, and kick off Wave 1 (the 4 parallel streams)
— unless the owner redirects.
```
