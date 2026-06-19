# Flow Verification Protocol — the Definition of Done for any user-facing flow

> Created 2026-06-19 after a recurring failure: "complete" features (login, KYC approval, admin tickets, the
> Gift Catalogue, the dashboards) were marked done on `tsc`-clean + passing unit tests + a single happy-path
> "browser check", and then turned out **broken at runtime** for real roles / cross-tenant / real HTTP input.
> This protocol exists so that never counts as "done" again. It is **mandatory** for the orchestrator gate
> (`08-agent-execution-guide.md`) and is referenced by the P0.5+ gate.

## The one rule

**"Done" = a real user, in the correct role, completes the actual business flow end-to-end, observed at
RUNTIME against realistic seeded data — and the adversarial cases behave correctly.**

"Compiles + unit tests pass" is NOT done. "Worked once for me as one role" is NOT done. **Treat
"the backend is complete" as a hypothesis to test, not a fact** — every backend gap below sat behind a
feature already marked complete.

## Why the cheaper proxies keep missing real bugs

Each level substituted a cheaper check for "does the flow work," and each new wave re-inherited the substitution:

| Cheaper proxy used | Real bug it structurally cannot see | Example it missed |
|---|---|---|
| Unit test (service called with typed args) | HTTP query-string coercion | Gift Catalogue 500 (`?limit=200` → string `take`) |
| Single-role / in-tenant test | role × tenant scoping | KYC approve 403/404; admin tickets sees 0 |
| Demo persona switcher / mock session | real auth/token/role | login broken end-to-end; fabricated dashboards |
| Agent `tsc`-clean (no runtime) | anything not in the type system | every item above |
| "Verified" after ONE happy path | the other roles / negative cases | premature commits this session |

The demo persona switchers (`useAdminSession`, the partner/sales WS/SSS toggles) show an identity **decoupled
from the real JWT** — "verifying" with them proves nothing. Always drive a **real login per role**.

## The 6 checks (ALL must pass, at runtime, before "done")

1. **Canonical surface.** Read the design doc (`spec/02` WF / the phase reconcile doc) and confirm you are on
   the *canonical* page + endpoints — not a legacy/orphan duplicate. *(Catches wiring the wrong page, e.g.
   the orphan `/admin/approvals` vs the canonical bulk `/admin/kyc/approvals`.)*
2. **Role matrix.** Every role that *should* perform the action succeeds; every role that *should not* gets an
   honest refusal. Drive each via a **real login** (FIXED_OTP=123456, seeded users per role) — never the demo
   switcher. *(Catches: only GIFSY can X; CLIENT_ADMIN silently sees nothing.)*
3. **Cross-tenant.** Actions where a Gifsy operator (`clientId='gifsy'`) acts on a *tenant's* data resolve
   correctly — no 404-from-caller-tenant-scope, no cross-tenant leakage. *(Catches KYC 404; tickets `isGifsy`.)*
4. **Persistence + observation.** The write actually changes the DB (verify by querying `gifsy_dev`), and a
   *different* authorized session/role then *sees* the change. *(Catches "fake success" + admin-can't-see.)*
5. **Unhappy path.** Invalid input, over-limit, empty state, and the failure case render **honestly** — no
   fabricated fallback, no fake success, no 401→demo-data. *(Catches dashboards, the catalogue, mock fallbacks.)*
6. **Data realism.** Tested against seeded data with **≥2 roles** and **≥1 record created by a different actor**
   than the one verifying. An empty DB or a single-actor DB hides every scoping bug.

## How to run it (this repo)

- Backend up (`api/` `dist` + `node dist/main.js`, :4000 → `gifsy_dev`); platform :3000; drive via the Chrome
  extension. Seed realistic multi-role data: `npx prisma db seed` (P0.5 W1B — idempotent demo set).
- Real login per role: `FIXED_OTP=123456`; seeded phones — gifsy admin `9830011252`/clientId `gifsy`,
  deoleo admin `9000000001`, partner `9000000002`, sales SO `9000000003` (all `clientId=deoleo` unless noted).
- Observe the **network** (real `/api/*` request fired + status) AND **the DB** (`pg` read of `gifsy_dev`) —
  a 200 alone is not persistence; a rendered number alone is not real data.
- When a check fails because the **backend** doesn't serve the role/tenant the flow needs, that is a
  **finding to fix in the backend**, not an assumption to route around in the FE.

## For executor agents

Agent tasks must read: *"Do NOT assume the backend endpoint works. Your task includes proving the flow works
end-to-end for the real roles it serves. If the backend doesn't serve the needed role/tenant, STOP and report
it as a backend finding."* Agents have no runtime — so the **orchestrator runs checks 2–6 at runtime** before
anything is called done or committed. An agent's `tsc`-clean is necessary, never sufficient.

## Recurring backend gap classes (check these first on any "complete" flow)

- **Role scoping too narrow:** an endpoint exempts only `isGifsy` (or one role) when a *tenant admin* also
  needs the broader view (tickets list). Confirm the role set matches the page's stated audience.
- **Tenant-scoped lookup blocks the cross-tenant operator:** `where: { id, clientId: caller.clientId }` makes
  a GIFSY operator (clientId `gifsy`) get 404 on a tenant's row (KYC approve). Gifsy-operated flows must scope
  by the *record's* tenant, not the caller's.
- **Uncoerced query params:** `@Query()` intersection types erase to `Object` → ValidationPipe skips transform
  → string reaches Prisma `take`/`skip` → 500 (Gift Catalogue). Use concrete DTOs with `@Type(()=>Number)`.
- **Missing endpoint for a UI action:** the FE has a button with no backend route (KYC submit/resubmit). Honest
  error beats fake success, but the flow isn't done until the route exists.
