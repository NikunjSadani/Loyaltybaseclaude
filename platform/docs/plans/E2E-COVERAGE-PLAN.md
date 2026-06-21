# E2E Coverage Plan — close the role×page matrix before UAT

> Created 2026-06-21. Goal: make the automated Playwright harness (`platform/e2e`) cover the app
> **comprehensively** — every page × every role, every state-changing write proven to persist — **before**
> the owner's manual UAT, so UAT is a confirmation pass, not the first place bugs surface.
>
> Bar (from [`GO-LIVE-READINESS.md`](./GO-LIVE-READINESS.md) §1–3 + [`VERIFICATION-PROTOCOL.md`](./VERIFICATION-PROTOCOL.md)):
> "comprehensive ≠ a representative sample — it is **every page × every role**, asserting real scoped data,
> honest errors, no fabricated values, and **every write flow persists** (a different session sees it)."
> This plan enumerates exactly what is uncovered and lays out parallelisable waves to close it.
>
> Source of the "expected": [`DATA-VISIBILITY.md`](./DATA-VISIBILITY.md) (the role→scope model + per-page rows).
> Harness design + env-parameterisation: [`../e2e/README.md`](../../e2e/README.md).

---

## 0. Where we stand (baseline, 2026-06-21)

- Harness is **GREEN** at ~59 tests across 22 spec files, but covers **slices, not the matrix**. Confirmed by
  the 22 existing `*.e2e.ts` files (below) + the README "Status / Coverage limits" sections.
- Real seeded `gifsy_dev` truth (from `api/prisma/seed.ts`): tenants `deoleo` (3 partners CP001/CP002/CP003,
  3 outlets O001–O003, SO sales user assigned to O001, 2 rewards RW001/RW002, KYC seed-kyc-1 PENDING_GIFSY /
  seed-kyc-2 UNDER_REVIEW / seed-kyc-3 APPROVED, VisibilityProgram VP001, CreditBatch CB-2026-05 + payout
  entry for O003, Scheme DEMO-VIS ACTIVE) · `clientb` (admin + CPB001 "Zenith Trading Co" / Bharat Verma +
  OB001 + PENDING_GIFSY KYC, the cross-tenant leak markers) · `gifsy` (platform super-admin).
