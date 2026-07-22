# Database Migrations — how schema is applied across dev / staging / prod

> Created 2026-06-20 after the staging OTP outage. Root cause: `gifsy_staging` had **no
> tables** — the deploy pipeline never ran migrations, every DB had been migrated **by hand**,
> and staging was simply skipped. This doc is the canonical practice so that never recurs.

## The model (industry-standard, now enforced)

- **Schema source of truth:** `api/prisma/schema.prisma` (the backend owns it).
- **Migrations are forward-only files** in `api/prisma/migrations/`, version-controlled.
- **Applied via `prisma migrate deploy`** (the production command — **never** `migrate dev` or
  `db push` against staging/prod).
- **Run as an in-VPC Cloud Run Job**, *not* from a laptop and *not* from a GitHub Actions runner.
  **Why:** the staging/prod Cloud SQL instance `gifsy-platform:asia-south1:gifsy-db` is
  **private-IP only** — unreachable from outside the VPC. The job attaches a **Direct VPC egress**
  network interface (`--network=gifsy-vpc --subnet=gifsy-subnet-asia-south1 --vpc-egress=private-ranges-only`)
  + the Cloud SQL instance binding, so it *can* reach the private IP. *(This replaced the old
  `gifsy-connector` VPC Access connector, deleted 2026-07-22 — see `INFRA-ARCHITECTURE.md`.)*

## The 2026-06-20 baseline squash

The formal migration history had diverged from `schema.prisma`: it was frozen at a June-6 (P3)
state, while P4–P6 schema changes were applied only as **manual dev SQL** (`migrations-manual/`).
Because the project is **greenfield (no real data anywhere)**, we did the Prisma-recommended
pre-production cleanup:

- **Squashed to one clean baseline** — `migrations/00000000000000_baseline/migration.sql` =
  the entire current schema (72 tables / 51 enums / 66 FKs / 270 indexes), generated with
  `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`.
- **Archived** the 6 stale migrations to `api/prisma/migrations-archive/` (kept on disk for
  history, out of the active set).
- **Recovered two PARTIAL unique indexes** that `migrate diff` cannot emit (Prisma can't model
  partial indexes) and appended them to the baseline — the TDS re-upload dedup indexes
  (`tds_off_platform_entries`, `tds_deposits`, `WHERE "uploadBatchId" IS NOT NULL`). An audit
  caught this; without them, duplicate TDS rows inflate liability. **Any future partial index
  must be hand-added to its migration the same way.**

## Per-environment

| Env | DB / instance | How it's migrated |
|---|---|---|
| **dev** | `gifsy_dev` — separate **public-IP** instance `gifsy-db-dev` | Local, via the Cloud SQL Auth Proxy. See [`DEV-DB.md`](DEV-DB.md). Never `migrate dev` (resets `gifsy_dev`). |
| **staging** | `gifsy_staging` — shared **private** instance `gifsy-db` | **Automatic** on every `develop` push: `deploy-staging.yml` runs the `gifsy-migrate-staging` Cloud Run Job (`migrate deploy`, SHA-pinned image, `--wait`) **before** the new revision serves. A failed migration fails the deploy. |
| **prod** | `gifsy_prod` — shared **private** instance `gifsy-db` | **Gated.** The `gifsy-migrate` Cloud Run Job (targets prod `DATABASE_URL`). **Not auto-wired** in `deploy.yml`. First apply with the new baseline needs a one-time reconcile — see the runbook below. |

## ⚠️ Prod cutover — the one-time baseline reconcile

`gifsy_prod` already recorded the 6 (now-archived) migrations in its `_prisma_migrations` table.
After the squash, `prisma migrate deploy` on prod will **hard-fail with P3005** ("applied
migrations not found locally"). It will **not** drop data — it refuses to proceed. To reconcile
at cutover (greenfield, so a clean recreate is also acceptable):

1. Backup / PITR confirmed (runbook Step 0).
2. Clear the 6 stale rows from `_prisma_migrations` (or DROP+recreate the empty prod DB).
3. `prisma migrate resolve --applied 00000000000000_baseline` **if** prod already has the tables,
   **or** let `migrate deploy` apply the baseline fresh if prod was recreated empty.
4. From then on, prod migrates forward normally via the job.

Full procedure: [`runbooks/PROD-DB-MIGRATION.md`](runbooks/PROD-DB-MIGRATION.md).

## Rules going forward (do NOT regress)

- **Every schema change = a new migration file** in `api/prisma/migrations/`, applied via the job.
- **`migrations-manual/` is legacy** — do not add to it. It exists only as the source record of
  the pre-baseline manual SQL.
- **Never `db push` to staging or prod.** `db push` is a dev-loop tool with no ledger.
- **Partial indexes / anything Prisma can't model** → hand-add to the migration SQL **and** add a
  guard (the upload service's P2002 catch + a test) so a future regression is loud.
- **Staging mirrors prod's mechanism** — both use `migrate deploy` via the job. That is the point
  of staging.

Related: [`DEV-DB.md`](DEV-DB.md) · [`ENVIRONMENTS.md`](ENVIRONMENTS.md) ·
[`runbooks/PROD-DB-MIGRATION.md`](runbooks/PROD-DB-MIGRATION.md) ·
[`08-agent-execution-guide.md`](08-agent-execution-guide.md).
