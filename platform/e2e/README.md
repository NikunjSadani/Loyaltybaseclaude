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
pre-prod gate. Harness-side staging support now exists (env switch + OTP-injection seam; see
"Env parameterisation" below); the only remaining staging-side dependency is either a test-only
OTP read-back endpoint **or** running the staging backend with `FIXED_OTP` set.

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
The SAME specs are the local merge gate **and** the staging pre-prod gate. All env differences are
isolated in **`fixtures/env.ts`** (resolution) + **`helpers/otp.ts`** (OTP source) — never in specs.

| Var | Default (local) | Purpose |
|---|---|---|
| `E2E_ENV` | `local` | High-level switch: `local` \| `staging`. Picks per-env defaults for everything below. |
| `E2E_BASE_URL` | `http://localhost:3000` | FE URL. **Required** for `staging` (no default — refuses to guess). |
| `E2E_OTP` | `123456` | The fixed OTP (used by the `fixed` strategy). Same var/meaning as before. |
| `E2E_OTP_STRATEGY` | `fixed` (staging: `fetch`) | `fixed` = a known constant; `fetch` = pull the real code from a test-only hook. |
| `E2E_OTP_FETCH_URL` | – | (`fetch` only) test-only endpoint returning the just-sent OTP for a phone. See below. |
| `E2E_OTP_FETCH_TOKEN` | – | (`fetch` only) shared secret sent as `x-e2e-otp-token` to guard that endpoint. |
| `E2E_TENANT_STRATEGY` | `devClientIdField` (staging: `subdomain`) | How a role's tenant is identified (dev org-override field vs host/subdomain). |

**Backward compatibility:** with NO env vars set, everything resolves to the prior local behavior
(`http://localhost:3000`, fixed OTP `123456`, dev clientId override field). `npm run e2e` is unchanged.

### Running against staging
```bash
cd platform
# (a) Staging backend runs with FIXED_OTP set → simplest: just point at staging + give the OTP.
E2E_ENV=staging E2E_BASE_URL=https://<staging-fe> E2E_OTP_STRATEGY=fixed E2E_OTP=<the-fixed-otp> npm run e2e

# (b) Staging uses REAL MSG91 (the default for E2E_ENV=staging) → the OTP must be fetched:
E2E_ENV=staging E2E_BASE_URL=https://<staging-fe> \
  E2E_OTP_FETCH_URL='https://<staging-api>/v1/_e2e/otp?phone={phone}&clientId={clientId}' \
  E2E_OTP_FETCH_TOKEN=<secret> npm run e2e
```
Tenant on staging comes from the **host/subdomain** (the dev "Organization" override field is not
rendered in the production FE build, `NODE_ENV=production`). For per-tenant roles (gifsy / clientb)
the staging run must hit the correct subdomain — i.e. `E2E_BASE_URL` / the storageState origin must
resolve to that tenant. If staging serves all tenants off one host, that's a staging-routing gap to
close before those roles are valid on staging (the `deoleo` roles work off the default host).

### OTP on staging — the required staging-side support (`fetch` strategy)
The harness does **not** add an auth bypass. For real-MSG91 staging it needs a **test-only OTP
read-back** seam so it can type the code the backend already generated:

- Endpoint shape: `GET {E2E_OTP_FETCH_URL}` with `{phone}` / `{clientId}` substituted, returning
  JSON `{ "otp": "123456" }` (or `{ "code": "..." }`) — the **most recent un-consumed** OTP for that
  phone+tenant. (Login and the redeem-confirm flow both send to the partner's phone, so "most recent"
  must win; the login hydration-retry may send more than once, so it must return the latest.)
- **Must be non-prod-only and secret-guarded.** Mount it only when a staging/E2E flag is set, require
  the `x-e2e-otp-token` header to equal a secret, and **never** deploy it to prod. It reads an OTP the
  backend already created — it does not verify, mint tokens, or weaken the real `verify-otp` path.
- If the orchestrator would rather **not** build this read-back hook, set `FIXED_OTP` on the staging
  backend instead and run with `E2E_OTP_STRATEGY=fixed E2E_OTP=<value>` (option (a) above) — the
  harness fully supports that with no staging-side endpoint. `verify-otp` already accepts `FIXED_OTP`
  on any env where it's set (`auth.service.ts`), so this is the lowest-effort path.

⚠️ The `{E2E_OTP_FETCH_URL}` endpoint above is **not yet implemented** — it is the one staging-side
TODO the orchestrator must action (or pick the `FIXED_OTP` path instead).

## Layout
```
e2e/
  fixtures/env.ts          # env resolution (local↔staging): base URL, tenant + OTP strategy
  fixtures/roles.ts        # seeded users + expected dashboard/role (ground truth)
  fixtures/fabricated.ts   # the #40 fail-list
  helpers/login.ts         # real-form login (NOT the persona switcher)
  helpers/otp.ts           # OTP source: fixed (local) | fetch (staging real-MSG91)
  helpers/assert.ts        # expectNoFabricatedData, expectScopedOut
  setup/auth.setup.ts      # logs each role in once → e2e/.auth/<role>.json
  partner/*.e2e.ts         # the partner vertical slice
```

## Extending (fan-out)
Add a role's session in `setup/auth.setup.ts` (`SESSION_ROLES`), add a project in
`playwright.config.ts`, and add `e2e/<role>/*.e2e.ts` for each DATA-VISIBILITY row. A row is "done"
only when its E2E test passes against real data.

## Status (2026-06-20): GREEN (59) for the slices it covers — NOT the full matrix
- Covered: #40 fabricated identity, #41 FE role guards, Q1 payouts, #47 admin KPIs, #52 cross-tenant
  (both dirs), #39 GIFSY login, A1/A2 gifsy oversight+switcher, the partner redemption MONEY path +
  visibility/support writes, B2 invoices, B3 gifsy console, sales catalogue/KYC.
- ⚠️ **NOT the full role×page matrix.** Uncovered: most admin sub-pages (schemes/targets/achievements/
  outlets/catalog/credits/TDS/payouts/settings/tickets/banners), partner targets/leaderboard/schemes/
  orders/KYC, sales team/outlets/targets/tasks, and several write flows (KYC-approve, invoice-generate,
  scheme-enrollment, credits/payouts). The GO-LIVE-READINESS "matrix 100% green" bar is **not met**.
- ⚠️ **Never run end-to-end against live staging.** And since `FIXED_OTP` was **removed from staging
  (2026-06-20, real MSG91 now)**, option (a) below no longer works as-is — a staging harness run now
  needs the test-only OTP read-back endpoint (option (b), still unbuilt → P8) **or** temporarily
  re-adding `FIXED_OTP` to the staging backend for the run.

## Coverage limits & still-OPEN (what GREEN does NOT yet cover)
- **Write-persistence helper (S4):** none exists yet. Build the act→re-read-in-2nd-session pattern with
  the first write flow (KYC approve / redemption / visibility submit).
- **GIFSY-sees-both real data (gap #49):** the `/gifsy/*` console reads a static `CLIENT_REGISTRY` mock,
  not the real `clients` table — so the "operator sees both tenants" assertion is deferred until a real
  `GET /v1/gifsy/clients` lands. (Login + a console smoke ARE covered.)
- **Staging:** harness env-support now lands (see "Env parameterisation"). Remaining staging-side
  dependency: a test-only OTP read-back endpoint (`E2E_OTP_FETCH_URL`) **or** `FIXED_OTP` on the
  staging backend; plus per-subdomain routing for the gifsy/clientb roles. Not yet executed end-to-end
  against a live staging deploy.
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