- The 5 wired roles (and their storageState projects, by directory) are in `e2e/fixtures/roles.ts` +
  `e2e/setup/auth.setup.ts`: `partner` (WHOLESALER, deoleo), `clientAdmin` (deoleo), `sales` (SALES_SO,
  deoleo), `clientbAdmin` (deoleo's twin tenant), `gifsy` (GIFSY_ADMIN).
- **MIS_USER is NOT seeded and NOT a harness role at all** — yet DATA-VISIBILITY makes it a first-class
  read-only tenant role. This is a coverage hole *and* a seed gap (see §3 Wave 0 + §4 staging note).

### Existing spec inventory (what GREEN actually covers)
| Spec file | Role | What it asserts |
|---|---|---|
| `clientAdmin/dashboard.e2e.ts` | clientAdmin | real tenant identity + KPI integer (#47), no fabricated, no clientb leak |
| `clientAdmin/kyc.e2e.ts` | clientAdmin | `/admin/kyc` routes + no fabricated (read-only, shallow) |
| `clientAdmin/invoices.e2e.ts` | clientAdmin | `/admin/invoices` + `/upload` render, list-shape crash guard, empty-state (NO generate write) |
| `clientAdmin/cross-tenant.e2e.ts` | clientAdmin | deoleo admin never sees clientb data |
| `clientAdmin/scoping.e2e.ts` | clientAdmin | scoped out of gifsy/other surfaces |
| `clientbAdmin/cross-tenant.e2e.ts` | clientbAdmin | reverse direction — clientb never sees deoleo (#52) |
| `partner/dashboard.e2e.ts` | partner | real identity via `/partner/me`, no fabricated rank/available |
| `partner/wallet.e2e.ts` | partner | real balance + ledger (read) |
| `partner/invoices.e2e.ts` | partner | own invoices render |
| `partner/redemption-write.e2e.ts` | partner | **WRITE-PERSIST**: redeem RW001 → OTP → debit 500 → fresh `/api/wallet` read sticks |
| `partner/visibility-write.e2e.ts` | partner | **WRITE-PERSIST**: `POST /api/visibility/submit` → GIFSY re-read shows new id |
| `partner/support-write.e2e.ts` | partner | **WRITE-PERSIST**: raise ticket → survives reload (backend re-fetch) |
| `partner/scoping.e2e.ts` | partner | scoped out of admin/gifsy |
| `sales/dashboard.e2e.ts` | sales | dashboard renders, no fabricated |
| `sales/kyc.e2e.ts` | sales | `/sales/kyc` review scaffold + status filter (NO first-approve write) |
| `sales/catalogue.e2e.ts` | sales | catalogue renders for sales (not 403) — NO assisted-redeem write |
| `sales/scoping.e2e.ts` | sales | scoped out |
| `gifsy/console.e2e.ts` | gifsy | login lands on console + clients page loads (mock data, #49) |
| `gifsy/overview.e2e.ts` | gifsy | overview smoke |
| `gifsy/client-detail.e2e.ts` | gifsy | client detail smoke |
| `gifsy/kyc-cross-tenant.e2e.ts` | gifsy | A1 cross-tenant KYC queue (both brands + brand filter) |
| `gifsy/operator-switch.e2e.ts` | gifsy | A2 assume-tenant round-trip (switch → banner → exit) |

**Harness patterns to reuse** (do NOT reinvent): `helpers/login.ts` (real-form login, asserts backendRole),
`helpers/assert.ts` → `expectNoFabricatedData` / `expectScopedOut`, `helpers/persist.ts` →
`uniqueMarker` / `expectPersistsAfterReload`, `helpers/otp.ts` → `resolveOtp(role)` (env-aware OTP; use for
EVERY OTP-gated write so it works on staging too), `fixtures/fabricated.ts` (the #40 fail-list,
`onlyOnPaths` supported). Cross-role reads: pull a second role's JWT from its storageState
(`partner/visibility-write.e2e.ts` `tokenFor()` is the template).

---

## 1. Coverage matrix (role × page)

Real page inventory enumerated from `src/app/**/page.tsx` (72 page files). Status: ✅ covered (cite spec) ·
◐ shallow (route/render smoke only, no data/scope/write assertion) · ◻ uncovered. "Role" columns mark the
*intended* audience per DATA-VISIBILITY §2–3 (blank = not in that role's nav / hard-403).

Legend for audience: **CA**=CLIENT_ADMIN, **MIS**=MIS_USER (read-only), **P**=partner, **S**=sales,
**G**=GIFSY_ADMIN, **CB**=clientbAdmin (isolation twin).

### 1a. Auth
| Page | Audience | Status | Spec / note |
|---|---|---|---|
| `/auth/login` | all | ✅ | login asserted per-role in `setup/auth.setup.ts` (real form, backendRole + route). MIS untested (not seeded). |

### 1b. Admin surface (CLIENT_ADMIN; MIS = read-only; some GIFSY-only)
| Page | Audience | Status | Spec / note |
|---|---|---|---|
| `/admin/dashboard` | CA, MIS | ✅ CA | `clientAdmin/dashboard.e2e.ts`. ◻ MIS read-only. |
| `/admin/dashboards/kyc` | CA, MIS | ◻ | aggregates — fabricated-risk (#36/#40) |
| `/admin/dashboards/payments` | CA, MIS | ◻ | aggregates |
| `/admin/dashboards/redemptions` | CA, MIS | ◻ | aggregates |
| `/admin/dashboards/engagement` | CA, MIS | ◻ | aggregates |
| `/admin/kyc` | CA, MIS | ◐ CA | `clientAdmin/kyc.e2e.ts` (route+no-fab only; no row/scope assert) |
| `/admin/kyc/[id]` | CA | ◻ | detail render + tenant scope |
| `/admin/kyc/approvals` | **G only** (Q2) | ✅ G | `gifsy/kyc-cross-tenant.e2e.ts` (cross-tenant queue + brand filter). ◻ CA-403 assertion. |
| `/admin/approvals` | CA | ◻ | approvals queue (distinct from kyc/approvals) |
| `/admin/payouts` | **G only** (Q1) | ◐ | scoping specs assert CA-out generally; ◻ no dedicated CA-403-on-`/admin/payouts` + ◻ G data render |
| `/admin/payouts/fund` | **G only** | ◻ | fund page |
| `/admin/visibility` | CA | ◻ | tenant visibility submissions list |
| `/admin/credits-payouts` | CA | ◻ | credit batches |
| `/admin/credits-payouts/upload` | CA | ◻ | **WRITE** (upload batch) |
| `/admin/credits-payouts/status` | CA | ◻ | batch status |
| `/admin/credits-payouts/payout` | CA | ◻ | **WRITE** (process payout) |
| `/admin/credits-payouts/fields` | CA | ◻ | **WRITE** (credit-field CRUD) |
| `/admin/invoices` | CA, G | ✅ CA | `clientAdmin/invoices.e2e.ts` (render+crash guard; NO generate write) |
| `/admin/invoices/upload` | CA, G | ◐ CA | render only (`invoices.e2e.ts`); ◻ **generate WRITE** |
| `/admin/targets` | CA | ◻ | tenant targets list |
| `/admin/targets/upload` | CA | ◻ | **WRITE** (target upload) |
| `/admin/schemes` | CA | ◻ | schemes list |
| `/admin/schemes/[id]` | CA | ◻ | scheme detail |
| `/admin/schemes/[id]/enrollments` | CA | ◻ | **WRITE** (enrollment) |
| `/admin/tds` | CA (194R), G (194C) | ◻ | 194R tenant view; 194C is G-only cross-tenant (Q6) |
| `/admin/tickets` | CA, MIS | ◻ | tenant tickets list (read) + ◻ reply **WRITE** |
| `/admin/gifts` | CA | ◻ | reward catalog list + ◻ **CRUD WRITE** |
| `/admin/banners` | CA | ◻ | banner CRUD |
| `/admin/sales` | CA | ◻ | sales-user admin |
| `/admin/users/outlets` | CA | ◻ | outlet/user admin + ◻ **CRUD WRITE** |
| `/admin/outlets` | CA | ◻ | outlets list |
| `/admin/hierarchy` | CA | ◻ | sales hierarchy config |
| `/admin/settings` | CA | ◻ | tenant settings + ◻ **WRITE** |
| `/admin/reports` | CA, MIS | ◻ | reports index |
| `/admin/reports/points-ledger` | CA, MIS | ◻ | ledger report |
| `/admin/reports/ticket-aging` | CA, MIS | ◻ | aging report |

### 1c. Partner surface
| Page | Audience | Status | Spec / note |
|---|---|---|---|
| `/partner/dashboard` | P | ✅ | `partner/dashboard.e2e.ts` |
| `/partner/wallet` | P | ✅ | `partner/wallet.e2e.ts` |
| `/partner/rewards` | P | ◐ | exercised by `redemption-write` but no standalone catalog-render/no-fab assert |
| `/partner/rewards/orders` | P | ◻ | own orders list |
| `/partner/targets` | P | ◻ | own targets |
| `/partner/invoices` | P | ✅ | `partner/invoices.e2e.ts` |
| `/partner/invoices/[id]` | P | ◻ | invoice detail + scope (not another partner's) |
| `/partner/leaderboard` | P | ◻ | leaderboard (own-rank real, no fabricated rank) |
| `/partner/support` | P | ✅ write | `partner/support-write.e2e.ts` (read of own list still ◐) |
| `/partner/visibility` | P | ✅ write | `partner/visibility-write.e2e.ts` |
| `/partner/payouts` | P | ◻ | own payouts |
| `/partner/profile` | P | ◻ | own profile + ◻ **edit WRITE** |

### 1d. Sales surface (hierarchy-scoped; SO seeded only — Q4 manager downline UNSEEDED)
| Page | Audience | Status | Spec / note |
|---|---|---|---|
| `/sales/dashboard` | S | ✅ | `sales/dashboard.e2e.ts` |
| `/sales/kyc` | S | ◐ | `sales/kyc.e2e.ts` (scaffold; NO first-approve **WRITE**) |
| `/sales/kyc/new` | S | ◻ | **WRITE** (create KYC submission) |
| `/sales/kyc/[id]` | S | ◻ | KYC detail (assigned scope) |
| `/sales/kyc/[id]/edit` | S | ◻ | **WRITE** (edit KYC) |
| `/sales/kyc/[id]/ledger` | S | ◻ | outlet ledger |
| `/sales/catalogue` | S | ◐ | `sales/catalogue.e2e.ts` (renders, not 403); NO assisted-redeem **WRITE** (#50-E) |
| `/sales/outlets` | S | ◻ | assigned outlets (scope) |
| `/sales/team` | S (manager) | ◻ | downline (Q4) — **needs manager seed** |
| `/sales/team/[memberId]` | S (manager) | ◻ | member detail (Q4) |
| `/sales/team/[memberId]/outlets` | S (manager) | ◻ | member outlets (Q4) |
| `/sales/leaderboard` | S | ◻ | leaderboard (deferred per GO-LIVE §3, but route should still render) |
| `/sales/tasks` | S | ◻ | tasks list |
| `/sales/support` | S | ◻ | own tickets only (Q4 individual) |
| `/sales/visibility` | S | ◻ | list ✅-ish; **submit deferred** — `VisibilitySubmission.partnerId` FKs ChannelPartner; sales has none (model change needed; see §2) |
| `/sales/profile` | S | ◻ | own profile |

### 1e. GIFSY platform surface (cross-tenant operator)
| Page | Audience | Status | Spec / note |
|---|---|---|---|
| `/gifsy` | G | ✅ | `gifsy/console.e2e.ts` + `overview.e2e.ts` (smoke; mock data #49) |
| `/gifsy/clients` | G | ◐ | loads; data is mock `CLIENT_REGISTRY` (#49) not real `clients` table |
| `/gifsy/clients/[slug]` | G | ◐ | `gifsy/client-detail.e2e.ts` (smoke) |
| `/gifsy/clients/new` | G | ◻ | **WRITE** — deferred (tenant-create not at launch) but route should 200 |
| `/gifsy/users` | G | ◻ | platform users |
| `/gifsy/outlet-types` | G | ◻ | global outlet-type master |
| `/gifsy/settings` | G | ◻ | platform settings |

### 1f. Cross-cutting (every protected page × every wrong role)
- ◻ **Negative matrix is sparse.** Only `partner/scoping`, `sales/scoping`, `clientAdmin/scoping`,
  `clientAdmin|clientbAdmin/cross-tenant` exist. DATA-VISIBILITY §2 demands: P/S never reach any `/admin/*`
  or `/gifsy/*`; CA never reaches `/admin/kyc/approvals`, `/admin/payouts`, or any `/gifsy/*`; CB never sees
  deoleo data on ANY data-bearing page; G is the only cross-tenant reader. Most (page × wrong-role) cells
  are unasserted — see Wave 4.

**Tally:** ~72 pages × up-to-5 audiences. Positively covered with a real data/scope/write assertion: ~12
cells. Shallow (◐): ~10. The rest (◻, the large majority) are uncovered. **MIS_USER = 0 cells** (role not
seeded/wired).

---

## 2. Write-flow inventory (highest bug-risk → prioritised)

A read test proves a page *shows* real data; a **write-persistence** test proves an action *sticks* (act →
re-read in a second session/reload). Per GO-LIVE §2.5 + §3, every write must have one. Status below:

| # | Write flow | Page(s) | Covered? | Notes / seed |
|---|---|---|---|---|
| W1 | Partner redemption (money path) | `/partner/rewards` | ✅ `partner/redemption-write.e2e.ts` | drains 500pts/run; reseed when low |
| W2 | Visibility submit (partner) | `/partner/visibility` | ✅ `partner/visibility-write.e2e.ts` | VP001 seeded |
| W3 | Support ticket raise (partner) | `/partner/support` | ✅ `partner/support-write.e2e.ts` | — |
| W4 | **Sales-assisted redemption** (#50-E) | `/sales/catalogue` | ◻ | **HIGH RISK money path.** Needs SO assigned to an outlet with a balance — seed gap: SO's outlet O001's partner CP001 HAS 50k pts, reuse it. Real backend replaced the `otp==='999999'` fake. |
| W5 | **KYC first-approve (sales)** then **Gifsy bulk-verify** | `/sales/kyc/[id]`, `/admin/kyc/approvals` | ◻ | two-stage (#38). seed-kyc-1 PENDING_GIFSY + seed-kyc-2 UNDER_REVIEW available. Prove sales-approve advances status, then Gifsy verifies; re-read in a 2nd session. |
| W6 | **Invoice generate** | `/admin/invoices/upload` → generate | ◻ | seed has CP003 APPROVED KYC + CB-2026-05 payout (₹5,000/O003) so `POST /admin/invoices/generate` yields a real invoice. Page render is covered; the WRITE is not. |
| W7 | **Scheme enrollment** | `/admin/schemes/[id]/enrollments` (+ sales-assisted #53) | ◻ | Scheme DEMO-VIS ACTIVE seeded. Prove enroll persists. |
| W8 | **Target/achievement upload** | `/admin/targets/upload` | ◻ | no-compute upload model; needs a sample xlsx fixture + re-read of the uploaded target. |
| W9 | **Credit batch upload + payout process** | `/admin/credits-payouts/upload`, `/payout` | ◻ | `payouts.processBatch` is transactional/guarded (#42) — must assert persist + no double-process. |
| W10 | **Reward catalog CRUD** | `/admin/gifts` | ◻ | create/edit/disable a reward → re-read. |
| W11 | **Outlet / user CRUD** | `/admin/users/outlets`, `/admin/outlets` | ◻ | create outlet/user → re-read; tenant-scoped. |
| W12 | **Credit-field CRUD** | `/admin/credits-payouts/fields` | ◻ | field create → re-read. |
| W13 | **Admin ticket reply** | `/admin/tickets` | ◻ | reply to a partner ticket → partner session sees it (cross-session). |
| W14 | **Banner CRUD** | `/admin/banners` | ◻ | create banner → re-read. |
| W15 | **Settings save** | `/admin/settings` | ◻ | change a tenant setting → re-read. |
| W16 | **Sales KYC create/edit** | `/sales/kyc/new`, `/[id]/edit` | ◻ | create submission → admin/gifsy sees it. |
| W17 | **Profile edit** (partner/sales) | `/partner/profile`, `/sales/profile` | ◻ | low risk; edit → re-read. |
| W18 | Sales visibility submit | `/sales/visibility` | ◻ **BLOCKED** | model change first: `VisibilitySubmission.partnerId` FKs ChannelPartner; a sales user has none. Needs nullable `submittedByUserId` (per DATA-VISIBILITY). **Out of scope for E2E until the model lands** — track as a dependency, not a spec. |

**Priority order for the build:** money + auth + irreversible first → W4, W5, W6, W9, W7, then W8/W10/W11/W12,
then W13/W14/W15/W16/W17. W18 is blocked on a backend model change (flag, don't build).

---

## 3. Phased build plan (parallel waves of DISJOINT files)

Each wave is a set of **new spec files in distinct paths** so multiple executors run in parallel with **zero
file collisions**. Specs live under `e2e/<roleDir>/` where `<roleDir>` ∈ {`clientAdmin`, `partner`, `sales`,
`gifsy`, `clientbAdmin`, `mis`} — the directory selects the storageState project in `playwright.config.ts`
(see the directory note in `clientAdmin/invoices.e2e.ts`). **New shared helpers/fixtures land once, up front
(Wave 0)** so later waves don't touch shared files.

> Effort key: S ≈ ½ day, M ≈ 1 day, L ≈ 2 days (one executor).

### 3.0 Parallel-stream map — what multiple agents can own concurrently

**"Parallel" here = parallel AUTHORING** (N agents each writing a different file at once), **not parallel
runtime** — the suite runs single-worker by design (shared live DB state; see the comment in
`playwright.config.ts`). The unit of parallelism is **one spec file = one agent**; collisions only happen on
SHARED files (seed, roles, config, helpers), which is why all shared edits are quarantined into Wave 0.

**The hard serialisation point is Wave 0.** It edits `api/prisma/seed.ts` + `e2e/fixtures/roles.ts` +
`playwright.config.ts` + new `helpers/write.ts` — every later wave imports these, so Wave 0 is **ONE agent,
no fan-out**. ⚠️ **Pre-check before Wave 0 seeding (Opus-owned, may be a serial schema step):** confirm the
`UserRole` enum already has `MIS_USER` and a sales-manager role (ASM/STATE_HEAD), and that the hierarchy
model supports a manager→SO downline. If any is missing it's a `schema.prisma` change → Opus does that
migration FIRST (executors never touch schema), then Wave 0 seeds against it.

Once Wave 0 lands, the streams below are **mutually file-disjoint and can all run at once** (bounded only by
how many executors you want to spend). Concurrency ceiling ≈ **12 streams**:

| Stream | Owns (files) | Concurrent? | Depends on |
|---|---|---|---|
| **W0** Foundations | seed.ts · roles.ts · playwright.config.ts · helpers/write.ts · fixtures/files/ | ❌ solo (shared files) | Opus schema pre-check |
| **S1** Admin finance writes | `clientAdmin/`: invoice-generate (W6) · credits-payout (W9) · scheme-enroll (W7) | ✅ (splittable into 3) | W0 helper |
| **S2** KYC two-stage (W5) | `sales/kyc-approve` + `gifsy/kyc-approve` | ✅ — **one agent owns BOTH files** (single flow: sales-approve → gifsy-verify) | W0 helper; seed-kyc-1/2 |
| **S3** Sales-assisted redeem (W4) | `sales/assisted-redemption-write` | ✅ | W0; ⚠️ runtime-shares CP001's point pool w/ partner-redeem |
| **S2a–f** Admin CRUD + reads | `clientAdmin/`: targets · gifts · outlets · credit-fields · tickets+reply(W13) · banners+settings · dashboards · visibility/schemes/tds/reports/hierarchy/sales-admin/approvals | ✅ ~6 agents, all distinct files | W0; **ticket-reply needs W0 seeded partner ticket** |
| **S3p** Partner remaining | `partner/`: rewards · orders · targets · leaderboard · payouts · profile-write · invoice-detail-scope | ✅ | W0 |
| **S3s** Sales remaining | `sales/`: outlets · team(Q4) · leaderboard · tasks · support · kyc-detail · kyc-create-write · profile | ✅ | W0; **team needs W0 manager+downline seed** |
| **S4m** MIS read-only column | `mis/*` (new dir) | ✅ | **W0 MIS seed + new project** (hard dep) |
| **S4g** GIFSY remaining | `gifsy/`: users · outlet-types · settings · clients-new · tds-194c | ✅ | W0; gifsy-real-data upgrade waits on #49 |
| **S4n** Negative/scoping matrix | extends EXISTING `partner/scoping` · `sales/scoping` · `clientAdmin/scoping` · `clientbAdmin/cross-tenant` | ✅ — splittable per-role (each file disjoint), but ⚠️ **these are the only EXISTING files anyone edits** — no other stream may touch them | W0 |

**Read it as:** after the W0 gate, hand S1/S2/S3 to 3 agents for the UAT-gating slice; the rest (S2a–f, S3p,
S3s, S4g) can run in the same parallel batch on spare executors; S4m and S3s-`team` only unblock once W0's
new seed/roles are merged. **S4n is the one stream that mutates existing files** — keep it on a single
owner (or strictly per-role) so it never races another stream.

> **Out-of-scope / flag-don't-build:** W18 sales-visibility submit (blocked on a `VisibilitySubmission`
> nullable-`submittedByUserId` model change) and the gifsy console real-data assertion (blocked on #49
> `GET /v1/gifsy/clients`). Track as dependencies, not streams.

### Wave 0 — Foundations (BLOCKS all later waves; single executor, then fan out)
> **✅ DONE + runtime-verified (2026-06-21).** Seed (`MIS_USER` 9000000004, ASM manager 9000000006 with the SO
> reporting to it + a 2nd outlet assignment, partner ticket `DEO-0001`), the `mis`/`salesManager` harness roles
> (roles.ts + auth.setup `SESSION_ROLES` + playwright projects), and `e2e/helpers/write.ts` (`tokenFor`/`authHeader`)
> all landed; schema needed **no** change (`MIS_USER`/`SALES_ASM` already exist; downline = `SalesUser.reportingToId`).
> Independent audit = SAFE-TO-PROCEED; harness `setup` ran **7/7 green** (real-form login for all roles incl. the 2 new).
> **The audit also caught + we FIXED gap #55** (the admin shell showed the demo persona "Rahul Agarwal" for every real
> admin/MIS login — the admin analog of the partner #54 fix; now reads the real JWT user + `'Rahul Agarwal'` is on the
> #40 fail-list). **Deferred to Wave 3 (audit Finding #8):** the sales shell's demo role-picker defaults to `SO`, so a
> `salesManager` spec must set/assert the role-picker state before relying on the "Team" nav (don't assume it on first render).

Shared scaffolding + seed/role gaps. Do NOT parallelise within this wave (it edits shared files).
- **Seed gaps to close** (`api/prisma/seed.ts`):
  1. **MIS_USER** for deoleo (e.g. phone `9000000004`, role `MIS_USER`, status ACTIVE) — required for the
     entire MIS read-only column. Today it does not exist.
  2. **Sales MANAGER + downline** (Q4): an ASM/STATE_HEAD over the existing SO, with the SO as a child and
     a second assigned outlet, so `/sales/team*` has real roll-up data. Today only one SO is seeded.
  3. **A partner ticket from CA's tenant** so W13 (admin reply) and `/admin/tickets` read have a row.
  4. (Optional) a second redeemable wallet so W1/W4 don't starve each other across parallel runs.
- **New role wiring** (`e2e/fixtures/roles.ts` + `setup/auth.setup.ts` `SESSION_ROLES` + a `mis` project in
  `playwright.config.ts`): add `mis` and `salesManager` role defs + storageState.
- **Shared fixtures**: a tiny xlsx/template fixture dir `e2e/fixtures/files/` (target-upload, credit-upload,
  invoice sample) — W6/W8/W9 reuse it. A `helpers/write.ts` convenience for the common "act via API with
  role token → re-read as same or other role" pattern (generalise `redemption-write`/`visibility-write`).
- Effort: **M**. Output: all later waves can run without touching shared files.

### Wave 1 — Write-persistence, money/auth/irreversible first (parallel; one file per flow)
Highest bug-risk; each is an independent file.
- `sales/assisted-redemption-write.e2e.ts` (W4) — assisted redeem for CP001's outlet → debit persists. **M**
- `gifsy/kyc-approve-write.e2e.ts` + `sales/kyc-approve-write.e2e.ts` (W5, two-stage; two files, run in
  their own role dirs so disjoint) — sales first-approve advances status; Gifsy bulk-verify finalises;
  re-read each in a 2nd session. **M**
- `clientAdmin/invoice-generate-write.e2e.ts` (W6) — generate from CB-2026-05 → invoice row persists. **S**
- `clientAdmin/credits-payout-write.e2e.ts` (W9) — upload batch + process payout, assert no double-process. **M**
- `clientAdmin/scheme-enroll-write.e2e.ts` (W7) — enroll into DEMO-VIS → persists. **S**
- Effort total: **L+**, but 5 disjoint files → ~1 day wall-clock with 5 executors.

### Wave 2 — Admin CRUD writes + remaining admin reads (parallel; disjoint files)
- `clientAdmin/targets.e2e.ts` (read) + `clientAdmin/target-upload-write.e2e.ts` (W8). **M**
- `clientAdmin/gifts-crud-write.e2e.ts` (W10) + `clientAdmin/gifts-read.e2e.ts`. **M**
- `clientAdmin/outlets-crud-write.e2e.ts` (W11) + `clientAdmin/users-outlets-read.e2e.ts`. **M**
- `clientAdmin/credit-fields-write.e2e.ts` (W12). **S**
- `clientAdmin/tickets.e2e.ts` (read) + `clientAdmin/ticket-reply-write.e2e.ts` (W13, cross-session to partner). **M**
- `clientAdmin/banners-write.e2e.ts` (W14) · `clientAdmin/settings-write.e2e.ts` (W15). **S each**
- `clientAdmin/dashboards.e2e.ts` — the 4 `/admin/dashboards/*` aggregate pages: real values + no-fabricated. **S**
- `clientAdmin/visibility.e2e.ts` · `clientAdmin/schemes.e2e.ts` · `clientAdmin/tds.e2e.ts` (194R only) ·
  `clientAdmin/reports.e2e.ts` (index + points-ledger + ticket-aging) · `clientAdmin/hierarchy.e2e.ts` ·
  `clientAdmin/sales-admin.e2e.ts` · `clientAdmin/approvals.e2e.ts` — render + real-data + no-fab. **S each**
- Effort: **L** across many disjoint files.

### Wave 3 — Partner + sales remaining reads & writes (parallel)
- Partner: `partner/rewards.e2e.ts` (standalone catalog) · `partner/orders.e2e.ts` ·
  `partner/targets.e2e.ts` · `partner/leaderboard.e2e.ts` (real own-rank, no fabricated) ·
  `partner/payouts.e2e.ts` · `partner/profile-write.e2e.ts` (W17) ·
  `partner/invoice-detail-scope.e2e.ts` (can't open another partner's invoice). **M**
- Sales: `sales/outlets.e2e.ts` (assigned scope) · `sales/team.e2e.ts` (Q4 downline — needs Wave-0 manager
  seed) · `sales/leaderboard.e2e.ts` · `sales/tasks.e2e.ts` · `sales/support.e2e.ts` (own tickets only,
  Q4) · `sales/kyc-detail.e2e.ts` · `sales/kyc-create-write.e2e.ts` (W16) · `sales/profile.e2e.ts`. **M**
- Effort: **L** across disjoint files.

### Wave 4 — MIS read-only column + GIFSY remaining + the negative/scoping matrix (parallel)
- `mis/*.e2e.ts` — MIS sees the tenant read-only: dashboard, dashboards/*, kyc (read), tickets (read),
  reports, targets, schemes — and is **WRITE-DENIED** (assert no mutate controls / 403 on a sample write)
  and **payout-DENIED** (Q1/Q5). **M** (depends on Wave-0 MIS seed).
- `gifsy/users.e2e.ts` · `gifsy/outlet-types.e2e.ts` · `gifsy/settings.e2e.ts` · `gifsy/clients-new.e2e.ts`
  (route 200; create deferred) · `gifsy/tds-194c.e2e.ts` (cross-tenant 194C, NOT on any tenant screen). **M**
  - When `GET /v1/gifsy/clients` real-data lands (#49): upgrade `gifsy/console` from mock-smoke to a
    real "sees both deoleo + clientb" assertion.
- **Negative matrix** — extend each role's `scoping.e2e.ts` (these files already exist per role, so editing
  them is disjoint per role) to cover the full DATA-VISIBILITY §2 denials:
  - partner & sales → 403/redirect on a representative `/admin/*` AND `/gifsy/*`.
  - CA → 403 on `/admin/kyc/approvals`, `/admin/payouts`, `/admin/payouts/fund`, and all `/gifsy/*`.
  - CB → no deoleo data on each data-bearing page (extend `clientbAdmin/cross-tenant.e2e.ts`).
  - Use `expectScopedOut` with `forbiddenMarkers` = the other scope's real seed strings. **M**
- Effort: **M–L**.

### Dependency order
Wave 0 → (Waves 1, 2, 3 in parallel) → Wave 4 (MIS depends on Wave-0 seed; gifsy-real-data depends on #49).
Within a wave every file is disjoint → assign one executor per file.

---

## 4. Staging-execution dependency (the OTP decision)

The harness is env-parameterised already (`fixtures/env.ts`, `helpers/otp.ts`): `E2E_ENV=local|staging`,
`E2E_OTP_STRATEGY=fixed|fetch`. The **only** unresolved staging-side dependency is the OTP source, because
**`FIXED_OTP` was REMOVED from staging on 2026-06-20 (staging now uses real MSG91)**. Two mutually exclusive
options:

- **Option A (lowest effort, recommended for the FIRST staging run): temporarily re-add `FIXED_OTP`** to the
  staging backend, then run with `E2E_ENV=staging E2E_BASE_URL=<fe> E2E_OTP_STRATEGY=fixed E2E_OTP=<value>`.
  `verify-otp` already honours `FIXED_OTP` wherever it's set (`auth.service.ts`) — no new code. Trade-off:
  weakens staging auth for the window it's set; must be removed immediately after.
- **Option B (the durable path): build the test-only OTP read-back endpoint** `E2E_OTP_FETCH_URL`
  (`E2E_OTP_STRATEGY=fetch`, the staging default). It is **unbuilt** today (the one staging-side TODO). Per
  `e2e/README.md` "OTP on staging", required shape:
  - `GET /v1/_e2e/otp?phone={phone}&clientId={clientId}` → JSON `{ "otp": "123456" }` (or `{ "code": ... }`),
    returning the **most recent un-consumed** OTP for that phone+tenant (login hydration-retry can send more
    than once → latest must win; the redeem-confirm flow also sends to the same phone).
  - **Non-prod-only**: mounted only when a STAGING/E2E flag is set; **never** deployed to prod.
  - **Secret-guarded**: requires header `x-e2e-otp-token` == a configured secret (passed via
    `E2E_OTP_FETCH_TOKEN`).
  - **Observability-only**: it *reads* an OTP the backend already generated — it does not verify, mint
    tokens, or alter the real `verify-otp` path. Prod is not weakened because it isn't mounted there.

**Recommendation:** Option A for the very first staging smoke (unblock now, prove env-parameterisation
end-to-end), then build **Option B** as the standing pre-prod gate so no auth bypass ever ships and nightly
staging runs need no manual `FIXED_OTP` toggling. Option B is a small backend unit (one guarded read-only
controller); schedule it alongside Wave 4.

**Second staging-side dependency (per README):** per-subdomain tenant routing. On staging the tenant comes
from the host/subdomain (the dev clientId override field isn't rendered in `NODE_ENV=production`). The
`deoleo` default-host roles (partner/clientAdmin/sales/mis) work off the default host; the **gifsy** and
**clientb** roles need their own subdomains to resolve `clientId`. If staging serves all tenants off one
host, close that routing gap before gifsy/clientb roles are valid on staging.

---

## 5. Definition of done — "E2E covers the app" (UAT-ready)

Two distinct gates (mirroring GO-LIVE-READINESS §2 "merge gate vs pre-prod gate"):

### LOCAL gate (merge / pre-UAT)
"E2E covers the app" is true enough to back UAT when, on `gifsy_dev`:
1. **Every page in §1's inventory has ≥1 spec** asserting (a) it renders for its intended role, (b) real
   scoped data (no fabricated, `expectNoFabricatedData` passes), (c) honest empty/forbidden where applicable
   — i.e. no ◻ cells remain for in-scope audiences. (Sales-team needs the Wave-0 manager seed; MIS needs the
   MIS seed.)
2. **Every write flow W1–W17 has a write-persistence test** (act → re-read in a 2nd session/reload) that is
   GREEN. W18 (sales visibility submit) is explicitly **deferred with a tracked backend-model dependency**,
   not counted against done.
3. **The negative matrix is closed**: for every protected page, each wrong role gets a 403/redirect/empty
   (never another scope's data); cross-tenant isolation asserted **both** directions on every data-bearing
   page (deoleo↔clientb).
4. `npm run e2e` is **GREEN** with all of the above wired, and the count materially exceeds today's ~59
   (expect ~140–180 tests across ~50+ files).

### STAGING gate (pre-prod)
The **same** specs run with `E2E_ENV=staging` GREEN, which additionally proves:
5. The OTP seam works on staging (Option A or B from §4) — login + every OTP-gated write (redeem, KYC
   verify) pass against real-MSG91-or-FIXED.
6. Per-subdomain tenant routing resolves gifsy/clientb correctly (or those roles are explicitly scoped out
   of the staging run with the routing gap logged).
7. No env-specific reds (config/secret/migration drift). Then GO-LIVE-READINESS §3's
   "E2E matrix 100% green" box can finally be checked.

UAT can begin on the **LOCAL gate**; the **STAGING gate** is required before the prod-cutover sign-off (and
before pointing real Deoleo users at it).

---

## 6. Recommended sequence vs UAT

**Recommendation: build coverage in PARALLEL with the owner's manual UAT, but front-load the write waves so
the money/auth/irreversible paths are machine-verified BEFORE the owner exercises them by hand.**

Rationale:
- The owner's intent is explicitly "automated matrix covers the app FIRST, so UAT isn't where bugs surface."
  Taken literally that gates UAT on full coverage — but full coverage is ~50 files (Waves 0–4) and UAT is
  imminent. Gating entirely would stall UAT for days.
- The risk the owner actually cares about is **silent data/scope/money bugs**. Those live almost entirely in
  the **write flows** (§2) and the **scoping/cross-tenant** matrix (§1f). Reads that merely render the wrong
  number are loud and obvious in manual UAT; a redemption that double-debits or a tenant that leaks another's
  data is exactly what a human pass misses.

Concrete sequence:
1. **Gate UAT on Wave 0 + Wave 1 + the Wave-4 negative/scoping matrix only.** These are the money/auth/
   irreversible writes and the isolation guarantees — the bug classes a human can't reliably catch. This is
   ~1–1.5 days with parallel executors.
2. **Run Waves 2 + 3 (the read coverage + lower-risk CRUD) CONCURRENTLY with the owner's manual UAT.** If a
   read renders wrong, both the human and the (soon-after) automated test catch it; no need to block.
3. **Stand up the STAGING gate (§4 Option A now, Option B as the durable follow-up) before prod cutover** —
   not before UAT. Local-green is sufficient to start UAT with confidence.

Net: UAT is gated only on the high-leverage slice (Waves 0/1 + negative matrix), the rest fills in alongside,
and the staging gate closes before prod — satisfying the owner's intent without stalling the launch.
