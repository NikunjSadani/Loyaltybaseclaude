# Go-live E2E harness

The **executable** form of [`docs/plans/DATA-VISIBILITY.md`](../docs/plans/DATA-VISIBILITY.md) and the
enforcement described in [`GO-LIVE-READINESS.md`](../docs/plans/GO-LIVE-READINESS.md). It drives the
**real running stack** (FE → `next.config.ts` proxy → NestJS backend → DB) as each role and asserts:

1. **Real, role-scoped data** renders (grounded against the seeded `gifsy_dev` truth).
2. **No fabricated/demo values** appear (`fixtures/fabricated.ts` fail-list — gap #40).
3. **Scoping holds** — a role can't reach another scope's pages/data (gap #41 / Q6).
4. **Writes persist** — ⚠️ **NOT YET IMPLEMENTED.** No spec exercises a write path today; the
   persistence pattern (act → re-read in a second session) lands with the first P0.6 write flow.

`tsc` + unit tests are necessary but NEVER sufficient (`VERIFICATION-PROTOCOL.md`); this is what makes
"done" real. A green **local** run is the merge gate. A green **staging** run is the *intended*
pre-prod gate — but **staging support is a TODO** (needs MSG91-OTP injection + staging tenant slugs;
see "Coverage limits" below). Today this is the **local** gate only.

## Prerequisites (local)
The harness does **not** spawn the app — the owner already runs it:
- DB Auth Proxy on `127.0.0.1:5433` → `gifsy_dev` (see `docs/plans/DEV-DB.md`)
- backend on `:4000` (`node dist/main.js`), with `FIXED_OTP=123456`
- FE on `:3000` (`next dev`)
- `gifsy_dev` seeded: `cd api && npx prisma db seed`

## Run
```bash
cd platform
npm run e2e            # all projects (setup logs each role in, then role specs)
npm run e2e -- --project=partner   # one role
npm run e2e:ui         # interactive
npm run e2e:report     # open the last HTML report
```

## Env parameterisation (local ↔ staging)
| Var | Local default | Staging |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` | the staging FE URL |
| `E2E_OTP` | `123456` (FIXED_OTP) | real MSG91 — needs a staging OTP-injection strategy (TODO before the staging gate) |

The suite must **not** hardcode `FIXED_OTP`/`localhost` semantics — those live in `fixtures/roles.ts`,
overridable by env, so the same specs run both places (see `ENVIRONMENTS.md`).

## Layout
```
e2e/
  fixtures/roles.ts        # seeded users + expected dashboard/role (ground truth)
  fixtures/fabricated.ts   # the #40 fail-list
  helpers/login.ts         # real-form login (NOT the persona switcher)
  helpers/assert.ts        # expectNoFabricatedData, expectScopedOut
  setup/auth.setup.ts      # logs each role in once → e2e/.auth/<role>.json
  partner/*.e2e.ts         # the partner vertical slice
```

## Extending (fan-out)
Add a role's session in `setup/auth.setup.ts` (`SESSION_ROLES`), add a project in
`playwright.config.ts`, and add `e2e/<role>/*.e2e.ts` for each DATA-VISIBILITY row. A row is "done"
only when its E2E test passes against real data.

## Status (2026-06-19): the matrix is GREEN (34/34) — the original reds are all remediated
- #40 fabricated identity (partner/sales/admin), #41 FE role guards, Q1 payouts, #47 admin KPIs,
  #52 cross-tenant (both directions), #39 GIFSY login — all fixed + verified through the harness.

## Coverage limits & still-OPEN (what GREEN does NOT yet cover)
- **Write-persistence helper (S4):** none exists yet. Build the act→re-read-in-2nd-session pattern with
  the first write flow (KYC approve / redemption / visibility submit).
- **GIFSY-sees-both real data (gap #49):** the `/gifsy/*` console reads a static `CLIENT_REGISTRY` mock,
  not the real `clients` table — so the "operator sees both tenants" assertion is deferred until a real
  `GET /v1/gifsy/clients` lands. (Login + a console smoke ARE covered.)
- **Staging:** env-support is a TODO (MSG91-OTP injection + staging tenant slugs).
- **DOM-only scan (S5):** `expectNoFabricatedData` reads `innerText` only — it misses values in input
  `value`/`placeholder`, `aria`/`alt`/`title`, `<title>`/`<meta>`, SVG/canvas. Add attribute/value
  assertions per-page when a flow renders data into form controls.
- **Per-path fabricated tokens (S3):** `fixtures/fabricated.ts` supports `onlyOnPaths`; use it when a
  real value on one page could collide with a demo token elsewhere.
- **DOM-only scan (S5):** `expectNoFabricatedData` reads `innerText` only — it misses values in input
  `value`/`placeholder`, `aria`/`alt`/`title`, `<title>`/`<meta>`, SVG/canvas. Add attribute/value
  assertions per-page when a flow renders data into form controls.
- **Per-path fabricated tokens (S3):** `fixtures/fabricated.ts` supports `onlyOnPaths`; use it when a
  real value on one page could collide with a demo token elsewhere.
- **API-level assertions:** the suite asserts rendered DOM only. For tenant-scope/authz, consider a
  direct API probe (same token, manipulated `x-tenant-slug`) — DOM tests can't see header-level scope.
