# Employee Rewards — Execution / Build Plan (Britannia anchor)

> **Status: PLAN — how we build & ship the Britannia employee-rewards product.**
> Created 2026-10. **Companions:** [EMPLOYEE-REWARDS-DESIGN.md](./EMPLOYEE-REWARDS-DESIGN.md) (earner
> model + three surfaces) · [EMPLOYEE-REWARDS-ADMIN-DESIGN.md](./EMPLOYEE-REWARDS-ADMIN-DESIGN.md)
> (admin surface). Read those for *what* we build; this doc is *how* we build it, in what order, on
> which branches, with which safety gates, and how we go live without touching Deoleo.
> **Process / rules authority:** [EMPLOYEE-REWARDS-WAYS-OF-WORKING.md](./EMPLOYEE-REWARDS-WAYS-OF-WORKING.md)
> (inherit/adapt/exclude map) · acceptance [EMPLOYEE-REWARDS-UAT-CHECKLIST.md](./EMPLOYEE-REWARDS-UAT-CHECKLIST.md)
> · restart brief [EMPLOYEE-REWARDS-RESUME.md](./EMPLOYEE-REWARDS-RESUME.md).
> **Audience:** an engineer who knows this platform but was not in the design discussion.

---

## 0. TL;DR — how we execute

- **Orchestrated build**: parallel sub-agents write code per lane; I integrate, run the full gates,
  run the independent adversarial audit, and runtime-verify. You do per-role UAT and give the prod go.
- **On `develop`, never on `main`.** Short-lived per-lane branches merge into `develop` continuously
  (daily-ish). `main` only receives the owner-gated prod cutover at pilot go-live.
- **Additive + gated**, so Deoleo is never at risk: every new path sits behind the `loyaltyType`
  capability gate; migrations are additive + backward-compatible; nothing ungated changes shared
  behaviour. Staging is the regression net before any cutover.
- **Pilot-first**: one region, **bulk points upload (no compute)**, a trimmed gift catalogue →
  **~8–10 weeks to production pilot go-live**. National rollout afterwards is mostly configuration.
