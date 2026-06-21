# Production Cutover — Record (A-9)

> Executed 2026-06-20. This is the **as-run record** of the Deoleo production cutover. The cutover was
> performed directly (each step gated by an independent adversarial audit) rather than handed off as a
> runbook; this doc captures exactly what was done so it's reproducible/auditable. Companions:
> [`PROD-DB-MIGRATION.md`](PROD-DB-MIGRATION.md) (the migration mechanics) + [`../MIGRATIONS.md`](../MIGRATIONS.md).

## Pre-state (verified read-only, in-VPC)
`gifsy_prod`: stale **June-6 schema** — `public_tables: 75`, `otp_codes: true`, **`kpi_defs`(P4): false**,
**`tds_deposits`(P6): false**, **World-A `tier_configs`: true**, `_prisma_migrations: 6 rows`, **`users: 0`,
`clients: 0`** (greenfield, no real data). Prod ran OLD code; `deoleoloyalty.gifsy.in` served via a temporary
worker host-alias (`deoleoloyalty`→`deoleo.gifsy.in`).

## Steps executed (in order)
1. **Backup** — on-demand backup of the shared Cloud SQL instance `gifsy-db`.
2. **Wire prod auto-migrate** — added a "Run DB migrations (production)" step to `.github/workflows/deploy.yml`
   (mirrors staging: `gcloud run jobs deploy gifsy-migrate … npx prisma migrate deploy … --execute-now --wait`,
   prod `DATABASE_URL`, SHA-pinned image, before the service deploy).
3. **Recreate `gifsy_prod` empty** — in-VPC job, **double-guarded** (`current_database()='gifsy_prod'` AND
   `users=0`): `DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;`. This
   reconciles the P3005 (drops the 6 stale migration rows + the World-A tables). Zero real data lost (0 users).
4. **Apply baseline** — ran the `gifsy-migrate` job (`prisma migrate deploy`) → applied
   `00000000000000_baseline`. Verified: **`public_tables: 73`** (72 + ledger), `kpi_defs`(P4)=true,
   `tds_deposits`(P6)=true, **World-A=false**, `_prisma_migrations: 1`, `users: 0`, `clients: 0`.
5. **`CORS_ORIGINS`** — added `https://deoleoloyalty.gifsy.in` (secret v3).
6. **Code deploy** — merged `develop`→`main` (fast-forward, 193 commits) → pushed → prod deploy approved at the
   GitHub "production" required-reviewer gate → `gifsy-api` + `gifsy-frontend` now serve `b3ab2e0`.
7. **Remove the worker host-alias** — deleted `deoleoloyalty.gifsy.in`→`deoleo.gifsy.in` from
   `cloudflare-worker/worker.js` (current code resolves `deoleoloyalty.gifsy.in`→`deoleo` natively) + `wrangler deploy`.
   The UAT alias (`uat.deoleoloyalty.gifsy.in`→`deoleoloyalty.gifsy.in`, for staging) was kept.

## Post-state (verified)
- Prod `gifsy-api` + `gifsy-frontend` serve `b3ab2e0` (current code).
- `https://deoleoloyalty.gifsy.in/auth/login` → **200**; `…/api/auth/send-otp` (no-channel) → **400** from the
  backend (proves FE→backend routing + the `NEXT_PUBLIC_API_URL` GitHub secret = `https://api.gifsy.in`; no SMS sent).
- `https://api.gifsy.in/health` → **200**.
- Independent Opus audit pre-deploy: **SAFE-TO-APPROVE** (all in-repo correct; the two external values — the
  `NEXT_PUBLIC_API_URL` secret + `CORS_ORIGINS` — were then verified/fixed).

## What is intentionally NOT done (prod is greenfield-empty)
Prod has **0 users / 0 clients** — by design. Real users cannot log in until the **real Deoleo master data** is
loaded (client config, admins, sales team, partners/outlets, reward catalog, schemes). That is the go-live
data-load step, tracked in [`GO-LIVE-READINESS.md`](../GO-LIVE-READINESS.md) / `DEOLEO-GO-LIVE-BUNDLE.md`.

## Rollback
The pre-cutover backup (step 1) is the restore point. Prod had no real data, so rollback ≈ restore the empty
instance; in practice forward-fix (another `main` deploy) is the path.
