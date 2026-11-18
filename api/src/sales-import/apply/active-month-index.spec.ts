import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The PARTIAL unique index `sales_apply_job_months_active_month_key` (one active Apply / Recalculate per tenant × month)
 * lives only in migration 20261118170000_sales_apply_jobs — Prisma cannot express it, so `prisma migrate dev` will try
 * to DROP it in any migration it generates later. Without it two applies of one month can be queued and both run.
 * This spec fails if the index is not created, or if any LATER migration drops it without re-creating it (re-review L7).
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', 'prisma', 'migrations');
const INDEX = 'sales_apply_job_months_active_month_key';

describe('sales_apply_job_months_active_month_key (partial unique index)', () => {
  const dirs = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
  const sql = (d: string) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

  it('is created as a PARTIAL unique index on (clientId, month) for QUEUED / RUNNING months', () => {
    const text = sql('20261118170000_sales_apply_jobs').replace(/\s+/g, ' ');
    expect(text).toMatch(new RegExp(`CREATE UNIQUE INDEX "${INDEX}" ON "sales_apply_job_months"\\("clientId", "month"\\) WHERE "status" IN \\('QUEUED', 'RUNNING'\\)`));
  });

  it('is never dropped by a later migration (unless that migration re-creates it)', () => {
    const later = dirs.filter((d) => d > '20261118170000_sales_apply_jobs');
    const offenders = later.filter((d) => {
      const text = sql(d);
      const drops = new RegExp(`DROP INDEX[^;]*"?${INDEX}"?`, 'i').test(text);
      const recreates = new RegExp(`CREATE UNIQUE INDEX[^;]*"?${INDEX}"?[^;]*WHERE`, 'i').test(text);
      return drops && !recreates;
    });
    expect(offenders).toEqual([]);
  });
});
