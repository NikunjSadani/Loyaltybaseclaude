# Go-Live Readiness — the enforcement mechanism + the gate

> Created 2026-06-19. Documentation alone is **passive** and gets shortcut (proven repeatedly this session).
> "Done / ready to ship" must be **enforced by something executable**, not trusted to a checklist. This doc
> defines (1) the intent, (2) the automated enforcement, (3) the readiness gate, (4) who does what.
>
> 📋 **Complement:** what we deliberately deferred to *after* launch lives in
> [`POST-GO-LIVE-BACKLOG.md`](POST-GO-LIVE-BACKLOG.md). This doc = launch **blockers**; that doc = **fast-follows**.

## 1. Intent (the bar)
A **green comprehensive run on local dev must mean we can push `develop` expecting it to pass staging → prod with
no surprises.** No half-baked merges. Comprehensive ≠ "a representative sample" — it is **every page × every role**,
asserting real scoped data, honest errors, no fabricated values. If a page or role isn't covered, it is **OPEN**,
not "done".

## 2. The enforcement = an automated E2E harness (not a doc)
Build a **Playwright** E2E suite that **is** the `DATA-VISIBILITY.md` matrix, executable:

For **each role × each page**:
1. Log in as that role through the real stack (FE→proxy→backend). *(Local: `FIXED_OTP=123456`. Staging: real MSG91 — the suite handles both; see env-parameterisation below.)*
2. Load the page; assert it renders the **expected real data** for that role/tenant (from `DATA-VISIBILITY.md`).
3. Assert it shows **NO known-fabricated values** (e.g. `8,550`, `248`, `4,821`, `2,947`, `Rajesh Kumar`) — a hard fail-list that catches demo leftovers (gap #40).
4. Assert **role scoping**: a role that should NOT see a thing gets an honest 403/empty (gap #41); a partner sees only its own; an admin sees the whole tenant; cross-tenant data never leaks (gap #6/Q6).
5. For write flows: perform the action, assert it **persisted to the DB** and a different session sees it (no fake success).

**It fails CI when a page fabricates, a scope leaks, or a flow doesn't persist** — the enforcement no human can shortcut. `tsc` + unit tests remain necessary, never sufficient (`VERIFICATION-PROTOCOL.md`).

### Env-parameterised (encodes the local↔staging intent)
The same suite runs against **local** (`BASE_URL=http://localhost:3000`, `OTP_MODE=fixed`) and **staging**
(`BASE_URL=<staging>`, `OTP_MODE=msg91`, real subdomains → real `clientId` resolution). A green **local** run is the
merge gate; a green **staging** run is the pre-prod gate. (This is *why* `ENVIRONMENTS.md` lists the local↔staging
differences — the harness must not assume `FIXED_OTP`/`localhost` semantics.)

### CI integration
- Add the E2E job to CI: run the harness on every PR/`develop` push (spins up the stack + seeded `gifsy_dev`-shape DB).
- A nightly/pre-prod job runs it against **staging**.
- Deploy to prod (`main`) stays behind the existing required-reviewer gate **and** a green staging E2E.

## 3. Readiness gate (broader than pages — all must be ✅ before go-live)
- [ ] **Auth:** login works for **all roles** (real flow), route-by-role correct, logout clears session. *(GIFSY broken #39)*
- [ ] **RBAC + tenant isolation:** every endpoint role+tenant scoped to the `DATA-VISIBILITY.md` audience; cross-tenant never leaks; the Gifsy operator can reach the cross-tenant data it must (#38/#41). RBAC enablement decided (`RBAC-ENABLEMENT.md`).
- [ ] **No fabricated data anywhere** — the E2E fail-list passes on every page (#40).
- [ ] **Money-path integrity:** wallet/credits/redemption/payouts/TDS verified end-to-end per role; `payouts.processBatch` transactional+guarded (#42); BigInt-paise throughout; double-spend/oversell audited.
- [ ] **Every write flow persists** (no fake success) — KYC approve, redemption, visibility submit, invoice generate, tickets (#36/#38).
- [ ] **Environments configured + seeded:** staging has a known seeded dataset + the current schema; secrets set; `staging` E2E green.
- [ ] **Excel round-trips** work (download→fill→upload) where applicable (#44).
- [ ] **Observability** baseline (logs/metrics/alerts) (#27 → P8.4) — at least error visibility before prod.
- [ ] **The E2E matrix is 100% green** (every `DATA-VISIBILITY.md` row covered, no OPEN cells).

## 4. Who does what
- **Owner:** answer the 🟦 product decisions in `DATA-VISIBILITY.md §3` (who-sees-what); confirm when to run E2E against staging + staging access.
- **Me (orchestrator):** write `DATA-VISIBILITY.md` (done, skeleton) → build the Playwright harness → wire CI → run local (then staging) → fix/log every failure (gap-register with WHEN) → keep RESUME/memory current.
- **Continuity:** RESUME's post-compact prompt + memory carry this plan + state so a fresh session continues seamlessly.

## 5. Sequence
1. Owner answers `DATA-VISIBILITY.md §3`. 2. Build the Playwright harness (the matrix). 3. Run local → fix every red
(real-data, scoping, persistence). 4. Run staging → fix env/config-specific reds. 5. Readiness gate §3 all green →
push with confidence. **Status: not started — this is the foundation that makes "done" real.**
