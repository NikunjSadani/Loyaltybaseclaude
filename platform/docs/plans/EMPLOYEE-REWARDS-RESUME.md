# Employee Rewards — RESUME (post-compact restart brief)

> **Read this first for any employee-rewards build work** (the employee-rewards equivalent of
> [`RESUME.md`](./RESUME.md), which is the *trade* restart brief). Keep it current every wave.
> This is **state**; the authoritative *how/what* live in the doc set below.

## Current state (2026-10-03)
- **PHASE 0 CODE DONE + LOCAL RUNTIME-VERIFIED (harness-limited) — STAGING DEPLOY HELD BY OWNER.** The
  capability-gated admin shell is scaffolded, **FULL-GATE GREEN**, **independently audited (PASS-WITH-NOTES)**, and
  **local runtime-verified** on the isolated worktree `../Loyaltybaseclaude-er` (branch `er/phase0-shell`,
  HEAD `1c0139b`) — committed **local only, NOT pushed**, isolated from the trade work.
- **Local verify result (see Wave log for detail):** the enabler really writes `loyaltyType=EMPLOYEE_REWARDS`
  (DB-confirmed), and real OTP-login-per-role returns the correct per-tenant `capabilities` from the live config
  endpoint (Deoleo=OUTLET/trade, Britannia=EMPLOYEE/cockpit) — the exact `selectAdminNav` input. Deoleo's trade shell
  renders in the browser; the Britannia **cockpit screenshot is the one thing the local browser pane can't show**
  (it blocks cookies for `*.localhost`, so the FE's client-side config XHR 401s → TRADE fallback). Not a product
  defect (proven server-side + unit tests); it's naturally captured on the planned **staging** verify.
- ⏸️ **Owner HELD the staging deploy (2026-10-03).** Do **NOT** push `er/phase0-shell`→`develop` — `develop`
  carries ~20 unpushed commits including the **held trade Points Compute Engine Waves 1–3**, so a push would
  deploy those too. No `uat-britannia` tenant / staging runtime-verify until the owner re-opens the staging
  cadence.
- ▶ **To resume:** owner GO on staging → push + staging `uat-britannia` tenant → runtime-verify (Deoleo nav
  unchanged + Britannia employee cockpit) → then **Phase A** (BUILD-PLAN §5). The worktree + lane branch
  persist; nothing is lost.
- **Foundation is LIVE in prod** (cutover #35, dormant): `Client.loyaltyType` + unified `RewardAccount`
  (OUTLET|EMPLOYEE) + dual-write + back-fill. Deoleo byte-identical. See [[employee-rewards-product]].
- **This is a SECOND product on the same platform/repo** — inherits Loyaltybase's engineering process
  in full, curates out trade product rules, adds the employee gate (see WAYS-OF-WORKING).

## The doc set (source of truth)
1. [`EMPLOYEE-REWARDS-DESIGN.md`](./EMPLOYEE-REWARDS-DESIGN.md) — earner model, `loyaltyType`, three surfaces.
2. [`EMPLOYEE-REWARDS-ADMIN-DESIGN.md`](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md) — the admin cockpit, module-by-module.
3. [`EMPLOYEE-REWARDS-BUILD-PLAN.md`](./EMPLOYEE-REWARDS-BUILD-PLAN.md) — execution, branching, safety gates, go-live, timeline.
4. [`EMPLOYEE-REWARDS-WAYS-OF-WORKING.md`](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md) — process/rules (inherit/adapt/exclude).
5. [`EMPLOYEE-REWARDS-UAT-CHECKLIST.md`](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) — curated go-live acceptance.
6. Visual/UX target: `britannia-rewards-demo` (`docs/PROJECT-LOG.md`).

## Locked decisions (owner, 2026-10-02) — do not re-litigate
1. **Points crediting = BULK UPLOAD, NO compute engine** (reuse the no-compute credit-batch, keyed by
   `employeeCode` → `EMPLOYEE` RewardAccount). ⚠️ **NOT** the trade "Points Compute Engine" on `develop`.
2. **Target column = INCLUDE** (uploaded, display-only → achievement/"Potential").
3. **Roster = REUSE** the existing employee-hierarchy Excel upload + per-employee edit (`api/src/admin-core`).
4. **Admin operator = BOTH** (Gifsy central + Britannia scoped self-serve).
5. **Regional admin = REUSE** the existing `/sales/**` hierarchy scoping (subtree = `descendantSalesUserIds`).
6. **Field execution (POSM) = OUT** of pilot; opt-in later.

## ⚠️ Traps / rules specific to this build
- **Build in a dedicated git worktree** off `develop`, isolated from the **active trade Points Compute
  Engine** work (its own worktrees + uncommitted WIP live in the primary checkout — do NOT disturb them).
- **Additive + gated** only: everything behind the `loyaltyType` gate; migrations additive + backward-compatible.
- **DUAL audit** the credit/upload money boundary + redemption.
- **Cross-tenant isolation (Deoleo↔Britannia)** + a **Deoleo staging regression** are cutover gates.
- **Doc-consistency:** do NOT add "compute engine" to the global `RETIRED_TERMS` (it's live for trade) —
  annotate locally (WAYS-OF-WORKING §7).
- Gates (full, before every push): `cd api && npx jest --no-coverage` · `cd api && npx nest build` ·
  `cd platform && npx vitest run` · `cd platform && npx tsc --noEmit`.

## Open spec items (surfaced by the 2026-10-03 doc audit — specify before the named phase)
- **Phase 2 — EMPLOYEE owner-generalisation (NET-NEW, not reuse):** the `RewardAccount → SalesUser` profile
  relation does **not** exist in schema yet (`RewardAccount` has only `outletProfile ChannelPartner?`), and
  `ensureOutletAccount` is **OUTLET-only** today. Build the EMPLOYEE account keying + profile link + the
  "exactly one profile per `accountType`" DB constraint (the DESIGN §5.2 invariant is unenforceable until
  then). Grep **all ~7 `resolveActivePartnerId` consumers** (wallet, rewards, partner, schemes,
  scheme-enrollment, invoices, leaderboard) before landing.
- **Phase 2 — employee login identity:** `employeeCode` is the identity key, but how a roster employee
  acquires a **phone** for the (reused) phone-OTP login, and how `employeeCode ↔ phone` map, is not yet
  specified. One explicit line of design needed before Phase 2.
- **Phase C — contest bonus auto-credit:** the "validation rule → credits bonus" path is the vaguest
  money-adjacent spec (only "reframes scheme/campaign"). Give it a concrete data-model + validation spec
  before building (already flagged DUAL-audit).

## Next action (on owner GO)
Phase 0 (BUILD-PLAN §5): create the worktree + first `er/*` lane branch → scaffold the capability-gated
shell + `loyaltyType` flags → stand up the staging `uat-britannia` tenant (empty employee nav; Deoleo
nav unchanged). In parallel, the owner pre-stages external deps (DLT templates, Britannia roster + point
credits + catalogue, pilot vendors).

## Wave log (append as the build progresses)
- **Phase 0 — capability-gated admin shell** (2026-10-03, `er/phase0-shell`, FULL-GATE GREEN):
  - BE: `getTenantConfig` (admin-core) now returns the resolved `capabilities` (reuses `resolveCapabilities`,
    additive + fail-safe to TRADE). `api jest` 3456 ✓, `nest build` ✓.
  - FE: `lib/tenant-features.ts` surfaces `capabilities`; **new `lib/admin-nav.ts`** = the trade nav (moved
    verbatim) + the employee cockpit skeleton + a pure, unit-tested `selectAdminNav` (picks the world by
    `earnerModel`); `app/admin/layout.tsx` wired to it; 8 employee stub pages. `platform tsc` ✓, `vitest`
    2595 ✓ (incl. `admin-nav.test.ts` 5 ✓; fixed 2 source-read tests that moved with the nav).
  - TRADE output is byte-identical (same tree, same gates); EMPLOYEE flips to the cockpit.
  - **Independent audit (opus) = PASS-WITH-NOTES** — nav move verified faithful item-by-item (all 29 items +
    flags + children), fail-safe confirmed BE+FE, BE query tenant-scoped (`Client.id == slug`). FIXED: 2
    stale nav refs (`route-permissions.ts` comment + POINTS doc). **Accepted minors (tracked, not blocking):**
    (a) EMPLOYEE admins briefly flash the TRADE nav before the config endpoint resolves — cosmetic, safe
    direction (toward MORE compliance; reverse impossible), inherent to the client-side config model, mirrors
    the existing features-default; (b) `getTenantConfig` does one extra uncached `client.findUnique` for
    `loyaltyType` (micro-perf; cleaner once `loyaltyType` is exposed on the cached ClientConfig); (c) employee
    stub routes are capability-ungated (direct-URL reachable; harmless stubs — real route guards land with the
    real pages in Phase A+). Residual: a `gen_doc.js` help string (trade tooling) still says `ALL_NAV_ITEMS`.
    Sibling shells (partner/sales/vendor) not yet capability-gated — consistent with Phase 0 scope, tracked.
  - **Tenant-create enabler** (2026-10-03, `er/phase0-shell`): wired `loyaltyType` into
    `POST /v1/gifsy/clients` (`CreateClientDto` + `gifsy.createClient`, additive — default stays TRADE, set
    only when `EMPLOYEE_REWARDS`; TDD both cases). So `uat-britannia` can be onboarded as an EMPLOYEE tenant
    via a **clean authenticated API call — no raw DB write ever**, once staging un-holds. `nest build` ✓,
    `api jest` 3458 ✓ (BE-only; FE unaffected).
  - **LOCAL RUNTIME-VERIFY** (2026-10-03, dev DB `gifsy_dev` via Cloud SQL Auth Proxy; api :4001 + platform :3001,
    isolated from the primary trade stack on :4000/:3000). Dev commit `1c0139b` adds a DEV-ONLY
    `allowedDevOrigins` (`*.localhost`/`*.app.localhost`) so local per-tenant subdomains hydrate (ignored in prod).
    **PROVEN end-to-end against the real running server + real DB:**
    - **Enabler works for real:** `POST /v1/gifsy/clients {loyaltyType:'EMPLOYEE_REWARDS'}` (GIFSY_ADMIN OTP login)
      → HTTP 201, and the **DB row `britannia.loyaltyType == EMPLOYEE_REWARDS`** (verified directly). A clean
      authenticated API call — no raw DB write. (Britannia tenant + a `CLIENT_ADMIN` test user `9000000030` now
      seeded in `gifsy_dev` — additive dev data, reusable for future local verifies.)
    - **Capability resolution per role (real OTP login each):** `GET /v1/admin/settings/config` returns —
      Deoleo (TRADE) → `earnerModel:OUTLET, kyc/gst/tds/payouts/invoicing:true, celebratoryUx:false`;
      Britannia (EMPLOYEE) → `earnerModel:EMPLOYEE, compliance all false, vendorMarketplace+celebratoryUx:true`.
      This is the **exact input `selectAdminNav` consumes** → trade world vs employee cockpit. Also confirmed via a
      backend log line (`statusCode:200, tenantId:britannia, role:CLIENT_ADMIN`) — the proxy+auth+capabilities path
      works end-to-end server-side.
    - **Deoleo admin real browser login → `/admin/dashboard` renders the trade shell/nav** (screenshot), unchanged.
    - **Britannia admin real browser login SUCCEEDS** ("logged in — client: britannia", redirect to `/admin`).
    - ⚠️ **One gap — the live Britannia COCKPIT screenshot was NOT captured locally.** Root cause (fully diagnosed):
      the **built-in browser pane blocks cookies for the local `*.localhost` origin** (`document.cookie` is empty +
      unwritable), so the httpOnly session cookie is never sent on the FE's client-side `/api` XHR → the config
      fetch 401s client-side → `useTenantFeatures` falls back to the TRADE default → the cockpit nav never swaps in
      the pane (Deoleo looks right only because TRADE *is* the fallback). This is a **harness limitation, not a
      product defect** — it 401s identically for the trade tenant (code I didn't touch), and the same endpoint
      returns the correct EMPLOYEE capabilities when called with a valid Bearer (server-side 200, and `selectAdminNav`
      unit tests prove the cockpit selection). The cockpit visual is naturally captured on **staging** (real https
      origin + real cookies), which is already the planned staging-verify step.
  - ⏳ Owner-gated (unchanged): push `er/phase0-shell`→`develop` + create `uat-britannia` via `POST /v1/gifsy/clients`
    (`loyaltyType: EMPLOYEE_REWARDS`) + staging runtime-verify (Deoleo unchanged + **Britannia cockpit screenshot** —
    the one thing the local browser pane couldn't show). ▶ Then **Phase A** (People roster, BUILD-PLAN §5).
