# §A-DOMAIN — DB-driven tenant domain routing + branding (build plan)

> **Status (updated 2026-07-20): P0–P5 + D-1 ✅ SHIPPED, P6 IN PROGRESS.** P0/P1/P2/P4/P4b are IN PROD
> (cutover #10, `437045a`); P3 worker DEPLOYED to CF edge; branding-backfill live in prod DB; **D-1 (resolveClient
> →clients) + P5 (registry-code retired, features from authenticated /me) ✅ DONE on develop (`9872806`/`c4d1cf9`,
> audited GO, staging-verified) — awaiting cutover #11.** Only **P6** remains: S1 edge-secret (code done+inert,
> activation pending) + proxy/worker tests + 2nd-tenant E2E + favicon-by-slug fix + docs. See [[deoleo-go-live-bundle]]
> NEWEST-54/53 + `RESUME.md` for the as-built detail. (Original plan below is retained for reference.)
> Created 2026-07-18. Supersedes the sizing in `POST-GO-LIVE-BACKLOG.md:23-44`. Tracks as task **#150**.

## 0. Goal in one line

**A GIFSY operator provisions a new tenant entirely from the console + DB — slug, branded
`*.gifsy.in` domain, colors, logo/wordmark/favicon, WhatsApp template names — and it ROUTES and
RENDERS with zero code changes and zero manual edge redeploy.** Today all of that is hardcoded in an
in-code registry across 5+ sites and a hand-edited Cloudflare worker.

## 1. Locked decisions (owner, 2026-07-18)

- **Domain scope = `*.gifsy.in` subdomains only.** No truly-external customer domains
  (`rewards.theirbrand.com`) → **no Cloudflare-for-SaaS custom-hostname / per-hostname TLS work.**
  Cloudflare's managed wildcard TLS on the `gifsy.in` zone covers every tenant host automatically.
  (External domains remain a future add-on; this plan does not preclude it, but does not build it.)
- **Branding-to-DB is IN scope.** Move domains **+** branding (colors/display name/support) **+** logo
  assets **+** WhatsApp template names from the code registry to the DB, so a new tenant needs no code
  edit. This is the full "Multi-tenant SSR branding" item folded in.

### Phase-0 sub-decision — RESOLVED (no bucket to stand up)
- **Logo/wordmark/favicon asset hosting.** P0 discovery found a **GCS integration already exists**
  (`api/src/storage/storage.service.ts`, `@Global` module, bucket `GCS_BUCKET=gifsy-platform-files`,
  modeled by the KYC upload with magic-byte sniffing + a 5 MB cap). So the logo-upload endpoint reuses
  `StorageService` + the KYC pattern — **no new bucket/IAM.** Assets upload to `branding/<slug>` keys;
  the public URL is stored in `clients.branding`. See [A-DOMAIN-P0-DESIGN.md](./A-DOMAIN-P0-DESIGN.md) §2.

## 2. Current state (verified in code 2026-07-18)

The whole chain is **hostname → slug → clientId, baked into the JWT at login**; the backend never
parses a host.

| Layer | File | What it does today | Why it blocks us |
|---|---|---|---|
| Edge | `cloudflare-worker/worker.js` (`ROUTES`), `wrangler.toml` (`routes`) | Hardcoded per-hostname map → Cloud Run origin; forwards `x-forwarded-host` | Every new host = a hand-edit + manual `wrangler deploy` |
| Next proxy | `platform/src/proxy.ts:54-90` | Reads host, calls the pure resolver, sets `x-tenant-slug` | Resolver is in-code only |
| Resolver | `platform/src/lib/platform/tenant-resolution.ts` | `resolveSlugFromHostname` (pure/no-I/O): operator hosts → `gifsy`; `DOMAIN_TO_SLUG` (built from registry `domains[]`) → slug; else subdomain heuristic | Domain→slug map is compiled from the code registry, not the DB |
| Registry | `platform/src/lib/platform/client-registry.ts` + `client-config.ts` | `CLIENT_REGISTRY[slug]` holds domains, branding, logo URLs, WhatsApp templates — all keyed by slug, in code | Adding/branding a tenant = a code change + deploy |
| Login | `auth/login/actions.ts:32-34`, `lib/auth-actions.ts`, `lib/platform/server.ts` | Re-derive clientId from host via the same resolver | 5+ consumers must all follow the DB path |
| Schema | `api/prisma/schema.prisma` `Client` (id = slug) | **No `domain`/`domains` column.** `branding Json` column already exists | Need a domains store + reverse lookup |

