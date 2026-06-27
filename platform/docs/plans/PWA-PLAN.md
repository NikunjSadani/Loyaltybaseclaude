# PWA Plan — installable sales + partner apps (per-tenant, with Web Push)

> **Scope (owner, 2026-06-27):** FULL PWA incl. Web Push, **per-tenant icon pipeline now**, for the
> `/sales/*` and `/partner/*` shells ONLY. `/admin/*` and `/gifsy/*` are desktop-operator tools — explicitly
> OUT of scope (no install/icons/push). Supersedes the deferred sketch in `POST-GO-LIVE-BACKLOG.md` §F.
>
> **Precondition MET:** UAT of the sales/partner screens is **done → screens are stable**, so the service
> worker (which must not run over churning UI) is now safe to build. Owner confirmed minor future tweaks are
> expected — handled by the SW update strategy below (content-hashed assets + versioned precache + update prompt).

## Status — Wave 1 DONE (2026-06-27, `185c548`, gate-green + audited + runtime-verified + pushed)
Built + integrated + pushed to `develop` (ships DISABLED): **F1** installable shell (per-tenant
manifests + iOS meta) · **F2** sharp icon pipeline (monogram placeholders for deoleo/clientb/gifsy)
· **F3** Serwist SW (flag-OFF) · **F4** install UX (`InstallPrompt`: Android `beforeinstallprompt`
+ iOS A2HS banner, `NEXT_PUBLIC_PWA_INSTALL_ENABLED` default OFF; `1b8d349`) · **F5 backend**
(PushSubscription + endpoints + sender + drain worker OFF + 3 triggers). Gate: api jest **1191**
(+5 push) · nest 0 · FE vitest **1628** (+4 install) · tsc 0.
Three load-bearing learnings baked in:
1. **Manifest = Route Handler, NOT the metadata-file convention.** `app/sales/manifest.ts` (nested
   `manifest` metadata file) **404s** — that convention is root-only. Use
   `app/<scope>/manifest.webmanifest/route.ts` returning `application/manifest+json`. (Caught at
   runtime; tsc/build would not have.)
2. **🔴 SW cache must be COOKIE-aware, not just header-aware.** The app authenticates server
   navigations via the `token` COOKIE, not an `Authorization` header — so SW rules keyed on
   `/api/*` + the auth header DON'T catch RSC/HTML/`/_next/data`. A naive `defaultCache` would
   NetworkFirst-cache those tenant-rendered responses → cross-tenant leak on shared devices.
   Fix (post-audit): ALL server-rendered responses are **NetworkOnly**; cache only content-hashed
   static + public icons. Re-verify this before EVER flipping the SW flag on.
3. **Next 16 builds with Turbopack by default; Serwist needs webpack.** The `withSerwist` wrap is
   gated on `PWA_SW_BUILD=true` so default builds are untouched. To ship the SW post-cutover: build
   that image with `PWA_SW_BUILD=true` + `next build --webpack` AND set
   `NEXT_PUBLIC_PWA_SW_ENABLED=true` (the two flags are coupled — registering /sw.js needs a build
   that emitted it).

Per-tenant manifests **runtime-verified on the live Deoleo staging edge** (`uat.deoleoloyalty.gifsy.in`:
/sales + /partner manifests 200 with real Deoleo branding + correct scopes; icons 200). **F4 install
UX DONE** (`1b8d349`). Remaining (cutover-coupled): push FE subscribe (E) + apply `push_subscription`
migration to staging (double-guard) + VAPID keys + `PUSH_WORKER_ENABLED=true` → live push send/receive
runtime-verify; the SW ships only when built `PWA_SW_BUILD=true` + `next build --webpack` AND
`NEXT_PUBLIC_PWA_SW_ENABLED=true`. Three runtime enable-flags, all default OFF:
`NEXT_PUBLIC_PWA_SW_ENABLED` (SW register), `PWA_SW_BUILD` (emit /sw.js), `NEXT_PUBLIC_PWA_INSTALL_ENABLED`
(install prompt).

## Grounding (verified infra — see file:line)
- **Tenant resolution:** `platform/src/proxy.ts:40-81` resolves slug from `x-forwarded-host` (Cloudflare Worker)
  and injects `x-tenant-slug` / `x-tenant-color` / `x-tenant-name`. Registry: `lib/platform/client-registry.ts`
  (`CLIENT_REGISTRY`, per-tenant `branding{displayName, primaryColor, logoUrl, faviconUrl, productBrands}`).
