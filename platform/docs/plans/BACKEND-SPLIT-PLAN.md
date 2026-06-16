# Backend Split — API-first re-architecture (Phase S)

**Decision (owner, 2026-06-16):** split the full-stack Next.js platform into a **dedicated NestJS backend API**
+ a **thin Next.js web frontend**. Do it **now** (greenfield, no prod data, only at P2 = cheapest it will
ever be), before building P3+. No speed-vs-quality tradeoff. Architecture source of truth = `../spec/04-architecture.md`;
why = Gap #31. This doc = how we execute it.

> **STATUS (2026-06-16): S0–S4 ✅ DONE & pushed to `origin/develop`.** The backend is built in `api/` — **124 `/v1`
> endpoints across 17 modules**, a 66-model canonical schema (World-A de-scaffolded, migration applied to
> `gifsy_dev`), and foundation rails (response envelope · RBAC permission guard · `StorageService` GCS ·
> `NotificationsService` enqueue seam · shared xlsx/`StreamableFile`). Every wave was gated (tsc + tests + boot) and
> **independently audited**. **Remaining (light): S5** tenant-scoping guard · **S6** thin the frontend · **S7** infra
> (near-no-op) · **S8** cutover + delete World-A `api/` leftovers. Live per-step status in `00-MASTER-PLAN.md`;
> restart at S5 via `RESUME.md`.

## Why now (one paragraph)
The code was built full-stack (the Next.js `platform/` owns the DB via 119 Prisma routes) but the **infra was
always built for a split** (`terraform/` runs `gifsy-frontend` stateless + `gifsy-api` as the DB owner; the
frontend has **no prod `DATABASE_URL`**, so the platform **cannot run in prod as deployed**). The owner's
long-term goal — **multiple FMCG clients, per-client customization, multiple API consumers (web + mobile + PWA +
partner integrations)** — requires one versioned backend API as the single source of truth. Building more phases
full-stack first means re-homing them twice. So we realign the **code** to the architecture the **infra already
assumes**, while the surface is smallest.

## Target architecture
```
   Consumers:  Web Portal (Next.js PWA) · Future Mobile App · Future Partner Integrations
                                   │  HTTP / JSON  (Bearer JWT, header tenant)
                                   ▼
                       NestJS Backend API   ← single source of truth
                       owns: auth/z · tenancy · sales hierarchy · KYC ·
                             targets (ingest) · wallet/redemption · visibility ·
                             campaigns · reporting · notifications · audit
                                   │
                                   ▼
                              PostgreSQL  (one canonical schema)
```
The web frontend only renders UI, collects input, calls APIs, displays responses. **No business logic, math,
approval routing, hierarchy/wallet/target processing in the frontend** (it may *mirror* validation for UX; the
backend is always the authority).

## Principles (locked with owner)
> The **multi-tenancy & customization model** (config-not-code-branches, the customization spectrum, isolation
> enforcement, multi-consumer auth, now-vs-later effort) is documented in full in **`../spec/06-configurability.md` §0**.
> Principles 3–4 below summarize it.
1. **API-first** — one backend, many consumers. Versioned (`/v1`).
2. **Real, no-compute model** — the backend **ingests/tracks** uploaded target-parameter/achievement/wallet
   amounts; it does **NOT** compute incentives. The inherited "World A" compute engine (tiers, partner-class,
   scheme `pointsPerRupee`, SKU) is **de-scaffolded as part of this build — never ported in** (see `MODEL-ALIGNMENT.md`).
3. **Multi-tenancy is data + config, never code branches** — `clientId` row-scoping (now enforceable at one
   point) + per-tenant config in the DB. **No `if (clientId === …)` in the backend, ever.**
4. **Defer per-client customization machinery (YAGNI)** — the current client needs none; a future client who
   needs divergent logic gets a scoped strategy interface in the *one* module that diverges, **when a real
   requirement exists**. We do not build a customization framework now. The only "now" cost is clean module
   boundaries, which are free.