**Deoleo works today only because `deoleoloyalty.gifsy.in → deoleo` is hand-wired in three places:**
the registry `domains` array, `worker.js` ROUTES, and `wrangler.toml`.

## 3. Target architecture

1. **Edge goes tenant-agnostic.** Because we only serve `*.gifsy.in`, replace the per-host `ROUTES`
   map with a **coarse rule**: all tenant frontend hosts (`*.gifsy.in`, minus the explicit API +
   operator hosts) → the frontend Cloud Run origin, forwarding the real `x-forwarded-host`. **This
   removes the per-tenant worker redeploy** — the single biggest pain. Tenant resolution moves
   entirely into Next.
2. **DB is the source of truth.** A `client_domains` table (domain = unique PK for reverse lookup) +
   the existing `clients.branding` JSON (extended to hold logo URLs + template names). The operator
   writes these via the console; nothing is compiled into the image.
3. **Resolver reads a cached DB map, registry is the fallback.** The Next server fetches a small
   `GET /v1/tenants/routing` (public, cache-friendly) and builds the domain→slug map at runtime with
   a TTL + explicit invalidation on client create/edit. `resolveSlugFromHostname` keeps its pure
   *logic* but is fed the DB map; if the DB path is unavailable it falls back to `CLIENT_REGISTRY`
   (zero-gap rollout). Same for `resolveClientConfig` → DB branding first, registry fallback.
4. **Deoleo is protected by the `deoleo` slug never changing.** We only move *where the
   `deoleoloyalty.gifsy.in → deoleo` mapping is read from* (code → DB), behind a fallback, verified on
   staging first. No clientId/PK migration, ever.

## 4. Phased build

> Effort = build-days under the orchestration model (parallel sub-agents write code; I run the full
> gate + independent adversarial audit + staging runtime-verify). **Tenant resolution is
> security-critical** — a domain-resolution bug mis-routes a login to the wrong tenant → the audit at
> Phase 6 is mandatory and heavy (treat like a money/auth path).

