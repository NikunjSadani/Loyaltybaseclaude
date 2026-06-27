# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16, app router). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled
`dist/`). Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-06-27.

🟢 PWA — you are the ORCHESTRATOR (multiple workstreams in parallel). **Wave 1 is DONE + PUSHED** (`185c548`,
gate-green + independently audited + runtime-verified locally) per **`platform/docs/plans/PWA-PLAN.md`** (read its
"Status — Wave 1 DONE" block first — it has the 3 load-bearing learnings). Wave 1 shipped DISABLED: F1 installable
shell (per-tenant `app/<scope>/manifest.webmanifest/route.ts` + PwaHead iOS meta) · F2 sharp icon pipeline
(`public/icons/<slug>/`, monogram placeholders for deoleo/clientb/gifsy) · F3 Serwist SW (flag-OFF) · F5 backend
(`PushSubscription` + /v1/push/{vapid-public-key,subscribe,unsubscribe} + web-push sender + drain worker OFF + triggers
at wallet-credit/redeem-confirm/KYC-approve). Integration files (mine): `proxy.ts` (x-pathname inject + `*.webmanifest`
auth-passthrough), root `app/layout.tsx` (mount PwaHead gated by x-pathname + ServiceWorkerRegister + viewport-fit),
`next.config.ts` (Serwist wrap gated on `PWA_SW_BUILD`). **Single platform-wide VAPID** (owner-decided).

**✅ Per-tenant manifests runtime-verified on the live Deoleo staging edge** (`uat.deoleoloyalty.gifsy.in` — /sales +
/partner manifests 200 w/ real Deoleo branding + scopes, icons 200). **✅ F4 install UX DONE** (`1b8d349` —
`InstallPrompt`, Android `beforeinstallprompt` + iOS A2HS banner, flag `NEXT_PUBLIC_PWA_INSTALL_ENABLED` default OFF;
gate FE vitest 1628 · tsc 0).

▶️ **NEXT for the PWA (all CUTOVER-COUPLED — do NOT do during UAT):** push FE subscribe (E) on the
`POST /v1/push/subscribe` contract, THEN apply the additive `push_subscription` migration to staging (double-guard) +
set VAPID keys (`npx web-push generate-vapid-keys`) + flip `PUSH_WORKER_ENABLED=true` → runtime-verify live push
send/receive. The SW ships only when built `PWA_SW_BUILD=true` + `next build --webpack` AND
`NEXT_PUBLIC_PWA_SW_ENABLED=true` (coupled). Three enable-flags, all default OFF: `NEXT_PUBLIC_PWA_SW_ENABLED`,
`PWA_SW_BUILD`, `NEXT_PUBLIC_PWA_INSTALL_ENABLED`. Scope = `/sales` + `/partner` ONLY. Per item: integrate → FULL gate →
INDEPENDENT adversarial audit (SW never caches authed/tenant data; push sender userId-scoped) → runtime-verify → push.

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
