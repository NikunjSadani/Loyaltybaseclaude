# Employee Rewards — RESUME (post-compact restart brief)

> **Read this first for any employee-rewards build work** (the employee-rewards equivalent of
> [`RESUME.md`](./RESUME.md), which is the *trade* restart brief). Keep it current every wave.
> This is **state**; the authoritative *how/what* live in the doc set below.

## Current state (2026-10-04)
- **PHASE 0 + PHASE A DONE, FULL-GATE GREEN, AUDITED (dual money + UI/UX) + LOCAL RUNTIME-VERIFIED — STAGING
  DEPLOY HELD BY OWNER.** Worktree `../Loyaltybaseclaude-er` (branch `er/phase0-shell`) — committed **local
  only, NOT pushed**, isolated from the trade work.
- **Phase A (Shell + People roster) landed (2026-10-04):** the one net-new piece — the EMPLOYEE
  `RewardAccount` ↔ `SalesUser` linkage (migration `20261003120000` + `ensureEmployeeAccount`/bulk helper,
  gated by `earnerModel`) — plus `/admin/people` surfacing the reused roster. Two money-audit defects (lock
  namespace, per-row link scale) FIXED. Runtime-verified on real `gifsy_dev`: EMPLOYEE roster → accounts
  linked (4/4), idempotent, **Deoleo untouched (0)**.
- **Phase A polish landed (2026-10-04, HEAD `e382e3f`):** (1) **per-tenant hierarchy levels** — custom codes,
  **custom level names**, and a per-level `userRole`→coarse-role mapping, stored as a `hierarchy_levels`
  ProgramSetting, **defaulting to Deoleo when unset** (trade byte-identical); validated `GET/PUT
  /v1/admin/hierarchy-levels` + a FE levels editor; (2) **employee cockpit Overview** (`/admin/overview`, first
  nav item + the cockpit landing via a capability-gated dashboard redirect) with roster KPIs + per-level
  breakdown. Independent audit (1 lane) = **Deoleo byte-identical CONFIRMED**; 4 findings FIXED (F1 require
  `userRole`, F3 overview excludes parked levels, F6 normalize rejects dup blobs, F7 roleCode charset).
  Full gate green (api **3495** · platform tsc · vitest **2595**); runtime-verified on `gifsy_dev`: a custom
  3-level Britannia config drives the coarse role (MGR→SALES_STATE_HEAD, which the legacy switch would never
  produce), Deoleo roles unchanged (ASM→SALES_ASM), overview `levelCount` excludes parked levels (3 not 9),
  F1/F7 reject with 400.
- See the Wave log for full detail + Open spec items for deferred owner decisions (UI/UX reskin fork,
  `employeeCode`-reuse policy, onboarding assumption, **+ the level-code-rename operational rule**).
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
- **Phase 2 — EMPLOYEE owner-generalisation (PARTLY DONE in Phase A).** The `RewardAccount ↔ SalesUser`
  profile link now EXISTS (`SalesUser.accountId` + `RewardAccount.employeeProfile`, migration
  `20261003120000`), and `ensureEmployeeAccount` / `ensureEmployeeAccountsForSalesUsers` CREATE+link the
  account on the roster path (Phase A). **Still Phase 2 (the READ/earn side):** branch **all ~7
  `resolveActivePartnerId` consumers** (wallet `:294/:415`, rewards `:638`, schemes `:80`,
  scheme-enrollment `:483/:539/:1378/:1487`, partner `:51/:92`, leaderboard `:26`, invoices `:955`) so the
  rep app resolves the logged-in user → their `SalesUser` → `EMPLOYEE RewardAccount`; wire wallet creation
  **account-first** (→ decide `Wallet.partnerId` nullability then — NOT needed in Phase A); and consider a
  DB constraint enforcing profile↔accountType pairing (today only code enforces it).
- **DECISION NEEDED before Phase 2 — `employeeCode` reuse re-inherits an account (audit Finding-2).** The
  roster never clears `SalesUser.accountId` on deactivation, and `ensureEmployee…` only fills a NULL. If a
  resigned person's `employeeCode` is later refilled by a DIFFERENT human, they inherit the prior account —
  harmless now (no wallet), but a silent balance transfer once Phase 2 wallets land. Owner to decide the
  policy (clear accountId on deactivate? key accounts to a person, not a code?).
- **CONFIRM before staging cutover — onboarding assumption (audit M3).** Accounts are ensured only on a
  roster upload / single-edit (migration is "no backfill"). An EMPLOYEE tenant switched from TRADE *after*
  its roster was loaded would have account-less active employees until the next upload. Fine **iff** EMPLOYEE
  tenants are always onboarded as `EMPLOYEE_REWARDS` from the first roster (the enabler sets `loyaltyType` at
  create, so this holds for the normal path) — else add a one-shot backfill.
- **Staging/prod migration note (audit M5).** `20261003120000` builds a **non-concurrent** unique index on
  `sales_users` → brief write-lock during the migration window (fast here; the column is all-NULL). `ON
  DELETE SET NULL` means deleting a RewardAccount unlinks (and would strand a future wallet) — Phase 2 note.
