/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — pure rules + normalisers (src/lib/voucher-dispersal.ts).
 * Run: npx vitest run src/lib/__tests__/voucher-dispersal.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  billedToText, campaignStatusText, canCancelCampaign, canResendRow, canRetryRow, checkUploadFile, confirmBlock,
  confirmDialogTitle, confirmPayload, defaultProgramLabel, formatCount, formatRupees, isOverBudget, isSetupCampaign,
  isUncertainFailure, maskVoucherCode, nextPollDelay, normalizeClients, normalizeListItem, normalizePreview, normalizeRow,
  normalizeRowsPage, plural, pollPhase, rowStatusText, validateCreateForm, POLL_AFTER_COMPLETE_MS, POLL_MAX_MS,
  type VdPreview, type VdPreviewSummary,
} from '@/lib/voucher-dispersal';

const summary = (o: Partial<VdPreviewSummary> = {}): VdPreviewSummary => ({
  total: 4, valid: 2, invalid: 1, duplicates: 1, totalRupees: 1500, budgetRupees: 5000,
  overBudget: false, perBrand: [], ...o,
});
const preview = (o: Partial<VdPreviewSummary> = {}, previewId: string | null = 'pv-1'): Pick<VdPreview, 'previewId' | 'summary'> =>
  ({ previewId, summary: summary(o) });

