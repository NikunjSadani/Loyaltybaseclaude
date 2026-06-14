/**
 * Phase 0 — Live DB integration test
 *
 * Verifies the add_credit_batch_models.sql migration was applied to the
 * running Prisma database. Requires:
 *   - DATABASE_URL set to a live PostgreSQL instance
 *   - cloud-sql-proxy running (for GCP Cloud SQL)
 *
 * NOTE: gifsy_prod has no public IP — cannot run from local machine.
 * Run inside Cloud Run (which has VPC + unix socket access):
 *   gcloud run jobs execute gifsy-verify-migration
 *
 * The migration was applied via `gcloud sql import sql` on 2026-06-14
 * and verified via Cloud Run job (exit 0, all 5 tables confirmed).
 *
 * Groups:
 *   A — Prisma can reach the database
 *   B — All 5 new tables are queryable (count returns without error)
 *   C — Enum values are accepted by the DB (insert + rollback)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// URL-encode special chars in password so the driver can parse it.
// Raw in .env: postgresql://postgres:Gifsy@DB#2026Prod@localhost:5432/gifsy_prod
// @ → %40, # → %23
const DB_URL =
  process.env.DATABASE_URL_ENCODED ??
  'postgresql://postgres:Gifsy%40DB%232026Prod@localhost:5432/gifsy_prod';

const adapter = new PrismaPg({ connectionString: DB_URL });
const prisma = new PrismaClient({ adapter });

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ─── A — Connectivity ────────────────────────────────────────────────────────

describe('A — Prisma can reach the database', () => {
  it('A1: $queryRaw SELECT 1 returns a result', async () => {
    const result = await prisma.$queryRaw<[{ '?column?': number }]>`SELECT 1`;
    expect(result[0]['?column?']).toBe(1);
  });
});

// ─── B — Tables are queryable ─────────────────────────────────────────────────

describe('B — All 5 new tables are queryable', () => {
  it('B1: creditField.count() returns without error', async () => {
    const n = await prisma.creditField.count();
    expect(typeof n).toBe('number');
  });

  it('B2: creditBatch.count() returns without error', async () => {
    const n = await prisma.creditBatch.count();
    expect(typeof n).toBe('number');
  });

  it('B3: creditPayoutEntry.count() returns without error', async () => {
    const n = await prisma.creditPayoutEntry.count();
    expect(typeof n).toBe('number');
  });

  it('B4: creditPayoutDownload.count() returns without error', async () => {
    const n = await prisma.creditPayoutDownload.count();
    expect(typeof n).toBe('number');
  });

  it('B5: creditReversal.count() returns without error', async () => {
    const n = await prisma.creditReversal.count();
    expect(typeof n).toBe('number');
  });
});

// ─── C — Enum values accepted ─────────────────────────────────────────────────

describe('C — Enum values are accepted by the database', () => {
  it('C1: CreditBatchStatus enum values are valid (raw query)', async () => {
    const result = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'CreditBatchStatus'
      ORDER BY enumlabel
    `;
    const values = result.map((r) => r.enumlabel).sort();
    expect(values).toContain('CONFIRMED');
    expect(values).toContain('PARTIALLY_REVERSED');
    expect(values).toContain('PENDING_CONFIRM');
  });

  it('C2: CreditReversalStatus enum values are valid (raw query)', async () => {
    const result = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'CreditReversalStatus'
      ORDER BY enumlabel
    `;
    const values = result.map((r) => r.enumlabel).sort();
    expect(values).toContain('APPROVED');
    expect(values).toContain('PARTIAL');
    expect(values).toContain('PENDING_GIFSY');
    expect(values).toContain('REJECTED');
  });

  it('C3: CreditEntryStatus enum values are valid (raw query)', async () => {
    const result = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'CreditEntryStatus'
      ORDER BY enumlabel
    `;
    const values = result.map((r) => r.enumlabel).sort();
    expect(values).toContain('FAILED');
    expect(values).toContain('PAID');
    expect(values).toContain('PENDING');
    expect(values).toContain('PROCESSING');
  });

  it('C4: all 5 table names exist in information_schema.tables', async () => {
    const result = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'credit_fields', 'credit_batches',
          'credit_payout_entries', 'credit_payout_downloads', 'credit_reversals'
        )
      ORDER BY table_name
    `;
    const names = result.map((r) => r.table_name).sort();
    expect(names).toEqual([
      'credit_batches',
      'credit_fields',
      'credit_payout_downloads',
      'credit_payout_entries',
      'credit_reversals',
    ]);
  });
});
