# D2 — Platform-Prisma Retirement (#31/#32) — PLAN (audited, awaiting owner go)

> Status: **AUDITED — core thesis confirmed by 3 independent audits; their findings folded in below.** No files
> deleted yet. **Owner reviews + approves before execution.** Grounded on the read-only inventory (2026-06-20) +
> orchestrator runtime verification + 3 independent adversarial audits.

## 0. Audit outcome (3 independent red-teams, 2026-06-20)

- **A — import-graph safety:** PASS. Re-traced every importer of every "dead-transitive" module. `lib/auth.ts`'s
  **128 importers are all dead `app/api` routes or tests — zero live.** `app/layout.tsx` is provably the ONLY live
  Prisma importer (all 14 `.tsx` matches were false positives on sibling modules). The delete set is safe.
- **B — build/runtime breakage:** confirmed the runtime claims; **found a deploy-breaker** — `Dockerfile:14` + `ci.yml:71`
  run an UNGUARDED `npx prisma generate`, which fails once `platform/prisma` + deps are removed. Local `next build`
  (the original §5) would NOT catch it. Folded in (steps 5b/5c + §5).
- **C — scope/completeness:** confirmed scope; **found** a missed orphan (`client-row.ts`), an inaccurate #32 premise
  (`force-logout-all` IS a live ported revoke route), and an under-scoped test sweep (~20 `lib/__tests__` `readFileSync`
  compliance tests fail at RUNTIME, not `tsc`). Folded in (§2, §3-B, §4.7).

Net: **the core thesis (one live SSR Prisma chain; everything else dead-shadowed; `prisma.ts` deleted last) is sound and
triple-verified.** The plan below incorporates every audit finding.

## 1. The one fact that de-risks everything

The frontend is already thin: `next.config.ts` proxies **100% of `/api/*` → backend `/v1/*`** (zero exclusions), so
**every `platform/src/app/api/**/route.ts` (~135 files) is dead-shadowed** as an HTTP endpoint.

The **only** server-side platform-Prisma usage is a single SSR chain:
`app/layout.tsx` → `getTenantConfig()` (`lib/platform/server.ts`) → `client-config-db.ts` → `prisma.client.findUnique()`.

**And that Prisma read never executes at runtime:** it only runs when the `x-tenant-slug` request header is present;
that header is set ONLY by `src/proxy.ts`, which is **NOT wired as Next middleware** (there is no `middleware.ts`). So
`getTenantConfig()` always falls through to the in-code `DEOLEO_CONFIG` fallback. The Prisma import is **build-blocking
only**, not runtime-live. ⇒ D2 needs **no backend porting** to preserve current behavior — just rewire the layout to its
existing Prisma-free fallback.

## 2. Verified buckets (from the inventory; auditors must re-confirm)

| Bucket | Contents | Action |
|---|---|---|
| **DEAD-SHADOWED** | ~135 `app/api/**/route.ts` files (all dirs) | DELETE |
| **DEAD-TRANSITIVE** | `lib/auth.ts`, `lib/session.ts`, `lib/wallet.ts`, `lib/visibility.ts`, `lib/tds.ts`, `lib/notifications.ts`, `lib/incentive.ts` (orphan, 0 importers), `lib/outlet-persist.ts`, `lib/hierarchy-persistence.ts`, `lib/rbac/*`, `lib/kyc-approval.ts` — imported ONLY by dead routes/tests | DELETE (after confirming no live importer) |
| **LIVE-server (PORT/REWIRE FIRST)** | `app/layout.tsx` tenant-config Prisma chain (the ONLY one) | Rewire to Prisma-free fallback BEFORE deleting `lib/prisma.ts` |
| **Prisma infra** | `lib/prisma.ts`, `lib/platform/client-config-db.ts` + its orphan helper **`lib/platform/client-row.ts`** (audit C), `platform/prisma/schema.prisma`, **`platform/prisma.config.ts`** (audit B), `@prisma/client`+`@prisma/adapter-pg` in `platform/package.json`, AND the unguarded `prisma generate` in **`platform/Dockerfile:14`** + **`.github/workflows/ci.yml:71`** (audit B — deploy/CI breakers) | DELETE/REMOVE last |
| **CLIENT_REGISTRY** | `lib/platform/client-registry.ts` (in-code, Prisma-free) | **KEEP** as the FE SSR-branding fallback (see Decision A) |
| **Legacy-lib demos** | `lib/targets.ts`, `lib/gifts.ts`, `lib/partner-session.ts`, `lib/redemption-store.ts`, `lib/platform/{outlet-types,platform-admin,tenant-kpi-config,...}` — **NOT Prisma-backed** | **OUT OF D2 SCOPE** (retire as pages get real wiring) |

