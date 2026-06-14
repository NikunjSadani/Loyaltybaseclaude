/// <reference types="vitest/globals" />
/**
 * TDD — credits migration SQL file verification
 *
 * Source-read tests that confirm the migration SQL is correct and complete
 * before it is applied to the database. These tests do NOT require a live DB.
 *
 * Groups:
 *   A — Migration file exists
 *   B — All 4 enums are defined with correct values
 *   C — All 5 tables are created with IF NOT EXISTS
 *   D — Foreign keys are correct
 *   E — All indexes are present
 *   F — Idempotent: uses IF NOT EXISTS / exception-safe DO blocks
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');
const SQL_PATH = 'prisma/migrations/add_credit_batch_models.sql';

function sql(): string {
  return readFileSync(resolve(ROOT, SQL_PATH), 'utf-8');
}

// ─── A — File exists ──────────────────────────────────────────────────────────

describe('A — Migration file exists', () => {
  it('A1: add_credit_batch_models.sql exists in prisma/migrations/', () => {
    expect(existsSync(resolve(ROOT, SQL_PATH))).toBe(true);
  });
});

// ─── B — Enums ────────────────────────────────────────────────────────────────

describe('B — Enum definitions', () => {
  it('B1: CreditBatchStatus enum includes PENDING_CONFIRM, CONFIRMED, PARTIALLY_REVERSED', () => {
    const s = sql();
    expect(s).toMatch(/CREATE TYPE "CreditBatchStatus"/);
    expect(s).toMatch(/PENDING_CONFIRM/);
    expect(s).toMatch(/CONFIRMED/);
    expect(s).toMatch(/PARTIALLY_REVERSED/);
  });

  it('B2: CreditAwardType enum includes POINTS, PAYOUT', () => {
    const s = sql();
    expect(s).toMatch(/CREATE TYPE "CreditAwardType"/);
    expect(s).toMatch(/POINTS/);
    expect(s).toMatch(/PAYOUT/);
  });

  it('B3: CreditReversalStatus enum includes PENDING_GIFSY, APPROVED, PARTIAL, REJECTED', () => {
    const s = sql();
    expect(s).toMatch(/CREATE TYPE "CreditReversalStatus"/);
    expect(s).toMatch(/PENDING_GIFSY/);
    expect(s).toMatch(/APPROVED/);
    expect(s).toMatch(/PARTIAL/);
    expect(s).toMatch(/REJECTED/);
  });

  it('B4: CreditEntryStatus enum includes PENDING, PROCESSING, PAID, FAILED', () => {
    const s = sql();
    expect(s).toMatch(/CREATE TYPE "CreditEntryStatus"/);
    expect(s).toMatch(/PROCESSING/);
    expect(s).toMatch(/PAID/);
    expect(s).toMatch(/FAILED/);
  });
});

// ─── C — Tables ───────────────────────────────────────────────────────────────

describe('C — Table creation', () => {
  it('C1: creates credit_fields table', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credit_fields"/);
  });

  it('C2: creates credit_batches table', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credit_batches"/);
  });

  it('C3: creates credit_payout_entries table', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credit_payout_entries"/);
  });

  it('C4: creates credit_payout_downloads table', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credit_payout_downloads"/);
  });

  it('C5: creates credit_reversals table', () => {
    expect(sql()).toMatch(/CREATE TABLE IF NOT EXISTS "credit_reversals"/);
  });

  it('C6: credit_fields has outletTypeAwards JSONB column', () => {
    expect(sql()).toMatch(/outletTypeAwards.*JSONB/s);
  });

  it('C7: credit_batches has rows JSONB column with default []', () => {
    const s = sql();
    expect(s).toMatch(/"rows"\s+JSONB/);
    expect(s).toMatch(/DEFAULT '\[\]'/);
  });

  it('C8: credit_payout_entries has DECIMAL amountInr column', () => {
    expect(sql()).toMatch(/"amountInr"\s+DECIMAL/);
  });

  it('C9: credit_reversals has originalAmount, requestedAmount, approvedAmount columns', () => {
    const s = sql();
    expect(s).toMatch(/"originalAmount"/);
    expect(s).toMatch(/"requestedAmount"/);
    expect(s).toMatch(/"approvedAmount"/);
  });
});

// ─── D — Foreign keys ─────────────────────────────────────────────────────────

describe('D — Foreign key constraints', () => {
  it('D1: credit_payout_entries.batchId references credit_batches(id)', () => {
    const s = sql();
    expect(s).toMatch(/credit_payout_entries_batchId_fkey/);
    expect(s).toMatch(/REFERENCES "credit_batches"\("id"\)/);
  });

  it('D2: credit_payout_entries.downloadId references credit_payout_downloads(id)', () => {
    const s = sql();
    expect(s).toMatch(/credit_payout_entries_downloadId_fkey/);
    expect(s).toMatch(/REFERENCES "credit_payout_downloads"\("id"\)/);
  });

  it('D3: credit_reversals.batchId references credit_batches(id)', () => {
    const s = sql();
    expect(s).toMatch(/credit_reversals_batchId_fkey/);
    expect(s).toMatch(/REFERENCES "credit_batches"\("id"\)/);
  });

  it('D4: downloadId FK uses ON DELETE SET NULL (nullable field)', () => {
    expect(sql()).toMatch(/ON DELETE SET NULL/);
  });
});

// ─── E — Indexes ──────────────────────────────────────────────────────────────

describe('E — Indexes', () => {
  it('E1: unique index on credit_fields(clientId, name)', () => {
    expect(sql()).toMatch(/credit_fields_clientId_name_key/);
  });

  it('E2: unique index on credit_batches(batchCode)', () => {
    expect(sql()).toMatch(/credit_batches_batchCode_key/);
  });

  it('E3: unique index on credit_payout_downloads(downloadCode)', () => {
    expect(sql()).toMatch(/credit_payout_downloads_downloadCode_key/);
  });

  it('E4: clientId index on every main table', () => {
    const s = sql();
    expect(s).toMatch(/credit_fields_clientId_idx/);
    expect(s).toMatch(/credit_batches_clientId_idx/);
    expect(s).toMatch(/credit_payout_entries_clientId_idx/);
    expect(s).toMatch(/credit_payout_downloads_clientId_idx/);
    expect(s).toMatch(/credit_reversals_clientId_idx/);
  });

  it('E5: period index on batches, entries, downloads', () => {
    const s = sql();
    expect(s).toMatch(/credit_batches_period_idx/);
    expect(s).toMatch(/credit_payout_entries_period_idx/);
    expect(s).toMatch(/credit_payout_downloads_period_idx/);
  });

  it('E6: status index on entries, downloads, reversals', () => {
    const s = sql();
    expect(s).toMatch(/credit_payout_entries_status_idx/);
    expect(s).toMatch(/credit_payout_downloads_status_idx/);
    expect(s).toMatch(/credit_reversals_status_idx/);
  });
});

// ─── F — Idempotency ──────────────────────────────────────────────────────────

describe('F — Idempotency (safe to re-run)', () => {
  it('F1: all CREATE TABLE statements use IF NOT EXISTS', () => {
    const s = sql();
    const createTableCount = (s.match(/CREATE TABLE/g) ?? []).length;
    const ifNotExistsCount = (s.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length;
    expect(ifNotExistsCount).toBe(createTableCount);
  });

  it('F2: all CREATE INDEX statements use IF NOT EXISTS', () => {
    const s = sql();
    const createIndexCount  = (s.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length;
    const ifNotExistsCount  = (s.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length;
    expect(ifNotExistsCount).toBe(createIndexCount);
  });

  it('F3: enum creation blocks catch duplicate_object exception', () => {
    const s = sql();
    const enumCount     = (s.match(/CREATE TYPE.*AS ENUM/g) ?? []).length;
    const exceptionCount = (s.match(/duplicate_object/g) ?? []).length;
    expect(exceptionCount).toBe(enumCount);
  });
});
