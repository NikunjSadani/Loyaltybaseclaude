# §A-DOMAIN — Phase 0 design lock (schema + contracts + consumer checklist)

> Created 2026-07-18. Output of the three P0 discovery investigations (edge topology, resolver+branding
> consumer map, backend CRUD+migration mechanics). This is the **design lock** P1–P6 execute against.
> Parent plan: [A-DOMAIN-PLAN.md](./A-DOMAIN-PLAN.md). Tracks task #152. Every claim below is grounded
> in a cited investigation finding.

## 0. What discovery changed vs the original plan

| Finding | Impact on the plan |
|---|---|
| **A GCS integration already exists** (`api/src/storage/storage.service.ts`, `@Global` module, bucket `GCS_BUCKET`=`gifsy-platform-files`, modeled by the KYC upload with magic-byte sniffing + 5 MB cap). | **Removes the Phase-0 blocker.** No new bucket/IAM to stand up. The logo-upload endpoint is a thin addition on `GifsyController` reusing `StorageService` + the KYC upload pattern. |
| **There are TWO backend tenant-config stores**: the `clients` table (edited by the Gifsy console via `gifsy.service`) **and** an `AdminConfig` row `key='client_config'` (read at runtime by `tenant.service.resolveClient`, a *reduced* branding shape). They are not obviously kept in sync. | New **reconciliation decision** (§6, D-1). Recommended: make the `clients` table the single source of truth; new endpoints read it; converge `resolveClient` in a scoped step. |
| **WhatsApp template names are BACKEND, not FE.** The FE registry `notifications.templateIds` is edit/display-only. Live selection: OTP templates are **already DB-backed** (`tenant-settings.service`); WhatsApp KYC/credit/payout templates are an **in-code map** `api/src/notifications/whatsapp-kyc.config.ts` (deoleo-only). | "Move template names to DB" = a **backend** change (migrate `whatsapp-kyc.config.ts` → `clients.notifications`, in-code map as fallback). Folded into P1. Not FE work. |
| **The Deoleo fallback is duplicated in 3 constants and is silent.** `DEFAULT_DEV_SLUG`/`DEFAULT_CLIENT_ID='deoleo'` in `tenant-resolution.ts:19`, `login/actions.ts:20`, `tenant.ts:9`. A DB miss silently serves Deoleo. | New invariant: **fail-closed in prod/staging** on an unknown host (dev keeps the `deoleo` default). §5. |
| **`auth/layout.tsx:21,50` hardcodes the Deoleo wordmark** on the pre-login screen — mis-brands every non-Deoleo tenant. **Favicon is keyed on `config.slug`** (`layout.tsx:72-73`), not `branding.faviconUrl`. | Two concrete branding-render fixes added to P2/P4 (§4, render-path checklist). |

## 1. Storage decision — `client_domains` join table (LOCKED)

House style has **zero array columns** (every list lives inside a `Json` blob) and uses compound/global
`@@unique` + `findFirst`-then-`ConflictException` + a `P2002` race catch. So: a **join table**, global
case-insensitive unique on `domain`. A `text[]` on `Client` has no precedent and can't be uniquely
indexed cleanly.

```
model ClientDomain {                     // @@map("client_domains")
  id        String  @id @default(cuid()) // app-side cuid, like every other PK
  clientId  String                       // = Client.id (the slug); bare, no FK (house convention)
  domain    String                       // full lowercase host, e.g. "deoleoloyalty.gifsy.in"
  isPrimary Boolean @default(false)       // the tenant's canonical/display domain
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([clientId])
  // global case-insensitive uniqueness is a LOWER(domain) expression index —
  // hand-added in the migration SQL (Prisma can't model it), per MIGRATIONS.md
}
```

## 2. Asset hosting decision — reuse existing GCS (LOCKED)

- Logo/wordmark/favicon upload → `POST /v1/gifsy/clients/:slug/logo` (and `/wordmark-white`,
  `/wordmark-color`, `/favicon`), GIFSY_ADMIN-guarded, `FileInterceptor('file')`, reusing
  `StorageService.uploadFile` with a `branding/<slug>` key prefix + the KYC magic-byte sniff + size cap.