## 3. Decisions for the owner (the plan branches on these)

**Decision A — tenant-config (SSR branding):**
- **A1 (recommended for D2):** rewire `layout.tsx`/`server.ts` to resolve tenant config from the in-code
  `CLIENT_REGISTRY` (Prisma-free) — **preserves exact current runtime behavior** (always `DEOLEO_CONFIG` today, since no
  middleware sets the slug). Minimal, behavior-neutral, unblocks all deletion. CLIENT_REGISTRY stays as a small config
  fallback. The "real" multi-tenant SSR branding (subdomain → backend tenant-config endpoint + wiring middleware) becomes
  a **separate future task** (P8/tenant), NOT D2.
- **A2:** build a backend `GET /v1/tenant/config` public endpoint now + have the layout fetch it. More work, achieves
  "no tenant data in FE," but pulls a feature build into a retirement task.

**Decision B — `auth/logout` (#32)** *(premise corrected per audit C):* a **per-user** logout/revoke route is absent on
the backend (`api/src/auth` exposes only send-otp/verify-otp/refresh/me/assume-tenant), and FE `logout()` is client-only
(clears localStorage, no network). **However** a live **admin** revocation route IS ported and exists:
`POST /v1/admin/force-logout-all` (`api/src/admin-core/force-logout-all.controller.ts`) — no FE currently calls it. So
the de-facto behavior is **stateless per-user logout**; the dead `app/api/auth/logout(-all)` routes are shadowed and get
deleted regardless.
- **B1 (recommended):** accept **stateless per-user logout** (clear client token; the access token expires naturally;
  refresh-rotation already revokes the old session) — matches today's behavior; delete the dead logout routes. Track the
  residual (a stolen access token stays valid until expiry) as a security item; `force-logout-all` remains available for
  the break-glass case.
- **B2:** port a per-user `POST /v1/auth/logout` (revoke the caller's session row) + wire FE `logout()` to call it.
  Proper per-user revocation; small backend add.

## 4. Proposed deletion sequence (dependency-ordered; each step gated)

> Principle: rewire the one live importer FIRST, then delete leaves-up so the build never breaks mid-sequence.

0. **Pre-flight:** branch is `develop`, clean tree, harness green (59), `tsc` baseline captured. Snapshot the exact file
   list to delete (a manifest) for review.
1. **Rewire `layout.tsx` tenant-config off Prisma** (Decision A1): make `getTenantConfig()` resolve from `CLIENT_REGISTRY`
   only; drop the `client-config-db.ts` Prisma branch. `tsc` + `next build` + harness must stay green. **(Behavior must be
   identical — verify the rendered branding is unchanged.)**
2. **Delete the dead `app/api/**` route tree** (~135 files). `tsc` + `next build` + harness.
3. **Delete the dead-transitive `lib` modules** (auth/session/wallet/visibility/tds/notifications/incentive/outlet-persist/
   hierarchy-persistence/rbac/kyc-approval). After each cluster: `tsc` (catches any missed live importer). 
4. **Retire `client-config-db.ts` + its orphan helper `lib/platform/client-row.ts`** (their only purpose was the Prisma
   tenant read + secret/partnerClasses re-attach — now unused; audit C confirmed no live consumer). Keep `CLIENT_REGISTRY`
   + `server.ts` (Prisma-free).
5. **Delete `lib/prisma.ts` + `platform/prisma/` + `platform/prisma.config.ts` + the `@prisma/*` deps in
   `platform/package.json`.** `tsc` + `next build`.
   - **5b. [DEPLOY-CRITICAL] Fix `platform/Dockerfile:14`** — remove the `RUN npx prisma generate` line (or guard it
     `if [ -f prisma/schema.prisma ]`). Without this the frontend Docker image build fails → staging/prod deploy breaks.
   - **5c. [CI-CRITICAL] Remove the platform `prisma generate` step at `.github/workflows/ci.yml:71`** (the `platform-test`
     job — `cache-dependency-path: platform/package-lock.json`). **Do NOT touch `ci.yml:35`** — that's the *api* job's
     generate (api/ keeps Prisma). **`deploy.yml:52` + `deploy-staging.yml:46` need NO change** — verified already
     `if [ -f prisma/schema.prisma ]`-guarded (the comment anticipates this exact S8 deletion → they no-op cleanly).
6. **Resolve #32** per Decision B (delete the dead `app/api/auth/logout*` + `admin/force-logout-all` *platform* routes in
   step 2 regardless — the backend `POST /v1/admin/force-logout-all` is the live one and is untouched; add a per-user
   backend logout only if B2).
7. **Delete the orphaned tests — BOTH kinds (audit C):**
   - (a) route-colocated `app/api/**/__tests__` (fail at `tsc`/compile), AND
   - (b) the **~20 `lib/__tests__` source-reading "compliance" tests** that `readFileSync` a deleted route/lib's source
     (e.g. `tenant-isolation-audit`, `*-compliance`, `*-export`, `kyc-wiring`, `points-ledger-export`, …) — these fail at
     **RUNTIME (ENOENT), NOT `tsc`**, and are NOT under the route trees, so a route-folder sweep misses them.
   Enumerate both into the manifest; delete; then **re-cut the vitest red-snapshot** deliberately so the differential gate
   stays meaningful (no NEW reds beyond the intentional removals).

## 5. Verification (every step + final) — *expanded per audit B (the TS graph is not enough)*

- `cd platform && npx tsc --noEmit -p tsconfig.json` = 0 (catches any surviving importer of a deleted module).
- `npx next build` (standalone) succeeds — catches `server-only` / route-collection breaks the dev server hides.
- **🔴 Build the frontend Docker image (`platform/Dockerfile`)** — this is the ONLY check that catches the
  `prisma generate` deploy-breaker (5b). `tsc`/`next build` are blind to it (it's outside the TS graph). MANDATORY.
- **🔴 Run the `ci.yml` `platform-test` job logic** (or at least the `prisma generate`-removed step) to confirm 5c — the
  GH workflow only fails on a real PR otherwise.
- `npm run e2e` = **59 passed** (no NEW reds) — every role/page still renders + the proxy still serves from the backend.
- `vitest run` differential vs the **re-cut** red-snapshot — no NEW reds. ⚠️ remember the `lib/__tests__` `readFileSync`
  compliance tests fail at RUNTIME here (not `tsc`); they must be in the delete manifest first (§4.7).
- Manual: load each portal shell (admin/partner/gifsy/sales) + tenant-branded pages — branding unchanged (A1).

## 6. Rollback

Pure deletions on a branch → `git revert`/reset restores everything. No DB migration, no data change (the platform
`prisma/schema.prisma` is stale/unused; the real DB is owned by `api/`). Lowest-risk class of change once the build is
green.

## 7. Risks / watch-items (auditors: focus here)

1. **A missed live importer** — the whole plan rests on "dead-transitive" being truly dead. `tsc` + `next build` are the
   backstop, but auditors must independently re-trace the import graph for each lib in §2 (esp. `lib/auth.ts` — 120+
   importers; confirm ALL are dead routes/tests, none a page/layout/server-action).
2. **`next build` vs dev** — the dev server tolerates some dead imports; only a full `next build` surfaces `server-only`
   + route-collection errors. MUST run a real build, not just `tsc`.
3. **Hidden non-`/api` Prisma reach** — re-confirm there is no `middleware.ts`, no `instrumentation.ts`, no server action,
   and no server component (other than the root layout) importing Prisma. (Inventory says none; re-verify.)
4. **`package.json` prisma scripts / postinstall** — removing `@prisma/client` may break a `prisma generate` postinstall
   or a CI step; check `platform/package.json` scripts + any CI workflow referencing platform prisma.
5. **CLIENT_REGISTRY secret/partnerClasses** — `client-config-db` re-attached MSG91 secret + partnerClasses from the
   registry; confirm nothing live consumes those (RBAC is off; partnerClasses retired) before deleting client-config-db.
6. **Test fallout** — deleting routes orphans ~many `__tests__`; quantify + re-baseline so the gate stays meaningful.

## 8. Out of scope (explicitly NOT D2)

- The legacy-lib demos (`lib/targets`/`gifts`/`partner-session`/`redemption-store`/`platform/*`) — Prisma-free; retire as
  the consuming pages get real backend wiring (separate FE effort).
- Real multi-tenant SSR branding (subdomain → backend tenant-config endpoint + middleware) — future P8/tenant task
  (Decision A2 if pulled forward).
- The api/ backend — untouched.
