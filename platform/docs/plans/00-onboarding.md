# 00 · Onboarding (read before any task)

You are skilled, but new to this stack and this business. This doc gets you productive without
guessing. ~1–2 hours, including the spec reading.

## 1 · What this product is (10 min)

Loyaltybase is a **multi-tenant SaaS** (operator: **Gifsy**) where consumer brands ("tenants")
run trade-loyalty programs for their retailers/wholesalers ("partners/outlets"). Read, in order:

1. [`spec/00-foundation.md`](../spec/00-foundation.md) — vocabulary. **Learn these words**:
   Tenant, Partner vs Outlet, Sales hierarchy (ISR→NSM), KYC, Scheme/Activation, Target,
   Wallet, Points, Payout, **Credit**, **UTR**, Visibility.
2. [`spec/01-capabilities.md`](../spec/01-capabilities.md) — the **Core value model** box at the
   top is the single most important thing to internalize: *tenants compute incentives
   externally and upload final amounts; the platform is a ledger + disbursement system.*
3. Skim [`spec/02-workflows.md`](../spec/02-workflows.md) for the flow your task touches.

> If a task ever seems to contradict the spec, **stop and ask** — don't guess.

## 2 · The toolset (know these before coding)

| Tool | Version | What you must know |
|---|---|---|
| **Next.js** | 15, App Router | ⚠️ **Read [`AGENTS.md`](../../AGENTS.md): this is NOT the Next.js in your memory.** APIs differ. Before writing route/page code, read the relevant guide under `node_modules/next/dist/docs/`. |
| **TypeScript** | strict | `npx tsc --noEmit` must stay clean. Use `@/…` imports (alias for `src/…`). |
| **Prisma** | 7 (+ `@prisma/adapter-pg`) | ORM for Postgres. Schema: `prisma/schema.prisma`. After schema edits: `npx prisma generate`. |
| **Vitest** | — | Test runner. `npm test` (run once), `npm run test:watch`. See [`01-how-we-test.md`](01-how-we-test.md). |
| **GCS** | `lib/s3.ts` | Object storage (file is named `s3` for legacy reasons; it's Google Cloud Storage). |
| **MSG91** | `lib/msg91.ts` | SMS/WhatsApp/OTP. |

**API route shape** (every file under `src/app/api/**/route.ts`):
```ts
export async function GET(req: NextRequest) { … }   // also POST/PUT/PATCH/DELETE
```
The house style at the top of most routes:
```ts
const ok  = (data, status = 200) => NextResponse.json({ success: true,  data    }, { status });
const err = (message, status = 400) => NextResponse.json({ success: false, error: message }, { status });
const authUser = getAuthUser(req);                 // from '@/lib/auth'
const clientId = getClientIdFromRequest(req);      // from '@/lib/tenant' — ALWAYS scope queries by this
```
**Rule:** every DB query must be scoped by `clientId` (directly or via a relation). Forgetting
this leaks data across tenants (see gap #23).

**`DEMO_MODE`**: when `process.env.DEMO_MODE === 'true'`, many routes short-circuit external
deps (DB/MSG91) and return simulated data. Useful for running the app without infra.

## 3 · Repo map

```
prisma/schema.prisma         ← the data model (~90 models). Your source of truth for fields.
src/app/<portal>/…           ← UI pages: gifsy/ admin/ sales/ partner/
src/app/api/**/route.ts      ← API endpoints (see spec/05-api-surface.md for the full list)
src/lib/*.ts                 ← domain logic. PURE functions live here — reuse them (DRY).
src/lib/__tests__/, *.test.ts← tests
src/types/index.ts           ← shared TS types/enums
docs/spec/                   ← the design spec (your domain reference)
docs/plans/                  ← you are here
```

The `lib/` convention: **pure, testable functions** (no DB/browser) are separated from
side-effectful callers. Example: `lib/kyc-approval.ts` is pure; the route calls it. Prefer
putting logic in a pure function and unit-testing that.

## 4 · Environment setup

**Node:** the repo has no `.nvmrc` or `engines` pin — use **Node 20 LTS** (Next.js 15 needs
≥18.18; 20 is safest). Confirm with `node -v` before installing.

```bash
# from repo root: platform/
cp .env.example .env            # fill values; for local work you can set DEMO_MODE=true
npm install
npx prisma generate             # generate the Prisma client
npm run dev                     # http://localhost:3000
npm test                        # the existing suite should pass before you change anything
npx tsc --noEmit                # should be clean
```
If `npm test` or `tsc` are not clean on a fresh checkout, **stop and report** — don't build on
a broken base.

**Do I need a database?** Often no. Pure-function work (most of Milestones A–C) needs only
`npm test`. Tasks with a **manual-verification** step that reads/writes data (e.g. Milestone B's
wallet check) need a local Postgres:
```bash
# one-time throwaway Postgres via Docker
docker run --name lb-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=loyaltybase -p 5432:5432 -d postgres:16
# set DATABASE_URL in .env to point at it, then create the schema:
npx prisma db push
```
**Milestones A–D add no schema changes — no migrations to write.** Only the epics (E1, E4) do.
If you can't run a DB, you can still complete every RED/GREEN step; just mark the manual check
"pending — needs DB" in your PR rather than skipping it silently.

## 5 · Git workflow

- Branch per task: `feat/points-to-wallet` / `fix/domain-refs` / `chore/...`.
- **Conventional commits**, present tense, small: `fix(credits): credit points to wallet on batch confirm`.
- Commit at **every green test**. Frequent small commits > one big commit.
- Never commit `.env`, `*.json` keys, or secrets. Check `git status` before every commit.
- One task → one PR. Keep diffs small and reviewable.

## 6 · The five golden rules (reread these)

1. **TDD** — failing test first, always.
2. **DRY** — search for an existing helper before writing one (`grep -r "functionName" src`).
3. **YAGNI** — only what the task asks.
4. **Small commits**, conventional messages.
5. **Scope every query by `clientId`.**

Next: [`01-how-we-test.md`](01-how-we-test.md).
