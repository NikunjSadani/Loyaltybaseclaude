/**
 * Drift guard (audit A9): the off-portal register relies on constraints Prisma cannot model — they live only in the
 * migration. If someone edits the migration / squashes the baseline and drops them, this fails. (A live-DB check after
 * `migrate deploy` is: SELECT indexname FROM pg_indexes WHERE indexname = 'off_portal_payments_one_live_supersede'.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const allMigrationSql = (): string =>
  readdirSync(join(PRISMA_DIR, 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      try {
        return readFileSync(join(PRISMA_DIR, 'migrations', d.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');

describe('off-portal payments — migration-only constraints stay in place', () => {
  const sql = allMigrationSql().replace(/\s+/g, ' ');
  it('one LIVE payment per legacy TDS off-platform row (partial unique index)', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "off_portal_payments_one_live_supersede" ON "off_portal_payments" ("supersedesOffPlatformEntryId") WHERE "supersedesOffPlatformEntryId" IS NOT NULL AND "voidedAt" IS NULL',
    );
  });
  it('amount is always positive (CHECK)', () => {
    expect(sql).toContain('CONSTRAINT "off_portal_payments_amount_positive" CHECK ("amountPaise" > 0)');
  });
  it('the schema documents both (so a reader of schema.prisma knows they exist)', () => {
    const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
    expect(schema).toContain('off_portal_payments_one_live_supersede');
    expect(schema).toContain('off_portal_payments_amount_positive');
  });
});
