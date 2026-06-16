# Backend Split — API-first re-architecture (Phase S)

**Decision (owner, 2026-06-16):** split the full-stack Next.js platform into a **dedicated NestJS backend API**
+ a **thin Next.js web frontend**. Do it **now** (greenfield, no prod data, only at P2 = cheapest it will
ever be), before building P3+. No speed-vs-quality tradeoff. Architecture source of truth = `../spec/04-architecture.md`;
why = Gap #31. This doc = how we execute it.

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
5. **Foundation = the platform's real-model `lib/` + schema, NOT the old `api/`.** The NestJS `api/` is mined for
   structural *patterns* (guards/DI/cron) then **deleted** — its domain is the wrong (World-A) model.

## Why NestJS (alternatives pressure-tested, 2026-06-16)
The hard part — the `lib/` domain logic + canonical schema — is **framework-independent** and ports the same
regardless; the framework choice only changes the handler-wrapper style. We still chose **NestJS**:
| Option | Verdict |
|---|---|
| **NestJS** ✅ | **Best fit for the stated future** — modular DI = the per-client customization seams; guards/interceptors for auth + tenant-isolation + throttle; first-class cron; `/v1` versioning; TS end-to-end (lib/ ports directly); **already proven to build+deploy on this GCP setup** (the `api/`). Costs a bit more re-home effort up front. |
| Keep Next.js API routes, deploy as a separate API-only service | **Rejected** — fastest to go-live and least re-home, BUT a headless-Next app is a weak "backend" (bolt-on cron/guards/versioning); it's the shortcut that **re-creates "redo later"** for the multi-consumer/customization goal. |
| Fastify / Hono (light TS framework) | **Rejected** — lighter, but you hand-build the DI/guards/module conventions NestJS gives for free. |
| Revive NestJS `api/` as the domain base | **Rejected** — real code but the wrong (World-A) model; see Foundation principle 5. |

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
| NestJS `api/` domain code + its 74-model schema | 🗑️ deleted | wrong (World-A) model; patterns only |
| terraform / cloudflare / CI | ◐ minor | already shaped for the split |

## Phased steps (each gated: tsc 0 · differential tests · lint · doc-scan · real-DB evidence for DB work)
- **S0 · Safety checks (do first).** Confirm greenfield (no prod data — owner: ✅ none). Confirm no external
  consumer of `api/` (owner: none today). Confirm prod DB ownership before any prod action (Gap #30). **Human gate.**
- **S1 · Backend scaffold.** New NestJS service (own dir, e.g. `backend/`), borrowing `api/`'s guard/DI/cron
  *patterns* (not its modules). Health route, config, Prisma module (Prisma 7 + `@prisma/adapter-pg`).
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
- **S7 · Infra/CI.** Give the backend the prod DB/secrets; frontend stays stateless; cloudflare already routes;
  CI builds/deploys both; remove the `api/` build/deploy.
- **S8 · Cutover + retire.** End-to-end smokes (web → backend → DB); **delete `api/`**; close Gaps #30/#31.

## Effort shape (planning-grade — tighten at S0)
A contained **re-home, not a rewrite** (TS→TS, Prisma→Prisma, logic already in `lib/`, frontend already
decoupled). Bulk = S4 (119 endpoints, smallest count now). Rough order: **~1–2 weeks** focused, agent-parallelized
+ gated. The endpoint-by-endpoint reconciliation in S4 is where surprises hide — that's the estimate to refine.
This is the floor; every phase built full-stack first would add to it.

## Human gates / escalate (don't guess)
- S0 safety confirmations · S2 schema-drop migration (show SQL, wait) · S8 `api/` deletion · any prod DB / `main` /
  deploy step. Never point dev at prod (`gifsy-db`); never `prisma migrate dev` on `gifsy_dev` (resets it — see DEV-DB.md).

## Sequencing
Phase **S runs now, gating P3+** (see `00-MASTER-PLAN.md`). The P4.0 loyalty-engine de-scaffold is **absorbed into
S2** (we build the backend clean rather than de-scaffolding the platform then porting). P3/P4 designs
(`KYC-APPROVAL-REVAMP.md`, program targeting) are unchanged in intent — they're simply built **in the backend**.