5. **Foundation = the platform's real-model `lib/` + schema, NOT `api/`'s domain.** `api/`'s **framework shell is
   reused in place** as the backend (it's the proven `gifsy-api` deploy target — see S1); its **World-A domain
   modules are deleted** and the real domain is rebuilt from `platform/lib`. We keep the shell (model-agnostic) +
   port auth/tenant; we never port the World-A domain.

## Why NestJS (alternatives pressure-tested, 2026-06-16)
The hard part — the `lib/` domain logic + canonical schema — is **framework-independent** and ports the same
regardless; the framework choice only changes the handler-wrapper style. We still chose **NestJS**:
| Option | Verdict |
|---|---|
| **NestJS** ✅ | **Best fit for the stated future** — modular DI = the per-client customization seams; guards/interceptors for auth + tenant-isolation + throttle; first-class cron; `/v1` versioning; TS end-to-end (lib/ ports directly); **already proven to build+deploy on this GCP setup** (the `api/`). Costs a bit more re-home effort up front. |
| Keep Next.js API routes, deploy as a separate API-only service | **Rejected** — fastest to go-live and least re-home, BUT a headless-Next app is a weak "backend" (bolt-on cron/guards/versioning); it's the shortcut that **re-creates "redo later"** for the multi-consumer/customization goal. |
| Fastify / Hono (light TS framework) | **Rejected** — lighter, but you hand-build the DI/guards/module conventions NestJS gives for free. |
| Revive NestJS `api/`'s **domain** as the base | **Rejected** — real code but the wrong (World-A) model; see principle 5. (We *do* reuse `api/`'s framework **shell** in place — that's the deploy target — just not its domain.) |

## Reused vs reworked vs deleted (verified against source)
| | Disposition | Why |
|---|---|---|
| P0–P2 domain decisions, model alignment | ✅ reused 100% | knowledge/design |
| `lib/` domain logic (~14k LOC; 60/63 framework-agnostic) | ✅ moves into backend ~as-is | only 3 files import `next/*` |
| Prisma schema (80 models) | ✅ becomes canonical | de-scaffold World-A as part of move |
| RBAC engine, sessions, Client tenant-config (in `lib/`) | ✅ reused | library code |
| `getAuthUser` / `requirePermission` (125 / 50 call-sites) | ♻️ → NestJS global guards | logic reused; net simplification |
| 119 API route handlers (~10.9k LOC) | ♻️ → controllers/services | TS→TS, Prisma→Prisma; the bulk of the work |
| 78 web pages (53 fetch `/api`) | ♻️ repoint base URL + CORS | already DB-decoupled (0 pages touch Prisma) |
| NestJS `api/` **framework shell** (Dockerfile, Prisma-7 module, common guards, bootstrap) + `auth/`+`tenant/` | ✅ reused **in place** — `api/` *becomes* the backend; auth/tenant ported | proven `gifsy-api` deploy target (build ctx `./api`); model-agnostic |
| NestJS `api/` **World-A domain** (`skus`/`schemes`/`targets`/… modules) + its 74-model schema | 🗑️ deleted (at S1/S2) | wrong (World-A) model |
| terraform / cloudflare / CI | ◐ ~no change | already shaped for the split; `api/` dir reuse keeps build paths intact |

## Phased steps (each gated: tsc 0 · differential tests · lint · doc-scan · real-DB evidence for DB work)
- **S0 · Safety checks (do first).** Confirm greenfield (no prod data — owner: ✅ none). Confirm no external
  consumer of `api/` (owner: none today). Confirm prod DB ownership before any prod action (Gap #30). **Human gate.**
- **S1 · Backend scaffold — in place in `api/` (verified 2026-06-16).** Build the backend **inside the existing
  `api/` dir**: the proven build+deploy path is hard-wired to `./api` (`docker build … ./api` in `deploy.yml`/
  `deploy-staging.yml`; `working-directory: api` in `ci.yml`), so reusing it leaves the prod pipeline **untouched**
  — a new dir would force edits to all three workflows (terraform is *not* coupled to the dir; it carries only the
  image var + service name). **Keep** `api/`'s framework shell (`Dockerfile`, `package.json` — Prisma 7 +
  `@prisma/adapter-pg`, already version-matched to the platform — `tsconfig*`, `nest-cli.json`, `src/main.ts`,
  `src/common/` guards/interceptors, `src/prisma/` module). **Port** `src/auth/` + `src/tenant/` against the real
  model (they read only `User`/`UserSession`/`OtpCode`/`AdminConfig`, which exist in both schemas → reusable, not
  throwaway). **Delete** the World-A domain dirs (`skus`, `schemes`, `targets`, `rewards`, `wallet`, `payouts`,
  `outlets`, `partners`, `sales`, `kyc`, `admin`, `reports`, `visibility`, `leaderboard`, `notifications`, `users`)
  + drop the `xlsx` dep (only `sales/` used it). Trim `app.module.ts` to a health route. Real domain is rebuilt from
  `platform/lib` (S3) on the canonical schema (S2). **Human gate** (the World-A deletion — recoverable in git).
- **S2 · Canonical schema + de-scaffold.** Take `platform/prisma/schema.prisma` as canonical; **drop World-A**
  (tiers/partner-class/compute/SKU per `MODEL-ALIGNMENT.md`) so the backend is born clean. **Human-gated migration**
  (dev `gifsy_dev` only; guarded SQL). Schema source-of-truth **moves to the backend** (update DEV-DB.md when done).
- **S3 · Port `lib/`.** Move domain logic into the backend as services; rewrite the 3 `next/*`-coupled helpers
  (`api-response`, `platform/server`, `rbac/require-permission`) to Nest equivalents.
- **S4 · Re-home endpoints.** Convert the 119 route handlers → Nest controllers calling the ported services.
  Parallelize by domain (disjoint waves of executors); batch the gate per wave. Add `/v1` versioning.
- **S5 · Cross-cutting as guards.** Global JWT/session auth, `requirePermission` → a permission guard,
  **tenant-scoping guard/interceptor** (single isolation enforcement point), throttling, audit, cron jobs.
- **S6 · Thin the frontend.** Point the web app's data layer at the backend base URL (`api-client.ts` +
  `NEXT_PUBLIC_API_URL` already plumbed); handle CORS + cross-origin auth; confirm 0 business logic remains client-side.