describe('voucher-dispersal rules', () => {
  it('confirm dialog title + payload carry the preview version and the numbers shown', () => {
    expect(confirmDialogTitle(summary())).toBe('Buy and send 2 vouchers · ₹1,500 total?');
    expect(confirmDialogTitle(summary({ valid: 1200, totalRupees: 1234567.5 }))).toBe('Buy and send 1,200 vouchers · ₹12,34,567.50 total?');
    expect(confirmPayload(preview())).toEqual({ previewId: 'pv-1', expectedValidCount: 2, expectedTotalRupees: 1500 });
    expect(confirmPayload(preview({}, null))).toBeNull();
    expect(confirmPayload(preview({ valid: null }))).toBeNull();
  });

  it('blocks buying when over budget, nothing valid, or the preview reply is incomplete', () => {
    expect(confirmBlock(preview({ overBudget: true })).blocked).toBe(true);
    expect(confirmBlock(preview({ totalRupees: 6000 })).blocked).toBe(true);
    expect(confirmBlock(preview({ valid: 0 })).blocked).toBe(true);
    expect(confirmBlock(preview({ totalRupees: null })).blocked).toBe(true);
    expect(confirmBlock(preview({}, null))).toMatchObject({ blocked: true, reason: expect.stringContaining('preview id') });
    expect(confirmBlock(preview()).blocked).toBe(false);
  });

  it('over-budget colour and block use the same condition', () => {
    expect(isOverBudget(summary({ totalRupees: 6000 }))).toBe(true);
    expect(isOverBudget(summary({ overBudget: true }))).toBe(true);
    expect(isOverBudget(summary({ budgetRupees: null }))).toBe(false);
    expect(isOverBudget(summary())).toBe(false);
  });

  it('resend: server canResend wins; fallback BOUGHT, but not while PROCESSING with no message yet', () => {
    const row = { status: 'BOUGHT' as const, canResend: null, messageStatus: null };
    expect(canResendRow(row, 'COMPLETED')).toBe(true);
    expect(canResendRow(row, 'PROCESSING')).toBe(false);
    expect(canResendRow({ ...row, messageStatus: 'failed' }, 'PROCESSING')).toBe(true);
    expect(canResendRow({ ...row, canResend: false }, 'COMPLETED')).toBe(false);
    expect(canResendRow({ status: 'BUY_FAILED', canResend: true, messageStatus: null }, 'COMPLETED')).toBe(true);
    expect(canResendRow({ status: 'BUY_FAILED', canResend: null, messageStatus: null }, 'COMPLETED')).toBe(false);
  });

  it('retry: only BUY_FAILED unless the server says otherwise', () => {
    expect(canRetryRow({ status: 'BUY_FAILED', canRetryBuy: null })).toBe(true);
    expect(canRetryRow({ status: 'PENDING_RECONCILE', canRetryBuy: null })).toBe(false);
    expect(canRetryRow({ status: 'BUY_FAILED', canRetryBuy: false })).toBe(false);
    expect(canRetryRow({ status: 'PENDING_RECONCILE', canRetryBuy: true })).toBe(true);
  });

  it('cancel follows status unless the server sends canCancel; UNKNOWN is never cancellable by default', () => {
    expect(canCancelCampaign({ status: 'PROCESSING', canCancel: null })).toBe(true);
    expect(canCancelCampaign({ status: 'COMPLETED', canCancel: null })).toBe(false);
    expect(canCancelCampaign({ status: 'UNKNOWN', canCancel: null })).toBe(false);
    expect(canCancelCampaign({ status: 'PROCESSING', canCancel: false })).toBe(false);
  });

  it('network error / 5xx = unknown outcome; 4xx = definite refusal', () => {
    expect(isUncertainFailure(undefined)).toBe(true);
    expect(isUncertainFailure(502)).toBe(true);
    expect(isUncertainFailure(409)).toBe(false);
  });

  it('masks codes: keeps server masks; last 4 only for 10+ chars; shorter fully masked', () => {
    expect(maskVoucherCode('ABCD-EFGH-1234')).toBe('••••1234');
    expect(maskVoucherCode('ABCDEF1234')).toBe('••••1234');
    expect(maskVoucherCode('ABC123456')).toBe('••••••••');
    expect(maskVoucherCode('****1234')).toBe('****1234');
    expect(maskVoucherCode(null)).toBeNull();
  });

  it('formatting: missing numbers are "—"; ₹ keeps paise with 2 decimals; plural grammar', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(0)).toBe('0');
    expect(formatRupees(null)).toBe('—');
    expect(formatRupees(1500)).toBe('₹1,500');
    expect(formatRupees(1500.5)).toBe('₹1,500.50');
    expect(plural(1, 'duplicate row')).toBe('1 duplicate row');
    expect(plural(3, 'duplicate row')).toBe('3 duplicate rows');
  });

  it('billed-to falls back to the client id, then "—"', () => {
    expect(billedToText({ billedToClientName: 'Bajaj', billedToClientId: 'bajaj' })).toBe('Bajaj');
    expect(billedToText({ billedToClientName: null, billedToClientId: 'bajaj' })).toBe('bajaj');
    expect(billedToText({ billedToClientName: null, billedToClientId: 'bajaj' }, [{ id: 'bajaj', name: 'Bajaj CC' }])).toBe('Bajaj CC');
    expect(billedToText({ billedToClientName: null, billedToClientId: null })).toBe('—');
  });

  it('poll delay backs off ×1.5 up to the ceiling', () => {
    expect(nextPollDelay(3000)).toBe(4500);
    expect(nextPollDelay(25000)).toBe(POLL_MAX_MS);
  });

  it('poll phase: live; unknown status keeps polling; settling 30 min after completion; then off', () => {
    const t0 = Date.parse('2026-11-16T10:00:00Z');
    const done = { status: 'COMPLETED' as const, completedAt: '2026-11-16T10:00:00Z' };
    expect(pollPhase({ status: 'PROCESSING', completedAt: null }, t0, null)).toBe('live');
    expect(pollPhase({ status: 'UNKNOWN', completedAt: null }, t0, null)).toBe('unknown');
    expect(pollPhase(done, t0 + 29 * 60_000, null)).toBe('settling');
    expect(pollPhase(done, t0 + POLL_AFTER_COMPLETE_MS, null)).toBe('off');
    expect(pollPhase({ status: 'COMPLETED_WITH_ERRORS', completedAt: null }, t0 + 60_000, t0)).toBe('settling');
    expect(pollPhase({ status: 'COMPLETED_WITH_ERRORS', completedAt: null }, t0, null)).toBe('off');
    expect(pollPhase({ status: 'CANCELLED', completedAt: null }, t0, t0)).toBe('off');
    expect(pollPhase({ status: 'PREVIEWED', completedAt: null }, t0, null)).toBe('off');
  });

  it('create-form validation + default programme label', () => {
    const e = validateCreateForm({ name: '', programLabel: ' ', billedToClientId: '', note: '', budgetRupees: '0' });
    expect(Object.keys(e).sort()).toEqual(['budgetRupees', 'name', 'programLabel']);
    expect(validateCreateForm({ name: 'A', programLabel: 'B', billedToClientId: '', note: '', budgetRupees: '10' })).toEqual({});
    expect(defaultProgramLabel('Bajaj')).toBe('Bajaj Loyalty');
  });

  it('client-side file check: type, empty, size', () => {
    expect(checkUploadFile({ name: 'a.pdf', size: 10 })).toMatch(/Excel/);
    expect(checkUploadFile({ name: 'a.xlsx', size: 0 })).toBe('That file is empty.');
    expect(checkUploadFile({ name: 'a.xlsx', size: 11 * 1024 * 1024 })).toMatch(/over 10 MB/);
    expect(checkUploadFile({ name: 'a.CSV', size: 10 })).toBeNull();
  });
});

