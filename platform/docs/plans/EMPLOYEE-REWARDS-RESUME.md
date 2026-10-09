# Employee Rewards — RESUME (post-compact restart brief)

> **Read this first for any employee-rewards build work** (the employee-rewards equivalent of
> [`RESUME.md`](./RESUME.md), which is the *trade* restart brief). Keep it current every wave.
> This is **state**; the authoritative *how/what* live in the doc set below.

## Current state (2026-10-05)
- **PHASE 0 + PHASE A + PHASE C (bulk points crediting, BE) DONE, FULL-GATE GREEN, AUDITED (dual money) +
  REAL-DB RUNTIME-VERIFIED — STAGING DEPLOY HELD BY OWNER.** Worktree `../Loyaltybaseclaude-er` (branch
  `er/phase0-shell`) — committed **local only, NOT pushed**, isolated from the trade work.
- **Phase C BE (bulk employee points crediting) landed (2026-10-05, HEAD `4259185`):** a SEPARATE employee
  credit rail reusing the ledger/batch primitives — trade `createBatch`/`confirmBatch`/`creditEarn`/
  `applyMovement` byte-unchanged. `Wallet.partnerId` made nullable (account-first employee wallet, migration
  `20261004120000`); `ensureEmployeeWallet` + `creditEarnForAccount` (mirror of `creditEarn` via the SAME
  `applyMovement`); `createEmployeeBatch`/`confirmEmployeeBatch` (EMPLOYEE-gated, `sourceKind=EMPLOYEE_UPLOAD`,
  employeeCode→account→wallet→credit, single atomic tx, guarded claim, skip-with-reason) on gated routes
  `POST /v1/admin/credits/employee-batches[/:id/confirm]`. **DUAL money audit → 4 CONFIRMED findings FIXED:**
  **F1** trade `confirmBatch` now rejects an EMPLOYEE_UPLOAD batch (symmetric guard); **F2** always-on
  advisory-locked period-uniqueness at employee confirm (a manual no-sourceKey 2nd batch can't double-credit —
  employee credits are account-owned + currently irreversible); **F3** employee-batch reversal refused outright
  (not a silent zero-clawback — `patchReversal` is partnerId-keyed); **F5** non-POINTS row surfaced as skipped
  `UNSUPPORTED_AWARD_TYPE`. Audit B confirmed nullable-`partnerId` is **SAFE for the live Deoleo/trade path**.
  Gate: **api jest 3522 + build clean**. **Real-DB runtime verify (throwaway Postgres :5434, full migrate
  deploy + create→confirm→credit):** double-entry ledger, `partnerId`-NULL wallet, idempotent re-confirm,
  F1/F2/F3/F5 + Deoleo-safety — **all green**.
- **Phase C FE (bulk employee points upload) landed (2026-10-05, HEAD `7b6326e`):** `/admin/points` is now the
  upload UI — 4-step flow (template → upload → dry-run preview → confirm/credit) mirroring the trade
  credits-upload page but POINTS-ONLY, one row per employee (Employee Code), calling the Phase C BE rail. New
  `employee-points-template.ts` (roster pre-fill) + `employee-points-parser.ts` (+16 unit tests) +
  `/admin/points` route-permission. **Independent FE audit (correctness + UI/UX) → payload whitelist-clean;
  5 fixes:** **#1 (MED→BE)** `confirmEmployeeBatch` now skips an INACTIVE employee (`EMPLOYEE_INACTIVE`),
  deterministically (never credited whether or not the roster pre-flight loaded — resolves the old F4 decision);
  **#2/#3** FE sends a per-parse `sourceKey` (no orphan drafts on retry) + a `useRef` double-click guard;
  **#4** parser skips any parsed-zero (`"0.0"`), no silent OK-0; **#5** done screen never shows green when 0
  credited; **#7** case-sensitive dedup (matches the resolver). Gate: **api jest 3523 · build clean · platform
  tsc clean · vitest 2619**. Real-DB runtime verify re-run incl. inactive-skip + sourceKey idempotency — all green.
  (Phase C follow-ons still open: the optional **target column** — owner-locked INCLUDE, needs a BE target
  store — and **Contests**, needs a spec.)
