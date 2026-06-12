/// <reference types="vitest/globals" />
/**
 * TDD — Credits & Payouts Phase 2: Reversal Workflow
 *
 * Groups:
 *   A — Source exports
 *   B — checkReversalEligibility: POINTS
 *   C — checkReversalEligibility: PAYOUT
 *   D — initiateReversal
 *   E — approveReversal / rejectReversal
 *   F — getReversalsForOutlet
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve }      from 'path';
import type { CreditBatch, CreditPayoutEntry } from '@/types';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CONFIRMED_BATCH: CreditBatch = {
  id:             'rev_batch_001',
  period:         '2026-05',
  status:         'CONFIRMED',
  uploadedBy:     'Test Admin',
  uploadedAt:     '2026-06-01T10:00:00.000Z',
  confirmedAt:    '2026-06-01T10:05:00.000Z',
  confirmedBy:    'Test Admin',
  totalOutlets:   2,
  totalPoints:    500,
  totalPayoutInr: 800,
  rows: [
    { rowNum: 3, outletId: 'WS-001', outletName: 'Anand Wholesale', fieldId: 'f_vol', fieldName: 'Volume', amount: 500, narration: '', awardType: 'POINTS', status: 'OK', errors: [] },
    { rowNum: 4, outletId: 'RT-001', outletName: 'Sharma Store',    fieldId: 'f_vol', fieldName: 'Volume', amount: 800, narration: '', awardType: 'PAYOUT', status: 'OK', errors: [] },
  ],
};

const PENDING_PAYOUT_ENTRY: CreditPayoutEntry = {
  id:          'pentry_001',
  batchId:     'rev_batch_001',
  outletId:    'RT-001',
  outletName:  'Sharma Store',
  fieldId:     'f_vol',
  fieldName:   'Volume',
  period:      '2026-05',
  amount:      800,
  narration:   '',
  status:      'PENDING',
  createdAt:   '2026-06-01T10:05:00.000Z',
};

// ─── A — Source exports ───────────────────────────────────────────────────────

describe('A — reversal: exports', () => {
  it('A1: checkReversalEligibility exported', () => {
    const code = src('lib/credits-payouts-reversal.ts');
    expect(code).toMatch(/export\s+function\s+checkReversalEligibility/);
  });

  it('A2: initiateReversal exported', () => {
    const code = src('lib/credits-payouts-reversal.ts');
    expect(code).toMatch(/export\s+function\s+initiateReversal/);
  });

  it('A3: approveReversal exported', () => {
    const code = src('lib/credits-payouts-reversal.ts');
    expect(code).toMatch(/export\s+function\s+approveReversal/);
  });

  it('A4: rejectReversal exported', () => {
    const code = src('lib/credits-payouts-reversal.ts');
    expect(code).toMatch(/export\s+function\s+rejectReversal/);
  });

  it('A5: resetReversals exported', () => {
    const code = src('lib/credits-payouts-reversal.ts');
    expect(code).toMatch(/export\s+function\s+resetReversals/);
  });
});

// ─── B — checkReversalEligibility: POINTS ────────────────────────────────────

describe('B — POINTS reversal eligibility', () => {
  beforeEach(() => { localStorage.clear(); });

  async function seedBatch() {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch(CONFIRMED_BATCH);
  }

  it('B1: eligible for full POINTS amount when no prior reversals', async () => {
    await seedBatch();
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const result = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'WS-001', fieldId: 'f_vol' });
    expect(result.eligible).toBe(true);
    expect(result.awardType).toBe('POINTS');
    expect(result.maxReversibleAmount).toBe(500);
  });

  it('B2: ineligible when batch not confirmed (status PENDING_CONFIRM)', async () => {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch({ ...CONFIRMED_BATCH, status: 'PENDING_CONFIRM' });
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const result = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'WS-001', fieldId: 'f_vol' });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/confirmed/i);
  });

  it('B3: maxReversibleAmount decreases after partial reversal', async () => {
    await seedBatch();
    const { checkReversalEligibility, initiateReversal, approveReversal, resetReversals } =
      await import('../credits-payouts-reversal');
    resetReversals();

    // Approve a 200-point partial reversal
    const rev = initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 200, requestedBy: 'Client Admin',
    });
    approveReversal(rev.id, 'Gifsy Admin', 200);

    const elig = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'WS-001', fieldId: 'f_vol' });
    expect(elig.eligible).toBe(true);
    expect(elig.maxReversibleAmount).toBe(300); // 500 - 200
  });

  it('B4: ineligible when all points already reversed', async () => {
    await seedBatch();
    const { checkReversalEligibility, initiateReversal, approveReversal, resetReversals } =
      await import('../credits-payouts-reversal');
    resetReversals();

    const rev = initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 500, requestedBy: 'Client Admin',
    });
    approveReversal(rev.id, 'Gifsy Admin', 500);

    const elig = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'WS-001', fieldId: 'f_vol' });
    expect(elig.eligible).toBe(false);
    expect(elig.reason).toMatch(/already been reversed/i);
  });

  it('B5: ineligible when outlet/field row not found in batch', async () => {
    await seedBatch();
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const result = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'WS-999', fieldId: 'f_vol' });
    expect(result.eligible).toBe(false);
  });
});

// ─── C — checkReversalEligibility: PAYOUT ────────────────────────────────────

describe('C — PAYOUT reversal eligibility', () => {
  beforeEach(() => { localStorage.clear(); });

  async function seedBatchAndEntry(entryStatus: CreditPayoutEntry['status'] = 'PENDING') {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch(CONFIRMED_BATCH);

    const { resetPayoutEntries } = await import('../credits-payouts-payout-store');
    resetPayoutEntries();
    // Manually inject a payout entry into localStorage
    const entry: CreditPayoutEntry = { ...PENDING_PAYOUT_ENTRY, status: entryStatus };
    localStorage.setItem('gifsy_payout_entries_v1', JSON.stringify([entry]));
  }

  it('C1: eligible when payout entry is PENDING', async () => {
    await seedBatchAndEntry('PENDING');
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const elig = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'RT-001', fieldId: 'f_vol' });
    expect(elig.eligible).toBe(true);
    expect(elig.awardType).toBe('PAYOUT');
    expect(elig.maxReversibleAmount).toBe(800);
  });

  it('C2: ineligible when payout entry is PAID', async () => {
    await seedBatchAndEntry('PAID');
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const elig = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'RT-001', fieldId: 'f_vol' });
    expect(elig.eligible).toBe(false);
    expect(elig.reason).toMatch(/paid|processed/i);
  });

  it('C3: ineligible when payout entry is FAILED', async () => {
    await seedBatchAndEntry('FAILED');
    const { checkReversalEligibility, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    const elig = checkReversalEligibility({ batchId: 'rev_batch_001', outletId: 'RT-001', fieldId: 'f_vol' });
    expect(elig.eligible).toBe(false);
    expect(elig.reason).toMatch(/failed|retry/i);
  });
});

// ─── D — initiateReversal ─────────────────────────────────────────────────────

describe('D — initiateReversal', () => {
  beforeEach(() => { localStorage.clear(); });

  async function seed() {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch(CONFIRMED_BATCH);
    const { resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
  }

  it('D1: creates a PENDING_GIFSY reversal request', async () => {
    await seed();
    const { initiateReversal } = await import('../credits-payouts-reversal');
    const rev = initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 100, requestedBy: 'Client Admin',
    });
    expect(rev.status).toBe('PENDING_GIFSY');
    expect(rev.requestedAmount).toBe(100);
    expect(rev.awardType).toBe('POINTS');
  });

  it('D2: throws when amount > max reversible', async () => {
    await seed();
    const { initiateReversal } = await import('../credits-payouts-reversal');
    expect(() => initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 9999, requestedBy: 'Client Admin',
    })).toThrow(/exceeds/i);
  });

  it('D3: throws when amount is zero or negative', async () => {
    await seed();
    const { initiateReversal } = await import('../credits-payouts-reversal');
    expect(() => initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 0, requestedBy: 'Client Admin',
    })).toThrow(/greater than zero/i);
  });

  it('D4: reversal is persisted to localStorage', async () => {
    await seed();
    const { initiateReversal, getAllReversals } = await import('../credits-payouts-reversal');
    initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 200, requestedBy: 'Client Admin',
    });
    expect(getAllReversals()).toHaveLength(1);
  });
});

// ─── E — approveReversal / rejectReversal ─────────────────────────────────────

describe('E — approve / reject reversal', () => {
  beforeEach(() => { localStorage.clear(); });

  async function seedAndCreate(amount = 300) {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch(CONFIRMED_BATCH);
    const { initiateReversal, resetReversals } = await import('../credits-payouts-reversal');
    resetReversals();
    return initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: amount, requestedBy: 'Client Admin',
    });
  }

  it('E1: full approval → status APPROVED', async () => {
    const rev = await seedAndCreate(300);
    const { approveReversal } = await import('../credits-payouts-reversal');
    const updated = approveReversal(rev.id, 'Gifsy Admin', 300);
    expect(updated.status).toBe('APPROVED');
    expect(updated.approvedAmount).toBe(300);
    expect(updated.approvedBy).toBe('Gifsy Admin');
  });

  it('E2: partial approval → status PARTIAL', async () => {
    const rev = await seedAndCreate(300);
    const { approveReversal } = await import('../credits-payouts-reversal');
    const updated = approveReversal(rev.id, 'Gifsy Admin', 100);
    expect(updated.status).toBe('PARTIAL');
    expect(updated.approvedAmount).toBe(100);
  });

  it('E3: rejection → status REJECTED', async () => {
    const rev = await seedAndCreate(300);
    const { rejectReversal } = await import('../credits-payouts-reversal');
    const updated = rejectReversal(rev.id, 'Gifsy Admin', 'Not eligible at this time');
    expect(updated.status).toBe('REJECTED');
    expect(updated.remarks).toMatch(/not eligible/i);
  });

  it('E4: cannot approve an already-approved reversal', async () => {
    const rev = await seedAndCreate(300);
    const { approveReversal } = await import('../credits-payouts-reversal');
    approveReversal(rev.id, 'Gifsy Admin', 300);
    expect(() => approveReversal(rev.id, 'Gifsy Admin', 300)).toThrow(/PENDING_GIFSY/i);
  });

  it('E5: approved amount cannot exceed requested amount', async () => {
    const rev = await seedAndCreate(300);
    const { approveReversal } = await import('../credits-payouts-reversal');
    expect(() => approveReversal(rev.id, 'Gifsy Admin', 9999)).toThrow(/cannot exceed/i);
  });
});

// ─── F — getReversalsForOutlet ────────────────────────────────────────────────

describe('F — getReversalsForOutlet', () => {
  beforeEach(() => { localStorage.clear(); });

  it('F1: returns only reversals for the specified outlet', async () => {
    const { saveBatch, resetBatches } = await import('../credits-payouts-store');
    resetBatches();
    saveBatch(CONFIRMED_BATCH);
    const { initiateReversal, resetReversals, getReversalsForOutlet } =
      await import('../credits-payouts-reversal');
    resetReversals();

    // WS-001 reversal
    initiateReversal({
      batchId: 'rev_batch_001', outletId: 'WS-001', outletName: 'Anand Wholesale',
      fieldId: 'f_vol', fieldName: 'Volume', period: '2026-05',
      requestedAmount: 200, requestedBy: 'Client Admin',
    });

    const result = getReversalsForOutlet('WS-001');
    expect(result).toHaveLength(1);
    expect(result[0].outletId).toBe('WS-001');
  });

  it('F2: returns empty array for outlet with no reversals', async () => {
    const { resetReversals, getReversalsForOutlet } = await import('../credits-payouts-reversal');
    resetReversals();
    expect(getReversalsForOutlet('WS-NONE')).toHaveLength(0);
  });
});