- The returned public GCS URL is written into the `clients.branding` JSON (`logoUrl`,
  `wordmarkWhiteUrl`, `wordmarkColorUrl`, `faviconUrl`).
- Replaces the committed static files under `platform/public/brand/`. **Favicon + PWA icons must switch
  from the `/icons/<slug>/…` build-generated paths to the DB URLs** (else a new DB-provisioned tenant
  has no generated icons) — tracked in the render-path checklist (§4).

## 3. Branding-JSON contract (the `clients.branding` blob — canonical shape)

The column already exists and already holds most of this; `createClient`/`updateClient` just don't
*write* the asset fields yet. Contract P1 must persist + P4 must edit:

| Field | Type | Rendered today? | Source after refactor |
|---|---|---|---|
| `displayName` | string | ✅ everywhere (title, headers, PWA) | DB |
| `primaryColor` | string (hex, sanitized) | ✅ CSS vars + theme-color + PWA | DB (AF-9 sanitizer already DB-ready) |
| `logoUrl` | string (GCS URL) | ❌ contract-only today | DB (uploaded) |
| `wordmarkWhiteUrl` | string (GCS URL) | ✅ sales header, partner sidebar | DB (uploaded) |
| `wordmarkColorUrl` | string (GCS URL) | ✅ partner mobile header | DB (uploaded) |
| `faviconUrl` | string (GCS URL) | ⚠️ NOT wired (favicon uses `slug`) | DB (uploaded) — **and wire it** |
| `supportEmail` / `supportPhone` | string | ❌ editor-only | DB |
| `productBrands` | string[] | ❌ editor-only | DB |

`notifications.templateIds` (schemePublished, enrollmentConfirm, otpVerification, kycApproved,
kycRejected, payoutGenerated) already exists in the `clients.notifications` blob — P1 persists it there
and swaps the backend `whatsapp-kyc.config.ts` reader to it (in-code map as fallback).

## 4. Consumer + render-path checklist (what P2/P4 must switch — nothing else)

**Resolution consumers (feed these the DB map, registry as fallback):**
1. `tenant-resolution.ts:45-49` `DOMAIN_TO_SLUG` — **the root**; compiled from the registry today.
2. `tenant-resolution.ts:64-100` `resolveSlugFromHostname` (pure/sync) + `:106-109` `resolveClientConfig`.
3. `proxy.ts:58,65` (Next edge, every request) · `auth/login/actions.ts:45,80` (both OTP actions) ·
   `lib/auth-actions.ts:140` (assumed-brand banner) · `lib/platform/server.ts:32` (SSR config entry).
4. `lib/tenant.ts:16-22` reads `x-tenant-slug` (trusts the proxy — unaffected, but its silent Deoleo
   fallback becomes fail-closed).
5. `client-config-context.tsx:22` context default = `DEOLEO_CONFIG` (fine as a client-side default).
6. `scripts/generate-pwa-icons.ts:51` enumerates the registry (build-time) — replace with DB or
   provision-time icon generation.
7. **`cloudflare-worker/worker.js` `ROUTES`/`TENANT_HOST_ALIAS`** — the second hardcoded host layer;
   P3 makes it tenant-agnostic (separate from the DB map).

**Branding render sites (switch to the DB-resolved config):**
- `layout.tsx:23-29,48,67-68,72-73` (title, brand CSS, theme-color, favicon — **rewire favicon to
  `branding.faviconUrl`**).
- `sales/layout.tsx:73-79` (wordmark-white), `partner/layout.tsx:101-102,116-124` (sidebar + mobile
  wordmark), `sidebar.tsx:51-53`, `admin/layout.tsx:231`, `admin/users/page.tsx:252`.
- **`auth/layout.tsx:21,50` — replace the hardcoded Deoleo wordmark** with the SSR-resolved tenant
  wordmark (highest multi-tenant risk; it's a public pre-login route → branding must come via
  `getTenantConfig()`).
- PWA: `PwaHead.tsx`, `sales|partner/manifest.webmanifest/route.ts`, `lib/pwa/manifest.ts` — icon paths
  move from `/icons/<slug>/` to DB URLs (or provision-time generation).
