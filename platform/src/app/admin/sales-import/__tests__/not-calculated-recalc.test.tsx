/// <reference types="vitest/globals" />
/**
 * FOCUS-NAMES-FROM-KPI: the recalculate panel with a not-calculated KPI — red warning, explicit tick (cleared on every
 * preview reload), "not calculated" KPI row, confirmNotCalculated sent.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/not-calculated-recalc.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EMPTY_MONTH_RECONCILIATION, type SalesMonthRecalcPreview } from '@/lib/sales-import/types';

const apiMock = vi.hoisted(() => ({
  recalcPreview: vi.fn(), recalculate: vi.fn(), getApplyJob: vi.fn(), findApplyJob: vi.fn(),
  acceptFocusToken: vi.fn(), undoFocusAcceptance: vi.fn(), getProfile: vi.fn(), segmentOptions: vi.fn(),
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'CLIENT_ADMIN' }) }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {}, has: () => true }),
}));

import { RecalculatePanel } from '../months/_components/recalculate-panel';

const ok = <T,>(data: T) => ({ success: true as const, data });
const NC = [{
  kpiCode: 'FB1 CASES', namesFromKpi: 'FOCUS BRAND', existingOutlets: 4,
  message: "No focus names in this month's target file — FB1 CASES not calculated. Existing FB1 CASES values for 4 outlets will be REMOVED.",
}];
function preview(over: Partial<SalesMonthRecalcPreview> = {}): SalesMonthRecalcPreview {
  return {
    month: '2026-10', monthState: 'OPEN', canApply: true, definitionsHash: 'dh1', historySourceImportId: 'i1',
    historyAppliedAt: '2026-11-02T05:00:00.000Z', matchedOutlets: 3, unmatchedCustomers: 0, matchedAmountRupees: 1200,
    matchedQuantity: 4, unmatchedAmountRupees: 0, unmatchedQuantity: 0, zeroFillOutlets: 0, outletsAffected: 4, warnings: [],
    kpis: [
      { kpiCode: 'TOTAL', label: 'Total', measure: 'AMOUNT', newTotal: 900, currentTotal: 900, delta: 0, outletsNonZero: 3, outletsNegative: 0 },
      { kpiCode: 'FB1 CASES', label: 'FB1 Cases', measure: 'QUANTITY', newTotal: 0, currentTotal: 12, delta: -12, outletsNonZero: 0, outletsNegative: 0, notCalculated: true },
    ],
    reconciliation: {
      ...EMPTY_MONTH_RECONCILIATION,
      focusFingerprint: 'fp1',
      notCalculated: NC,
      // An unmatched name of ANOTHER KPI, so "Accept — not sold yet" reloads the preview (the reload under test).
      blockers: [{ code: 'FOCUS_UNMATCHED', kpiCode: 'FOCUS BRAND 2', token: 'XYZ', key: 'XYZ', outlets: 1, sampleOutletCodes: ['O1'], message: '"XYZ" is not a product' }],
    },
    ...over,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  Object.values(apiMock).forEach((f) => f.mockReset());
  apiMock.getProfile.mockResolvedValue({ success: false, error: 'x', status: 500 });
  apiMock.segmentOptions.mockResolvedValue({ success: false, error: 'x', status: 500 });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('recalculate panel — KPI not calculated this month', () => {
  it('row says "not calculated" (not a 0), red warning names the removed values; Recalculate held until ticked, then sends confirmNotCalculated', async () => {
    apiMock.recalcPreview.mockResolvedValue(ok(preview({ reconciliation: { ...preview().reconciliation, blockers: [] } })));
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-10', ok: true, outletsWritten: 3, outletsZeroFilled: 0 }));
    render(<RecalculatePanel month="2026-10" onClose={vi.fn()} onApplied={vi.fn()} />);
    expect(await screen.findByTestId('recalc-not-calculated-FB1 CASES')).toHaveTextContent('not calculated');
    expect(screen.getByTestId('recalc-preview')).toHaveTextContent('removed');
    expect(screen.getByTestId('not-calculated-2026-10')).toHaveTextContent('Existing FB1 CASES values for 4 outlets will be REMOVED.');
    const btn = screen.getByTestId('recalc-apply');
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I accept that FB1 CASES is not calculated for October 2026 and that the existing FB1 CASES values for 4 outlets will be REMOVED/ }));
    expect(btn).not.toBeDisabled();
    await act(async () => { fireEvent.click(btn); });
    expect(apiMock.recalculate).toHaveBeenCalledWith('2026-10', expect.objectContaining({ confirmNotCalculated: true, expectedFocusFingerprint: 'fp1' }));
  });

  it('the tick is cleared whenever the preview reloads', async () => {
    apiMock.recalcPreview.mockResolvedValue(ok(preview()));
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-10', acceptances: [] }));
    render(<RecalculatePanel month="2026-10" onClose={vi.fn()} onApplied={vi.fn()} />);
    const tick = await screen.findByRole('checkbox', { name: /I accept that FB1 CASES is not calculated/ });
    fireEvent.click(tick);
    expect(tick).toBeChecked();
    await act(async () => { fireEvent.click(screen.getByTestId('recon-blocker-accept-FOCUS BRAND 2-XYZ')); });
    await waitFor(() => expect(apiMock.recalcPreview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /I accept that FB1 CASES is not calculated/ })).not.toBeChecked());
  });
});