- **S7 · Infra/CI (mostly already done).** Because the backend lives in `api/`, the existing `gifsy-api`
  build/deploy path is unchanged (no workflow-path edits). Confirm the backend has the prod DB/secrets — it already
  does (only `gifsy-api` gets `DATABASE_URL`); frontend stays stateless; cloudflare already routes; the CI build/test
  matrix dir names stay `[api, platform]`. Remove the now-dead `prisma generate --schema=../api/prisma/schema.prisma`
  fallback in the deploy workflows once the canonical schema lands in `api/prisma/` (S2).
- **S8 · Cutover + retire.** End-to-end smokes (web → backend → DB); confirm no World-A leftovers remain in `api/`;
  close Gaps #30/#31. **The `api/` dir persists — it *is* the backend now**; only its World-A domain was deleted (S1).

## Effort shape (planning-grade — tighten at S0)
A contained **re-home, not a rewrite** (TS→TS, Prisma→Prisma, logic already in `lib/`, frontend already
decoupled). Bulk = S4 (119 endpoints, smallest count now). Rough order: **~1–2 weeks** focused, agent-parallelized
+ gated. The endpoint-by-endpoint reconciliation in S4 is where surprises hide — that's the estimate to refine.
This is the floor; every phase built full-stack first would add to it.

## Human gates / escalate (don't guess)
- S0 safety confirmations · S1 World-A domain deletion (recoverable in git) · S2 schema-drop migration (show SQL,
  wait) · any prod DB / `main` / deploy step. Never point dev at prod (`gifsy-db`); never `prisma migrate dev` on
  `gifsy_dev` (resets it — see DEV-DB.md).

## Sequencing
Phase **S runs now, gating P3+** (see `00-MASTER-PLAN.md`). The P4.0 loyalty-engine de-scaffold is **absorbed into
S2** (we build the backend clean rather than de-scaffolding the platform then porting). P3/P4 designs
(`KYC-APPROVAL-REVAMP.md`, program targeting) are unchanged in intent — they're simply built **in the backend**.