- **✅ CLOSED (2026-10-04, HEAD `fc2749a`) — editing level codes no longer needs a roster re-upload.**
  `setHierarchyLevels` now runs `reconcileLevelsToConfig` in the same tx: matches by LEVEL NUMBER, updates
  the relational `SalesHierarchyLevel` row at each level IN PLACE (same id → employees stay linked) and
  remaps existing employees' `User.role` to the new per-level `userRole`; a removal of a populated level is
  rejected (400, no orphaning). Independent audit (auth/destructive-adjacent) fixes applied: **F3** —
  `setHierarchyLevels` is now **EMPLOYEE-tenants-only** (a Deoleo CLIENT_ADMIN could otherwise have run the
  reconcile on the live trade roster; GET stays open for the shared roster page); **F1/F2** — unique
  monotonically-negative parking + orphan cleanup (no `(clientId,level)`/`(clientId,code)` self-collision,
  no `__tmp__` accumulation); **F6** — `__tmp__` codes never surface in the UI. Runtime-verified: rename
  MGR→MANAGER + role change auto-propagates with no re-upload; populated-level removal → 400; Deoleo PUT → 400.
  **Residuals (tracked, Phase-A-acceptable):** F4 — a role change via the editor does NOT revoke the
  affected users' sessions (a demoted manager keeps the old role claim until token refresh, ~rolling-session
  window; **consistent with the bulk-upload path**; revoke before a staff-enabled live tenant). F5 — the
  editor matches by position, so REORDERING rows re-roles employees by position (rename-in-place is the
  intended use). Audit F5-prev (employee admin briefly sees the trade dashboard + one trade-KPI fetch during
  the redirect) is an accepted cosmetic minor, same class as the Phase-0 pre-config-load flash.
- **UI/UX fork — People roster reskin vs reuse-as-is (owner decision).** Phase A reuses the trade hierarchy
  page verbatim (design §5.1 "reuse as-is"). The UI/UX audit flags trade-era chrome bleeding into the
  employee cockpit: a "← back to /admin/dashboard" link (orphan — the employee nav has no dashboard) and
  trade sales-role labels (XSR…NSM, "Manage sales team structure", "has outlets"). Fixing these means
  editing the shared trade page or building an employee-flavoured roster view (new scope). **Owner: reskin
  for the pilot, or accept trade chrome for now?**
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
    the one thing the local browser pane couldn't show).

- **Phase A — Shell + People roster** (2026-10-04, `er/phase0-shell`, FULL-GATE GREEN, orchestrated 2 build
  agents + a 3-lane independent audit [dual money + UI/UX]). ADDITIVE + gated; Deoleo/OUTLET write-identical.
  - **BE — EMPLOYEE RewardAccount linkage (the one net-new piece):** migration `20261003120000` adds
    `SalesUser.accountId @unique` ↔ `RewardAccount.employeeProfile` (mirrors `ChannelPartner.accountId`,
    `ON DELETE SET NULL`). New `ensureEmployeeAccount` (single) + `ensureEmployeeAccountsForSalesUsers`
    (set-based bulk) in `reward-account.helper.ts`. Wired into `persistHierarchy` (bulk) + `updateEmployee`
    (single), **gated by `resolveCapabilities().earnerModel === 'EMPLOYEE'`** (fail-safe → TRADE skips). The
    roster CRUD itself is REUSED unchanged (it already writes `SalesUser`/`User`/`SalesHierarchyLevel` keyed
    by `employeeCode`).
  - **FE — People:** `/admin/people` now renders the existing employee-hierarchy page (roster upload +
    per-employee edit) reused as-is; added `/admin/people → sales_org:read` to `ROUTE_PERMISSIONS`. (Dropped
    an over-added, mislabeled "admin accounts" tab — not the design's roster.)
  - **Independent DUAL money audit — BOTH lanes CONFIRMED the same top defect; FIXED:**
    - **M1 (HIGH, fixed):** single-edit & bulk used DIFFERENT advisory-lock namespaces → a concurrent
      upload + single-edit of the same employee could mint a duplicate/orphan account. Fix: both paths now
      lock on the SAME tenant key `reward_account:employee:client:<clientId>` + single re-checks after the
      lock. Regression-guard tests assert the lock KEY (closes the "$executeRaw mocked no-op" test gap).
    - **M2 (MEDIUM, fixed):** per-row link loop inside the 20s tx (2,261-row timeout risk) → replaced with
      ONE set-based `UPDATE … FROM (VALUES …)` + `accountId IS NULL` guard.
    - Deferred (see Open spec items): Finding-2 (code-reuse re-inherits account → Phase 2 decision), M3
      (onboarding assumption → confirm), M5 (migration notes), UI/UX reskin fork.
  - **FULL GATE GREEN (run personally):** `api nest build` ✓ · `api jest` **3473** ✓ (+2 M1 guards) ·
    `platform tsc` ✓ · `platform vitest` **2595** ✓.
  - **RUNTIME-VERIFIED end-to-end against real `gifsy_dev`** (migration applied via `prisma db execute`;
    api on :4001 → own proxy on **:5434**, since the primary trade stack holds :5433): real Britannia
    (EMPLOYEE) roster upload → accounts created+linked (**4/4** employees, DB-confirmed); re-upload /
    mixed existing+new → `employeeAccountsEnsured` counts only the NEW (idempotent, set-based link works on
    real Postgres); **Deoleo (TRADE) re-save → 0 accounts, 0 SalesUser.accountId (Deoleo-safety, DB-confirmed)**;
    exactly 4 EMPLOYEE accounts, all britannia (no orphans/duplicates/leakage). This path is API-level, so it is
    NOT blocked by the browser-pane cookie limit.
  - ▶ **NEXT:** owner call on the UI/UX reskin fork (Open spec items), then **Phase B** (Rewards + Fulfilment
    + Vendors) / **Phase C** (points-upload + contests) per BUILD-PLAN §5 — still on the held branch.