- Dead-header check: `proxy.ts:87-88` sets `x-tenant-color`/`x-tenant-name` with **no reader found** —
  confirm dead and drop, or wire.

## 5. Resolver cache contract (P2 detail, locked here)

`resolveSlugFromHostname` is pure/sync and runs at the Next edge → it can't do I/O inline. Design:
- New `platform/src/lib/platform/tenant-routing-cache.ts`: fetches `GET /v1/tenants/routing`, holds
  `{ domainToSlug, slugToBranding, fetchedAt }`, **TTL ~60s** + an `invalidate()` the client
  create/edit server actions call to bust it immediately.
- **Fallback ladder (zero-gap rollout):** DB cache hit → else `CLIENT_REGISTRY` (during rollout) → else
  subdomain heuristic → else **fail-closed** (404/platform home) in prod/staging; **dev keeps the
  `deoleo` default**. After the registry is retired (P5), the ladder is DB → heuristic → fail-closed.
- Flag `TENANT_ROUTING_SOURCE=db|registry` gates which is authoritative (instant rollback).

## 6. `GET /v1/tenants/routing` — the public routing endpoint (contract)

Public (the proxy needs it pre-auth), cache-friendly (`Cache-Control`), returns **only** ACTIVE +
ONBOARDING tenants and **only** public fields (no features/invoicing/notifications/secrets):

```jsonc
{ "tenants": [
  { "slug": "deoleo", "status": "ACTIVE",
    "domains": ["deoleoloyalty.gifsy.in", "deoleo.gifsy.in"],
    "branding": { "displayName": "Deoleo India", "primaryColor": "#16a34a",
                  "logoUrl": "...", "wordmarkWhiteUrl": "...", "wordmarkColorUrl": "...", "faviconUrl": "..." } }
] }
```
Everything here is already public (visible in the served pages) → no new exposure. Reads the **`clients`
table** (the console-canonical store).

### D-1 — the two config stores — CONVERGENCE DEFERRED (post-audit decision, 2026-07-18)
`tenant.service.resolveClient` reads `AdminConfig[key='client_config']` (reduced branding + a *runtime*
feature vocabulary: `loyalty/visibility/leaderboard/schemes/…`), while the console edits the `clients`
table (a *different*, console feature vocabulary: `visibilityInvoiceModule/kycApprovalFlow/…/rbacEnforcement`).
Owner initially chose to converge onto `clients` (D-1). It was **built, then reverted** after the P1
adversarial audit found converging is riskier than represented:
- **Two different feature vocabularies.** `permission.guard` reads `features.rbacEnforcement` off the
  resolved config; switching the runtime read to `clients.features` touches RBAC enforcement on the
  **live** Deoleo tenant, and green specs masked the divergence (hand-shaped mocks).
- **A-DOMAIN does not need it.** FE SSR branding will read the new public `/tenants/routing` endpoint,
  not `resolveClient` (which is backend-internal). So the convergence is orthogonal to A-DOMAIN.
- The convergence also introduced a stale-cache window (a deactivated tenant serving up to 5 min) and
  an ONBOARDING→403 semantic change.

**Decision:** keep `resolveClient` on `AdminConfig` for now (zero behavior change to the live RBAC path);
do the store-convergence as its **own task** with a real-DB read of Deoleo's `clients.features` vs the
`AdminConfig` blob + runtime verification + cache-invalidation wiring. Tracked as task #159. This keeps
P1 clean and does not touch the live tenant-resolution/RBAC path.

### P1 audit outcomes (2026-07-18)
Independent adversarial audit ran on the full P1 diff. **No cross-tenant leak or injection** — domain
uniqueness/TOCTOU, validation-bypass, the public endpoint whitelist, and upload magic-byte safety all
verified clean. Fixed before landing: **M4** (reserved-slug set now ⊇ reserved-domain labels — clean
409 for a `status`/`mail`/`uat` slug), **M5** (empty-domains PATCH re-injects the canonical → a tenant
is never left unroutable), **L6** (5 MB cap enforced at the multer boundary), **L7** (an explicitly
supplied branded domain becomes primary, matching the Deoleo backfill). Deferred with a note: **L8**
(branding assets are written as public `storage.googleapis.com` URLs but the KYC bucket is private →
logos won't render until the branding objects are public-read / served via a public prefix — an
infra/ACL decision to resolve in **P4** when the upload UI is wired) and **L9** (pre-existing
read-modify-write race on the JSON blob under concurrent admin PATCH — low, admin-only).

