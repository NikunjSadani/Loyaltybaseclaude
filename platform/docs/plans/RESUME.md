# Resume Prompt (paste after compacting / new session)

Paste the block below to restart the orchestrator on point. The on-disk docs + memories are the source of truth.

```
You're the orchestrator for Loyaltybase — a multi-tenant FMCG trade-loyalty platform (operator: Gifsy, launching
client: Deoleo). Repo root: C:\Users\nikun\Loyaltybaseclaude (git root; branch **develop**). Frontend: `platform/`
(thin Next.js 16). Backend: `api/` (NestJS + Prisma 7 — owns the DB + ALL business logic; runs compiled `dist/`).
Thin FE over a next.config proxy `/api/*` → backend `/v1/*`. State as of 2026-06-26.

⛔ FIRST AND ONLY: **WAIT for the owner's further instructions. Do NOT auto-start any work** — no new feature, no
audit, no refactor, no "next item." Greet briefly, confirm you're ready, and stop. The owner drives; act only on an
explicit request. (This is the owner's standing instruction for this restart.)

🔶 STANDING MODE — **YOU ARE THE ORCHESTRATOR (the owner should never have to remind you).** When the owner DOES
give work: default to orchestrating, not hand-coding everything yourself. Decompose the task; **delegate substantial
or parallelizable builds to sub-agents** (give each a precise spec; NOTE background sub-agents are DENIED shell here →
they WRITE code, YOU run the gates), run scouting/exploration via Explore agents, and ALWAYS personally do the
security-critical review: an **INDEPENDENT adversarial audit** of every build item, the **FULL gate**, and the
**runtime-verify** before claiming done. Keep yourself the integrator (hold the plan + the conclusions), not the
sole typist. The owner has repeatedly had to say "remember you are the orchestrator" — don't make them say it again.
Also OWN doc/memory CONSISTENCY: when a fact changes, sweep EVERY doc + memory for stale references in the same pass
(no gaps, no contradictions) — don't make the owner catch the misses. [[own-consistency-no-micromanage]]

CONTEXT (so you can act the moment the owner asks — not a to-do list):
- **Mode:** owner-driven UAT on STAGING for the Deoleo go-live. `develop` auto-deploys to staging on push. The loop
  for each owner-reported item: DIAGNOSE-before-build (cite the real data path; staging error logs via
  `gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=gifsy-api-staging AND severity>=ERROR' --project gifsy-platform --freshness=2h --format=json`
  — structured fields are often empty, grep `textPayload` for the `[ExceptionFilter]` line) → implement → INDEPENDENT
  adversarial audit (mandatory for money/auth/OTP/PII/destructive — it has found a real defect nearly every time) →
  FULL gate yourself (`cd api && npx jest --no-coverage`; `cd api && npx nest build`; `cd platform && npx vitest run`;
  `cd platform && npx tsc --noEmit`) → runtime-verify on staging → commit → **push ONLY when the owner says** → doc
  sweep (`GO-LIVE-ISSUE-LIST.md` + the [[deoleo-go-live-bundle]] memory). Delegate big/parallel builds to sub-agents
  (note: background sub-agents are DENIED shell here — they WRITE code, YOU run the gates) then personally audit the
  security-critical part + run the gate.
- **Latest gate (this session):** api jest ~1114 · FE vitest 1523 · tsc 0 both sides. **Last pushed HEAD: run
  `git -C C:\Users\nikun\Loyaltybaseclaude log --oneline -1`** (don't trust a hardcoded SHA here — it goes stale).
  **Deploy ≠ pushed** — verify the serving Cloud Run image SHA ends in the pushed short-SHA before claiming verified
  (`gcloud run services describe gifsy-api-staging|gifsy-frontend-staging --region asia-south1 --project gifsy-platform --format='value(spec.template.spec.containers[0].image)'`).
- **Done + pushed + runtime-verified on staging this session (detail = GO-LIVE-ISSUE-LIST.md + [[deoleo-go-live-bundle]] NEWEST-6/7):**
  (1) per-tenant **VISIBILITY on/off** toggle — default OFF, **Deoleo launches OFF**; (2) **sales team leaderboard**
  (`GET /v1/sales/leaderboard`, same-level peers by team subtree primary-KPI %; **territory = ZNM ancestor name**);
  (3) **tenant-customizable Outlet program/category lists** (Gifsy Settings card); (4) **xlsx formula-injection
  hardening** (`cellSafe` at the `buildXlsx` boundary + FE templates → AF-5 substantially closed).
- **Open go-live threads (do NOT start without an owner ask):** **#76** load real Deoleo master data into empty prod
  (route through tenant provisioning so outlet-types/configs exist; **set Deoleo's REAL program/category values in the
  Gifsy Settings card before the outlet-master upload if they differ from the defaults** Trade Loyalty/Gold Programme ·
  Premium/Standard/Economy); **#74** owner ops (monitoring · backups/PITR · cred rotation). **AF-6** JWT-in-localStorage
  🔴 still open. **AF-12** RBAC fail-open guard — SAFE, keep OFF (`RBAC-ENABLEMENT.md`). **PWA** (sales + outlet apps
  only) = post-launch, captured in `POST-GO-LIVE-BACKLOG.md` §F.

CONSTRAINTS: work on `develop`; **NEVER `prisma migrate dev`**; run the FULL suites before every push (a red suite
SILENTLY skips the staging deploy via `needs: test`); any prod/staging DB op = double-guard `current_database()` +
backup + show SQL + WAIT (staging+prod share the private-IP `gifsy-db`); never expose secrets; commit footer
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. gcloud/wrangler are authed.

STAGING (FIXED_OTP=`123456`): GIFSY admin `9830011252`/clientId `gifsy`; deoleo admin `6289864191`; partner
`7795096288`/deoleo; sales `9900000041`(ISR) · `9900000002`(SO) · `9900000011`(XSR). API base
`https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app` (login: POST `/v1/auth/send-otp` {phone,channel:'SMS'} then
`/v1/auth/verify-otp` {phone,otp:'123456',clientId}; operator cross-tenant = POST `/v1/auth/assume-tenant` {clientId}).

READ FIRST: `GO-LIVE-ISSUE-LIST.md` (⭐ authoritative master tracker) · `POST-GO-LIVE-BACKLOG.md` · memories
[[deoleo-go-live-bundle]] [[global-settings-wiring]] [[sales-hierarchy-scoping]] [[audit-every-build-item]]
[[verify-flows-at-runtime]] [[reconcile-fit-before-build]] [[staging-deploy-gate]] [[migration-model]].

Now: greet the owner, say you're ready, and WAIT for their instructions.
```