describe('voucher-dispersal normalisers', () => {
  it('list item: nested {campaign, summary} and flat campaign-with-summary; missing counts stay null', () => {
    const a = normalizeListItem({ campaign: { id: 'c1', status: 'processing', billedToClient: { displayName: 'Bajaj' } }, summary: { bought: 3 } });
    expect(a.campaign.status).toBe('PROCESSING');
    expect(a.campaign.billedToClientName).toBe('Bajaj');
    expect(a.summary.bought).toBe(3);
    expect(a.summary.delivered).toBeNull();
    const b = normalizeListItem({ id: 'c2', status: 'COMPLETED', summary: { delivered: 5 } });
    expect(b.summary.delivered).toBe(5);
    expect(b.campaign.budgetRupees).toBeNull();
  });

  it('unknown statuses become UNKNOWN with the raw value — never INVALID, never setup', () => {
    const c = normalizeListItem({ id: 'c', status: 'PAUSED' }).campaign;
    expect(c.status).toBe('UNKNOWN');
    expect(campaignStatusText(c)).toBe('Unknown status: PAUSED');
    expect(isSetupCampaign(c.status)).toBe(false);
    const r = normalizeRow({ id: 'r', status: 'REFUNDED' });
    expect(r.status).toBe('UNKNOWN');
    expect(rowStatusText(r)).toBe('Unknown status: REFUNDED');
    const p = normalizePreview({ rows: [{ rowNumber: 2, status: 'WEIRD' }] });
    expect(p.rows[0].status).toBe('UNKNOWN');
  });

  it('preview: previewId, perBrand as object or array, missing totals null', () => {
    const p = normalizePreview({ previewId: 'pv-9', summary: { valid: 1, perBrand: { AMAZON: { count: 1, totalRupees: 500 } } }, rows: [{ rowNumber: 2, status: 'VALID' }] });
    expect(p.previewId).toBe('pv-9');
    expect(p.summary.perBrand).toEqual([{ brand: 'AMAZON', count: 1, rupees: 500 }]);
    expect(p.summary.totalRupees).toBeNull();
    expect(p.rows[0].status).toBe('VALID');
  });

  it('row: aliases, masked code, lower-cased message status, canResend', () => {
    const r = normalizeRow({ id: 'r', status: 'BOUGHT', hubbleOrderId: 'H-1', voucherCode: 'SECRETCODE9876', messageStatus: 'DELIVERED', deliveredAt: '2026-11-16T10:00:00Z', canResend: true });
    expect(r.hubbleRef).toBe('H-1');
    expect(r.voucherCode).toBe('••••9876');
    expect(r.messageStatus).toBe('delivered');
    expect(r.messageDeliveredAt).toBe('2026-11-16T10:00:00Z');
    expect(r.canResend).toBe(true);
    expect(r.rowNumber).toBeNull();
  });

  it('rows page: bare array or {rows,total,pageSize}; missing total null', () => {
    expect(normalizeRowsPage([{ id: 'a' }], 1).total).toBe(1);
    expect(normalizeRowsPage({ rows: [{ id: 'a' }], total: 120, pageSize: 50, page: 2 }, 2)).toMatchObject({ total: 120, pageSize: 50, page: 2 });
    expect(normalizeRowsPage({ rows: [] }, 1).total).toBeNull();
  });

  it('clients: {clients:[…]} with slug ids, sorted by name', () => {
    expect(normalizeClients({ clients: [{ slug: 'z', internalName: 'Zed' }, { slug: 'b', displayName: 'Bajaj' }] }))
      .toEqual([{ id: 'b', name: 'Bajaj' }, { id: 'z', name: 'Zed' }]);
  });
});
