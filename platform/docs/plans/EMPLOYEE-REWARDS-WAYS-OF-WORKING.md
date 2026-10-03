# Employee Rewards — Ways of Working (process, rules & doc index)

> **Status: AUTHORITATIVE for how the employee-rewards build is run.** Created 2026-10.
> **Companions:** [EMPLOYEE-REWARDS-DESIGN.md](./EMPLOYEE-REWARDS-DESIGN.md) ·
> [EMPLOYEE-REWARDS-ADMIN-DESIGN.md](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md) ·
> [EMPLOYEE-REWARDS-BUILD-PLAN.md](./EMPLOYEE-REWARDS-BUILD-PLAN.md).
> **The principle:** employee rewards is a **second product on the SAME platform/repo**, so it
> **inherits Loyaltybase's engineering discipline in full**, **curates out** the trade-specific
> *product* rules, and **adds** a few employee-specific ones. Most of the process is inherited *by
> construction* (same CI, same gates, same scripts) — this doc is the map of what applies, what's
> adapted, and what does not.

---

## 0. TL;DR
- **INHERIT as-is:** the gates, git/deploy workflow, the orchestration + gate model, the runtime
  Verification Protocol, TDD, the doc-consistency gate, migration discipline, environments, the
  runbooks, and the security/ops/perf/concurrency acceptance axes. Same repo ⇒ inherited automatically.
- **ADAPT:** the verification **role matrix** and **data-visibility** (employee roles + hierarchy
  scoping, no outlet/partner); a **curated UAT checklist**; a **living-state brief**; DLT applies to
  *employee* comms templates.
- **EXCLUDE (trade-only product rules — never force-fit):** KYC, GST/PAN/GSTIN, TDS (194R/194C),
  payouts/settlement/UTR, self-bill invoicing, outlets/multi-outlet, POSM/visibility, and the **trade
  Points Compute Engine** (employee = bulk upload, no compute).
- **ADD:** the 5 safety disciplines (loyaltyType gate, additive migrations, no-ungated-shared-change,
  full gates + boot smoke, Deoleo staging regression), worktree isolation, DUAL audit on the
  credit/upload boundary.

---

## 1. INHERIT — universal engineering process/rules (apply in full)

These govern *how engineering is done on this platform*, independent of product. They apply to the
employee-rewards build unchanged; link to them, don't restate.

| Inherited rule / process | Governs | Source |
|---|---|---|
| **Standing agreements** (clarify-before-build · trace all consumers · orchestrate · verify-at-runtime · doc+memory consistency) | how we work | [`../../CLAUDE.md`](../../CLAUDE.md) |
| **Gates** — `cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` · `cd platform && npx tsc --noEmit`, **full, before every push** (a red suite silently skips the staging deploy) | merge/push gate | `CLAUDE.md` · [`staging-deploy-gate`](memory) |
| **Git/deploy workflow** — `develop`→staging (auto), `main`=manual release, revert/rollback | branching/deploy | [`GIT-WORKFLOW.md`](./GIT-WORKFLOW.md) |
| **Orchestration + gate model** — parallel disjoint waves, pipeline the audits, batch the gate, **AUDIT EVERYTHING (no risk-tier)**, model assignment, orchestrator/executor/auditor contract, the gate checklist, context bundles, throughput limiter | how the build runs | [`08-agent-execution-guide.md`](./08-agent-execution-guide.md) |
| **Verification Protocol — the Definition of Done** (the 6 runtime checks; real login per role; a persona switcher never counts) | "done" | [`VERIFICATION-PROTOCOL.md`](./VERIFICATION-PROTOCOL.md) (role matrix adapted §4) |
| **TDD / test style** — RED→GREEN→REFACTOR; pure-fn tests preferred; Prisma-testing rules | tests | [`01-how-we-test.md`](./01-how-we-test.md) |
| **Doc-consistency gate** — `scripts/check-doc-consistency.mjs` (CI + wave gate); trigger events; ownership map | docs don't drift | [`DOC-MAINTENANCE.md`](./DOC-MAINTENANCE.md) (nuance §8) |
| **Migration discipline** — additive forward-only files, `migrate deploy` via the in-VPC Cloud Run Job, staging auto-migrates on `develop` push, prod gated; never `db push`/`migrate dev` on staging/prod; `prisma generate` before gating a schema change | DB | [`MIGRATIONS.md`](./MIGRATIONS.md) · [`DEV-DB.md`](./DEV-DB.md) |
| **Environments** — 3 envs; `FIXED_OTP=123456` local+staging (prod real MSG91); zero-touch tenant hosts | envs | [`ENVIRONMENTS.md`](./ENVIRONMENTS.md) |
| **Ops runbooks** — cutover, prod DB migration, owner-ops, prod data load | go-live ops | [`runbooks/`](./runbooks/) |
| **Role → scope visibility model** (the "expected" the E2E harness asserts) | scoping | [`DATA-VISIBILITY.md`](./DATA-VISIBILITY.md) (employee role→scope adapted §4) |
| **Acceptance axes beyond functional** — security (IDOR/mass-assignment/XSS/CSV-injection/token), performance/scale, concurrency/resilience, operational readiness (backups/PITR, prod-backdoor sweep, observability, rollback), real-data-load | go-live quality | [`UAT-CHECKLIST.md`](./UAT-CHECKLIST.md) §12–§19 (curated in our checklist) |

