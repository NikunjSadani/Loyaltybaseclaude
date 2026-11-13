/// <reference types="vitest/globals" />
/**
 * FOCUS-FROM-TARGETS screens (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md): the month reconciliation panel
 * (import preview + Months → Recalculate), Accept / Undo, apply / recalculate fingerprints, the Months badge and the
 * KPI editor's "Which products count" choice. API mocked.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/focus-from-targets.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  EMPTY_MONTH_RECONCILIATION,
  type MonthPreview, type MonthReconciliation, type SalesImportDetail, type SalesImportPreview,
  type SalesKpiDefinitionDto, type SalesMonthRecalcPreview, type SalesMonthRow,
} from '@/lib/sales-import/types';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'imp1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) =>
    <a href={href} {...props}>{children}</a>,
}));
vi.mock('@/lib/admin-session', () => ({ useAdminSession: () => ({ role: 'CLIENT_ADMIN' }) }));

const apiMock = vi.hoisted(() => ({
  get: vi.fn(), preview: vi.fn(), apply: vi.fn(), reprocess: vi.fn(), remove: vi.fn(), cancel: vi.fn(), reprocessAsNew: vi.fn(),
  getProfile: vi.fn(), acceptFocusToken: vi.fn(), undoFocusAcceptance: vi.fn(),
  months: vi.fn(), closeMonth: vi.fn(), reopenMonth: vi.fn(), recalcPreview: vi.fn(), recalculate: vi.fn(), rebuildProductList: vi.fn(),
  createKpi: vi.fn(), patchKpi: vi.fn(), testKpi: vi.fn(),
  unmatchedCsvUrl: (id: string) => `/u/${id}`, errorsXlsxUrl: (id: string) => `/e/${id}`,
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));
const perms = vi.hoisted(() => ({ granted: true }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {}, has: () => perms.granted }),
}));

import ImportPage from '../[id]/page';
import MonthsPage from '../months/page';
import { MonthReconciliationPanel, describeProduct } from '../_components/month-reconciliation-panel';
import { KpiEditor } from '../settings/_components/kpi-editor';

const ok = <T,>(data: T) => ({ success: true as const, data });
const DIMS = [{ key: 'brand', label: 'Brand', header: 'BRAND' }, { key: 'skuGroup', label: 'SKU group', header: 'SKU' }];

function recon(over: Partial<MonthReconciliation> = {}): MonthReconciliation {
  return {
    targets: {
      kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', outletsWithTarget: 4079, totalTarget: 125000 }],
      targetUploadedAt: '2026-11-06T05:00:00.000Z', newerThanLastApply: false,
    },
    focus: [{
      kpiCode: 'FB1', label: 'Focus Brand 1',
      names: [{
        name: 'CNO & ADHO500', key: 'ADHO500&CNO', outlets: 4079, outletsByType: { RETAILER: 4079 },
        tokens: [
          { token: 'CNO', key: 'CNO', status: 'MATCHED', product: { brand: 'CNO' } },
          { token: 'ADHO500', key: 'ADHO500', status: 'MATCHED', product: { brand: 'ADHO', skuGroup: '500' } },
        ],
        achieved: { total: 54321.5, outletsZero: 12 },
      }],
      missingName: { outlets: 0, sampleOutletCodes: [] },
    }],
    blockers: [],
    gaps: { targetNoSales: { outlets: 0, sampleOutletCodes: [] }, salesNoTarget: { outlets: 0, sampleOutletCodes: [] } },
    focusFingerprint: 'fp-nov',
    ...over,
  };
}

const UNMATCHED_RECON = recon({
  focus: [{
    kpiCode: 'FB2', label: 'Focus Brand 2',
    names: [{
      name: 'ADHO50 & XYZ', key: 'ADHO50&XYZ', outlets: 2338, outletsByType: { WHOLESALER: 2300, '': 38 },
      tokens: [
        { token: 'ADHO50', key: 'ADHO50', status: 'AMBIGUOUS', candidates: [{ brand: 'ADHO', skuGroup: '50' }, { brand: 'ADHO5', skuGroup: '0' }] },
        { token: 'XYZ', key: 'XYZ', status: 'UNMATCHED' },
      ],
      achieved: { total: 0, outletsZero: 2338 },
    }],
    missingName: { outlets: 3, sampleOutletCodes: ['W1', 'W2', 'W3'] },
  }],
  blockers: [
    { code: 'FOCUS_UNMATCHED', kpiCode: 'FB2', token: 'XYZ', key: 'XYZ', outlets: 2338, sampleOutletCodes: ['W1'], message: 'XYZ (Focus Brand 2) is not in the sales data.' },
    { code: 'FOCUS_MISSING_NAME', kpiCode: 'FB2', outlets: 3, sampleOutletCodes: ['W1', 'W2', 'W3'], message: '3 outlets have a Focus Brand 2 target but no product name' },
  ],
  focusFingerprint: 'fp-blocked',
});

beforeEach(() => {
  Object.values(apiMock).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  apiMock.getProfile.mockResolvedValue(ok({ dimensions: DIMS }));
  perms.granted = true;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

// ── The panel on its own ─────────────────────────────────────────────────────

function renderPanel(r: MonthReconciliation | null, over: Partial<React.ComponentProps<typeof MonthReconciliationPanel>> = {}) {
  const onRefresh = vi.fn(async () => true);
  render(
    <MonthReconciliationPanel month="2026-11" reconciliation={r} measures={{ FB1: 'AMOUNT', FB2: 'QUANTITY' }} dims={DIMS}
      canAct monthOpen onRefresh={onRefresh} {...over} />,
  );
  return { onRefresh };
}

describe('MonthReconciliationPanel', () => {
  it('describes products in words', () => {
    expect(describeProduct({ brand: 'ADHO', skuGroup: '500' }, DIMS)).toBe('ADHO, SKU group 500');
    expect(describeProduct({ brand: 'CNO' }, DIMS)).toBe('all CNO products');
    expect(describeProduct({ brand: 'ADHO', skuGroup: '500' }, [])).toBe('ADHO, sku group 500');
  });

  it('no targets for the month + a focus KPI → amber notice', () => {
    renderPanel(recon({ targets: { kpis: [], targetUploadedAt: null, newerThanLastApply: false }, focus: [{ kpiCode: 'FB1', label: 'Focus Brand 1', names: [], missingName: { outlets: 0, sampleOutletCodes: [] } }] }));
    expect(screen.getByTestId('recon-no-targets')).toHaveTextContent(
      'No targets uploaded for this month yet — focus KPIs are not calculated. Upload targets, then recalculate.',
    );
  });

  it('no targets but no focus KPI → no amber notice (tenants without focus KPIs are not alarmed)', () => {
    renderPanel(EMPTY_MONTH_RECONCILIATION);
    expect(screen.queryByTestId('recon-no-targets')).not.toBeInTheDocument();
    expect(screen.getByText('No targets uploaded for November 2026 yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('recon-focus-2026-11')).not.toBeInTheDocument();
  });

  it('targets newer than the last apply → amber notice', () => {
    renderPanel(recon({ targets: { ...recon().targets, newerThanLastApply: true } }));
    expect(screen.getByTestId('recon-targets-newer')).toHaveTextContent(
      'Targets were uploaded after this month was last applied — apply again (or Recalculate) to use them.',
    );
  });

  it('targets per KPI and MATCHED chips in words, achieved in the KPI measure', () => {
    renderPanel(recon());
    expect(screen.getByTestId('recon-target-FB1')).toHaveTextContent('Focus Brand 1: targets for 4,079 outlets (total 1,25,000)');
    expect(screen.getByTestId('focus-token-FB1-ADHO500')).toHaveTextContent('ADHO500 → ADHO, SKU group 500');
    expect(screen.getByTestId('focus-token-FB1-CNO')).toHaveTextContent('CNO → all CNO products');
    const row = screen.getByTestId('focus-name-FB1-ADHO500&CNO');
    expect(row).toHaveTextContent('CNO & ADHO500');
    expect(row).toHaveTextContent('4,079 RETAILER');
    expect(row).toHaveTextContent('₹54,321.50');
    expect(screen.queryByTestId('recon-blockers-2026-11')).not.toBeInTheDocument();
  });

  it('UNMATCHED / AMBIGUOUS red chips, missing names, blockers with sample codes', () => {
    renderPanel(UNMATCHED_RECON);
    const unmatched = screen.getByTestId('focus-token-FB2-XYZ');
    expect(unmatched).toHaveAttribute('data-status', 'UNMATCHED');
    expect(unmatched).toHaveTextContent('XYZ — not found in sales data');
    expect(within(unmatched).getByRole('button', { name: 'Accept XYZ as not sold yet' })).toBeInTheDocument();
    const ambiguous = screen.getByTestId('focus-token-FB2-ADHO50');
    expect(ambiguous).toHaveTextContent('could mean more than one product: ADHO, SKU group 50 · or ADHO5, SKU group 0');
    expect(within(ambiguous).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('focus-missing-name-FB2')).toHaveTextContent('3 outlets have a target for this KPI but no product name');
    expect(screen.getByTestId('focus-name-FB2-ADHO50&XYZ')).toHaveTextContent('0 cases');
    const blockers = screen.getByTestId('recon-blockers-2026-11');
    expect(blockers).toHaveTextContent("November 2026 can't be applied until these are fixed:");
    expect(within(blockers).getAllByTestId('recon-blocker')).toHaveLength(2);
    expect(blockers).toHaveTextContent('XYZ (Focus Brand 2) is not in the sales data. (2,338 outlets)');
    expect(within(blockers).getByText('W1, W2, W3')).toBeInTheDocument();
  });

  it('Accept → API call → refresh; buttons disabled while pending', async () => {
    let resolve!: (v: unknown) => void;
    apiMock.acceptFocusToken.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { onRefresh } = renderPanel(UNMATCHED_RECON);
    const btn = screen.getByRole('button', { name: 'Accept XYZ as not sold yet' });
    fireEvent.click(btn);
    expect(apiMock.acceptFocusToken).toHaveBeenCalledWith('2026-11', { kpiCode: 'FB2', key: 'XYZ' });
    expect(btn).toBeDisabled();
    await act(async () => { resolve(ok({ month: '2026-11', acceptances: [] })); });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('recon-action-error')).not.toBeInTheDocument();
  });

  it('Accept refused → error shown, never optimistic', async () => {
    apiMock.acceptFocusToken.mockResolvedValue({ success: false, error: 'The month is closed.', status: 409 });
    renderPanel(UNMATCHED_RECON);
    fireEvent.click(screen.getByRole('button', { name: 'Accept XYZ as not sold yet' }));
    expect(await screen.findByTestId('recon-action-error')).toHaveTextContent('Not accepted: The month is closed. The preview has been reloaded.');
  });

  it('accepted chip is grey with who / when, and Undo calls DELETE then refreshes', async () => {
    apiMock.undoFocusAcceptance.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    const r = recon({
      focus: [{
        ...UNMATCHED_RECON.focus[0],
        names: [{
          ...UNMATCHED_RECON.focus[0].names[0],
          tokens: [{ token: 'XYZ', key: 'XYZ', status: 'UNMATCHED', accepted: { byName: 'Asha', at: '2026-11-07T06:30:00.000Z' } }],
        }],
        missingName: { outlets: 0, sampleOutletCodes: [] },
      }],
    });
    const { onRefresh } = renderPanel(r);
    const chip = screen.getByTestId('focus-token-FB2-XYZ');
    expect(chip).toHaveAttribute('data-status', 'ACCEPTED');
    expect(chip).toHaveTextContent('XYZ — accepted as not sold yet by Asha on');
    fireEvent.click(within(chip).getByRole('button', { name: 'Undo accepting XYZ as not sold yet' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(apiMock.undoFocusAcceptance).toHaveBeenCalledWith('2026-11', 'FB2', 'XYZ');
  });

  it('a closed month or a viewer without targets:upload gets no Accept button', () => {
    renderPanel(UNMATCHED_RECON, { monthOpen: false });
    expect(screen.queryByRole('button', { name: /Accept XYZ/ })).not.toBeInTheDocument();
  });

  it('gaps are informational with sample codes', () => {
    renderPanel(recon({ gaps: { targetNoSales: { outlets: 2, sampleOutletCodes: ['R1', 'R2'] }, salesNoTarget: { outlets: 1, sampleOutletCodes: ['R9'] } } }));
    expect(screen.getByTestId('recon-gap-target-no-sales')).toHaveTextContent('2 outlets have a target but no sales this month.');
    expect(screen.getByTestId('recon-gap-sales-no-target')).toHaveTextContent('1 outlet has sales but no target this month.');
    expect(screen.getByText('R1, R2')).toBeInTheDocument();
  });

  it('collapsed (expanded=false) shows only blockers and notices', () => {
    renderPanel(UNMATCHED_RECON, { expanded: false });
    expect(screen.getByTestId('recon-blockers-2026-11')).toBeInTheDocument();
    expect(screen.queryByTestId('recon-focus-2026-11')).not.toBeInTheDocument();
  });
});

// ── Import preview: blockers + fingerprints ──────────────────────────────────

function detail(): SalesImportDetail {
  return {
    id: 'imp1', status: 'READY', originalFilename: 'dms.xlsx', fileKind: 'XLSX', sizeBytes: 1000, partCount: 1,
    partsReceived: 1, bytesRead: 1000, rowsRead: 50, rowsSkipped: 0, progressPct: null, duplicateOfId: null,
    error: null, detectedHeaders: null, createdAt: '2026-11-01T10:00:00.000Z', finishedAt: null, uploadedBy: 'Asha',
    queuedAt: null, heartbeatAt: null, stalled: false, applied: false, purgedAt: null, canReprocess: true, canCancel: false,
    canDelete: true, reprocessedFromId: null, canReprocessAsNew: false, monthSummaries: null, errorSamples: null,
  };
}
function month(over: Partial<MonthPreview> = {}): MonthPreview {
  return {
    month: '2026-11', firstDate: '2026-11-01', lastDate: '2026-11-30', lines: 40, matchedOutlets: 3,
    unmatchedCustomers: 0, matchedAmountRupees: 1200, matchedQuantity: 4.5, unmatchedAmountRupees: 0,
    unmatchedQuantity: 0, monthState: 'OPEN', canApply: true, warnings: [], zeroFillOutlets: 1,
    kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT', newTotal: 1200, currentTotal: 0, delta: 1200, outletsNonZero: 3, outletsNegative: 0 }],
    lastApplied: null, reconciliation: recon(), ...over,
  };
}
function preview(months: MonthPreview[]): SalesImportPreview {
  return { importId: 'imp1', definitionsHash: 'h1', processingVersion: 7, mappingChanged: false, rosterOutletsAddedSinceProcessing: 0, months };
}

describe('import preview — focus reconciliation', () => {
  it('apply sends expectedFocusFingerprints for ticked months with a non-empty fingerprint', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([
      month(),
      month({ month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-31', reconciliation: EMPTY_MONTH_RECONCILIATION }),
    ])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-11', ok: true, outletsWritten: 3 }, { month: '2026-10', ok: true, outletsWritten: 3 }] }));
    render(<ImportPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply November 2026' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply October 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(apiMock.apply).toHaveBeenCalledWith('imp1', expect.objectContaining({
      months: ['2026-11', '2026-10'], expectedFocusFingerprints: { '2026-11': 'fp-nov' },
    }));
  });

  it('no fingerprint anywhere → the field is not sent (existing tenants unchanged)', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ reconciliation: EMPTY_MONTH_RECONCILIATION })])));
    apiMock.apply.mockResolvedValue(ok({ results: [{ month: '2026-11', ok: true }] }));
    render(<ImportPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply November 2026' }));
    await act(async () => { fireEvent.click(screen.getByTestId('sales-import-apply')); });
    expect(apiMock.apply.mock.calls[0][1]).not.toHaveProperty('expectedFocusFingerprints');
  });

  it('a blocked month shows its blockers without expanding, cannot be ticked, and Apply says why', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({
      canApply: false, blockedReason: '2 focus product names in the November target file could not be matched — see Focus brands.',
      reconciliation: UNMATCHED_RECON,
    })])));
    render(<ImportPage />);
    expect(await screen.findByTestId('recon-blockers-2026-11')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Apply November 2026' })).toBeDisabled();
    expect(screen.getByTestId('sales-import-apply')).toBeDisabled();
    expect(screen.getByTestId('sales-import-apply-blockers')).toHaveTextContent(
      'November 2026 cannot be applied: 2 focus product names in the November target file could not be matched — see Focus brands.',
    );
  });

  it('Accept in the preview refreshes it; the month becomes tickable', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview
      .mockResolvedValueOnce(ok(preview([month({ canApply: false, blockedReason: 'blocked', reconciliation: UNMATCHED_RECON })])))
      .mockResolvedValue(ok(preview([month()])));
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    render(<ImportPage />);
    // Open the month so the Focus brands section (with the Accept button) shows.
    fireEvent.click(await screen.findByRole('button', { name: 'November 2026' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept XYZ as not sold yet' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Apply November 2026' })).not.toBeDisabled());
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('recon-blockers-2026-11')).not.toBeInTheDocument();
  });
});

// ── Months: badge + recalculate fingerprint ──────────────────────────────────

function row(over: Partial<SalesMonthRow> = {}): SalesMonthRow {
  return {
    month: '2026-11', state: 'OPEN', implicit: true, closedAt: null, closedBy: null, lastAppliedAt: '2026-11-02T05:00:00.000Z',
    lastAppliedImportId: 'i1', canClose: false, canReopen: false, downstream: { creditBatches: 0, exports: 0 },
    hasHistory: true, historySourceImportId: 'i1', historyAppliedAt: '2026-11-02T05:00:00.000Z', productListCurrent: true,
    targetsChangedSinceApply: false, ...over,
  };
}
function recalc(over: Partial<SalesMonthRecalcPreview> = {}): SalesMonthRecalcPreview {
  return {
    month: '2026-11', monthState: 'OPEN', canApply: true, definitionsHash: 'dh1', historySourceImportId: 'i1',
    historyAppliedAt: '2026-11-02T05:00:00.000Z', matchedOutlets: 3, unmatchedCustomers: 0, matchedAmountRupees: 1200,
    matchedQuantity: 4, unmatchedAmountRupees: 0, unmatchedQuantity: 0, zeroFillOutlets: 0, outletsAffected: 5,
    warnings: [], kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT', newTotal: 900, currentTotal: 0, delta: 900, outletsNonZero: 3, outletsNegative: 0 }],
    reconciliation: recon(), ...over,
  };
}

describe('months — targets changed badge + recalculate', () => {
  it('"Targets changed — recalculate" opens the recalculate panel, which sends the focus fingerprint', async () => {
    apiMock.months.mockResolvedValue(ok([row({ targetsChangedSinceApply: true }), row({ month: '2026-10' })]));
    apiMock.recalcPreview.mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-11', ok: true, outletsWritten: 5, outletsZeroFilled: 0 }));
    render(<MonthsPage />);
    const badge = await screen.findByTestId('targets-changed-2026-11');
    expect(badge).toHaveTextContent('Targets changed — recalculate');
    expect(screen.queryByTestId('targets-changed-2026-10')).not.toBeInTheDocument();
    fireEvent.click(badge);
    expect(await screen.findByTestId('month-recon-2026-11')).toBeInTheDocument();
    expect(apiMock.recalcPreview).toHaveBeenCalledWith('2026-11');
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect(apiMock.recalculate).toHaveBeenCalledWith('2026-11', {
      expectedDefinitionsHash: 'dh1', expectedHistoryAppliedAt: '2026-11-02T05:00:00.000Z', expectedFocusFingerprint: 'fp-nov',
    });
  });

  it('a closed month shows a plain badge (no button)', async () => {
    apiMock.months.mockResolvedValue(ok([row({ state: 'CLOSED', targetsChangedSinceApply: true })]));
    render(<MonthsPage />);
    const badge = await screen.findByTestId('targets-changed-2026-11');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveTextContent('Targets changed after the last apply');
  });

  it('recalculate with blockers: blocked + Accept refreshes the recalc preview', async () => {
    apiMock.months.mockResolvedValue(ok([row()]));
    apiMock.recalcPreview
      .mockResolvedValueOnce(ok(recalc({ canApply: false, blockedReason: 'Focus names could not be matched', reconciliation: UNMATCHED_RECON })))
      .mockResolvedValue(ok(recalc()));
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-11'));
    expect(await screen.findByTestId('recon-blockers-2026-11')).toBeInTheDocument();
    expect(screen.getByTestId('recalc-apply')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept XYZ as not sold yet' }));
    await waitFor(() => expect(screen.getByTestId('recalc-apply')).not.toBeDisabled());
    expect(apiMock.recalcPreview).toHaveBeenCalledTimes(2);
  });
});

// ── KPI editor: Which products count ─────────────────────────────────────────

describe('KPI editor — products from the target file', () => {
  const MAPPING = {
    sheetName: null, headerRow: 'auto' as const, outletCode: 'CUST', outletName: null, invoiceDate: 'DATE', amount: 'AMT',
    quantity: 'QTY', dateOrder: 'DMY' as const, dimensions: DIMS,
  };
  const NEW: SalesKpiDefinitionDto = { kpiCode: '', measure: 'PRODUCT_COUNT', filter: { anyOf: [{ brand: 'P' }] }, outletTypes: [], programs: [], enabled: true, order: 0 };
  const KPIS = [{ code: 'FB1', label: 'Focus Brand 1', unit: '', enabled: true, hasNameOverride: true, nameOverrideLabel: 'FOCUS BRAND' },
    { code: 'FB9', label: 'No names', unit: '', enabled: true, hasNameOverride: false, nameOverrideLabel: null }];

  function renderEditor(initial = NEW) {
    const onSaved = vi.fn();
    render(<KpiEditor initial={initial} tenantKpis={KPIS} ownedCodes={[]} mapping={MAPPING} combos={null}
      onSaved={onSaved} onCancel={vi.fn()} onDuplicateAsCases={vi.fn()} />);
    return { onSaved };
  }

  it('choosing "From the target file" hides the picker + test and saves {productSource:TARGET_NAMES, filter:{}}', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    const { onSaved } = renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB1' } });
    fireEvent.click(screen.getByRole('radio', { name: 'From the target file, per outlet' }));
    const help = screen.getByTestId('product-source-target-names');
    expect(help).toHaveTextContent("Each outlet counts the products written for this KPI in that month's target file");
    expect(help).toHaveTextContent('Name column for FB1 in the target file: FOCUS BRAND.');
    expect(screen.queryByRole('button', { name: /Test against latest import/ })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi).toHaveBeenCalledWith(expect.objectContaining({
      kpiCode: 'FB1', measure: 'PRODUCT_COUNT', productSource: 'TARGET_NAMES', filter: {},
    }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('a KPI without a name column warns, and the API refusal is shown', async () => {
    apiMock.createKpi.mockResolvedValue({ success: false, error: 'Turn on the per-outlet name column for this KPI in KPI settings first, so the target file can carry the product names.', status: 400 });
    renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB9' } });
    fireEvent.click(screen.getByRole('radio', { name: 'From the target file, per outlet' }));
    expect(screen.getByTestId('product-source-no-name-column')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Turn on the per-outlet name column');
  });

  it('a plain FILTER definition is saved as before (no productSource key)', async () => {
    apiMock.createKpi.mockImplementation(async (d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    renderEditor({ ...NEW, measure: 'AMOUNT' });
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB1' } });
    expect(screen.getByRole('radio', { name: 'Pick products here' })).toBeChecked();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.createKpi.mock.calls[0][0]).not.toHaveProperty('productSource');
    expect(apiMock.createKpi.mock.calls[0][0].filter).toEqual({ anyOf: [{ brand: 'P' }] });
  });

  it('switching an existing TARGET_NAMES definition back to "Pick products here" saves FILTER', async () => {
    apiMock.patchKpi.mockImplementation(async (_id: string, d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    renderEditor({ ...NEW, id: 'k1', kpiCode: 'FB1', productSource: 'TARGET_NAMES', filter: {} });
    expect(screen.getByTestId('product-source-target-names')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Pick products here' }));
    expect(screen.queryByTestId('product-source-target-names')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.patchKpi).toHaveBeenCalledWith('k1', expect.objectContaining({ productSource: 'FILTER' }));
  });
});
