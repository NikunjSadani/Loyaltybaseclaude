/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — pure rules + normalisers (src/lib/voucher-dispersal.ts).
 * Run: npx vitest run src/lib/__tests__/voucher-dispersal.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  canCancelCampaign, canResendRow, canRetryRow, confirmBlock, confirmDialogTitle, confirmPayload, defaultProgramLabel,
  maskVoucherCode, nextPollDelay, normalizeClients, normalizeListItem, normalizePreview, normalizeRow, normalizeRowsPage,
  pollPhase, validateCreateForm, POLL_AFTER_COMPLETE_MS, POLL_MAX_MS, type VdPreviewSummary,
} from '@/lib/voucher-dispersal';

const summary = (o: Partial<VdPreviewSummary> = {}): VdPreviewSummary => ({
  total: 4, valid: 2, invalid: 1, duplicates: 1, totalRupees: 1500, budgetRupees: 5000,
  overBudget: false, perBrand: [], ...o,
});

describe('voucher-dispersal rules', () => {
  it('confirm dialog title + payload carry the previewed numbers', () => {
    expect(confirmDialogTitle(summary())).toBe('Buy and send 2 vouchers · ₹1,500 total?');
    expect(confirmDialogTitle(summary({ valid: 1200, totalRupees: 1234567 }))).toBe('Buy and send 1200 vouchers · ₹12,34,567 total?');
    expect(confirmPayload(summary())).toEqual({ expectedValidCount: 2, expectedTotalRupees: 1500 });
  });

  it('poll phase: live while processing; settling 30 min after completion; then off', () => {
    const t0 = Date.parse('2026-11-16T10:00:00Z');
    const done = { status: 'COMPLETED' as const, completedAt: '2026-11-16T10:00:00Z' };
    expect(pollPhase({ status: 'PROCESSING', completedAt: null }, t0, null)).toBe('live');
    expect(pollPhase(done, t0 + 29 * 60_000, null)).toBe('settling');
    expect(pollPhase(done, t0 + POLL_AFTER_COMPLETE_MS, null)).toBe('off');
    // No server timestamp: the page's own observation starts the window; unknown → off.
    expect(pollPhase({ status: 'COMPLETED_WITH_ERRORS', completedAt: null }, t0 + 60_000, t0)).toBe('settling');
    expect(pollPhase({ status: 'COMPLETED_WITH_ERRORS', completedAt: null }, t0, null)).toBe('off');
    expect(pollPhase({ status: 'CANCELLED', completedAt: null }, t0, t0)).toBe('off');
    expect(pollPhase({ status: 'PREVIEWED', completedAt: null }, t0, null)).toBe('off');
  });

  it('blocks confirm when over budget (flag or arithmetic) or no valid rows', () => {
    expect(confirmBlock(summary({ overBudget: true })).blocked).toBe(true);
    expect(confirmBlock(summary({ totalRupees: 6000 })).blocked).toBe(true);
    expect(confirmBlock(summary({ valid: 0 })).blocked).toBe(true);
    expect(confirmBlock(summary()).blocked).toBe(false);
  });

  it('row actions: resend only BOUGHT; retry only BUY_FAILED unless the server says otherwise', () => {
    expect(canResendRow({ status: 'BOUGHT' })).toBe(true);
    expect(canResendRow({ status: 'BUY_FAILED' })).toBe(false);
    expect(canRetryRow({ status: 'BUY_FAILED', canRetryBuy: null })).toBe(true);
    expect(canRetryRow({ status: 'PENDING_RECONCILE', canRetryBuy: null })).toBe(false);
    expect(canRetryRow({ status: 'BUY_FAILED', canRetryBuy: false })).toBe(false);
    expect(canRetryRow({ status: 'PENDING_RECONCILE', canRetryBuy: true })).toBe(true);
  });

  it('cancel follows status unless the server sends canCancel', () => {
    expect(canCancelCampaign({ status: 'PROCESSING', canCancel: null })).toBe(true);
    expect(canCancelCampaign({ status: 'COMPLETED', canCancel: null })).toBe(false);
    expect(canCancelCampaign({ status: 'PROCESSING', canCancel: false })).toBe(false);
  });

  it('never shows a full voucher code', () => {
    expect(maskVoucherCode('ABCD-EFGH-1234')).toBe('••••1234');
    expect(maskVoucherCode('****1234')).toBe('****1234');
    expect(maskVoucherCode('123')).toBe('••••');
    expect(maskVoucherCode(null)).toBeNull();
  });

  it('poll delay backs off ×1.5 up to the ceiling', () => {
    expect(nextPollDelay(3000)).toBe(4500);
    expect(nextPollDelay(25000)).toBe(POLL_MAX_MS);
  });

  it('create-form validation', () => {
    const e = validateCreateForm({ name: '', programLabel: ' ', billedToClientId: '', note: '', budgetRupees: '0' });
    expect(Object.keys(e).sort()).toEqual(['budgetRupees', 'name', 'programLabel']);
    expect(validateCreateForm({ name: 'A', programLabel: 'B', billedToClientId: '', note: '', budgetRupees: '10' })).toEqual({});
    expect(defaultProgramLabel('Bajaj')).toBe('Bajaj Loyalty');
  });
});

describe('voucher-dispersal normalisers', () => {
  it('list item: nested {campaign, summary} and flat campaign-with-summary', () => {
    const a = normalizeListItem({ campaign: { id: 'c1', status: 'processing', billedToClient: { displayName: 'Bajaj' } }, summary: { bought: 3 } });
    expect(a.campaign.status).toBe('PROCESSING');
    expect(a.campaign.billedToClientName).toBe('Bajaj');
    expect(a.summary.bought).toBe(3);
    const b = normalizeListItem({ id: 'c2', status: 'COMPLETED', summary: { delivered: 5 } });
    expect(b.summary.delivered).toBe(5);
    expect(b.campaign.billedToClientName).toBeNull();
  });

  it('preview: perBrand as object or array', () => {
    const p = normalizePreview({ summary: { valid: 1, perBrand: { AMAZON: { count: 1, totalRupees: 500 } } }, rows: [{ rowNumber: 2, status: 'VALID' }] });
    expect(p.summary.perBrand).toEqual([{ brand: 'AMAZON', count: 1, rupees: 500 }]);
    expect(p.rows[0].status).toBe('VALID');
  });

  it('row: aliases + masked code + lower-cased message status', () => {
    const r = normalizeRow({ id: 'r', status: 'BOUGHT', hubbleOrderId: 'H-1', voucherCode: 'SECRETCODE9876', messageStatus: 'DELIVERED', deliveredAt: '2026-11-16T10:00:00Z' });
    expect(r.hubbleRef).toBe('H-1');
    expect(r.voucherCode).toBe('••••9876');
    expect(r.messageStatus).toBe('delivered');
    expect(r.messageDeliveredAt).toBe('2026-11-16T10:00:00Z');
  });

  it('rows page: bare array or {rows,total,pageSize}', () => {
    expect(normalizeRowsPage([{ id: 'a' }], 1).total).toBe(1);
    expect(normalizeRowsPage({ rows: [{ id: 'a' }], total: 120, pageSize: 50, page: 2 }, 2)).toMatchObject({ total: 120, pageSize: 50, page: 2 });
  });

  it('clients: {clients:[…]} with slug ids, sorted by name', () => {
    expect(normalizeClients({ clients: [{ slug: 'z', internalName: 'Zed' }, { slug: 'b', displayName: 'Bajaj' }] }))
      .toEqual([{ id: 'b', name: 'Bajaj' }, { id: 'z', name: 'Zed' }]);
  });
});