## 7. Migration SQL (for owner approval before it lands)

Additive, forward-only, no downtime — nothing reads the table until the P2 resolver ships. Applied the
house way: a new `api/prisma/migrations/20260718120000_add_client_domains/migration.sql`, run by
`prisma migrate deploy` via the in-VPC Cloud Run job (staging auto on `develop`, prod gated).

```sql
-- Additive: DB-driven tenant domain→slug routing. Backfills current registry
-- domains so the DB is a faithful copy before any resolver switch. Deoleo zero-impact.

CREATE TABLE "client_domains" (
    "id"        TEXT NOT NULL,
    "clientId"  TEXT NOT NULL,
    "domain"    TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_domains_pkey" PRIMARY KEY ("id")
);

-- Global, case-insensitive uniqueness: a domain maps to exactly ONE tenant platform-wide.
CREATE UNIQUE INDEX "client_domains_domain_lower_key" ON "client_domains" (LOWER("domain"));
CREATE INDEX "client_domains_clientId_idx" ON "client_domains" ("clientId");

-- Backfill 1: Deoleo's branded domain (exactly what CLIENT_REGISTRY.deoleo.domains holds today) → primary.
INSERT INTO "client_domains" ("id","clientId","domain","isPrimary","createdAt","updatedAt")
SELECT gen_random_uuid()::text, 'deoleo', 'deoleoloyalty.gifsy.in', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "clients" WHERE "id" = 'deoleo')
  AND NOT EXISTS (SELECT 1 FROM "client_domains" WHERE LOWER("domain") = 'deoleoloyalty.gifsy.in');

-- Backfill 2: every tenant's canonical <slug>.gifsy.in subdomain (so the DB map is complete and the
-- subdomain heuristic can be retired). Non-primary if the tenant already has a primary; else primary.
INSERT INTO "client_domains" ("id","clientId","domain","isPrimary","createdAt","updatedAt")
SELECT gen_random_uuid()::text, c."id", c."id" || '.gifsy.in',
       NOT EXISTS (SELECT 1 FROM "client_domains" d2 WHERE d2."clientId" = c."id" AND d2."isPrimary"),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "clients" c
WHERE NOT EXISTS (
  SELECT 1 FROM "client_domains" d WHERE LOWER(d."domain") = LOWER(c."id" || '.gifsy.in')
);
```
*(`gen_random_uuid()` is core in Postgres 13+; Cloud SQL is ≥14. App-side inserts use cuid — the
backfill only seeds pre-existing rows.)* The Prisma `schema.prisma` model (§1) is added in the same
migration commit; the `LOWER()` unique index stays as raw SQL (Prisma can't model it).

## 8. Sequencing (from the edge investigation)

The coarse `*.gifsy.in` edge rule (P3) sends previously-unknown hosts to the frontend, where resolution
must already work → **P2's DB resolver must ship in the frontend image before/with P3.** Plain
`<slug>.gifsy.in` hosts already resolve via the subdomain heuristic, so only branded domains depend on
P2. Worker deploy is a **manual out-of-band owner step** (`npx wrangler deploy` + dashboard DNS/cert),
not gated by CI.

### Needs a Cloudflare-dashboard confirmation before P3 (owner/ops)
1. A **proxied `*.gifsy.in` wildcard DNS record** exists (else a new tenant host still needs a per-host
   DNS record — the wildcard *route* has nothing to receive).
2. The edge **TLS cert covers arbitrary `*.gifsy.in`** (Universal SSL wildcard vs the per-host certs
   `custom_domain=true` created).
3. A wildcard **`*.gifsy.in/*` Worker route** is permitted on the zone/plan.