- **Phase B Wave B1 (account-first self-service redeem rail, BE) landed (2026-10-05, HEAD `87ddd34`):** the
  redeem mirror of Phase C's credit rail — a logged-in EMPLOYEE redeems a gift FOR THEMSELVES against their
  account-owned wallet (single-step, **NO OTP** per owner). `RedemptionOrder.partnerId`→nullable (migration
  `20261005120000`); `debitRedeemForAccount`+`reverseForAccount` (account-first mirrors via the same
  `applyMovement`); `redeemForEmployee` (own-SalesUser resolve, cash modes rejected → no PayoutTransaction/
  TDS/KYC/outlet gates, create-order-CONFIRMED + debit in one tx) + a guarded `transitionOrder` refund branch;
  route `POST /v1/rewards/employee/redeem`. **DUAL money audit:** Lane A FIXED Finding 1 (double-submit
  double-debit → `sourceKey` now REQUIRED + always-on dedup) + Finding 2 (key reuse for a different reward now
  FAILS LOUD); Lane B VERDICT **SAFE for Deoleo** (no null-partner order in a trade tenant; every trade query
  tenant-scoped or non-null; every `!` site provably unreachable; migration catalog-only; trade byte-identical).
  Gate: **api jest 3543 · build clean**. Real-DB runtime verify: redeem→debit, idempotent re-submit, key-reuse
  fail-loud, cash reject, inactive/non-employee reject, refund restores — all green.
- **Phase B Wave B2 part 1 (fulfilment console account-scoping) landed (2026-10-05, HEAD `53c1d14`):** the
  OPERATOR side of EMP-GAP-1 — account-first employee orders are now visible + fulfillable in the GIFSY dispatch
  console (new `orderTenantScope` helper → `OR[partner.clientId, account.clientId]` at 6 operator sites: list,
  detail, template, upload, transitionOrder fetch, updateOrder; list/detail show the employee name). Query-only,
  no schema change. Audit VERDICT **SAFE for Deoleo** (OR account arm is a provably same-tenant superset; trade
  rows byte-identical — OUTLET accounts have no `employeeProfile`). Gate api jest **3549**; runtime-verified
  (scoped operator sees the employee order, cross-tenant isolated). Member-facing order view NOT touched (WS2).
- **Phase B Wave B2 part 2 (vendor rail + disbursal account-scoping, Finding 6) landed (2026-10-09, HEAD `6992686`):**
  the 3P vendor portal (4 queue sites) + scoped gift-disbursal now span `OR[partner,account]` via the shared
  `orderTenantScopeWhere`, so a vendor-sourced employee gift surfaces to its vendor + into a scoped disbursal total.
  Audit caught + FIXED a real HIGH (vendor `transition()` 500 on a null-partner order — Prisma 7 throws on `id:null`;
  now branches notify by owner + notifies the employee via account→user) with a null-partner regression test.
  Audit SAFE for Deoleo. Gate api jest **3553**; disbursal runtime-verified on real data.