> ⚠️ **Gate currency (important):** the gate above is the **full-green 4-command suite** (per `CLAUDE.md` +
> the trade `RESUME.md`, which now cites green jest counts). The **"differential gate / no NEW reds vs a
> baseline snapshot"** language in [`GIT-WORKFLOW.md`](./GIT-WORKFLOW.md) §Current-blocker and
> [`08-agent-execution-guide.md`](./08-agent-execution-guide.md) §"The gate is DIFFERENTIAL" is **historical**
> (the P4–P8 red-by-design era is over). **Use full-green** — do not apply the weaker differential gate.

---

## 2. ADAPT — same practice, employee specifics

- **Verification role matrix** → employee roles (§4), not partner/SSS/outlet.
- **Data visibility (role→scope)** → employee roles + **reuse the sales-hierarchy scoping**; no
  outlet/partner/KYC/payout scopes (§5).
- **UAT acceptance** → [EMPLOYEE-REWARDS-UAT-CHECKLIST.md](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) — curates
  the Deoleo checklist: keeps auth/RBAC/isolation/nav/security/perf/concurrency/ops/real-data-load; adds
  points-upload/contests/liability/redemption; **drops KYC/TDS/payout/GST/invoicing**.
- **Living-state restart brief** → [EMPLOYEE-REWARDS-RESUME.md](./EMPLOYEE-REWARDS-RESUME.md) (our
  RESUME-equivalent; bootstrapped at Phase 0, kept current each wave).
- **DLT/MSG91** → applies to the *employee* comms templates (OTP, the locked Contest Alert, expiry
  reminders) — still a prod go-live gate, just our templates, not the trade ones.

## 3. The 6-check role matrix, applied (our roles)

Real login per role (`FIXED_OTP=123456` on staging/local), per `VERIFICATION-PROTOCOL.md`:
- **Program Admin** (Britannia, tenant-wide) · **Regional Admin** (subtree-scoped via `/sales/**`) ·
  **Employee / rep** · **Gift Vendor** (hard-scoped to own orders) · **GIFSY operator** (assume-tenant)
  · **+ a Deoleo TRADE user** — to prove cross-tenant isolation and that **Deoleo is unaffected** (the
  cutover gate).
- All 6 checks apply: canonical surface · role matrix (succeeds/refuses honestly) · **cross-tenant
  (Deoleo↔Britannia)** · persistence + observation (a different session sees the write) · unhappy path
  honest · data realism (≥2 roles, a record made by a different actor).

## 4. Employee data-visibility (role → scope)

| Role | Scope |
|---|---|
| **GIFSY operator** | cross-tenant (platform) un-assumed; **scoped to the tenant when assumed** (`platformWide()`) |
| **Program Admin** (Britannia) | their whole tenant (employees/points/contests/gifts/orders/liability) |
| **Regional Admin** | their **hierarchy subtree** only (`descendantSalesUserIds`) |
| **Employee / rep** | **only their own** wallet / orders / contests |
| **Gift Vendor** | **only their own** gift orders (hard-scoped, IDOR-critical) |

No `ChannelPartner`/outlet/KYC/payout scopes exist in this world.

---

## 5. EXCLUDE — trade-only product rules (do NOT force-fit)