| Phase | Scope | Days |
|---|---|---|
| **0 — Design lock + schema** | Confirm the GCS-bucket asset decision. Migration: add a **`client_domains`** table (`clientId`, `domain` unique, `isPrimary`) + extend the `branding` JSON contract (logo/wordmark/favicon URLs + WhatsApp template names). Define the `TenantRouting` DTO. | 0.5–1 |
| **1 — Backend: DB source of truth** | **Backfill migration first** — seed `deoleo` (+ `clientb`) domains + branding + templates as the EXACT values the registry holds today (DB becomes a faithful copy before any switch). Extend `CreateClientDto`/`UpdateClientDto` with domains + branding + templates; persist in `gifsy.service` create/update (pairs with the A-ONBOARDING `PATCH` already shipped, #148). Add `GET /v1/tenants/routing` (ACTIVE+ONBOARDING → `[{slug, domains, status}]`, public + cache headers). Domain-uniqueness validation (reject a domain owned by another tenant). GCS asset-upload endpoint → public URL. | 1.5–2 |
| **2 — Resolver + proxy DB-backed (registry fallback)** | Cached DB-backed domain→slug map in the Next server (fetch `/v1/tenants/routing`, TTL + invalidation hook). Feed it into `resolveSlugFromHostname`; registry stays as the fallback behind a flag (`TENANT_ROUTING_SOURCE=db\|registry`). `resolveClientConfig` → DB branding first. Update all consumers: `proxy.ts`, `login/actions.ts`, `lib/auth-actions.ts`, `lib/platform/server.ts`. | 1.5–2 |
| **3 — Edge worker tenant-agnostic** | Rewrite `worker.js` ROUTES + `wrangler.toml` to the coarse `*.gifsy.in` frontend rule (keep API + operator hosts explicit), forwarding the real host. Removes per-hostname redeploy. Manual `wrangler deploy` (owner/human — worker deploy is out-of-band today). Verify a fresh `*.gifsy.in` host reaches Next without a worker edit. | 0.5–1 |
| **4 — Console: full DB provisioning UI** | Onboarding wizard: **domain becomes a real entered field** (replace the 4 slug-derived display spots at `gifsy/clients/new/page.tsx:309,472,494,294`), validated + persisted. Client-detail edit form: branding (colors/display name/support), logo/wordmark/favicon **upload**, WhatsApp template names, domains add/remove. Ties into the A-ONBOARDING `PATCH` endpoint (#148). | 1.5–2 |
| **5 — Cutover source-of-truth + retire registry** | Flip `TENANT_ROUTING_SOURCE=db` on **staging first** → verify `deoleoloyalty.gifsy.in → deoleo` still resolves **and** Deoleo branding still renders → then prod, behind the fallback. After a bake period, retire `CLIENT_REGISTRY` (or keep as an emergency seed). | 0.5–1 |
| **6 — Hardening + E2E + audit + docs** | E2E: a 2nd tenant provisioned **entirely via console/DB** routes + renders; cross-tenant isolation still green; Deoleo unaffected. Independent adversarial audit (tenant-resolution = security-critical: no cross-tenant mis-route, domain-uniqueness enforced, fallback correctness, cache-invalidation races). Full gate. Doc + memory sweep; retire the §A backlog rows. | 1 |
| **Total** | | **~7–9** |

## 5. Non-negotiable invariants (bake into every phase)

1. **Deoleo zero-impact.** `deoleo` slug/clientId never changes. DB backfilled from the registry
   (exact values) as migration step 1. Registry kept as a live fallback during rollout. Every switch
   verified on **staging before prod**. Result: Deoleo keeps its slug, its `deoleoloyalty.gifsy.in`,
   and its branding — only the lookup *source* moves.
2. **No resolution gap.** DB path fails → fall back to registry → fall back to the subdomain
   heuristic. A tenant is never un-routable during rollout.
3. **Domain uniqueness enforced at write time** (DB unique + service validation) — two tenants can
   never claim the same host.
4. **Security audit gates the cutover.** A bug here = a login routed to the wrong tenant. Phase 6
   audit is mandatory; treat like an auth path.
5. **Gates green before every push** (api jest · nest build · FE vitest · tsc) — a red suite silently
   skips the staging deploy.

## 6. Dependencies / prerequisites (already in place)

- **A-ONBOARDING `PATCH /v1/gifsy/clients/:slug` (#148)** — the client update endpoint this plan's
  edit UI writes through. ✅ shipped.
- **Cloudflare `gifsy.in` zone with managed wildcard TLS** — assumed live (Deoleo + operator hosts
  already serve under it). Confirm the wildcard cert covers arbitrary `*.gifsy.in` at Phase 3.
- **GCS bucket for tenant assets** — to be created at Phase 0 (owner-ops for the bucket + IAM if it
  needs new permissions).

## 7. What this deliberately does NOT do

- No external customer domains (`*.theirbrand.com`) → no Cloudflare-for-SaaS. (Future add-on; the DB
  model doesn't preclude it.)
- No tenant self-service — provisioning stays a GIFSY-operator action.
- No change to tenant DATA isolation (already correct — scoped by `clientId` in the JWT).
