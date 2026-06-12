/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts: Store utilities
 *
 * Groups:
 *   A — newBatchId: format CB-YYYY-MM-NNN
 *   B — isUploadWindowOpen: monthCutoffDay enforcement
 *   C — updateField removed from fields
 *   D — upload page: cutoff + period wired to newBatchId (source-read)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import type { CreditBatch } from '@/types';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Minimal CreditBatch factory ──────────────────────────────────────────────

function makeBatch(id: string, period: string): CreditBatch {
  return {
    id, period,
    status: 'CONFIRMED', uploadedBy: 'Test', uploadedAt: new Date().toISOString(),
    totalOutlets: 1, totalPoints: 0, totalPayoutInr: 0, rows: [],
  };
}

// ─── A — newBatchId format ────────────────────────────────────────────────────

describe('A — newBatchId: CB-YYYY-MM-NNN format', () => {
  beforeEach(() => { localStorage.clear(); });

  it('A1: ID starts with "CB-"', async () => {
    const { newBatchId, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    expect(newBatchId('2026-05')).toMatch(/^CB-/);
  });

  it('A2: ID contains the period', async () => {
    const { newBatchId, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    expect(newBatchId('2026-05')).toContain('2026-05');
  });

  it('A3: ID matches CB-YYYY-MM-NNN pattern exactly', async () => {
    const { newBatchId, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    expect(newBatchId('2026-05')).toMatch(/^CB-\d{4}-\d{2}-\d{3}$/);
  });

  it('A4: first ID for a clean period is CB-YYYY-MM-001', async () => {
    const { newBatchId, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    expect(newBatchId('2026-05')).toBe('CB-2026-05-001');
  });

  it('A5: second ID increments to 002 after first batch is saved', async () => {
    const { newBatchId, saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    const id1 = newBatchId('2026-05');
    saveBatch(makeBatch(id1, '2026-05'));
    const id2 = newBatchId('2026-05');
    expect(id1).toBe('CB-2026-05-001');
    expect(id2).toBe('CB-2026-05-002');
  });

  it('A6: different periods have independent counters', async () => {
    const { newBatchId, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    expect(newBatchId('2026-05')).toBe('CB-2026-05-001');
    expect(newBatchId('2026-06')).toBe('CB-2026-06-001');
  });

  it('A7: newBatchId accepts the period parameter', () => {
    const code = src('lib/credits-payouts-store.ts');
    expect(code).toMatch(/newBatchId\s*\(\s*period\s*:/);
  });
});

// ─── B — isUploadWindowOpen ───────────────────────────────────────────────────

describe('B — isUploadWindowOpen: cutoff enforcement', () => {
  it('B1: exported from credits-payouts-store', () => {
    const code = src('lib/credits-payouts-store.ts');
    expect(code).toMatch(/export\s+function\s+isUploadWindowOpen/);
  });

  it('B2: returns true when today (day 11) is before cutoff (28)', async () => {
    const { isUploadWindowOpen } = await import('../credits-payouts-store');
    const today = new Date(2026, 5, 11); // June 11
    expect(isUploadWindowOpen(28, today)).toBe(true);
  });

  it('B3: returns false when today (day 29) is after cutoff (28)', async () => {
    const { isUploadWindowOpen } = await import('../credits-payouts-store');
    const today = new Date(2026, 5, 29); // June 29
    expect(isUploadWindowOpen(28, today)).toBe(false);
  });

  it('B4: returns true on exactly the cutoff day', async () => {
    const { isUploadWindowOpen } = await import('../credits-payouts-store');
    const today = new Date(2026, 5, 28); // June 28 = cutoff
    expect(isUploadWindowOpen(28, today)).toBe(true);
  });

  it('B5: cutoffDay=1 — day 1 is open, day 2 is closed', async () => {
    const { isUploadWindowOpen } = await import('../credits-payouts-store');
    expect(isUploadWindowOpen(1, new Date(2026, 5, 1))).toBe(true);
    expect(isUploadWindowOpen(1, new Date(2026, 5, 2))).toBe(false);
  });

  it('B6: default monthCutoffDay in gifsy-settings is 28', () => {
    const code = src('lib/gifsy-settings.ts');
    // Must contain monthCutoffDay: 28 (not 10)
    expect(code).toMatch(/monthCutoffDay\s*:\s*28/);
    expect(code).not.toMatch(/monthCutoffDay\s*:\s*10/);
  });
});

// ─── C — updateField removed ──────────────────────────────────────────────────

describe('C — updateField removed from fields', () => {
  it('C1: updateField is NOT exported from credits-payouts-fields.ts', () => {
    const code = src('lib/credits-payouts-fields.ts');
    expect(code).not.toMatch(/export\s+function\s+updateField/);
  });

  it('C2: updateField is not referenced in any admin page', () => {
    const uploadCode = src('app/admin/credits-payouts/upload/page.tsx');
    const fieldsCode = src('app/admin/credits-payouts/fields/page.tsx');
    expect(uploadCode).not.toMatch(/updateField/);
    expect(fieldsCode).not.toMatch(/updateField/);
  });
});

// ─── D — Upload page enforcement (source-read) ───────────────────────────────

describe('D — Upload page: cutoff + period in newBatchId', () => {
  it('D1: upload page imports isUploadWindowOpen', () => {
    const code = src('app/admin/credits-payouts/upload/page.tsx');
    expect(code).toMatch(/isUploadWindowOpen/);
  });

  it('D2: upload page calls newBatchId with period argument', () => {
    const code = src('app/admin/credits-payouts/upload/page.tsx');
    // Must call newBatchId(period) not newBatchId()
    expect(code).toMatch(/newBatchId\s*\(\s*period\s*\)/);
  });

  it('D3: upload page shows a cutoff warning when window is closed', () => {
    const code = src('app/admin/credits-payouts/upload/page.tsx');
    // Should reference a cutoff-closed state or message
    expect(code).toMatch(/cutoff|upload window|closed/i);
  });

  it('D4: upload page disables confirm button when window is closed', () => {
    const code = src('app/admin/credits-payouts/upload/page.tsx');
    // The confirm button must check uploadWindowOpen or similar
    expect(code).toMatch(/uploadWindowOpen|windowOpen|windowClosed|isClosed/i);
  });
});
