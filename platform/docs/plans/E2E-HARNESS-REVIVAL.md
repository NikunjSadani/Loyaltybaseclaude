# E2E Harness Revival — PICK UP FIRST after compaction

> **Created 2026-07-20.** This is the immediate-next task. The go-live Playwright E2E harness
> (`platform/e2e`) had been **dead since AF-6** (no role could log in). The AF-6 **login fix is DONE +
> committed (`5d6d717`, on `develop`/`main` = prod `e8de31a`)** — the harness runs again and **161 specs
> pass**. What remains is **reviving the rest of the harness**, which turned out to be a much bigger job
> than the login fix. **None of this affects production — the harness is a test tool, it does not run in
> prod or CI.** Prod (§A-DOMAIN, cutover #11) is live and healthy; this is purely test-infra debt.

---

## 0. TL;DR — what's done, what's left

| | State |
|---|---|
| **AF-6 login/token migration** | ✅ DONE + verified (`5d6d717`). All 7 role logins pass; 161 specs pass (was 0). tsc 0. |
| **~132 PRE-EXISTING stale specs** | ❌ TODO — harness last green **2026-06-21**; a month of app drift (D-1, P5, dashboards, KYC) broke specs the migration never touched. Separate re-validation effort. |
| **`requestAs` cross-role reads 401 locally** | ⚠️ INVESTIGATE — 7 specs; proven NOT a code bug in isolation (see §3). Verify on the real stack. |
| **`gifsy/operator-switch.e2e.ts` `homeToken`** | ❌ TODO — asserts a localStorage key AF-6 removed; needs the new exit-to-platform mechanism (product question). |

**Recommended order:** (1) resolve the `requestAs` runtime question (§3) — it gates whether the 7 cross-role
specs are actually green; (2) then grind the ~132 stale specs (§4) in batches by role/area; (3) fix
`operator-switch` (§5).

---

## 1. What the harness is + why it matters

`platform/e2e` is the **executable form of `DATA-VISIBILITY.md`** + the go-live gate described in
`GO-LIVE-READINESS.md`. It drives the **real running stack** (FE → proxy → NestJS backend → `gifsy_dev`)
as each role via the REAL login form (not a demo switcher) and asserts: real role-scoped data renders, no
fabricated/demo values (`fixtures/fabricated.ts`), scoping holds (a role can't reach another scope), and
writes persist. Config: `platform/playwright.config.ts` (projects = one per role: setup → partner,
clientAdmin, sales, gifsy, clientbAdmin, mis, salesManager). **workers:1, serial** (specs share live DB
state; money-path specs drain points from the same seeded outlet). `retries:1`.

**It does NOT run in CI** (`npm test` ignores `e2e/**`) — it's a manual/staging pre-prod gate the owner
runs. So its staleness never surfaced until now.

---

## 2. HOW TO RUN IT LOCALLY (the runbook — hard-won 2026-07-20; DEV-DB.md + e2e/README.md are the base)

The harness does **not** spawn the stack — you bring up 3 things, then run playwright. Windows/PowerShell
notes below; use **git-bash** for anything with `npm`/`npx` (PowerShell execution-policy blocks the `.ps1`
shims — or use `npm.cmd`/`npx.cmd`).

**Prereqs discovered this session:**
- `cloud-sql-proxy.exe` lives at `$env:TEMP\cloud-sql-proxy.exe` (downloaded from
  `https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/<ver>/cloud-sql-proxy.x64.exe`).
- ADC is NOT set up; use the gitignored deployer SA key (has `roles/cloudsql.admin`):
  `--credentials-file "C:/Users/nikun/Loyaltybaseclaude/gifsy-platform-60018da0d5b4.json"`.

**1. DB proxy → `gifsy_dev`** (leave running):
```bash
"$TEMP/cloud-sql-proxy.exe" --credentials-file "C:/Users/nikun/Loyaltybaseclaude/gifsy-platform-60018da0d5b4.json" \
  gifsy-platform:asia-south1:gifsy-db-dev --port 5433
```

**2. Seed `gifsy_dev`** (adds the seed data + the clientb→zenith `client_domains` rows the P6 spec needs):
```bash
cd api && npx prisma db seed
```
> ⚠️ `gifsy_dev` was BEHIND on migrations this session — the `client_domains` table was missing (P0
> migration never applied to dev). If the seed fails with `client_domains does not exist`, run
> `npx prisma db push` (the DEV workflow per DEV-DB.md) to sync the schema, then re-seed. (I created the
> table surgically last time; `db push` was later run and reported "in sync".)

**3. Backend on `:4000`** with fixed OTP:
```bash
cd api
# ⚠️ nest-build FOOTGUN: deleteOutDir wipes dist but a stale *.tsbuildinfo makes incremental tsc emit
#    NOTHING (exit 0, empty dist). If dist/main.js is missing after a build, delete *.tsbuildinfo first:
find . -maxdepth 2 -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete
./node_modules/.bin/tsc -p tsconfig.build.json     # emits dist/
FIXED_OTP=123456 node dist/main.js                 # DATABASE_URL + JWT_SECRET come from api/.env
```
(`*.tsbuildinfo` is now gitignored, `e8de31a`.)

**4. Frontend dev on `:3100`** (the plain `:3000` was squatted by an unrelated stale Next app this session).
The FE proxy MUST get the SAME `JWT_SECRET` as the backend (else it can't verify the token cookie → every
auth redirects to login), and `NEXT_PUBLIC_APP_URL` must point at its own port:
```bash
JWT_SECRET=$(grep -m1 '^JWT_SECRET' api/.env | sed -E 's/^JWT_SECRET[[:space:]]*=[[:space:]]*"?([^"\r]+)"?.*/\1/')
cd platform
JWT_SECRET="$JWT_SECRET" NEXT_PUBLIC_APP_URL="http://localhost:3100" NEXT_PUBLIC_API_URL="http://localhost:4000" \
  npx next dev -p 3100
```
> ⚠️ Do NOT `rm -rf platform/.next` while this dev server is running — it corrupts the build manifests and
> the FE starts serving 500s (had to restart it). Run the FE-tsc gate against a SEPARATE checkout or before
> starting the dev server.

**5. Run playwright** (git-bash), pointing at 3100:
```bash
cd platform
E2E_BASE_URL=http://localhost:3100 npx playwright test                    # whole suite (~1h, serial)
E2E_BASE_URL=http://localhost:3100 npx playwright test --project=gifsy     # one role
E2E_BASE_URL=http://localhost:3100 npx playwright test --project=clientAdmin clientAdmin/settings-write.e2e.ts  # one spec
npx playwright show-report e2e/.report                                     # HTML report
```
Failed tests leave a folder each under `platform/test-results/` (2 per failure with retry) — count/triage
from there. `test-results/.last-run.json` has `status` + `failedTests`.

---

## 3. WORKSTREAM A — the `requestAs` cross-role runtime question (do FIRST)

**What it is:** AF-6's `proxy.ts` does `headers.delete('authorization')` **unconditionally** then injects a
Bearer from the `token` cookie. So a manual `Authorization: Bearer` header is ignored — a request is
authenticated by whatever **cookie** it carries. The old harness pattern `page.request.get(url, { headers:
authHeader('gifsy') })` therefore silently ran as the **page's** role, not gifsy (a false-pass for
cross-role reads). The fix (in `helpers/write.ts`): `requestAs(role)` =
`request.newContext({ baseURL, storageState: ROLES[role].storageStatePath })` → a request context carrying
that role's cookie → authenticates as that role through the proxy. 7 specs converted to it (`settings-write`,
`ticket-reply-write`, `scheme-enroll-write`, `assisted-redemption-write`, `kyc-approve-write`,
`kyc-create-write`, `visibility-write`).

