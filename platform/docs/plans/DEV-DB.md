# Dev Database — operational notes

A dedicated GCP Cloud SQL instance for development, **isolated from production**.

## Facts
- **Instance:** `gifsy-db-dev` — Postgres 15, db-f1-micro, asia-south1-b, **public IP 34.14.195.38**
- **Connection name:** `gifsy-platform:asia-south1:gifsy-db-dev`
- **Database:** `gifsy_dev` · **User:** `gifsy_user`
- **Password:** GCP **Secret Manager** secret `gifsy-dev-db-password` (never in git/transcript)
- **Local access:** Cloud SQL **Auth Proxy** on `127.0.0.1:5433`
- **`.env`:** `DATABASE_URL=postgresql://gifsy_user:<pw>@127.0.0.1:5433/gifsy_dev`, `DEMO_MODE=false`
- **Schema:** built from **`platform/prisma/schema.prisma`** (the platform's OWN schema = source of truth; 80
  models as of P2) via `npx prisma db push`, starts empty. ⚠️ This is the **platform** schema — NOT the separate
  `api/prisma/schema.prisma` (the NestJS `api/` service is a different app with its own schema, 74 models). Always
  generate/migrate from the platform's own schema (`npx prisma generate` in `platform/` uses `prisma.config.ts`).
- Cost: ~$8/mo (smallest tier, HDD, no backups).

## ⚠️ Never point dev at prod
Prod is `gifsy-db` (database `gifsy_prod`), **private-IP only**. Dev migrations/writes must hit
**only** `gifsy-db-dev`. Never run Prisma against `gifsy-db`.

## Start / restart the Auth Proxy (does NOT survive a reboot)
1. Check whether anything is on 5433:
   `Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue`
2. If nothing, start it in the background:
   ```powershell
   & "$env:TEMP\cloud-sql-proxy.exe" gifsy-platform:asia-south1:gifsy-db-dev --port 5433 `
     --credentials-file="C:/Users/nikun/Loyaltybaseclaude/gifsy-platform-60018da0d5b4.json"
   ```
3. If the binary is missing from `%TEMP%`, re-download the Cloud SQL Auth Proxy v2 (windows/amd64)
   from `https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/<version>/cloud-sql-proxy.x64.exe`.

## Verify connectivity
`npx prisma db push` (idempotent) — or a `SELECT 1` against `127.0.0.1:5433/gifsy_dev`.

## Applying schema changes — do NOT use `prisma migrate dev`
This DB is **db-push / manual-SQL managed**: there is **no `_prisma_migrations` table** and no
Prisma migration-folder history (`prisma/migrations/` holds only loose `*.sql` records).
`npx prisma migrate dev` would see the populated schema with no migration history, detect "drift",
and **reset (drop all tables)**. Never run it here.

To apply a schema change to dev, either:
- **`npx prisma db push`** — syncs the whole `schema.prisma` to the DB (additive; warns on data loss); or
- **surgical diff-SQL** for a single change (what 1.3 did): generate the exact delta read-only with
  `npx prisma migrate diff --from-schema <old-schema> --to-schema prisma/schema.prisma --script`,
  review it, save it under `prisma/migrations/<name>.sql`, and apply it in a transaction (with a
  `current_database() = 'gifsy_dev'` guard). Then `npx prisma generate` to refresh the client.

Backfill/seed scripts must reuse the `lib/prisma` singleton (Prisma 7 + `@prisma/adapter-pg`);
a bare `new PrismaClient()` throws. Load `dotenv/config` first so `DATABASE_URL` is set.

## Reset the dev DB (safe — isolated, empty by default)
`npx prisma db push --force-reset`

## Rotate / fetch the password
- Fetch: `gcloud secrets versions access latest --secret=gifsy-dev-db-password`
- Rotate: set a new password on `gifsy_user` (`gcloud sql users set-password`), add a new Secret
  Manager version, update `.env`.
