# Environments — ready reference (verified from infra config, 2026-06-19)

> The single place to check "what runs where, against which data." Verified from `terraform/cloud-sql.tf`,
> `.github/workflows/deploy*.yml`, `DEV-DB.md`, and git. Update this when the infra changes.

## The three environments (+ local)

| Environment | Code runs | Database | DB instance | Deploy trigger |
|---|---|---|---|---|
| **Local dev** (where we build/verify) | your machine — FE `:3000` (`next dev`), API `:4000` (`node dist/main.js`) | `gifsy_dev` | **`gifsy-db-dev`** — a **separate, isolated** Cloud SQL instance (Postgres 15, db-f1-micro, asia-south1-b, **public IP 34.14.195.38**, conn `gifsy-platform:asia-south1:gifsy-db-dev`), via Auth Proxy on `127.0.0.1:5433` | n/a (local) |
| **Staging** | Cloud Run `gifsy-api-staging` + staging FE | `gifsy_staging` | **shared** instance `gifsy_db` (POSTGRES_15) — *same physical instance as prod* | **push to `develop`** → `deploy-staging.yml` (auto) |
| **Production** | Cloud Run (prod) | `gifsy_prod` | **shared** instance `gifsy_db` | **push to `main`** → `deploy.yml` (GitHub Environment "production" **required-reviewer gate**) |

**Key facts (the ones that bite):**
- **Local dev is the only isolated DB instance.** Staging + prod share one Cloud SQL instance (different databases). `gifsy_dev` is on its own instance.
- **Staging auto-deploys from every `develop` push.** As of 2026-06-19 our P0.5/P0.6 work is **6 commits AHEAD of `origin/develop` (unpushed)** → **staging does NOT have it yet**; staging is at the last-pushed state. Pushing `develop` deploys everything to staging.
- **Prod is never pushed by us** (`main`, approval-gated). Never point dev at prod; never `prisma migrate dev` (resets `gifsy_dev`).
- **DB migrations (2026-06-20):** schema applies from one squashed Prisma **baseline** via `prisma migrate deploy` run as an **in-VPC Cloud Run Job** (the shared instance is private-IP). **Staging auto-migrates** on every `develop` push (`gifsy-migrate-staging` in `deploy-staging.yml`, before the new revision serves); **prod is gated** (`gifsy-migrate` job + a one-time P3005 baseline reconcile). `gifsy_dev` is unchanged — db-push / surgical-SQL via the proxy. Full model: [`MIGRATIONS.md`](MIGRATIONS.md).

## What data shows where

**The principle is identical in every environment: the app renders ONLY real data from that environment's database, scoped to the logged-in user's role + tenant. Nothing is hardcoded.** (Fabricated demo numbers — 8,550 pts / 248 partners / persona switchers — are pre-backend leftovers and are bugs; see gap #40. Intended per-page/per-role data: `DATA-VISIBILITY.md`.)

| Environment | Data in its DB |
|---|---|
| Local dev / `gifsy_dev` | the seeded test set (`npx prisma db seed`): gifsy admin + deoleo admin/partner/sales users, 2 partners+wallets+outlets, sales hierarchy, 2 KYC, rewards, tickets created during testing |
| Staging / `gifsy_staging` | **seeded 2026-06-20** (full deoleo + clientb demo set via the seed job). **OTP = `FIXED_OTP=123456` for fast UAT (re-enabled 2026-06-22; see below).** Login phones: GIFSY admin `9830011252` (clientId `gifsy`), deoleo admin `6289864191`, partner+outlet `7795096288`. *(Sales `9875436349` was parked off the demo sales-user during the 2026-06-22 hierarchy-conflict cleanup — no longer a live login.)* |
| Prod / `gifsy_prod` | **confirmed EMPTY — 0 users (2026-06-20)** — on the stale June-6 schema (has `otp_codes` + dead World-A `tier_configs`, MISSING P4–P6 tables + the `clients` table; 6 recorded migrations → P3005 on the baseline). Greenfield → recreated empty + migrated at the gated cutover |

**Visibility by role (same in all envs):** GIFSY operator → cross-tenant (all tenants) · CLIENT_ADMIN / MIS_USER → their whole tenant · sales → their assigned outlets/team · partner → only their own.

## Local-vs-staging differences that break despite identical code

Comprehensive testing is done on **local dev** (fast iteration); **staging is the final pre-prod confirmation** because these differ:
- **`FIXED_OTP` on staging — RE-ENABLED for fast UAT (2026-06-22):** staging uses **`FIXED_OTP=123456`** (every login/redemption OTP is `123456`; no real SMS). Gated by `isFixedOtpAllowed` (`api/src/common/fixed-otp.ts`): honored only when `ALLOW_FIXED_OTP=true` **AND** the DB is `gifsy_staging`, and **hard-refused whenever the DB is `gifsy_prod`** — so prod can never be backdoored even if the flag leaks. Set via `deploy-staging.yml` (staging workflow only). **To revert staging to real MSG91 OTP, unset `ALLOW_FIXED_OTP` there.** Local dev uses `FIXED_OTP=123456` too. **Prod has NO `FIXED_OTP`** (real MSG91 only, `NODE_ENV=production`); an independent security audit confirmed prod stays safe even under a fat-fingered `ALLOW_FIXED_OTP`. ⚠️ MSG91 secrets must be saved **without a UTF-8 BOM** — a BOM on `MSG91_AUTH_KEY` 500'd OTP (fixed: secret re-saved + defensive `.trim()` in `msg91.service`).
- **`resolveClientId(host)`**: `localhost`→`deoleo` locally; real subdomains on staging → different tenant resolution. *(Exactly why the GIFSY-login bug #39 can't be fully exercised locally.)*
- **Secrets/config** (JWT, GCS, `DATABASE_URL` via Cloud SQL socket) come from Secret Manager on staging vs `.env` locally.
- **Build**: local `next dev` (HMR) vs the `output:standalone` production Docker build on staging.
- **Data**: `gifsy_dev` (seed) ≠ `gifsy_staging`.

**Intent (must be encoded in the E2E harness + `GO-LIVE-READINESS.md`):** the **local comprehensive run must be thorough enough that a green result means we can push `develop` expecting it to pass staging → prod with no surprises — no half-baked merges.** The E2E harness is therefore written to run against **both** local and staging (same suite, env-parameterised).

## Dev login quick-ref
`FIXED_OTP=123456` (dev only). Seeded phones (all `clientId=deoleo` unless noted): gifsy admin `9830011252` (clientId `gifsy` — login currently broken, #39), deoleo admin `9000000001`, partner `9000000002`, sales SO `9000000003`. Backend `:4000` rebuild: `cd api && npx tsc -p tsconfig.build.json --incremental false && node dist/main.js`. Proxy restart: see `DEV-DB.md`.
