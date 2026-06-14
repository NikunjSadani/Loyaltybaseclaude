# Dev Database — operational notes

A dedicated GCP Cloud SQL instance for development, **isolated from production**.

## Facts
- **Instance:** `gifsy-db-dev` — Postgres 15, db-f1-micro, asia-south1-b, **public IP 34.14.195.38**
- **Connection name:** `gifsy-platform:asia-south1:gifsy-db-dev`
- **Database:** `gifsy_dev` · **User:** `gifsy_user`
- **Password:** GCP **Secret Manager** secret `gifsy-dev-db-password` (never in git/transcript)
- **Local access:** Cloud SQL **Auth Proxy** on `127.0.0.1:5433`
- **`.env`:** `DATABASE_URL=postgresql://gifsy_user:<pw>@127.0.0.1:5433/gifsy_dev`, `DEMO_MODE=false`
- **Schema:** created with `npx prisma db push` (79 tables), starts empty.
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

## Reset the dev DB (safe — isolated, empty by default)
`npx prisma db push --force-reset`

## Rotate / fetch the password
- Fetch: `gcloud secrets versions access latest --secret=gifsy-dev-db-password`
- Rotate: set a new password on `gifsy_user` (`gcloud sql users set-password`), add a new Secret
  Manager version, update `.env`.