- **Foundation is already live** (`Client.loyaltyType` + unified `RewardAccount`, #35), so we build
  the **three surfaces** (employee app, admin, vendor portal) on a reused engine — not from scratch.

**Per-unit loop (every work item):** agent builds → I run FULL gates → runtime-verify per role →
independent adversarial audit (DUAL for any money/liability/identity path; UI/UX lane for user-facing)
→ merge to `develop` → staging auto-deploy → staging regression incl. Deoleo flows → owner UAT →
(at phase/pilot boundary) owner-gated prod cutover.

---

## 1. Scope

**Already in place — reuse (do not rebuild):**
`loyaltyType` + `RewardAccount` earner model (live, dormant); points ledger / wallet / expiry
(`Wallet`/`WalletTransaction`/`PointsLedger`); reward catalogue + OTP-gated redemption; gift
dispatch/fulfilment + the 3P vendor portal (Gift Catalogue Waves 0–2); notifications fabric +
templates + broadcasts + delivery reporting; RBAC Option-X; `program_settings`; admin-dashboard
framework; `SalesUser` hierarchy + scoping helpers; phone-OTP auth; zero-touch tenant hosts.

**To build (net-new or reshaped):** points & contest crediting (reuse of the no-compute upload, Employee-Code-keyed — **no compute engine**); Contests; points-liability/budget finance; the employee rep-app surfaces
(wire to real backend + Dream Reward + contest screens + theming); capability-gated admin shell; curated
engagement analytics; T&C/privacy/help content. *(The employee roster + regional scoping are **reuse**, not
new — the existing employee-hierarchy upload/edit and `/sales/**` hierarchy scoping.)*

**Out of scope — permanently for `EMPLOYEE_REWARDS`:** KYC, GST/PAN/GSTIN, TDS (194R/194C), self-bill
invoicing, cash payouts, outlet/multi-outlet groups. The gate keeps these off.

---

## 2. Guiding principles (non-negotiable, from the standing agreements)

1. **Clarify before an imperfect build** — forks go to the owner first (see §11), not shipped behind a caveat.
2. **A fix/feature is DONE only when every consumer + alternate path + scale case is traced.**
3. **Orchestrate** — decompose into parallel lanes; I personally run the gate + audit + runtime-verify.
4. **Verify at runtime** — end-to-end, real login per role; never on `tsc`/tests alone.
5. **Independent adversarial audit on every item** — a fresh agent whose only job is to find defects;
   **DUAL** for money/liability/identity/destructive; a UI/UX lane for anything user-facing.
6. **Run the FULL gates; never trust a piped exit code.** A red suite silently skips the staging deploy.
7. **Own doc + memory consistency in the same pass.**
8. **Never defer unilaterally; never take irreversible action unasked** — no merge to `main`, no prod/
   staging DB op, no cutover without the owner.
9. **Additive + gated** — the safety spine (§3).

---

## 3. Branching, gating & migration safety (the safety spine)

### 3.1 Branch model
- `main` = production (Deoleo live). **No build work, ever.** Receives only the owner-gated cutover.
- `develop` = integration; auto-deploys to **staging**. Everything converges here.
- **Lane branches** off `develop`, short-lived (≤ a couple of days): e.g. `er/people`,
  `er/performance`, `er/contests`, `er/rep-app`, `er/liability`, `er/vendor`. One agent per lane.
  Frequent small merges into `develop`; I keep `develop` green.

### 3.2 The five disciplines that make "gated" actually safe
The `loyaltyType` gate only guards *new runtime branches*. These five, together, are what guarantee
existing clients are untouched:
1. **Everything new stays strictly behind the `loyaltyType` / capability gate.** No ungated behaviour.
2. **Migrations are additive + backward-compatible** — new tables / nullable columns only. No
   rename / drop / NOT-NULL / type-change / locking backfill against shared tables. (`prisma generate`
   before gating any schema change.)
3. **No shared-behaviour change ships ungated** — if a feature must edit a shared service/component
   (wallet, catalogue, auth guard, admin shell), that change is behind a flag or proven non-regressive
   with a Deoleo runtime check.
4. **Full green gates before every merge** — `cd api && npx jest --no-coverage` · `cd api && npx nest
   build` · `cd platform && npx vitest run` · `cd platform && npx tsc --noEmit`. (Gates do NOT boot the
   DI container or catch a new dep missing from `package.json` — a bad import = green gates but boot
   crash; add a boot smoke check.)
5. **Staging regression on Deoleo flows before any prod cutover** (the E2E harness, real-login-per-role).

### 3.3 Pre-cutover checklist (every cutover must pass)
- [ ] Full gates green on the exact `main` SHA being deployed.
- [ ] Migrations reviewed: additive-only, reversible, no lock on shared tables.
- [ ] Boot smoke on staging (API comes up; `send-otp` empty → 400, not 500).
- [ ] **Deoleo regression on staging**: trade login per role, wallet, redemption, KYC/credits unaffected.
- [ ] New employee tenant verified on staging host (`uat-britannia.gifsy.in`), dormant for Deoleo.
- [ ] Owner UAT sign-off.
- [ ] Deploy via `deploy.yml` `workflow_dispatch` → **verify the SERVING image SHA via gcloud** (not
      branch HEAD) + revision Ready + 100% traffic.
- [ ] GitHub Actions billing confirmed un-blocked (see §8) before relying on the run.

---

## 4. The orchestration model (who does what)

- **Sub-agents** (one per lane) write code against their lane branch to the design docs.
- **I (integrator)** own: decomposition, integration, the FULL gates, the independent adversarial
  audit, runtime verification, keeping `develop` green, and the pre-cutover checklist. I hand you a
  verified conclusion, not a pile of agent output.
- **You (owner)** own: the §11 decisions, per-role UAT (the real OTP logins), the prod go, and the
  external dependencies (§8).
- **Parallelism has a ceiling:** adding agents speeds the *widest* lane, but the critical path is my
  integration/audit throughput + your UAT availability — past a point, more agents just create review
  queue, not a sooner date. We size lanes to that ceiling, not beyond.

---

## 5. Phased build plan (lanes, deliverables, exit criteria)

Phase 0 is sequential (it unblocks everything). Workstreams 1–3 then run in parallel; Phase F folds
them together and ships the pilot.

### Phase 0 — Decisions + scaffolding (week ~0)
- **Work:** (§11 decisions are now LOCKED — see §11); confirm pilot scope (§9); scaffold the capability-gated shell +
  `loyaltyType` flags; set up lane branches + the pre-cutover checklist; stand up the staging
  `uat-britannia` tenant (zero-touch host).
- **Exit:** decisions locked; a Britannia tenant exists on staging showing an (empty) employee nav;
  Deoleo nav unchanged on staging.

### Workstream 1 — Admin cockpit (the ADMIN-DESIGN phases)
- **A — Shell + People** (capability-gated shell; roster = **reuse** the existing employee-hierarchy Excel
  upload + per-employee edit, keyed by `employeeCode`; wire the `EMPLOYEE` RewardAccount linkage).
  *Exit:* a program admin logs in, sees only employee nav, manages the roster via the existing upload;
  regional scoping reuses `/sales/**`.
- **B — Rewards + Fulfilment + Vendors** (reskin the Gift Catalogue/Dispatch + vendor portal;
  Dream-eligible flag; employee shipping). *Exit:* gift can be curated → redeemed → fulfilled on staging.
- **C — Points crediting + Contests** (bulk points upload → ledger credits, keyed by Employee Code,
  reusing the no-compute credit-batch; optional target column; contest builder with region/beneficiary,
  bonuses credited via the same upload — **no compute engine**). *Exit:* an upload credits points to
  employee wallets; a contest runs end-to-end and credits bonus. **DUAL-audited (the credit/upload boundary).**
- **D — Communications + Insights + Liability** (employee trigger set incl. locked Contest Alert;
  curated engagement dashboards; points-liability/budget views). *Exit:* program is run-able; liability
  reconciles to the ledger. **Liability = DUAL-audited.**
- **E — Content + regional RBAC** (T&C/Privacy/help content; Regional Admin scoped to a hierarchy
  subtree). *Exit:* regional admin sees only its subtree; content renders in the app.

### Workstream 2 — Employee rep app (parallel)
- Wire auth + wallet + rewards + redemption + orders to the real backend (mostly reuse); build Dream
  Reward + forecast + contest screens; bell/profile/support (Employee-Code reference); theming to the
  `britannia-rewards-demo` visual target. *Exit:* a rep logs in and completes earn→see→redeem→track
  on real data, per role, on staging. **Redemption = DUAL-audited; UI/UX audit lane throughout.**

### Workstream 3 — Vendor portal (parallel, light)
- Reskin/config the existing hard-scoped vendor portal for the employee context; confirm
  moderation + consent/retention + suspend-cascade. *Exit:* a test vendor sees only its orders, uploads
  a (moderated) product, enters tracking.

### Phase F — Integration, hardening & pilot go-live
- Integrate lanes on `develop`; full cross-surface runtime pass per role + cross-tenant isolation
  (Deoleo ↔ Britannia) proof; pilot data import dry-runs; prod OTP/notification config; run the
  pre-cutover checklist (§3.3); **owner-gated cutover to `main`**; post-cutover smoke + serving-SHA
  verify. *Exit:* pilot region live and verified; Deoleo unaffected (proven, not assumed).

---

## 6. Critical path & timeline

With the points-compute engine gone, Phase C is now mostly reuse, so the **rep-app lane (~3–4 w) is the
longest pole**. Foundation (done) → rep-app lane (~3–4 w) overlapping **Phase C (points-upload +
Contests, ~1.5–2 w)** → integration + audit (~1.5 w) → hardening + UAT (~2 w). Workstream 3 (vendor) and
the lighter admin phases (A, B, D, E) tuck inside the slack. That lands at **~8–10 weeks to pilot
go-live** (down from ~9–12 before we dropped the compute engine); ~5–7 weeks to a role-testable staging
build. (See the earlier estimate discussion for the lane-vs-sum reasoning: orchestration shrinks the
build lanes, not the verification/UAT tail.)

---

## 7. Verification strategy (applied to every item, not just at the end)

1. **Gate** — the four full suites above, run clean (never via a piped/`tail`'d exit code).
2. **Runtime-verify** — end-to-end through the real interface, **real login per role** (program admin,
   regional admin, rep, vendor, + a Deoleo trade user for isolation). OTP is `123456` on staging/local.
3. **Independent adversarial audit** — a fresh agent per item with a concrete failure scenario for each
   finding. **DUAL** for points crediting (the upload→ledger boundary), Contests, redemption, liability.
4. **Staging E2E** — the Playwright go-live harness (`platform/e2e`, `npm run e2e`), real-login-per-role,
   fabricated-data fail-list, scoping checks — **including a Deoleo regression lane** as the cutover gate.

---

## 8. Data & external dependencies (owner-side — these often set the real date)

- **Employee master + ASM→ASE→rep hierarchy + the point credits themselves (+ optional targets)** (for
  People + Points upload). Most common blocker; needed before meaningful UAT.
- **Gift vendors onboarded + catalogue stock** (so reps can actually redeem in the pilot).
- **Prod comms credentials**: real MSG91 OTP + **DLT-approved** SMS/WhatsApp templates (lead time
  outside our control) for the locked Contest Alert and expiry reminders.
- **UAT availability** — your per-role logins pace the final ~2 weeks.
- **GitHub Actions billing** — repo is private (Actions metered). If the spending-limit/billing block
  recurs, deploys (staging push *and* prod cutover) re-block with the same error; confirm billing fixed
  + set a spending limit before the pilot window. (Workaround-of-last-resort = temporarily public.)

---

## 9. Pilot scope & go-live / cutover

- **Pilot = one ASM area**, a defined employee set, a trimmed gift catalogue, **bulk points upload**
  (no compute), a small set of gift vendors. Deliberately narrow to de-risk §8 on a small group.
- **Tenant onboarding is zero-touch**: prod `britannia.gifsy.in` + staging `uat-britannia.gifsy.in` under
  the `*.gifsy.in` wildcard via the `gifsy-proxy` worker — console-only, no infra work.
- **Cutover**: Actions → "Deploy — Production (main)" `workflow_dispatch`; then verify the **serving**
  Cloud Run image SHA via gcloud + revision Ready + 100% traffic; boot smoke; Deoleo smoke.
- **Rollback**: prod & staging build separate images per SHA; roll traffic back to the prior Deoleo-only
  SHA if the smoke fails. (Employee code is dormant for Deoleo, so a rollback never risks trade data.)
- **National rollout** (post-pilot): more regions/vendors + support ramp — mostly configuration,
  +2–4 weeks, not new engineering.

---

## 10. Risk register (top risks → mitigation)

| Risk | Mitigation |
|---|---|
| Shared-code edit regresses Deoleo | §3.2 disc. 3 + Deoleo staging regression as cutover gate |
| Non-additive migration breaks shared DB | Additive-only rule + migration review in pre-cutover checklist |
| New dep / bad import = boot crash (green gates) | Boot smoke on staging; check `package.json`; prefer `node:` builtins |
| Point credits / roster data not ready | Pilot uses bulk upload; owner data-readiness tracked from Phase 0 |
| DLT/MSG91 template lead time | Start template registration in Phase 0 (long pole, owner-side) |
| Deploy blocked by Actions billing | Confirm billing + spending limit before pilot window (§8) |
| Scope creep (national before pilot proven) | Pilot-first; national is config, gated behind pilot sign-off |
| Money/liability defect | DUAL adversarial audit on every money/liability item |

---

## 11. Decisions — LOCKED (owner, 2026-10-02)

1. **Points crediting = bulk upload, no compute.** Points + contest bonuses are uploaded via the existing
   no-compute credit-batch (Employee-Code-keyed → `EMPLOYEE` RewardAccount). No compute engine, no DMS/SFA feed.
2. **Target column = INCLUDE** — upload an (optional per-row) target-points column per employee/period for
   the display-only achievement / "Potential" view (as in the demo).
3. **Roster = REUSE the existing employee-hierarchy upload + maintenance** (already built; keyed by
   `employeeCode`). HRMS/API feed = optional later integration, not a pilot dependency.
4. **Admin operator = BOTH** — Gifsy central + Britannia scoped self-serve (Program Admin + Regional Admins).
5. **Regional admin = REUSE the existing `/sales/**` hierarchy scoping** — reach = the admin's node subtree;
   no separate region model.
6. **Field execution (POSM) = OUT of pilot**; later opt-in capability, not default.

---

## 12. Definition of done — pilot go-live

- [ ] All three surfaces exercised end-to-end, real login per role, on staging then prod.
- [ ] Cross-tenant isolation proven: Britannia ↔ Deoleo, no leakage; Deoleo flows unchanged.
- [ ] Money/liability paths DUAL-audited; audit findings closed.
- [ ] Pilot employees + hierarchy + targets imported; gifts + vendors live; comms templates approved.
- [ ] Pre-cutover checklist (§3.3) passed; serving prod SHA verified via gcloud.
- [ ] Owner UAT sign-off recorded; rollback path confirmed.
- [ ] Docs + memory updated in the same pass (this plan, the two design docs, the go-live record).

---

*How = this doc. What = the two design docs. Visual target = `britannia-rewards-demo`.
§11 decisions are LOCKED (owner, 2026-10-02); nothing here starts until the owner gives the go.*
