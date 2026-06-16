# Git & Deploy Workflow

> Adopted 2026-06-15. Branches map to environments via the GitHub Actions in `.github/workflows/`.

## Branches
| Branch | Purpose | On push, triggers | Deploys to |
|---|---|---|---|
| **`develop`** | **All ongoing work** (the orchestrator commits here) | `ci.yml` (tsc+tests) + `deploy-staging.yml` | **Staging** Cloud Run (`gifsy-*-staging`) |
| **`main`** | **Releases only** — promote here when prod-ready | `deploy.yml` (tests → **manual `production` approval** → deploy) | **Production** Cloud Run (`gifsy-api`/`gifsy-frontend`) |

Feature branches off `develop` are optional; for a solo build, committing straight to `develop` is fine.

> **Post-Phase S** (`BACKEND-SPLIT-PLAN.md`): the deploy targets stay `gifsy-api` + `gifsy-frontend`. The backend is
> built **in place in the `api/` dir** (its World-A domain deleted, the real domain rebuilt from the platform's
> `lib/`), so the **CI build/test matrix dir names stay `[api, platform]`** — `api/` *is* the backend now, `platform/`
> thins to the frontend. No workflow build-path changes needed (the build is already hard-wired to `./api`); S7 only
> drops the dead `prisma generate --schema=../api/prisma/...` fallback once the canonical schema lands there (S2).

## Day-to-day flow
1. Work + commit on **`develop`** (executors/auditors/gate as usual). Push `develop`.
2. CI (`ci.yml`) runs `tsc` + tests; `deploy-staging.yml` deploys to **staging** when the test gate passes.
3. Validate on staging.
4. **Release:** merge `develop` → `main` (PR or fast-forward). The `main` push runs `deploy.yml`: tests →
   a **manual approval** on the `production` GitHub environment → deploy to **prod**. **A push to `main`
   IS a production-deploy attempt** — only do it for releases.
5. **Rollback:** revert the commit on the branch, or roll back the Cloud Run revision.

## ⚠️ Current blocker (fix = MASTER-PLAN P9.1)
CI runs the **full `npm test`** and requires it to PASS, but the suite is **red-by-design** (~105
TDD-baseline failures until P8). So the test gate **fails** and **neither staging nor prod will deploy**
until CI is switched to the **differential gate** ("no NEW reds vs `reconcile/baseline-red-snapshot.txt`")
or the baseline reds are quarantined in CI. Until then, pushes produce red workflow runs but **no deploy**
(safe). **Do P9.1 before relying on the pipeline to deploy.**

## Rules of thumb
- Default branch for the agent's commits = **`develop`**. Never push `main` except a deliberate release.
- Never set `DEMO_MODE=true` in staging/prod env.
- Prod DB migrations are NOT in the pipeline yet (MASTER-PLAN P9.3/9.5) — apply additively + guarded
  (see `DEV-DB.md`); prod is private-IP.