**The problem (LOCAL):** these `requestAs` calls **401** on the local `next dev` stack. Investigated:
- A **raw curl** with the gifsy `token` cookie → `401 {"error":"Authentication required — please log in."}`
  (the BACKEND's message).
- A **garbage token** (`Cookie: token=not.a.jwt`) → the **SAME** backend message (NOT the proxy's "Invalid
  token"). ⇒ **the local proxy middleware is NOT injecting the Bearer for non-browser requests** — the
  request reaches the backend with no auth.
- Yet the **browser page context authenticates fine** (all 7 logins + `banners-write`'s page.request writes
  pass). Same token, different transport.
- The gifsy JWT itself is valid (decodes: `role=GIFSY_ADMIN clientId=gifsy`, exp 2026-07-27; not expired).

**Hypotheses to test (pick up here):**
1. **Local `next dev` middleware vs external-rewrite header injection** — maybe the middleware-injected
   `authorization` request header doesn't survive the `next.config` rewrite to the EXTERNAL backend
   (`localhost:4000`) for non-browser clients in dev, but DOES for the browser. (In prod it clearly works —
   the whole app runs on it.) → **Verify `requestAs` on the REAL stack (staging) or in CI**, where the edge
   worker + real proxy handle it; if it works there, the local 401 is a `next dev` artifact and the 7 specs
   are fine.
2. **Is `platform/src/proxy.ts` even wired as Next middleware?** Confirm there's a `middleware.ts` that
   exports/calls `proxy` (the file is named `proxy.ts`, not `middleware.ts`). If middleware isn't running
   for `/api/*` at all locally, that explains the garbage-token result — and the browser "works" via a
   different path (SSR/RSC cookie reads, not the Bearer injection). **This is the single most important
   thing to check** — grep for `middleware` in `platform/src`.
3. Alternative if `requestAs`-through-proxy is genuinely unreliable: hit the **backend directly**
   (`http://localhost:4000/v1/...`) with `Authorization: Bearer ${tokenFor(role)}` for cross-role reads —
   bypasses the proxy's cookie injection entirely. Trade-off: doesn't exercise the FE proxy path. Add the
   backend base URL to `fixtures/env.ts` if going this route.

**Until resolved, the 7 cross-role specs' pass/fail is unknown** (they 401 locally). The `requestAs` DESIGN
is correct; the question is purely the local-run transport.

---

## 4. WORKSTREAM B — the ~132 pre-existing stale specs

The harness was last green **2026-06-21**; the app has changed enormously since. Running it now: **161
passed, 2 flaky, 3 skipped, ~132 failed** (≈264 `test-results/` folders incl. retries). The failures span
**specs the AF-6 migration never touched** — `clientAdmin/{approvals,dashboards,dashboard,cross-tenant,
gifts-read,visibility,users-outlets-read,hierarchy-roundtrip}`, `mis/{dashboard,reads}`,
`gifsy/{overview,settings,client-detail,users,outlet-types,...}`, `sales/{catalogue,leaderboard,outlets,
profile,support,scoping,...}`, `partner/*`, `salesManager/team`, `clientbAdmin/cross-tenant`, etc.

These fail because the **specs' expectations are stale** (renamed headings, changed KPIs, moved routes,
changed seed data, retired UI), NOT because of AF-6. Approach: **triage by role/area in batches**, open the
HTML report or the `test-results/<spec>/error-context.md` + trace per failure, and for each: decide is the
SPEC stale (update it to the current app) or is it a REAL app regression (rare — the app is live + working).
Most will be spec-staleness. This is the bulk of the effort — could be many hours; do it in owner-visible
batches, don't try to one-shot it.

**Do NOT weaken assertions to force green** — the harness's value is catching fabricated data / scope leaks
(`helpers/assert.ts`, `fixtures/fabricated.ts`). Update specs to the current TRUTH, keep the guards strict.

---

## 5. WORKSTREAM C — `gifsy/operator-switch.e2e.ts` (`homeToken`)

`operator-switch.e2e.ts:24-25` asserts `localStorage.getItem('homeToken')` is truthy. AF-6 removed
`homeToken` (the operator's saved "home" token for exit-to-platform) — it no longer exists in
`platform/src`; `auth-client.ts` documents localStorage now holds only `user` + `assumedBrand`. The
assume/exit mechanism moved to cookies + server actions (AF-6 tasks #132). Fix: rewrite the assertion to
verify the new assume-tenant → exit flow (cookie-based), not the removed `homeToken`. Needs reading the
current assume/exit server actions first. Left un-migrated on purpose (product-mechanism question).

---

## 6. Local stack state at hand-off (2026-07-20)

At the moment this was written, these were RUNNING (started via git-bash `&`, persist across shells) — reuse
or restart per §2:
- cloud-sql-proxy on `:5433` (deployer SA key)
- backend `node dist/main.js` on `:4000` (FIXED_OTP=123456)
- FE `next dev` on `:3100` (JWT_SECRET set, NEXT_PUBLIC_APP_URL=3100)
- (an unrelated stale Next app squats `:3000` — ignore it, use 3100)

`gifsy_dev` is seeded (incl. clientb→zenithrewards). Kill with `Get-Process node | Stop-Process` + close the
proxy tab when done.

---

## 7. Reference

- `platform/e2e/README.md` — the harness's own docs (prereqs, env parameterisation local↔staging).
- `platform/docs/plans/DEV-DB.md` — the dev-DB + cloud-sql-proxy setup.
- `platform/docs/plans/DATA-VISIBILITY.md` / `GO-LIVE-READINESS.md` — what the harness enforces + why.
- Helpers: `e2e/helpers/write.ts` (`cookieToken`, `requestAs`, `tokenFor`, `authHeader`),
  `e2e/helpers/assert.ts` (`expectNoFabricatedData`, `expectScopedOut`), `e2e/helpers/login.ts` (real-form
  login, now cookie-based), `e2e/fixtures/env.ts` (env resolution), `e2e/fixtures/roles.ts` (seeded users).
- The AF-6 migration commit: **`5d6d717`**. The proxy behaviour: `platform/src/proxy.ts` (strips
  Authorization, injects Bearer from the cookie — the crux of Workstream A).
</content>
