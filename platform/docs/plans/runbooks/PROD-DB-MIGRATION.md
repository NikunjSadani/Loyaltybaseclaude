# Runbook — Production DB migration (A-5 / 9.5)

> Bring `gifsy_prod` (the production database) up to the current schema
> (`api/prisma/schema.prisma`) **safely**, before the current code deploys to prod at cutover.
> This is a CUTOVER-PHASE step: prepare now, execute with the owner at launch.
>
> ⚠️ **Destructive-capable. Backups MUST be on first (Step 0).** Companion: [`PROD-DATA-WIPE.md`](PROD-DATA-WIPE.md).

## Context (why this is needed + how migrations work here)
- The app's schema source of truth is **`api/prisma/schema.prisma`**.

> **🔄 UPDATED 2026-06-20 — the migration model changed.** History was **squashed to one clean baseline**
> (`api/prisma/migrations/00000000000000_baseline/`; the 6 old migrations are in `migrations-archive/`). Migrations
> now apply via **`prisma migrate deploy` run as an in-VPC Cloud Run Job** (the instance is private-IP). **Staging is
> auto-migrated** on every `develop` push (`gifsy-migrate-staging` job in `deploy-staging.yml`). **Prod is still gated
> and run via the existing `gifsy-migrate` job.** Full model: [`../MIGRATIONS.md`](../MIGRATIONS.md). The diff-based
> Steps 1–4 below remain valid as the *reviewed, backed-up, guarded* cutover mechanic — but see **Step 1.5** first: with
> the baseline, the prod first-apply needs a one-time `_prisma_migrations` reconcile or `migrate deploy` will P3005-fail.

- `gifsy_prod` recorded the 6 now-archived migrations in its `_prisma_migrations` table (the `gifsy-migrate` job last ran
  2026-06-12, applying the June-6 set). So prod is on the **June-6 schema** — it has `otp_codes` (login works) but is
  **missing all P4–P6 tables** and still carries old World-A tables. It must be brought to the current baseline.

## ⚠️ Step 1.5 — Prod baseline reconcile (one-time, because of the squash)
After the 2026-06-20 squash, plain `prisma migrate deploy` against `gifsy_prod` **hard-fails with P3005** ("applied
migrations not found locally") — it refuses, does not drop data. Because the project is **greenfield (no real prod
data)**, the simplest correct reconcile is a **clean recreate** (prod is wiped at go-live anyway, see
[`PROD-DATA-WIPE.md`](PROD-DATA-WIPE.md)):
- **Path A (recreate, preferred at cutover):** after backup (Step 0), DROP+recreate an **empty** `gifsy_prod`, then run
  the `gifsy-migrate` job → `migrate deploy` applies the baseline fresh → full current schema. Then seed real data.
- **Path B (preserve, if ever needed):** clear the 6 stale rows from `_prisma_migrations`, ensure the tables match the
  baseline, then `prisma migrate resolve --applied 00000000000000_baseline` so the job treats it as already-applied.

## The tool: `prisma migrate diff` (Prisma 7 syntax — verified 2026-06-20)
Generates a **reviewable SQL script** to bring a live DB to a target schema. **Read-only** against the source DB.
```
# from the api/ dir, with DATABASE_URL pointed at the SOURCE db (via .env / prisma.config.ts):
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```
*(Note: Prisma 7 removed `--from-url`; use `--from-config-datasource`, which reads the datasource from `prisma.config.ts`
→ `DATABASE_URL`.)* Validated against `gifsy_dev`: output was just 4 cosmetic index RENAMEs (dev is current).

---

## Step 0 — HARD PRECONDITION: backups + PITR (O-4)
- [ ] Cloud SQL **automated backups ENABLED** on the shared instance `gifsy_db`.
- [ ] **Point-in-time recovery (PITR) ENABLED.**
- [ ] An **on-demand backup taken** + timestamp noted immediately before Step 4.