- **Meta/theme today:** root `app/layout.tsx` has `generateMetadata()` + static `viewport` + a dynamic
  `theme-color` meta + per-tenant CSS vars (`buildCssVariables` → `--brand-primary`). **No PWA artifact exists.**
- **Layouts:** `/sales` and `/partner` layouts are **client** components (can't export `metadata`). Root layout
  is a server component → the manifest `<link>` + iOS meta go there, gated to /sales+/partner by pathname.
- **Static assets:** proxy excludes `logos/ favicons/ icons/ images/` → served directly; manifest **route
  handlers** (`app/sales/manifest.ts`) are proven-feasible in Next 16.
- **Push integration point:** backend `api/src/notifications/notifications.service.ts` `enqueue()` →
  `NotificationQueue` (channel enum already includes `PUSH`). Delivery worker is unbuilt (P7). Per-tenant
  template IDs exist for `kycApproved` / `payoutGenerated` etc. FE has a toast provider + a (currently mock)
  partner notification panel.

## Hard dependencies (need from owner)
1. **Source logos** — Deoleo (and Gifsy) logo art (SVG/high-res PNG) to generate icon sets. Until provided,
   the pipeline produces a **monogram placeholder** (initials on `primaryColor`) so the app is installable now.
2. **VAPID key scope** — single **platform-wide** VAPID keypair (recommended; per-tenant branding lives in the
   payload, not the key) vs per-tenant keypairs. Drives push subscription + sender design.
3. **Push trigger events + copy** — default set: **points earned · redemption confirmed · KYC approved**
   (optionally payout generated, scheme published). Confirm the set + the message text per event.

## Phases (dependency-ordered)

### F1 — Installable shell  ·  SAFE NOW  ·  ~1–2 days
- Dynamic per-tenant manifest routes `app/sales/manifest.ts` + `app/partner/manifest.ts` (read `x-tenant-slug`
  → name/short_name/`theme_color=primaryColor`/`display:standalone`/scope=`/sales`|`/partner`/icons).
- Root layout: inject `<link rel="manifest">` + iOS meta (`apple-mobile-web-app-*`, `apple-touch-icon`,
  status-bar, safe-area `viewport-fit=cover`) **only** for /sales + /partner (proxy injects `x-pathname`).
- Result: "Add to Home Screen" works on Android + iOS. No service worker yet.

### F2 — Per-tenant icon/splash pipeline  ·  SAFE NOW  ·  ~2–4 days
- Build script (sharp) generates per tenant from the source logo: `icon-192/512/maskable`, `apple-touch-icon-180`,
  iOS splash set, `favicon` → `public/icons/<slug>/`. Run at build + on tenant onboarding (hook the
  `createClient` chokepoint that already provisions outlet-type configs).
- Placeholder monogram generator for tenants without a logo yet.

### F3 — Service worker  ·  BUILD NOW, SHIP DISABLED → activate post-cutover  ·  ~3–5 days
- **Serwist** (next-pwa successor). Strategy: **network-first for navigations/HTML**, **NEVER cache `/api/*`**
  (authed/tenant data = security hazard), versioned precache of the static shell (Next content-hashes assets →
  auto-invalidation), offline fallback page. `skipWaiting` + **"new version available — refresh" prompt** so a
  user is at most one load behind, never stuck.
- Scoped to `/sales` + `/partner`. Registered behind a **runtime enable flag (default OFF)** so it cannot affect
  UAT; flip ON after the develop→main cutover.

### F4 — Install UX  ·  with F3  ·  ~1–2 days
- Android: capture `beforeinstallprompt` → custom "Install app" affordance. iOS: instructional
  "Add to Home Screen" banner (no install API on iOS). Dismiss-state persisted.

### F5 — Web Push  ·  backend + migration (joins cutover batch)  ·  ~1–2 weeks
- New Prisma model `PushSubscription { id, userId, clientId, endpoint, p256dh, auth, userAgent, createdAt }`
  (tenant-scoped) → **migration** (lands with the cutover migration set).
- FE: after install, request notification permission (post-install, not on first load), subscribe, POST the
  subscription; unsubscribe on logout.
- Backend: a Web Push sender consuming `NotificationQueue` rows with `channel:'PUSH'` (VAPID-signed); wire
  triggers at the real event points — wallet credit (points earned), redemption confirm, KYC approve.
- iOS caveat: push works only on **16.4+** AND only for a home-screen-installed PWA (degrade gracefully).

## Sequencing & gating
- **Now (UAT-safe, no cutover dependency):** F1 → F2 → F3(disabled) → F4.
- **Cutover-coupled:** F5's migration joins the develop→main migration batch; the SW enable-flag flips ON
  after cutover once mobile flows are confirmed stable on prod.
- Each phase: build (delegate) → independent audit → full gate (api jest · nest · FE vitest · tsc) →
  runtime-verify (install on a real Android + iOS device / emulator; Lighthouse PWA audit) → push.

## Security notes (load-bearing)
- The SW must **never** cache any authed or tenant-scoped response — multi-tenant + JWT means a cached
  response could leak across tenants/sessions. Network-first for navigations, no-store for `/api/*`.
- Push subscriptions are **tenant + user scoped**; a tenant's sender can only target its own subscriptions.
- Manifest `scope` confined to `/sales`|`/partner` so the installed app can't navigate into admin/gifsy.

## Execution & orchestration (what runs simultaneously)

Five streams; dependency shape:
```
            ┌─ A: FE shell (F1 manifest + iOS meta) ─────────→ F4 install UX
start ──────┤
 (parallel) ├─ B: icon/splash pipeline (F2) ──────────────┐
            ├─ C: service worker (F3, flag-OFF) ───────────┤ (I integrate → root layout)
            └─ D: PUSH BACKEND (F5 model+migration+sender+   │
                  triggers) ─────────────────────────────────┴─→ E: push FE (subscribe)
```

**Wave 1 — 4 streams in parallel (one sub-agent each, no cross-block):**
- **A** (FE): F1 manifest routes + iOS meta — new files; I wire root layout.
- **B** (build): F2 sharp pipeline + onboarding hook + monogram placeholder — new script + `public/icons/<slug>/`.
- **C** (FE): F3 Serwist SW (network-first nav · never-cache `/api` · update prompt) registered behind an **OFF flag** — new SW files; I wire root layout.
- **D** (backend): F5 backend — `PushSubscription` model + migration, VAPID config, `web-push` sender on
  `NotificationQueue`, triggers at wallet-credit / redeem / KYC-approve.

**Contracts fixed up front (so parallel streams don't block):**
1. Icon paths `public/icons/<slug>/icon-{192,512,maskable,180}.png` — A's manifest ⟂ B's pipeline.
2. **Root `app/layout.tsx` + `proxy.ts` integration is the orchestrator's** — A and C deliver components/
   snippets, I merge (the only shared FE file). Avoids parallel-edit conflict.
3. `POST /v1/push/subscribe` request/response shape — D builds endpoint, E builds client, in parallel.

**Wave 2 — after Wave 1 integrated + gated:** A→F4 install UX (needs live manifest) + E push-FE (needs shell +
D's endpoint), two parallel agents.

**Per-wave cadence:** integrate shared files → full gate (api jest · nest · FE vitest · tsc) → INDEPENDENT
adversarial audit (focus: SW never caches authed/tenant data; push sender tenant-scoped) → runtime-verify
(install on real Android + iOS · Lighthouse PWA audit · live push send/receive) → push.

**Cutover-coupled:** D's migration ships with the develop→main migration batch; C's SW enable-flag flips ON
**after** cutover once prod mobile flows are confirmed stable.

**VAPID decision rationale (logged):** key scope is an architecture/ops choice, NOT a perf/benchmark one —
message encryption is per-subscription (RFC 8291) regardless of VAPID scope (RFC 8292); tenant isolation is
enforced by the scoped subscription query, not the key. Recommend **single platform-wide VAPID keypair**
(simpler rotation; per-tenant keys force full re-subscribe on rotation, for no payload-security gain). The real
scale concern is send fan-out (worker concurrency, batching, 410-pruning), handled in F5 independent of keys.

## What we are NOT doing (out of scope this effort)
- No PWA for `/admin` or `/gifsy`. No app-store wrappers (F6 TWA/Capacitor) unless separately requested.
