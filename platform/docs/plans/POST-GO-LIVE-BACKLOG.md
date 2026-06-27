# Post-Go-Live Backlog — deferred / fast-follow work (after Deoleo is live)

> Created 2026-06-20. **This is the complement of [`GO-LIVE-READINESS.md`](GO-LIVE-READINESS.md):** that doc lists what
> must be ✅ **before** launch; this one lists what we deliberately deferred to **after** Deoleo is live, so the go-live
> timeline stays clean and nothing gets lost. Each item: why it's safe to defer, the **trigger** (when it becomes
> needed), rough effort, and the source reference. Owner-owned priority. Nothing here blocks the Deoleo launch.

> ⚠️ **Go-live blockers do NOT belong here** — those live in `GO-LIVE-READINESS.md` §3. If an item is actually required
> for Deoleo to launch, move it there. When in doubt, ask: "can Deoleo run for its first weeks without this?" If yes → here.

---

## A. Before the 2ND real client onboards (tenant/provisioning)

These are invisible while Deoleo is the only real tenant; they matter when a second paying client arrives.

| Item | Why deferred / current state | Trigger | Effort | Ref |
|---|---|---|---|---|
| **Multi-tenant SSR branding** — subdomain → per-tenant logo/colors/title. **Today every tenant's *visual shell* defaults to Deoleo** (no middleware resolves the subdomain, so the tenant-config lookup never fires). **Tenant DATA is already correctly isolated** — only the cosmetic branding defaults to Deoleo. **NOTE:** the *login* tenant resolution (domain → clientId, e.g. `deoleoloyalty.gifsy.in` → `deoleo`) **is already DONE** (`5de8aa9`, via `CLIENT_REGISTRY.domains`); this item is the **SSR-branding** half (logo/colors/title by tenant), which additionally needs a wired `middleware.ts` + the per-tenant config read. | Deferred from **D2** (A1 decision 2026-06-20): building it in D2 would bolt a feature onto a retirement. It's **additive, not a refactor** — no migration, no backfill; the `clients` table already holds per-tenant config. Deferring does NOT make it harder later. | **Before client #2 goes live** (else they'd see "Deoleo" in their browser tab/theme — cosmetic, not a data risk) | ~3–5 days | D2 plan §3-A; `architecture-backend-split` |
| **Configurable RBAC + custom sub-roles + provisioning chain** — admin portal where heads define custom sub-roles; bootstrap super-admin → tenant admins → sub-users. RBAC engine exists but is OFF; roles are a fixed enum today. | Current client needs none; launch uses fixed `@Roles` + the coverage audit (A4). | When a tenant needs custom roles, OR at client #2 onboarding (provisioning flow) | medium | #47; `RBAC-ENABLEMENT.md` |

## B. First weeks post-launch (security / correctness fast-follows)