🛑 Do NOT run Step 4 until all three are true — the only rollback is a point-in-time restore.

## Step 1 — Compute the prod diff (READ-ONLY, safe)
1. Get the prod connection: a Cloud SQL Auth Proxy to the **`gifsy_db`** instance, and the **prod** `DATABASE_URL`
   (Secret Manager `DATABASE_URL`, `…/gifsy_prod`). **Confirm it is `gifsy_prod`, never `gifsy_staging`.**
2. With `DATABASE_URL` pointed at prod, from `api/`:
   ```
   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script > prod-migration.sql
   ```
3. This only **reads** prod's schema — it makes zero changes. Output = the SQL to bring prod → current schema.

## Step 2 — REVIEW the diff (the gate)
Read `prod-migration.sql` carefully. Classify every statement:
- **Additive** (CREATE TABLE/COLUMN/INDEX, ALTER ADD) — safe.
- **Renames** (ALTER INDEX/… RENAME) — safe.
- **⚠️ DESTRUCTIVE** (DROP TABLE/COLUMN, ALTER TYPE … DROP, NOT NULL on a populated column) — **stop and assess**.
  - If prod still has **old World-A tables**, the diff will DROP them. That's acceptable **only because prod has no real
    Deoleo data yet** — confirm prod is empty/seed-only before allowing drops.
  - **`ALTER TYPE … ADD VALUE` must run OUTSIDE a transaction** (see `migrations-manual/P3_doctype_split.sql` /
    `P5_wallet_rewards_additive.sql` for the proven shape). If the diff includes enum additions, split them out.
- **Independently audit** the SQL (Opus + an adversarial agent) before applying — same bar as every migration here.

## Step 3 — Dry-run on STAGING first
`gifsy_staging` is on the **same instance** as prod and is the closest analogue. Apply the reviewed SQL to
`gifsy_staging` first (DATABASE_URL → staging), then **redeploy/boot the staging API** and confirm it starts, `/health`
is 200, and a couple of key queries work. ⚠️ Assert `current_database()='gifsy_staging'` before applying here.

## Step 4 — Apply to PROD (after Step 0)
- Wrap `prod-migration.sql` so it **asserts `current_database()='gifsy_prod'`** at the top and aborts otherwise (mirror
  the guard in `migrations-manual/*.sql`). Put it in `api/prisma/migrations-manual/` for the record.
- Apply via guarded execute (NOT `prisma migrate dev` — that resets):
  ```
  npx prisma db execute --file prisma/migrations-manual/<prod-migration>.sql
  ```
  (Prisma 7: no `--schema` flag; the datasource URL comes from `prisma.config.ts` → confirm it's prod first.)
- Enum additions (if any) run as a separate non-transactional step.
- **Show the final SQL + wait for owner go before running.**

## Step 5 — Verify
- Prod API boots + `Database connected`; `/health` = 200.
- Spot-check a few representative queries per role (KYC list, wallet, a redemption read).
- Then the prod **code deploy** proceeds (current code), and the cutover continues (remove the worker alias, real-OTP smoke).

## Step 6 — Migration-history bookkeeping (optional)
After a diff-based apply, `_prisma_migrations` may not reflect reality. Either `prisma migrate resolve --applied <name>`
to baseline, or accept the diff-based model going forward (the project already mixes formal + manual migrations).

## Rollback
The only rollback is a **point-in-time restore** to the timestamp noted in Step 0. There is no in-place undo for a
destructive migration — which is why Step 0 is non-negotiable.

---

### Owner vs me
- **Me:** run the diff (Step 1, read-only) given prod access, review + audit the SQL (Step 2), drive the staging dry-run
  (Step 3) and the guarded prod apply (Step 4) + verify (Step 5), author the wrapped SQL.
- **Owner:** enable backups/PITR (Step 0), provide prod-DB access / the prod `DATABASE_URL`, approve the reviewed SQL
  before Step 4.
