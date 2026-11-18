/// <reference types="vitest/globals" />
/**
 * Voucher Dispersal — pure rules + normalisers (src/lib/voucher-dispersal.ts).
 * Run: npx vitest run src/lib/__tests__/voucher-dispersal.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  billedToText, campaignStatusText, canCancelCampaign, canResendRow, canRetryRow, checkUploadFile, confirmBlock,
  confirmDialogTitle, confirmPayload, defaultProgramLabel, formatCount, formatRupees, isOverBudget, isSetupCampaign,
  isProcessInFlight, isUncertainFailure, maskVoucherCode, nextPollDelay, nextProcessFailures, normalizeBrand, normalizeClients,
  normalizeDetail, normalizeListItem, normalizePreview, normalizeRow, normalizeRowsPage, pendingReasonText, plural, pollPhase,
  rowStatusText, shouldNudgeProcessing, validateCreateForm, vdApi, PENDING_RECONCILE_NOTE, POLL_AFTER_COMPLETE_MS, POLL_MAX_MS,
  batchConfirmBlock, editChangeText, editPayload, validateEditForm, normalizeBatch, normalizeCancelResult,
  parseRupeeInput, rupeeEcho, RUPEE_COMMA_ERROR, RUPEE_DIGITS_ERROR,
  type VdPreview, type VdPreviewSummary,
} from '@/lib/voucher-dispersal';

const summary = (o: Partial<VdPreviewSummary> = {}): VdPreviewSummary => ({
  total: 4, valid: 2, invalid: 1, duplicates: 1, totalRupees: 1500, budgetRupees: 5000,
  overBudget: false, perBrand: [], warningCount: 0, skippedNote: null, hiddenNote: null, ...o,
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
    // Server DTO limits: whole rupees <= 1 crore; name <= 120; programme <= 60; note <= 500.
    const base = { name: 'A', programLabel: 'B', billedToClientId: '', note: '', budgetRupees: '10' };
    expect(validateCreateForm({ ...base, budgetRupees: '10.5' }).budgetRupees).toMatch(/whole rupees/);
    expect(validateCreateForm({ ...base, budgetRupees: '10000001' }).budgetRupees).toMatch(/at most/);
    expect(validateCreateForm({ ...base, budgetRupees: '10000000' })).toEqual({});
    expect(validateCreateForm({ ...base, name: 'x'.repeat(121) }).name).toMatch(/120/);
    expect(validateCreateForm({ ...base, programLabel: 'x'.repeat(61) }).programLabel).toMatch(/60/);
    expect(validateCreateForm({ ...base, note: 'x'.repeat(501) }).note).toMatch(/500/);
  });

  it('client-side file check: .xlsx only (the server refuses anything else), empty, size', () => {
    expect(checkUploadFile({ name: 'a.pdf', size: 10 })).toMatch(/\.xlsx/);
    expect(checkUploadFile({ name: 'a.csv', size: 10 })).toMatch(/\.xlsx/);
    expect(checkUploadFile({ name: 'a.xls', size: 10 })).toMatch(/\.xlsx/);
    expect(checkUploadFile({ name: 'a.xlsx', size: 0 })).toBe('That file is empty.');
    expect(checkUploadFile({ name: 'a.xlsx', size: 11 * 1024 * 1024 })).toMatch(/over 10 MB/);
    expect(checkUploadFile({ name: 'a.XLSX', size: 10 })).toBeNull();
  });

  it('pending reasons: server codes in plain words; unknown code keeps the raw value', () => {
    expect(pendingReasonText(null)).toBe(PENDING_RECONCILE_NOTE);
    expect(pendingReasonText('STALE_BUYING')).toMatch(/interrupted/);
    expect(pendingReasonText('HUBBLE_INDETERMINATE')).toMatch(/clear answer/);
    expect(pendingReasonText('HUBBLE_UNKNOWN_STATUS:ON_HOLD')).toMatch(/unexpected status \(ON_HOLD\)/);
    expect(pendingReasonText('SOMETHING_NEW')).toMatch(/\(SOMETHING_NEW\)$/);
  });

  it('process nudge: only while live / settling; 4xx ignored, 5xx / network counted, success resets', () => {
    expect(shouldNudgeProcessing('live')).toBe(true);
    expect(shouldNudgeProcessing('settling')).toBe(true);
    expect(shouldNudgeProcessing('unknown')).toBe(false);
    expect(shouldNudgeProcessing('off')).toBe(false);
    expect(nextProcessFailures(1, { ok: false, error: 'x', status: 409 })).toBe(1);
    expect(nextProcessFailures(1, { ok: false, error: 'x', status: 502 })).toBe(2);
    expect(nextProcessFailures(1, { ok: false, error: 'x' })).toBe(2);
    expect(nextProcessFailures(3, { ok: true, data: null })).toBe(0);
  });
});

describe('voucher-dispersal normalisers (exact server field names)', () => {
  it('list item: campaign fields + summary (purchase counts only); WhatsApp counts stay null', () => {
    const a = normalizeListItem({ id: 'c1', status: 'processing', billedToClient: { id: 'bajaj', name: 'Bajaj' }, summary: { bought: 3, valid: 4 } });
    expect(a.campaign.status).toBe('PROCESSING');
    expect(a.campaign.billedToClientId).toBe('bajaj');
    expect(a.campaign.billedToClientName).toBe('Bajaj');
    expect(a.summary).toMatchObject({ bought: 3, valid: 4, pending: null, delivered: null });
    expect(a.hubbleConfigured).toBeNull();
    expect(normalizeListItem({ id: 'c2', status: 'COMPLETED', billedToClient: null, summary: {} }).campaign.budgetRupees).toBeNull();
  });

  it('detail: {campaign, hubbleConfigured, summary}', () => {
    const d = normalizeDetail({ campaign: { id: 'c1', status: 'COMPLETED', completedAt: '2026-11-16T10:00:00Z', canCancel: false }, hubbleConfigured: false, summary: { delivered: 5 } });
    expect(d.campaign.completedAt).toBe('2026-11-16T10:00:00Z');
    expect(d.campaign.canCancel).toBe(false);
    expect(d.hubbleConfigured).toBe(false);
    expect(d.summary.delivered).toBe(5);
    expect(d.summary.bought).toBeNull();
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

  it('preview: previewId, perBrand array, warning + skipped / hidden notes, missing totals null', () => {
    const p = normalizePreview({
      previewId: 'pv-9',
      summary: { valid: 1, perBrand: [{ brandKey: 'AMAZON_PAY', brand: 'Amazon Pay', count: 1, totalRupees: 500 }], warningCount: 1, skippedNote: '1 row skipped: 1 blank', hiddenNote: null },
      rows: [{ rowNumber: 2, status: 'VALID', warning: 'Already got a ₹500 Amazon Pay voucher' }],
    });
    expect(p.previewId).toBe('pv-9');
    expect(p.summary.perBrand).toEqual([{ brand: 'Amazon Pay', count: 1, rupees: 500 }]);
    expect(p.summary.totalRupees).toBeNull();
    expect(p.summary).toMatchObject({ warningCount: 1, skippedNote: '1 row skipped: 1 blank', hiddenNote: null });
    expect(p.rows[0]).toMatchObject({ status: 'VALID', warning: 'Already got a ₹500 Amazon Pay voucher' });
  });

  it('row: server-masked code kept, re-masked if ever raw; upper-case message status; order id else reference; reasons', () => {
    const r = normalizeRow({ id: 'r', status: 'BOUGHT', hubbleOrderId: 'H-1', hubbleReferenceId: 'vd1', voucherCodeMasked: '••••9876', messageStatus: 'DELIVERED', messageDeliveredAt: '2026-11-16T10:00:00Z', canResend: true, warning: 'w' });
    expect(r.hubbleRef).toBe('H-1');
    expect(r.voucherCodeMasked).toBe('••••9876');
    expect(r.messageStatus).toBe('delivered');
    expect(r.messageDeliveredAt).toBe('2026-11-16T10:00:00Z');
    expect(r.canResend).toBe(true);
    expect(r.warning).toBe('w');
    expect(r.rowNumber).toBeNull();
    expect(normalizeRow({ voucherCodeMasked: 'SECRETCODE9876' }).voucherCodeMasked).toBe('••••9876');
    expect(normalizeRow({ status: 'QUEUED', hubbleOrderId: null, hubbleReferenceId: 'vdabc' }).hubbleRef).toBe('vdabc');
    expect(normalizeRow({ status: 'BUY_FAILED', invalidReason: null, buyFailureReason: 'Out of stock' }).reason).toBe('Out of stock');
    const pend = normalizeRow({ status: 'PENDING_RECONCILE', pendingReason: 'HUBBLE_PROCESSING', retryAvailableAt: '2026-11-16T12:00:00Z' });
    expect(pend.reason).toMatch(/still processing/);
    expect(pend.retryAvailableAt).toBe('2026-11-16T12:00:00Z');
  });

  it('rows page: {rows,total,page,pageSize}; missing total null', () => {
    expect(normalizeRowsPage({ rows: [{ id: 'a' }], total: 120, pageSize: 100, page: 2 }, 2)).toMatchObject({ total: 120, pageSize: 100, page: 2 });
    expect(normalizeRowsPage({ rows: [] }, 1).total).toBeNull();
  });

  it('brand: live limits + availability', () => {
    expect(normalizeBrand({ key: 'FK', label: 'Flipkart', productId: 'p', minAmount: null, maxAmount: null, denominations: null, denominationType: null, available: false, unavailableReason: 'Hubble timeout' }))
      .toMatchObject({ available: false, unavailableReason: 'Hubble timeout', denominationType: null });
  });

  it('clients: {clients:[…]} → Client.id (= slug), sorted by name', () => {
    expect(normalizeClients({ clients: [{ id: 'z', slug: 'z', internalName: 'Zed' }, { id: 'b', slug: 'b', displayName: 'Bajaj' }] }))
      .toEqual([{ id: 'b', name: 'Bajaj' }, { id: 'z', name: 'Zed' }]);
  });
});

describe('vdApi.process — single-flight per campaign', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shares one request between callers until it settles, then allows the next', async () => {
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi.fn(() => new Promise((res) => { release = res; }));
    vi.stubGlobal('fetch', fetchMock);
    const a = vdApi.process('c1');
    const b = vdApi.process('c1');
    expect(a).toBe(b);
    expect(isProcessInFlight('c1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['/api/admin/voucher-dispersal/campaigns/c1/process', expect.objectContaining({ method: 'POST' })]);
    release({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { pass: {}, campaign: { id: 'c1', status: 'PROCESSING' }, hubbleConfigured: true, summary: { bought: 1 } } }) });
    const r = await a;
    expect(r.ok && r.data.summary.bought).toBe(1);
    expect(isProcessInFlight('c1')).toBe(false);
    void vdApi.process('c1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── Edit campaign + "Add more people" batches (2026-11-18) ──────────────────────

describe('validateEditForm / editPayload', () => {
  const cur = { name: 'Diwali', budgetRupees: 5000 };
  it('refuses empty name, non-whole / zero budget, a budget below the server floor, and no change', () => {
    expect(validateEditForm({ name: '  ', budgetRupees: '5000' }, cur, 0).name).toMatch(/name/);
    expect(validateEditForm({ name: 'Diwali', budgetRupees: '0' }, cur, 0).budgetRupees).toMatch(/greater than 0/);
    expect(validateEditForm({ name: 'Diwali', budgetRupees: '12.5' }, cur, 0).budgetRupees).toMatch(/whole rupees/);
    expect(validateEditForm({ name: 'Diwali', budgetRupees: '1799' }, cur, 1800).budgetRupees).toBe(
      "The budget can't go below ₹1,800 — that much is already spent or committed to purchases in progress.",
    );
    expect(validateEditForm({ name: ' Diwali ', budgetRupees: '5000' }, cur, 0).form).toBe('Nothing has changed.');
    expect(validateEditForm({ name: 'Diwali', budgetRupees: '1800' }, cur, 1800)).toEqual({});
    // Unknown floor → the server decides (its refusal is shown word for word).
    expect(validateEditForm({ name: 'Diwali', budgetRupees: '1' }, cur, null)).toEqual({});
  });
  it('sends only the changed fields', () => {
    expect(editPayload({ name: 'Diwali 2', budgetRupees: '5000' }, cur)).toEqual({ name: 'Diwali 2' });
    expect(editPayload({ name: 'Diwali', budgetRupees: '7000' }, cur)).toEqual({ budgetRupees: 7000 });
  });
  it('describes an audited change in plain words', () => {
    expect(editChangeText({ field: 'budgetRupees', from: 2000, to: 5000 })).toBe('Budget ₹2,000 → ₹5,000');
    expect(editChangeText({ field: 'name', from: 'A', to: 'B' })).toBe('Name "A" → "B"');
  });
});

describe('batchConfirmBlock', () => {
  const p = (o: Partial<VdPreviewSummary>, remaining: number | null, committed: number | null = 1000) => ({
    previewId: 'pv-2', summary: summary(o), remainingBudgetRupees: remaining, alreadyCommittedRupees: committed,
  });
  it('over what is LEFT of the budget → blocked, advising to raise the budget (Edit campaign)', () => {
    const b = batchConfirmBlock(p({ totalRupees: 800, budgetRupees: 1500, overBudget: true }, 500));
    expect(b).toEqual({
      blocked: true,
      reason: "This batch's valid rows total ₹800, but only ₹500 of the ₹1,500 budget is left (₹1,000 is already spent or committed). Raise the budget with Edit campaign, or remove rows and upload again.",
    });
    // The client-side rule also catches it when the server flag is missing.
    expect(batchConfirmBlock(p({ totalRupees: 800, overBudget: false }, 500)).blocked).toBe(true);
  });
  it('no valid rows / incomplete reply → blocked; otherwise free', () => {
    expect(batchConfirmBlock(p({ valid: 0, totalRupees: 0 }, 5000))).toMatchObject({ blocked: true, reason: expect.stringMatching(/no valid rows in this batch/) });
    expect(batchConfirmBlock({ ...p({}, 5000), previewId: null })).toMatchObject({ blocked: true });
    expect(batchConfirmBlock(p({ totalRupees: 500 }, 500))).toEqual({ blocked: false });
  });
});

describe('batch / cancel normalisers', () => {
  it('an unknown batch status is UNKNOWN (never disguised); missing counts are null', () => {
    expect(normalizeBatch({ batchNumber: 2, status: 'WEIRD' })).toMatchObject({ batchNumber: 2, status: 'UNKNOWN', rawStatus: 'WEIRD', bought: null });
    expect(normalizeCancelResult({ campaign: {}, cancelledRows: 1 }).discardedPendingBatchRows).toBeNull();
  });
  it('detail without batches / edits → empty lists; list items carry pendingBatchNumber', () => {
    expect(normalizeDetail({ campaign: {}, summary: {} })).toMatchObject({ batches: [], edits: [] });
    expect(normalizeListItem({ id: 'c', summary: { pendingBatchNumber: 3 } }).summary.pendingBatchNumber).toBe(3);
  });
});

// ─── UI/UX audit fixes (2026-11-18) ─────────────────────────────────────────────
describe('rupee input: typed as-is, parsed strictly (decimal point kept, commas only in real grouping, a leading ₹ ok)', () => {
  const create = (budgetRupees: string) => validateCreateForm({ name: 'x', programLabel: 'y', billedToClientId: '', note: '', budgetRupees }).budgetRupees;
  const edit = (budgetRupees: string) => validateEditForm({ name: 'Diwali', budgetRupees }, { name: 'Diwali', budgetRupees: 5000 }, 0).budgetRupees;
  it('parseRupeeInput', () => {
    expect(parseRupeeInput('2500')).toEqual({ clean: '2500', error: null });
    expect(parseRupeeInput('2,500')).toEqual({ clean: '2500', error: null });
    expect(parseRupeeInput('1,25,000')).toEqual({ clean: '125000', error: null });
    expect(parseRupeeInput('1,250,000')).toEqual({ clean: '1250000', error: null });
    expect(parseRupeeInput('₹2,500')).toEqual({ clean: '2500', error: null });
    expect(parseRupeeInput(' ₹ 2,500 ')).toEqual({ clean: '2500', error: null });
    expect(parseRupeeInput('2500.00')).toEqual({ clean: '2500.00', error: null });
    // L1: commas that are not a thousands grouping are refused — never silently "25,00" → ₹2,500.
    for (const bad of ['25,00', '2,50', '1,2,3', ',2500', '2500,', '2,5000', '12,34,5678']) {
      expect(parseRupeeInput(bad).error).toBe(RUPEE_COMMA_ERROR);
    }
  });
  it('validation uses it (create + edit): "2500.00" whole rupees; "25,00" comma message; "₹2,500" accepted', () => {
    expect(create('2500.00')).toBe('Enter the budget in whole rupees (no paise).');
    expect(edit('2500.00')).toBe('Enter the budget in whole rupees (no paise).');
    expect(create('25,00')).toBe(RUPEE_COMMA_ERROR);
    expect(edit('25,00')).toBe(RUPEE_COMMA_ERROR);
    expect(create('₹2,500')).toBeUndefined();
    expect(edit('₹2,500')).toBeUndefined();
    expect(editPayload({ name: 'Diwali', budgetRupees: '₹7,000' }, { name: 'Diwali', budgetRupees: 5000 })).toEqual({ budgetRupees: 7000 });
  });
  it('final review L1: clear reasons for non-digits and negatives', () => {
    for (const bad of ['1e5', '0x10', '२५००', '２５００', '25a0', '2 500']) {
      expect(create(bad)).toBe(RUPEE_DIGITS_ERROR);
      expect(edit(bad)).toBe(RUPEE_DIGITS_ERROR);
    }
    expect(create('-1,000')).toBe('Enter a budget in rupees greater than 0.');
    expect(edit('-1000')).toBe('Enter a budget in rupees greater than 0.');
    expect(create('2500.')).toBe('Enter the budget in whole rupees (no paise).');
    expect(rupeeEcho('1e5')).toBeNull();
    expect(rupeeEcho('-1000')).toBeNull();
  });

  it('echo', () => {
    expect(rupeeEcho('2500')).toBe('= ₹2,500');
    expect(rupeeEcho('₹1,25,000')).toBe('= ₹1,25,000');
    expect(rupeeEcho('2500.00')).toBe('= ₹2,500');
    expect(rupeeEcho('25,00')).toBeNull();
    expect(rupeeEcho('abc')).toBeNull();
    expect(rupeeEcho('')).toBeNull();
  });
});

describe('plurals', () => {
  it('confirm title says "1 voucher" / "N vouchers"', () => {
    expect(confirmDialogTitle({ valid: 1, totalRupees: 500 })).toBe('Buy and send 1 voucher · ₹500 total?');
    expect(confirmDialogTitle({ valid: 3, totalRupees: 1500 })).toBe('Buy and send 3 vouchers · ₹1,500 total?');
  });
});