- **✅ PHASE B COMPLETE (2026-10-09):** the last pieces landed — **catalogue curation flags + employee
  visibility gate (BE `f709ba3`)**: `RewardCatalog.featured/dreamEligible/visibleRoleCodes/visibleRegions`
  (migration `20261009120000`), admin-rewards CRUD accepts them, and `redeemForEmployee` enforces a defensive
  role/region visibility gate (employee-path-only, pre-debit, fails closed; trade byte-identical). **FE
  `a4ad714`**: the `/admin/gifts` curation controls + the `/admin/fulfilment` console (reuses the dispatch
  console via default-identical props). Gate api jest **3559** · platform vitest **2623**; visibility gate
  runtime-verified both directions (role/region-restricted → rejected, visible → redeemed). Item 2 (employee
  shipping-address) was already satisfied by B1 (ships to the employee's own address, never an outlet).
  ▶ **WORKSTREAM 2 — the employee REP APP** (owner GO'd 2026-10-09). **Wave 0 DECIDED:** login = phone-OTP via
  the roster mobile (owner chose it) — reuse `send-otp`/`verify-otp` as-is; `persistHierarchy` already maps roster
  `mobile`→`User.phone`. No new auth. (Residual, NOT silently fixed: the employeeCode-reuse→account-inherit
  hazard stays a flagged owner decision — "clear accountId on deactivate" would wrongly orphan a temporarily-
  deactivated person's points.) **✅ Wave 2 BE LANDED (2026-10-09, HEAD `f3e5f96`):** account-first employee
  READ rails — `GET /v1/rewards/employee/{wallet,wallet/transactions,orders,orders/:id,orders/:id/track,catalog}`
  via `resolveEmployeeReadContext` (own-SalesUser→accountId; reads never provision); closes the last EMP-GAP-1
  member residual. Reviewed (cross-account isolation: accountId-pinned, foreign id 404s; trade byte-identical).
  Gate api jest **3578**; real-DB runtime-verified (wallet/passbook/own-orders/cross-account-404/catalogue
  visibility+affordability). Follow-up noted: employee catalogue browse still lists cash-mode items the redeem
  rejects (filter non-redeemable channels from the browse).
  ▶ **NEXT: rep-app FE** — Wave 1 (new `rep/` route segment mirroring `partner/*` + OTP login + Britannia-demo
  theming) + Wave 2 FE (wallet/passbook/orders/catalogue screens wired to the new endpoints); then W3 redeem,
  W4 home, W5 team, W6 contests (needs spec), W7 profile+inbox. FE is staging-verified (browser-pane blocks
  `*.localhost` cookies). Still open: Phase C target column + Contests (feeds W6).
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
  **F4 CLOSED for the editor (HEAD `b8ac14a`):** a role change via the levels editor now stamps
  `sessionsInvalidBefore` + revokes the affected users' live sessions in-tx (stamp-before-revoke, mirroring
  `updateEmployee`), so the new role is enforced on the user's NEXT request (the per-request `JwtStrategy`
  rejects a revoked session). Verified facts: refresh RE-READS the role from the DB (`generateTokens(session.user)`)
  and `ACCESS_TTL=60m`, so the pre-fix exposure was **≤60m (bounded, not infinite)**; the fix makes it immediate.
  **Bulk roster upload ALSO CLOSED (HEAD `42a8c73`):** `persistHierarchy` now revokes the sessions of any
  employee whose coarse role changes on a re-upload (stamp-before-revoke, in-tx; returns `rolesRevoked`).
  **Applies to EVERY tenant incl. Deoleo** (consistent with the ungated single-edit revoke) — ⚠️ **behavior
  change for Deoleo:** a live sales-hierarchy re-upload that changes someone's role now logs that user out
  (re-auth with the new role); a re-upload that changes no roles is byte-identical. So revoke-on-role-change
  is now uniform across all three write paths (single-edit, levels editor, bulk upload). **F5 CLOSED (HEAD
  `4c936f3`):** the levels editor now shows a **reorder confirmation** on save — detecting when an existing
  level moved position (rename/add/remove/in-place role change don't trip it) and warning, with the specific
  moves + how many employees will be re-roled & signed out (from the Overview headcounts), before applying.
  Pure helpers unit-tested (`lib/hierarchy-levels-reorder.ts`). **No role-change residuals remain.** Audit F5-prev (employee admin briefly sees the trade dashboard + one trade-KPI fetch during
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
- **DECISION (Phase C BE audit F3) — account-aware clawback for the employee rail.** Employee credits are
  account-owned (`Wallet.partnerId` NULL) and the existing `patchReversal` clawback is partnerId-keyed, so an
  employee reversal would silently claw back ZERO. Phase C BE **refuses** employee-batch reversal outright
  (honest + complete, not a silent no-op) — but there is no way to undo a wrong employee credit in-product.
  **Owner: build an account-aware clawback now, or defer until employee reversal is actually needed?** (The
  pilot may not need reversal; F2's period-uniqueness already prevents the common double-credit.)
- **EMP-GAP-1 (employee orders invisible to tenant-scoped views) — operator console DONE (`53c1d14`); residual gates remain.**
  ✅ The GIFSY fulfilment/dispatch console (list/detail/template/upload/transition/updateOrder) now spans
  `OR[partner.clientId, account.clientId]` via `orderTenantScope`, so an operator sees + fulfils employee orders
  (audit SAFE for Deoleo; runtime-verified). ✅ **Finding 6 CLOSED (`6992686`):** the 3P **vendor portal** queue
  (4 sites) + scoped **gift-disbursal** now use the shared `orderTenantScopeWhere`, so a vendor-sourced employee
  gift surfaces to its vendor and into a scoped disbursal total (`redeemForEmployee` stamps `fulfilledByVendorId`).
  The audit caught a real HIGH in the same pass — the vendor `transition()` notify did `channelPartner.findFirst({
  id: order.partnerId! })`, and Prisma 7 THROWS on `id: null` → a vendor dispatching an employee gift would 500;
  FIXED (branch notify on `partnerId != null`; employee notified via account→SalesUser→user) + null-partner
  regression test. **Still open before go-live:** the employee's OWN order view (`listOrders`/`getOrder`/`track`)
  = **Workstream 2** (rep app); fails closed today (no cross-tenant/trade risk).
- **TRACKED (Phase B audit EMP-REC-1, low) — mixed-tenant disbursal↔194R reconciliation.** A platform-wide
  gift-disbursal report (OWNER, no clientId) would include employee DELIVERED `valuePaise` while 194R Source-2
  (partner-scoped) excludes it, breaking the "disbursal ties to the 194R base" note. Dormant until employee
  orders exist; revisit when the employee-liability/finance view is built.
- **TRACKED (Phase C BE audit Gap A) — employee-liability dashboard.** Every wallet aggregate
  (finance/program-health/admin-core dashboards) is partner-scoped, so account-only employee wallets report as
  **0** liability/issued/breakage. Good for trade isolation (Deoleo numbers can't be polluted), but the employee
  product needs its own liability view before it ships — a **Phase D (Insights + Liability)** lane per
  BUILD-PLAN, not a defect in Phase C.
- **✅ RESOLVED (Phase C FE audit #1, HEAD `7b6326e`) — inactive employees are SKIPPED, deterministically.**
  The FE audit showed the old behaviour was non-deterministic (a deactivated code was blocked when the roster
  pre-flight loaded, but CREDITED when the roster fetch 403'd). `confirmEmployeeBatch` now reads `isActive` and
  skips an inactive (deactivated, not deleted) employee with reason `EMPLOYEE_INACTIVE` — an inactive employee
  is NEVER credited regardless of the roster, aligning with the roster (which filters `isActive`). Safe default
  for the pilot; owner can later opt to credit inactive employees if ever wanted (would reverse this skip).

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

- **Phase C BE — bulk employee points crediting** (2026-10-05, `er/phase0-shell` HEAD `4259185`, FULL-GATE
  GREEN, DUAL money audit, REAL-DB runtime-verified). A SEPARATE employee credit rail reusing the ledger/batch
  primitives; **trade `createBatch`/`confirmBatch`/`creditEarn`/`applyMovement` byte-unchanged**.
  - **Schema:** `Wallet.partnerId` → nullable (account-first employee wallet); migration `20261004120000`
    (`ALTER COLUMN DROP NOT NULL` — catalog-only, non-blocking; `@unique` valid, NULLs distinct); `partner`
    relation optional.
  - **BE:** `ensureEmployeeWallet(tx, accountId)` (account-first upsert); `requireWalletByAccount` +
    `creditEarnForAccount` (mirror of `creditEarn` via the SAME `applyMovement`, whole-Int EARN);
    `createEmployeeBatch` + `confirmEmployeeBatch` (EMPLOYEE-gate, `sourceKind=EMPLOYEE_UPLOAD`,
    employeeCode→SalesUser→account→wallet→credit, single atomic tx, guarded status claim, skip-with-reason).
    Routes `POST /v1/admin/credits/employee-batches[/:id/confirm]` gated like trade.
  - **Independent DUAL money audit (2 lanes) — 4 CONFIRMED findings FIXED (all runtime-verified + unit tests):**
    - **F1 (HIGH):** trade `confirmBatch` had no `sourceKind` guard → an EMPLOYEE_UPLOAD batch confirmed via
      the trade endpoint would strand (every row `OUTLET_NOT_FOUND`) yet flip CONFIRMED, blocking the correct
      re-run. Fix: symmetric `sourceKind==='EMPLOYEE_UPLOAD'` rejection (twin of the employee path's guard).
    - **F2 (HIGH):** the create-time period-refusal was `if (dto.sourceKey)`-gated → two MANUAL batches could
      both confirm & double-credit; and employee credits are account-owned + irreversible (F3), so stacking is
      not clawback-recoverable. Fix: **always-on, advisory-locked period-uniqueness at confirm** (`CBATCH|
      client|period`) refusing a second confirmed EMPLOYEE_UPLOAD batch for the period; the throw rolls back
      the status claim (batch stays PENDING, never stranded).
    - **F3 (MED):** `patchReversal`'s POINTS clawback is partnerId-keyed → an employee reversal would flip
      APPROVED while clawing back ZERO (silent no-op). Fix: `createReversal` refuses an EMPLOYEE_UPLOAD batch
      outright (→ Open spec items: build account-aware clawback, or defer).
    - **F5 (LOW):** a non-POINTS row in an employee batch vanished. Fix: surfaced as skipped
      `UNSUPPORTED_AWARD_TYPE` (never silent).
    - **Audit B verdict:** nullable-`partnerId` is **SAFE for the live Deoleo/trade path** — no trade wallet
      read/write dereferences `partnerId`; auth login + all dashboards handle the NULL (and employee wallets
      are universally excluded from trade aggregates → can't pollute Deoleo numbers; the flip side = Gap A,
      the employee-liability dashboard, tracked for Phase D).
  - **FULL GATE GREEN:** `api nest build` ✓ · `api jest` **3522** ✓ (+4 audit-fix regression tests). (No
    platform changes this increment — platform gates unaffected.)
  - **REAL-DB RUNTIME-VERIFIED** (throwaway Postgres on **:5434** via the bundled PG binary — `gifsy_dev` isn't
    running locally & the Cloud SQL `gifsy-db` instance only hosts staging/prod, so a fresh isolated cluster;
    `prisma migrate deploy` applied the FULL chain incl. both ER migrations cleanly): a Nest TestingModule with
    the **real** CreditsService + WalletService + TenantSettings + Prisma drove create→confirm→credit —
    double-entry (1 PointsLedger EARN + 1 WalletTransaction), `partnerId`-NULL account-first wallet, balance
    100/100, idempotent re-confirm blocked, **F2** 2nd-manual-batch blocked (balance stayed 100), **F5** PAYOUT
    surfaced skipped, **F1** trade-confirm refused, **F3** reversal refused, **Deoleo-safety** TRADE tenant
    rejected — **all green**.
  - ▶ **NEXT:** **Phase C FE** (Points nav → bulk points upload → dry-run diff → confirm UI). Open owner
    decisions logged (account-aware clawback F3, employee-liability dashboard Gap A, credit-inactive F4).

- **Phase C FE — bulk employee points upload** (2026-10-05, `er/phase0-shell` HEAD `7b6326e`, FULL-GATE GREEN,
  independent FE audit, real-DB runtime-verified). `/admin/points` is now the upload UI (replaced the stub).
  - **FE:** `admin/points/page.tsx` — a 4-step flow (template → upload → dry-run preview → confirm/credit)
    mirroring the trade `credits-payouts/upload` page but POINTS-ONLY, ONE ROW PER EMPLOYEE (keyed by Employee
    Code, ADMIN-DESIGN §5.2); period picker; roster-aware pre-flight (best-effort `GET /sales-users/options`;
    `knownCodes=null` when unavailable → defer unknown-code validation to the server); reads the CONFIRM
    response as source-of-truth for what was actually credited; honest skip surfacing. New
    `lib/employee-points-template.ts` (roster-prefilled xlsx) + `lib/employee-points-parser.ts` (+
    `toEmployeeUploadRows` → the UploadRowDto shape); `/admin/points → credits:read` in ROUTE_PERMISSIONS
    (the upload/confirm ACTIONS are gated at the endpoint with credits:upload/confirm_payout).
  - **Independent FE audit (correctness + UI/UX) — payload verified whitelist-clean; 5 fixes:** **#1 (MED, BE
    fix)** inactive-employee determinism → `confirmEmployeeBatch` skips `EMPLOYEE_INACTIVE` (see Open spec items,
    resolves old F4); **#2/#3** per-parse `sourceKey` + `useRef` in-flight guard (no orphan drafts / no
    double-submit); **#4** parser skips any parsed-zero (no silent OK-0); **#5** done screen honest when 0
    credited; **#7** case-sensitive dedup. #6 (FE window gate uses browser-local time vs the backend's IST) left
    as inherited-from-trade (logic identical; India operators; rare boundary only).
  - **FULL GATE GREEN:** api jest **3523** (+EMPLOYEE_INACTIVE test) · nest build ✓ · platform tsc ✓ · vitest
    **2619** (+16 parser tests). **Real-DB runtime verify re-run** (throwaway Postgres): create→confirm→credit,
    idempotent re-confirm, F1/F2/F3/F5, **inactive-skip (EMPLOYEE_INACTIVE)**, **sourceKey idempotency**,
    Deoleo-safety — all green. (FE browser visual deferred to staging — the pane blocks `*.localhost` cookies.)
  - ▶ **NEXT:** the optional **target column** (owner-locked INCLUDE — needs a BE target store, NOT in the
    committed BE) + **Contests** (needs a concrete spec) per BUILD-PLAN §C; then Phase B/D/E.

- **Phase B Wave B1 — account-first self-service redeem rail (BE)** (2026-10-05, `er/phase0-shell` HEAD
  `87ddd34`, FULL-GATE GREEN, DUAL money audit, real-DB runtime-verified). Owner chose Phase B next; owner
  clarified employee redeem = self-service from the catalogue, **NO OTP**. Built as SEPARATE employee methods
  (Phase C precedent); the live trade redeem/confirm/payout path is runtime byte-identical.
  - **Reused as-is (mapped, no change):** the catalogue (`GiftCategory`/`RewardCategory`/`GiftMaster`/
    `RewardCatalog` + `/admin/rewards` CRUD) and the whole 3P vendor portal (vendor+tenant+order-scoped).
  - **Net-new (BE):** `RedemptionOrder.partnerId`→nullable (migration `20261005120000`); `WalletService`
    `debitRedeemForAccount`+`reverseForAccount` (+ account-first spec, 4 tests); `redeemForEmployee` (single-step,
    no-OTP, own-SalesUser resolve, cash rejected, atomic order+debit, idempotent on a REQUIRED sourceKey) +
    `assertEmployeeEarner`; the one guarded `transitionOrder` refund branch; route `POST /v1/rewards/employee/redeem`;
    spec `rewards.employee-redeem.spec.ts` (15 tests).
  - **DUAL money audit → Lane A fixes:** Finding 1 (double-submit double-debit) → `sourceKey` REQUIRED + always-on
    advisory-locked dedup; Finding 2 (key reused for a different reward) → FAILS LOUD (no silent wrong-order return).
    **Lane B VERDICT: SAFE for Deoleo** — no null-partner order can exist in a trade tenant (fail-closed
    `assertEmployeeEarner`), every trade query tenant-scoped or non-null, every `order.partnerId!` provably
    unreachable, migration catalog-only. Confirmed employee-side gaps are B2/tracked (EMP-GAP-1, EMP-REC-1).
  - **FULL GATE GREEN:** api jest **3543** · nest build ✓. **Real-DB runtime verify** (throwaway Postgres):
    redeem→debit (200→150, order account-first CONFIRMED, 1 REDEEM ledger + 1 history), idempotent re-submit (no
    2nd debit), key-reuse fail-loud, distinct redeem (fresh key), cash reject, inactive + non-employee reject,
    refund (RETURNED → reverseForAccount restores, pointsDeducted zeroed) — all green.
  - ▶ **NEXT:** **Wave B2** — close EMP-GAP-1 (account-first fulfilment console scoping + employee order read;
    wire the `/admin/fulfilment` stub) + catalogue curation flags (Dream-eligible/featured, role/region visibility)
    + employee shipping-address sourcing.

- **Phase B Wave B2 part 1 — fulfilment console account-scoping (EMP-GAP-1, operator side)** (2026-10-05,
  `er/phase0-shell` HEAD `53c1d14`, FULL-GATE GREEN, independent trade-safety audit, real-DB runtime-verified).
  Query-only (no schema change). The GIFSY dispatch console now sees + fulfils account-first employee orders.
  - **New:** `orderTenantScope(scope)` helper → `{}` (platform-wide) or `OR[{partner:{clientId}},{account:{clientId}}]`;
    applied at **6** operator sites (listFulfilmentOrders, getFulfilmentOrder, getFulfilmentTemplate,
    uploadFulfilment, transitionOrder fetch, **updateOrder** — the 6th found by consumer-tracing the PATCH + the
    upload blank-status branch, per agreement #2). List/detail include the account (+ employeeProfile.user.name);
    row maps fall back `clientId = partner?.clientId ?? account?.clientId`, `partnerName = partner?.businessName ??
    employee name ?? employeeCode`; the tenantName map spans account clientIds.
  - **Independent trade-safety + cross-tenant audit → VERDICT SAFE for Deoleo:** the OR account arm is a provably
    SAME-TENANT superset (`ensureOutletAccount` sets `account.clientId == partner.clientId` for every trade order;
    legacy accountId-null orders still match via the partner arm), trade rows byte-identical (OUTLET accounts have
    no `employeeProfile` → every `??` collapses to the prior value), no OR-collision, all 6 sites role-gated.
    Finding 6 (pre-existing, dormant, NOT trade risk): the 3P vendor-portal queue + scoped gift-disbursal are still
    partner-scoped → tracked as go-live gates (see Open spec items).
  - **FULL GATE GREEN:** api jest **3549** (+ `rewards-fulfilment-scope.spec.ts`, 7 tests) · nest build ✓.
    **Real-DB runtime verify:** a scoped operator LISTS + FETCHES the employee order (labelled with the employee
    name), a cross-tenant operator is isolated (NotFound, 0 items) — all green.
  - ▶ **NEXT:** vendor-portal/disbursal account-spanning (Finding 6, pilot-scope gated) + catalogue curation flags
    + employee shipping-address + the `/admin/fulfilment` FE page + the employee's own order view (WS2).

- **Phase B Wave B2 part 2 — vendor rail + disbursal account-scoping (Finding 6)** (2026-10-09, `er/phase0-shell`
  HEAD `6992686`, FULL-GATE GREEN, independent trade-safety audit, real-DB runtime-verified). Query-only.
  - **Net:** extracted a shared `common/order-tenant-scope.ts` → `orderTenantScopeWhere(scope)` (single source of the
    trade-safety reasoning); applied at the 3P vendor-portal's 4 order-queue sites + gift-disbursal `buildWhere`;
    `rewards.service`'s private `orderTenantScope` now DELEGATES to it (6 console sites unchanged). So a vendor-sourced
    employee gift (`redeemForEmployee` stamps `fulfilledByVendorId` + consent) surfaces to its vendor and into a
    scoped disbursal total. The vendor VIEW is partner-agnostic (delivery from the order's own fields) → no display change.
  - **Independent audit caught a real HIGH (Finding 1), FIXED:** spanning employee orders made the vendor
    `transition()` reachable with a null partnerId, but its notify did `channelPartner.findFirst({ id: order.partnerId! })`
    — **Prisma 7 THROWS on `id: null`** (not silent) → a vendor dispatching/delivering an employee gift would 500.
    Fix: branch the notify on `partnerId != null`; a null-partner employee order notifies the employee via
    account→SalesUser→user (mirrors the account-aware refund branch). Added a **null-partner transition regression
    test** (the exact gap that let it pass green). Audit VERDICT otherwise SAFE for Deoleo (no cross-tenant leak —
    account arm is a proven same-tenant superset; no OR-collision; PENDING/PII intact; trade rows byte-identical).
  - **FULL GATE GREEN:** api jest **3553** (+ `order-tenant-scope.spec.ts`, the null-partner transition test; the
    vendor/disbursal/isolation specs updated to the OR shape) · nest build ✓. **Real-DB runtime verify:** a scoped
    CLIENT_ADMIN's gift-disbursal total INCLUDES the employee DELIVERED value (2000 paise) and EXCLUDES another
    tenant's — the OR scoping proven on real data through a second consumer. (Vendor `transition()` fix covered by
    the unit regression test; a full vendor-queue DB seed is disproportionate for a dormant surface whose query
    pattern is already DB-proven.)
  - ▶ **NEXT:** catalogue curation flags + employee shipping-address + `/admin/fulfilment` FE + employee order view (WS2).
