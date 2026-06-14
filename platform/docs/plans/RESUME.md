# Resume Prompt (paste after compacting / new session)

Paste this to restart the orchestrator cleanly. It re-grounds in the on-disk docs (the real
source of truth) and ensures the dev-DB proxy is running before any DB work.

```
You're the orchestrator for the Loyaltybase build. Reload context by reading:
- docs/plans/00-MASTER-PLAN.md            (phased plan P0→P8)
- docs/plans/08-agent-execution-guide.md  (your role, the loop, review gate, context bundles)
- docs/plans/00-onboarding.md + 01-how-we-test.md  (conventions, test design)
- docs/plans/07-phased-execution-plan.md  (the 9 just-in-time decisions)
- docs/plans/DEV-DB.md                    (dev database + how to restart the Auth Proxy)
- docs/plans/reconcile/P0-baseline.md + baseline-red-snapshot.txt  (the gate: no NEW reds vs snapshot)
- docs/plans/reconcile/P0-shared-infra.md (P0 reconcile findings + decisions)
- docs/spec/gap-register.md               (open gaps; #1 closed, #21 decided)
- your memory note: loyaltybase-spec-effort.md

Your role: orchestrator + critical reviewer driving a Sonnet-4.6 executor. Assign each task with
its context bundle, then GATE it — re-run npm test / npx tsc --noEmit / npm run lint yourself,
confirm the test fails-without/passes-with, check DRY/YAGNI/clientId/secrets/commit, require
real-DB evidence for DB work, reject with specific feedback. A task is "done" only when your
review passes, never when the executor says so. Escalate human-gate items; don't guess.

DEV DB (do this before any DB task): per docs/plans/DEV-DB.md, the dev DB is Cloud SQL
gifsy-db-dev, reached via the Auth Proxy on 127.0.0.1:5433. After a reboot the proxy is DOWN —
check port 5433; if nothing's listening, restart it (command in DEV-DB.md). Confirm .env
DATABASE_URL points at 127.0.0.1:5433/gifsy_dev and DEMO_MODE=false, and SELECT 1 before
migrating. NEVER point dev at the prod instance gifsy-db.

P0 is DONE except 0.5 (portal UI sign-off, intentionally deferred — the user is revamping admin
UX). Baseline committed; gate is "no NEW reds vs reconcile/baseline-red-snapshot.txt" (the suite is
red throughout a TDD build — never gate on "zero reds").

START P1 (Identity, tenancy & access) — but run the BACKEND track only and keep OUT of the admin
portal: the user is revamping admin dashboards, reports, and the Gifsy KYC-approval page in parallel.
So defer P1's admin-UI bits (1.4 admin config UI, 1.6 admin role-gating UI) and 0.5 until those land;
do 1.1/1.2(backend)/1.3/1.5/1.7/1.8/1.9 now. When P3 (KYC) and P8 (dashboards/reports) arrive, their
3.0/8.0 Reconcile must build against the user's REVAMPED UX (code wins), not the current pages.

Before assigning each task show me the task, its context bundle, and what you'll verify; wait for my
go on anything irreversible. Begin by confirming the dev DB is reachable and giving me the P1 backend
task list.

(Still open, user action — NON-blocking: rotate the prod `postgres` superuser password. It was
hardcoded in credits-migration-live.test.ts, removed in 0.1 but still in git history. Zero-disruption:
nothing uses `postgres` (app uses gifsy_user). One command:
`gcloud sql users set-password postgres --instance=gifsy-db --project=gifsy-platform --prompt-for-password`.)
```
