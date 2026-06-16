> ⚠️ **SUPERSEDED (2026-06-16) by [`00-MASTER-PLAN.md`](00-MASTER-PLAN.md) P1.** Delivered: Gap #20 closed, #23
> reduced (session-bound tenant + isolation-audit test); per-route `clientId` fixes continued through P2 (RF1–RF7).
> Historical reference only — plan from `00-MASTER-PLAN.md`.

# Milestone D · Tenant-isolation guardrail (Gaps #23, #20, High)

**Context:** isolation today is "every developer remembers to add `where: { clientId }`." One
miss = a cross-tenant data leak. We add a guardrail now and plan the systemic fix. Treat anything
touching auth/tenancy as **sensitive** — get owner sign-off on D3/D4 before merging.

## Task D1 — A test that audits routes for tenant scoping

**Why:** make "did we scope this query?" automatically checkable.

**Steps**
1. Create `src/app/api/__tests__/tenant-scoping.test.ts`. Concrete starter:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { readFileSync } from 'fs';
   import { globSync } from 'glob';   // check it's installed: `grep '"glob"' package.json`.
                                       // If not, walk dirs with fs.readdirSync(recursive:true).
   const ALLOW = [/\/auth\//];        // genuinely tenant-agnostic; add entries WITH a reason
   const QUERY = /prisma\.\w+\.(findMany|findFirst|updateMany|deleteMany|aggregate|count)/;
   describe('tenant-scoped routes reference clientId', () => {
     for (const f of globSync('src/app/api/**/route.ts')) {
       const src = readFileSync(f, 'utf-8');
       if (!QUERY.test(src) || ALLOW.some(re => re.test(f))) continue;
       it(`${f}`, () => expect(src).toMatch(/clientId/));
     }
   }); 
   ```
2. **Set expectations honestly: this is a tripwire, not a proof.** It only checks the *word*
   `clientId` appears — it can't tell a correct filter from a mention, and the relation form
   (`partner: { user: { clientId } }`) passes because it contains `clientId`. So it catches the
   blatant misses, not the subtle ones. **Manually eyeball every file it flags**, and skim a few it
   *passes* too. Each flagged file is a real gap (→ D2) or a justified allow-list entry (with a reason).

**Commit:** `test(security): audit API routes for clientId scoping`
**DoD:** the test runs; every flagged route is either fixed (D2) or allow-listed with a reason.

## Task D2 — Fix the flagged routes

For each real offender from D1: add the `clientId` scope (mirror how sibling routes do it —
`const clientId = getClientIdFromRequest(req)` then `where: { clientId, … }` or the relation
form). One commit per route or per small cluster. Re-run the D1 audit until green.

**Commit(s):** `fix(security): scope <route> queries by clientId`
**DoD:** D1 audit green; each fix has a test or the audit covers it; `npm test` clean.

## Task D3 — Spike: systemic enforcement (don't hand-roll blindly)

**Why:** per-query discipline doesn't scale. Two known options — **evaluate, don't guess**:
- **Prisma client extension** (`$extends` query component) that injects/validates a `clientId`
  filter for tenant-scoped models. Pro: app-level, one place. Con: needs request context.
- **Postgres Row-Level Security (RLS)** keyed on a session `clientId`. Pro: DB-enforced, strongest.
  Con: infra + connection-setup work.

**Deliverable (no production code yet):** a 1-page recommendation in
`docs/spec/04-architecture.md` §8 — chosen approach, rough effort, migration steps, risks. This
unblocks a future milestone; it is **not** a blind implementation.

**Commit:** `docs(arch): recommendation for systemic tenant isolation`

## Task D4 — Bind token ↔ tenant (sensitive; design + sign-off)

**Context (Gap #20):** `clientId` isn't in the JWT; tenant comes from the host header. A valid
token used on another tenant's subdomain could mismatch. The real boundary is an **external proxy
not in this repo**.

**Steps**
1. Confirm with the owner whether the proxy already binds token↔tenant. If yes → document it in
   `04-architecture.md` and stop.
2. **Know the two auth paths before you "fix" one.** `getAuthUser` (`lib/auth.ts`) has a **primary**
   path that trusts proxy headers `x-user-id`/`x-user-role` (no tenant claim today) and a
   **fallback** Bearer-token path. Adding `clientId` to the JWT only covers the *fallback* — the
   primary path would still be unbound. The real fix is a **proxy-contract change**: the proxy must
   also inject the verified tenant (e.g. `x-client-id`). This needs the proxy owner at the table —
   it is **not** a code-only change.
3. Once the contract is agreed: add `clientId` to `TokenPayload`/`generateToken`, read `x-client-id`
   in `getAuthUser`, and have a small `assertTenant(req)` compare the injected/token tenant against
   `getClientIdFromRequest(req)`, rejecting mismatches. **Pure-test** the comparison (match → ok,
   mismatch → reject). Plan a grace path — existing tokens/headers won't carry the tenant yet.

**Commit:** `feat(auth): bind JWT to tenant as defence-in-depth (#20)`
**DoD:** comparison logic unit-tested; owner signed off on rollout; no lockout of valid users.