| Item | Why deferred / current state | Trigger | Effort | Ref |
|---|---|---|---|---|
| **Per-user backend logout** (revoke the caller's session server-side). Today logout is **stateless** (owner decision B1, 2026-06-20): FE clears the token; the access token stays valid until it expires (a few hours) even after logout. | Acceptable for a loyalty app; matches current behavior. Admin `POST /v1/admin/force-logout-all` already exists for break-glass. | Fast-follow if the "token-valid-until-expiry" window is deemed too long | small | #32; D2 plan §3-B |
| **`force-logout-all` break-glass admin UI** — the backend route exists but no FE calls it. | Not needed for launch. | When ops wants a one-click "log everyone out" | small | #32 |
| **Systemic tenant isolation (DB-level RLS / Postgres policy)** — today isolation is app-layer (`TenantGuard` + `clientId` scoping, harness-verified). RLS is defense-in-depth. | App-layer scoping is proven by the cross-tenant harness tests; RLS is belt-and-suspenders. | Hardening pass; before high-sensitivity scale | medium | #23; P8.6 |
| **Real staging/prod OTP path** — staging currently runs the E2E harness on `FIXED_OTP`; the real-MSG91 read-back hook is unbuilt. | Interim decision (C2, 2026-06-20). Real MSG91 OTP for **prod login** is a **launch blocker** (→ GO-LIVE-READINESS), but the **test read-back endpoint** for staging E2E is deferred. | When staging must be a true E2E gate | small | C2; P8.7 |

## C. When scale / usage demands (perf & ops)

| Item | Why deferred | Trigger | Ref |
|---|---|---|---|
| **Pagination on all tenant-scoped list endpoints** | Fine at launch data volumes | When any tenant's lists grow large | #26; P8.3 |
| **Observability baseline** (structured logs, metrics, tracing) | Not blocking a controlled launch | Before/with broader rollout | #27; P8.4 |
| **Notification engine / worker** (templates, queue, delivery — banners, leaderboard, ticket SLA/escalation) on MSG91; WhatsApp delivery | P7 scope; OTP works for launch | As engagement features go live | #21; P7 |

## D. Compliance / finance (when required)

| Item | Why deferred | Trigger | Ref |
|---|---|---|---|
| **Invoice PDF / email generation** | Invoices generate + export to Excel today; PDF/email is additive | When clients want emailed PDF invoices | P6 deferred |
| **TDS Form-16A / 26Q filing** | The platform computes + tracks + exports TDS; filing is off-platform (TRACES) | When automated filing is wanted (future TRACES/3rd-party API) | P6.5 / #25 |
| **DPDP retention / erasure policy + implementation** | Compliance hardening | Per the DPDP compliance timeline | #24; P8.5 |
| **Points holding / lock period** (schema fields already exist: `lockedUntil`/`lockedPoints`/`LOCK_HOLDING`) | Not needed for launch; ~½-day, no migration | If a scheme needs a holding window | P5 deferred |

## E. Analytics / reporting (P8)

| Item | Why deferred | Ref |
|---|---|---|
| **Admin dashboard trend analytics** — MoM/YoY deltas, Growth Trends, Top Territories, Scheme Activity, Billing-by-class. Removed as fabricated demo chrome in **D1**; the real KPI cards stay. | Needs time-series aggregation endpoints we don't build yet | #48; D1 |
| **Configurable + scheduled reports, exports** | P8 scope | P8.2 |

## F. Tech-debt / cleanup (opportunistic)

| Item | Why deferred | Ref |
|---|---|---|
| **D1 residuals** — admin header notifications dropdown (fabricated "14 KYC pending…"); partner `DemoSwitcher` + `lib/partner-session` demo personas (touch identity wiring → dedicated follow-up); the GIFSY cross-tenant KYC **brand column** (A1 polish); small display bugs (admin/approvals "Invalid Date", sales/catalogue "1 Issue"). | Left out of D1's admin-dashboard scope; partner shell needs careful identity rework | #45; D1 report |
| **Legacy-lib demo retirement** — `lib/targets`/`gifts`/`partner-session`/`redemption-store` (Prisma-free; not D2's scope) | Retire as each consuming page gets real backend wiring | D2 plan §8 |
| **`GIFT_CATALOGUE` cosmetic reliance** (emoji/gradient defaults in sales catalogue) | Cosmetic; real catalog data is wired | D1 |
| **target-config / banner JSON-blob normalization** | Works as blobs today | #18 residual |

---

## How to use this doc
- When something is deferred during a build, **add a row here** (with trigger + ref) instead of letting it live only in a
  commit message or a gap-register cell.
- At launch planning, scan section **A + B** first — those are the soonest-needed.
- Anything that turns out to be a launch blocker → promote it to `GO-LIVE-READINESS.md` §3.

## GIFSY settings page — wire the read-only sections (deferred, owner 2026-06-23)

The GIFSY operator settings page (`platform/src/app/gifsy/settings/page.tsx`) has four sections
now shown **read-only** (disabled inputs, no fake Save) so nothing pretends to persist:
**Platform Identity** (name/domain/support email), **Security** (JWT expiry / OTP expiry / max
OTP attempts), **Notifications** (alert email / SLA hours), **Data Retention** (audit / queue days).
The real **Redemption Thresholds** section on the same page is unaffected (it persists + is enforced).

Pick up per-field as needed — effort is very uneven because several have NO backend consumer yet:
- **Enforceable with moderate work** (read the setting at the enforcement point + audit): OTP expiry
  (`auth.service.ts:121`, hardcoded `10*60*1000`), max OTP attempts (`auth.service.ts:134`, hardcoded
  `3`), JWT expiry (`auth.module.ts:19`, boot-time env), support email / platform name (display only).
- **Need NET-NEW subsystems before they can be "real"** (do NOT just store them — that re-creates the
  fake-setting problem): alert email (no alerting pipeline), SLA breach threshold (no SLA engine
  consumes `slaTargetHours`), audit/queue retention (no scheduled purge job — touches data deletion).

Also deferred from the same audit: the credit-upload-window FE check
(`admin/credits-payouts/upload/page.tsx:46` `isUploadWindowOpen`) blocks any-period-after-cutoff
while the backend (`credits.service.ts:77`) blocks only prior-month. Cosmetic today (the page only
uploads the previous month, and the BACKEND enforces correctly); make the FE check period-aware if
the period selector ever allows the current month.

---

## F. PWA — installable mobile app for the SALES + OUTLET (partner) apps only

> **🟢 NOW ACTIVE (owner approved 2026-06-27) — promoted out of "deferred".** Full per-tenant PWA incl. Web Push.
> The canonical, dependency-ordered build + orchestration plan is **[`PWA-PLAN.md`](PWA-PLAN.md)** — read that, not
> this sketch, for execution. Decisions locked: **per-tenant icon pipeline now** · **single platform-wide VAPID
> keypair** · owner supplies Deoleo+Gifsy logo art (monogram placeholders meanwhile) · service worker shipped
> **flag-OFF** + push migration **joins the cutover batch** (both activate AFTER the develop→main cutover). Precondition
> met: sales/partner UAT is done → screens stable → service worker safe. The phase table below remains accurate context.

**Scope: the `/sales/*` and `/partner/*` shells ONLY** (owner decision 2026-06-26). The `/admin/*` and
`/gifsy/*` consoles are desktop-operator tools and are explicitly OUT of scope — no PWA/install/icons for them.

**Current state (2026-06-26):** the FE (Next.js 16) is a responsive, mobile-first web app with dedicated
`partner` + `sales` layouts, a dynamic `theme-color`, and a `Viewport` export — but it is **NOT a PWA**:
no web manifest, no icon set, no service worker, no install prompt, no push. Per-tenant branding already
exists (`config.branding`), so a per-tenant manifest/icons fit that pattern cleanly. **Multi-tenant +
branded domains means every tenant needs its own app name + icon set + (push) config** — adds ~30–50%
over a single-brand PWA.

**Why it's safe to defer:** the sales + outlet apps already work in the mobile browser today (incl.
camera-based KYC capture). A PWA is a distribution/UX/re-engagement enhancement, not a launch blocker.

**⚠️ Do NOT build the service worker while the sales/partner screens are still churning** — a SW over a
rapidly-changing UI creates stale-asset / cache-busting bugs. The SW wants a STABLE front end.

| Phase | What | Trigger | Effort |
|---|---|---|---|
| **F1 — Installable shell (low risk, can do anytime)** | Per-tenant `manifest.webmanifest` (name/short_name/icons 192·512·maskable/colors/`display:standalone`/scope=`/sales`+`/partner`) + iOS meta tags + apple-touch icons. **No service worker** (nothing to go stale). Makes it "Add to Home Screen"-able on Android + iOS. | Optional pre-launch quick win, or anytime | **~1–2 days** |
| **F2 — Per-tenant icon/splash pipeline** | Generate each tenant's icon set (+ iOS static splash images) from their logo, ideally at tenant onboarding. | Before client #2, or with F1 | +2–4 days |
| **F3 — Service worker** | Serwist (`next-pwa` successor). Precache the app shell, **network-first for `/api/*`, NEVER cache authed/tenant-scoped responses** (multi-tenant + JWT = caching is a security hazard), offline fallback. | After Deoleo live AND sales/partner mobile flows are STABLE (low churn) | ~3–5 days |
| **F4 — Install UX** | `beforeinstallprompt` custom prompt on Android; instructional banner on iOS (no install API there). | With F3 | ~1–2 days |
| **F5 — Web Push notifications** (the real ROI) | VAPID + backend push service + **per-tenant** subscription storage + send triggers (points earned / redeem / KYC approved). **iOS: 16.4+ and ONLY for home-screen-installed PWAs.** | When re-engagement is a priority (usually the actual reason to do a PWA for a loyalty app) | +1–2 weeks |
| **F6 — Store presence (optional)** | Android Play Store via TWA/Bubblewrap (~2–4 days + Play Console review). iOS App Store via a wrapper (Capacitor/PWABuilder) — +1–2 weeks + Apple review risk for "website wrapper". | If an app-store listing is wanted | varies |

**Rollups:** basic installable PWA (F1+F3+F4) ≈ **1–2 weeks**; full PWA with push (F1–F5) ≈ **4–6 weeks**.

**iOS reality check:** Android PWAs are first-class (install prompt, push, Play Store wrappable). iOS is
limited — install is Safari "Add to Home Screen" only (no prompt), push needs iOS 16.4+ AND a home-screen
install, plus storage-eviction / no-background-sync constraints.

**Recommended sequencing:** F1 (+optionally F2) is a cheap, low-risk win that can slot in anytime; F3–F5
(the heavy part) is a focused **post-go-live** project once the sales/partner mobile UI has settled and
re-engagement (push) becomes a priority. **Right trigger = Deoleo live + mobile flows stable + a concrete
push-notification need.**