Permanently out of scope for `EMPLOYEE_REWARDS` (the `loyaltyType` gate keeps them off):
KYC (two-stage + classification), GST/PAN/GSTIN, **TDS (194R/194C, gross-up)**, payouts/settlement/UTR,
self-bill invoicing, outlet master + multi-outlet groups, POSM/visibility geo-fence, and the **trade
"Points Compute Engine"** (configurable calc on `develop` — employee uses bulk upload, no compute).
→ The matching **UAT sections do not apply** (Deoleo §2 KYC, §5 money-settlement/payouts, §6 TDS/
invoicing, and the trade-specific rows of §10/§16). The matching **ownership-map fact-domains** (trade
finance, KYC tracks) are N/A.

## 6. ADD — employee-specific rules (the safety spine)

From [BUILD-PLAN §3](./EMPLOYEE-REWARDS-BUILD-PLAN.md):
1. **Everything new sits behind the `loyaltyType` capability gate** (additive + dormant for Deoleo).
2. **Migrations additive + backward-compatible** (`prisma generate` before gating a schema change).
3. **No shared-behaviour change ships ungated** (shared service/component edits are flagged/Deoleo-checked).
4. **Full green gates before every merge + a boot smoke** (a new dep/import not in `package.json` = green
   gates but boot crash; prefer `node:` builtins).
5. **Staging Deoleo regression before any cutover** (the pre-cutover checklist, BUILD-PLAN §3.3).
- **Build in a dedicated git worktree**, isolated from the active **trade Points Compute Engine** work on
  `develop` (its own `er/*` lane branches; never the primary checkout where the trade WIP lives).
- **DUAL adversarial audit** on the **credit/upload money boundary** and on redemption.
- **Cross-tenant isolation proof (Deoleo↔Britannia)** is a cutover gate.

## 7. Doc-consistency — the one nuance for a two-product repo

`scripts/check-doc-consistency.mjs` scans **all** `docs/**/*.md` for retired terms. ⚠️ **"compute engine"
is retired for employee rewards but ACTIVE for the trade Points Compute Engine** — so **do NOT add it to
the global `RETIRED_TERMS`** (that would false-flag the live trade docs). The employee docs annotate "no
compute engine" **inline** instead. General rule: when employee rewards retires a term that trade still
uses, handle it with a **local annotation**, never the global retired-terms list.

## 8. Employee-rewards doc set — ownership map (single source of truth per fact)

| Fact-domain | Source of truth |
|---|---|
| Earner model · `loyaltyType` · unified `RewardAccount` · three surfaces | [`EMPLOYEE-REWARDS-DESIGN.md`](./EMPLOYEE-REWARDS-DESIGN.md) |
| Admin surface (capability-gated cockpit, module-by-module) | [`EMPLOYEE-REWARDS-ADMIN-DESIGN.md`](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md) |
| Execution · branching · safety gates · go-live · timeline | [`EMPLOYEE-REWARDS-BUILD-PLAN.md`](./EMPLOYEE-REWARDS-BUILD-PLAN.md) |
| **Process / rules (this doc)** | **`EMPLOYEE-REWARDS-WAYS-OF-WORKING.md`** |
| Go-live acceptance | [`EMPLOYEE-REWARDS-UAT-CHECKLIST.md`](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md) |
| Living-state restart brief | [`EMPLOYEE-REWARDS-RESUME.md`](./EMPLOYEE-REWARDS-RESUME.md) |
| Locked decisions | BUILD-PLAN §11 / ADMIN-DESIGN §12 |
| Visual/UX target | `britannia-rewards-demo` (`docs/PROJECT-LOG.md`) |
| Everything *engineering-process* | the inherited universal docs (§1) |

Doc-consistency is owned by the orchestrator and swept every wave (DOC-MAINTENANCE), across this set.

## 9. Human gates (escalate — never guess) — inherited + one addition

Inherited (08-agent-execution-guide): design decisions / spec-vs-code conflicts · **migrations + any
prod/`main`/deploy action** · UI visual sign-off · the proxy / token↔tenant boundary. **Employee
addition:** the **cutover Deoleo-regression sign-off** (proof Deoleo is unaffected) before `main`.

---

*Inherit the discipline, curate out the trade product rules, add the gate. Same platform, two curated
products — the process is shared, the product rules are not.*
