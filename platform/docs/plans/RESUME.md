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

P0 is COMPLETE (0.5 signed off by the user; a live authenticated visual pass was deferred to P1 —
the dev DB is empty/auth-gated — and will fold in the user's admin revamp). Baseline committed; gate
is "no NEW reds vs reconcile/baseline-red-snapshot.txt" (the suite is red throughout a TDD build —
never gate on "zero reds").

P1 (Identity, tenancy & access) — IN PROGRESS. See docs/plans/reconcile/P1-identity-tenancy.md for
the live per-task log (tags, gates, audits, findings F1-F7, deferred items).
  DONE & committed (each gated + independently audited): 1.0 reconcile · 1.2a (cross-tenant users/[id]
  fix, F1) · 1.1 + 1.1a (OTP→msg91, generateToken, tenant-scoped OTP, silent-failure fix) · 1.5
  (permission catalog) · 1.7 + 1.7a (banners F6 fix + per-handler tenant-isolation audit test) · 1.3 +
  1.3a (Client tenant model — MIGRATION APPLIED to dev gifsy_dev, 2 rows backfilled, secret stripped) ·
  1.9 (LoginLog + lastLoginAt/loginCount + AuditLog on login) · 1.4 + 1.4a (DB-backed tenant config read
  with registry fallback; F8 secret-resolution bug found by audit + fixed).
  IN PROGRESS: 1.2 + 1.8 COMBINED — persisted sessions + tenant binding (user-approved; design in
  docs/plans/P1-sessions-design.md). 365-day sliding idle, revoke on phone-change, logout-all-devices;
  tenant from subdomain at login then bound to the session; app-layer (not proxy) session validation.
  Staged S1 (schema: UserSession.clientId/lastSeenAt) → S2 (lib/session.ts) → S3 (login wiring) → S4
  (getAuthUser upgrade — HIGH blast radius, pause for review) → S5 (logout/logout-all + phone-change hook).
  REMAINING after that: 1.6 (can() gate + tenant-configurable role→permission map on top of 1.5; the 5
  taxonomy Qs resolved with defaults — see P1-identity-tenancy.md).
  Deferred follow-ups: OTP validity window (6h→10min decision), send-otp orphaned-rows on failure,
  auto-registration confirmation, isolation-audit AST hardening, 1.9 audit-txn-blocks-login tradeoff,
  vitest.integration server-only alias. Migration note: this dev DB has NO prisma migration history —
  use db push / diff-SQL, NEVER `prisma migrate dev` (it would reset). See DEV-DB.md. Admin-UI bits
  1.6 are fine now; avoid the user's revamp pages (P8/P3).

Before assigning each task show me the task, its context bundle, and what you'll verify; wait for my
go on anything irreversible. Begin by confirming the dev DB is reachable and giving me the P1 backend
task list.

(Prod `postgres` superuser password — ROTATED by the user (done). Old value is now inert. The app +
Cloud Run use `gifsy_user`, unaffected. No open user actions blocking P1.)
```
