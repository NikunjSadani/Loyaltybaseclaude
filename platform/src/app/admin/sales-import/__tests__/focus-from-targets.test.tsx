/// <reference types="vitest/globals" />
/**
 * FOCUS-FROM-TARGETS screens (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md): the month reconciliation panel
 * (import preview + Months → Recalculate), Accept / Undo, apply / recalculate fingerprints, the Months badge and the
 * KPI editor's "Which products count" choice. API mocked.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/focus-from-targets.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  createKpi: vi.fn(), patchKpi: vi.fn(), testKpi: vi.fn(), segmentOptions: vi.fn(),
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
      kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', outletsWithTarget: 4079, totalTarget: 125000, measure: 'AMOUNT' }],
      targetUploadedAt: '2026-11-06T05:00:00.000Z', newerThanLastApply: false,
    },
    focus: [{
      kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT',
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
    kpiCode: 'FB2', label: 'Focus Brand 2', measure: 'QUANTITY',
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
    { code: 'FOCUS_UNMATCHED', kpiCode: 'FB2', token: 'XYZ', key: 'XYZ', outlets: 2338, sampleOutletCodes: ['W1'], message: '"XYZ" in Focus Brand 2 is not a product in the sales data (2,338 outlets). Fix the target file, or accept it as not sold yet.' },
    { code: 'FOCUS_MISSING_NAME', kpiCode: 'FB2', outlets: 3, sampleOutletCodes: ['W1', 'W2', 'W3'], message: '3 outlets have a Focus Brand 2 target but no product name in the target file.' },
  ],
  focusFingerprint: 'fp-blocked',
});

beforeEach(() => {
  Object.values(apiMock).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  apiMock.getProfile.mockResolvedValue(ok({ dimensions: DIMS }));
  apiMock.segmentOptions.mockResolvedValue(ok({
    outletTypes: [{ code: 'RETAILER', name: 'Retailer' }, { code: 'WHOLESALER', name: 'Wholesaler' }], programs: [], subPrograms: [],
  }));
  perms.granted = true;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

// ── The panel on its own ─────────────────────────────────────────────────────

function renderPanel(r: MonthReconciliation | null, over: Partial<React.ComponentProps<typeof MonthReconciliationPanel>> = {}) {
  const onRefresh = vi.fn(async () => true);
  render(
    <MonthReconciliationPanel month="2026-11" reconciliation={r} dims={DIMS}
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
    renderPanel(recon({ targets: { kpis: [], targetUploadedAt: null, newerThanLastApply: false }, focus: [{ kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT', names: [], missingName: { outlets: 0, sampleOutletCodes: [] } }] }));
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
    expect(screen.getByTestId('recon-target-FB1')).toHaveTextContent('Focus Brand 1: targets for 4,079 outlets (total ₹1,25,000)');
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
    expect(within(unmatched).getByRole('button', { name: 'Accept XYZ (Focus Brand 2) as not sold yet' })).toBeInTheDocument();
    const ambiguous = screen.getByTestId('focus-token-FB2-ADHO50');
    expect(ambiguous).toHaveTextContent('could mean more than one product: ADHO, SKU group 50 · or ADHO5, SKU group 0');
    expect(within(ambiguous).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('focus-missing-name-FB2')).toHaveTextContent('3 outlets have a target for this KPI but no product name');
    expect(screen.getByTestId('focus-name-FB2-ADHO50&XYZ')).toHaveTextContent('0 cases');
    const blockers = screen.getByTestId('recon-blockers-2026-11');
    expect(blockers).toHaveTextContent("November 2026 can't be applied until these are fixed:");
    expect(within(blockers).getAllByTestId('recon-blocker')).toHaveLength(2);
    expect(blockers).toHaveTextContent('"XYZ" in Focus Brand 2 is not a product in the sales data (2,338 outlets). Fix the target file, or accept it as not sold yet.');
    // M5: the server message already has the count; the screen appends nothing.
    expect(blockers.textContent!.match(/2,338 outlets/g)).toHaveLength(1);
    expect(within(blockers).getByText('W1, W2, W3')).toBeInTheDocument();
  });

  it('Accept → API call → refresh; buttons disabled while pending', async () => {
    let resolve!: (v: unknown) => void;
    apiMock.acceptFocusToken.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { onRefresh } = renderPanel(UNMATCHED_RECON);
    const btn = within(screen.getByTestId('focus-token-FB2-XYZ')).getByRole('button', { name: 'Accept XYZ (Focus Brand 2) as not sold yet' });
    fireEvent.click(btn);
    expect(apiMock.acceptFocusToken).toHaveBeenCalledWith('2026-11', { kpiCode: 'FB2', key: 'XYZ' });
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('recon-blocker-accept-FB2-XYZ')).toBeDisabled();
    await act(async () => { resolve(ok({ month: '2026-11', acceptances: [] })); });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('recon-action-error')).not.toBeInTheDocument();
  });

  it('Accept refused → error shown, never optimistic', async () => {
    apiMock.acceptFocusToken.mockResolvedValue({ success: false, error: 'The month is closed.', status: 409 });
    renderPanel(UNMATCHED_RECON);
    fireEvent.click(screen.getByTestId('recon-blocker-accept-FB2-XYZ'));
    expect(await screen.findByTestId('recon-action-error')).toHaveTextContent('Not accepted: The month is closed. The preview has been reloaded.');
  });

  it('M2: Accept refused AND the reload failed → never claims the preview was reloaded', async () => {
    apiMock.acceptFocusToken.mockResolvedValue({ success: false, error: 'The month is closed.', status: 409 });
    renderPanel(UNMATCHED_RECON, { onRefresh: vi.fn(async () => false) });
    fireEvent.click(screen.getByTestId('recon-blocker-accept-FB2-XYZ'));
    const err = await screen.findByTestId('recon-action-error');
    expect(err).toHaveTextContent('Not accepted: The month is closed. The preview could not be refreshed — press Refresh preview before applying.');
    expect(err).not.toHaveTextContent('has been reloaded');
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
    fireEvent.click(within(chip).getByRole('button', { name: 'Undo accepting XYZ (Focus Brand 2) as not sold yet' }));
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

  it('M1: collapsed with blockers → blockers AND the Focus brands section show; Accept is on the blocker line', () => {
    renderPanel(UNMATCHED_RECON, { expanded: false });
    const blockers = screen.getByTestId('recon-blockers-2026-11');
    expect(within(blockers).getByRole('button', { name: 'Accept XYZ (Focus Brand 2) as not sold yet' })).toBeInTheDocument();
    // Only UNMATCHED lines get the button (a missing name is fixed in the target file).
    expect(within(blockers).getAllByRole('button', { name: /^Accept/ })).toHaveLength(1);
    expect(screen.getByTestId('recon-focus-2026-11')).toBeInTheDocument();
    expect(screen.queryByTestId('recon-targets-2026-11')).not.toBeInTheDocument();
  });

  it('collapsed without anything needing attention → no Focus brands section', () => {
    renderPanel(recon(), { expanded: false });
    expect(screen.queryByTestId('recon-focus-2026-11')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recon-targets-2026-11')).not.toBeInTheDocument();
  });

  it('M1: the blocker-line Accept calls the API and refreshes', async () => {
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    const { onRefresh } = renderPanel(UNMATCHED_RECON, { expanded: false });
    fireEvent.click(screen.getByTestId('recon-blocker-accept-FB2-XYZ'));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(apiMock.acceptFocusToken).toHaveBeenCalledWith('2026-11', { kpiCode: 'FB2', key: 'XYZ' });
  });

  it('no blocker-line Accept for a viewer who cannot change the month', () => {
    renderPanel(UNMATCHED_RECON, { canAct: false });
    expect(screen.queryByTestId('recon-blocker-accept-FB2-XYZ')).not.toBeInTheDocument();
  });

  it('M7: long names wrap — no nowrap on the name cell, a fixed-layout table, no forced minimum width', () => {
    const long = 'SUPERLONGFOCUSPRODUCTNAMEWITHOUTANYSPACESATALL & ANOTHER VERY LONG PRODUCT NAME THAT GOES ON AND ON';
    renderPanel(recon({ focus: [{ ...recon().focus[0], names: [{ ...recon().focus[0].names[0], name: long }] }] }));
    const cell = screen.getAllByTestId('focus-name-cell')[0];
    expect(cell).toHaveTextContent(long);
    expect(cell.className).not.toMatch(/whitespace-nowrap/);
    expect(cell.className).toMatch(/break-words/);
    expect(cell.className).toMatch(/max-w-/);
    const table = screen.getByTestId('focus-table-FB1');
    expect(table.className).toMatch(/table-fixed/);
    expect(table.className).not.toMatch(/min-w-/);
    // Nothing in the panel sets a minimum width or turns wrapping off.
    const panel = screen.getByTestId('month-recon-2026-11');
    expect(panel.querySelectorAll('[class*="min-w-["], [class*="whitespace-nowrap"]')).toHaveLength(0);
  });

  it('L3: the KPI label (not the raw code) heads the section; outlet types by display name; never "no type"', () => {
    renderPanel(UNMATCHED_RECON, { typeNames: { WHOLESALER: 'Wholesaler' } });
    expect(screen.getByTestId('focus-kpi-title-FB2').textContent).toBe('Focus Brand 2');
    const row = screen.getByTestId('focus-name-FB2-ADHO50&XYZ');
    expect(row).toHaveTextContent('2,300 Wholesaler · 38 outlets without a type');
    expect(row).not.toHaveTextContent('no type');
  });

  it('L3: an outlet type without a display name falls back to its code; one untyped outlet reads naturally', () => {
    renderPanel(recon({ focus: [{ ...recon().focus[0], names: [{ ...recon().focus[0].names[0], outletsByType: { RETAILER: 5, '': 1 } }] }] }));
    expect(screen.getByTestId('focus-name-FB1-ADHO500&CNO')).toHaveTextContent('5 RETAILER · 1 outlet without a type');
  });

  it('L4: achieved and target totals use the measure on the payload (no lookup prop needed)', () => {
    renderPanel(recon({
      targets: { ...recon().targets, kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', outletsWithTarget: 10, totalTarget: 42.5, measure: 'QUANTITY' }] },
      focus: [{ ...recon().focus[0], measure: 'PRODUCT_COUNT', names: [{ ...recon().focus[0].names[0], achieved: { total: 17, outletsZero: 0 } }] }],
    }));
    expect(screen.getByTestId('recon-target-FB1')).toHaveTextContent('(total 42.5 cases)');
    const row = screen.getByTestId('focus-name-FB1-ADHO500&CNO');
    expect(row).toHaveTextContent('17');
    expect(row).not.toHaveTextContent('₹17');
  });

  it('L4: measure missing on an older payload → the measures prop, else a plain number', () => {
    const r = recon();
    const noMeasure = {
      ...r,
      targets: { ...r.targets, kpis: r.targets.kpis.map(({ measure: _m, ...k }) => k) },
      focus: r.focus.map(({ measure: _m, ...k }) => k),
    } as unknown as MonthReconciliation;
    renderPanel(noMeasure);
    expect(screen.getByTestId('recon-target-FB1')).toHaveTextContent('(total 1,25,000)');
    expect(screen.getByTestId('focus-name-FB1-ADHO500&CNO')).toHaveTextContent('54,321.5');
    cleanup();
    renderPanel(noMeasure, { measures: { FB1: 'AMOUNT' } });
    expect(screen.getByTestId('focus-name-FB1-ADHO500&CNO')).toHaveTextContent('₹54,321.50');
  });

  it('L5: blockers are a polite status (no alert), so N blocked months do not fire N alerts', () => {
    renderPanel(UNMATCHED_RECON);
    expect(screen.getByTestId('recon-blockers-2026-11')).toHaveAttribute('role', 'status');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('L5: after Accept, keyboard focus moves to the replacing chip\'s Undo button; after Undo, back to Accept', async () => {
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    apiMock.undoFocusAcceptance.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    const accepted = recon({
      focus: [{
        ...UNMATCHED_RECON.focus[0],
        names: [{
          ...UNMATCHED_RECON.focus[0].names[0],
          tokens: [{ token: 'XYZ', key: 'XYZ', status: 'UNMATCHED', accepted: { byName: 'Asha', at: '2026-11-07T06:30:00.000Z' } }],
        }],
        missingName: { outlets: 0, sampleOutletCodes: [] },
      }],
    });
    let current: MonthReconciliation = UNMATCHED_RECON;
    const view = (rr: MonthReconciliation) => (
      <MonthReconciliationPanel month="2026-11" reconciliation={rr} dims={DIMS} canAct monthOpen onRefresh={onRefresh} />
    );
    const onRefresh = vi.fn(async () => {
      current = current === UNMATCHED_RECON ? accepted : UNMATCHED_RECON;
      rerender(view(current));
      return true;
    });
    const { rerender } = render(view(current));
    fireEvent.click(screen.getByTestId('recon-blocker-accept-FB2-XYZ'));
    const undo = await screen.findByRole('button', { name: 'Undo accepting XYZ (Focus Brand 2) as not sold yet' });
    await waitFor(() => expect(undo).toHaveFocus());
    fireEvent.click(undo);
    const accept = await within(await screen.findByTestId('focus-token-FB2-XYZ'))
      .findByRole('button', { name: 'Accept XYZ (Focus Brand 2) as not sold yet' });
    await waitFor(() => expect(accept).toHaveFocus());
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

  it('a blocked month shows its blockers without expanding, cannot be ticked, and says why under "Not available:"', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({
      canApply: false, blockedReason: '2 focus product names in the November target file could not be matched — see Focus brands.',
      reconciliation: UNMATCHED_RECON,
    })])));
    render(<ImportPage />);
    expect(await screen.findByTestId('recon-blockers-2026-11')).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Apply November 2026' })).toBeDisabled();
    expect(await screen.findByTestId('sales-import-apply')).toBeDisabled();
    const unavailable = await screen.findByTestId('sales-import-unavailable-months');
    expect(unavailable).toHaveTextContent('Not available:');
    expect(unavailable).toHaveTextContent(
      'November 2026 cannot be applied: 2 focus product names in the November target file could not be matched — see Focus brands.',
    );
  });

  it('M1: Accept is reachable without expanding the month; the preview refreshes and the month becomes tickable', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview
      .mockResolvedValueOnce(ok(preview([month({ canApply: false, blockedReason: 'blocked', reconciliation: UNMATCHED_RECON })])))
      .mockResolvedValue(ok(preview([month()])));
    apiMock.acceptFocusToken.mockResolvedValue(ok({ month: '2026-11', acceptances: [] }));
    render(<ImportPage />);
    const blockers = await screen.findByTestId('recon-blockers-2026-11');
    // The Focus brands section shows too, without opening the month.
    expect(await screen.findByTestId('recon-focus-2026-11')).toBeInTheDocument();
    fireEvent.click(within(blockers).getByRole('button', { name: 'Accept XYZ (Focus Brand 2) as not sold yet' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Apply November 2026' })).not.toBeDisabled());
    expect(apiMock.preview).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('recon-blockers-2026-11')).not.toBeInTheDocument();
    // The row stays open after acting, so what was just changed is still on screen.
    expect(await screen.findByTestId('month-detail-2026-11')).toBeInTheDocument();
  });

  it('L5: the month toggle\'s aria-expanded follows the visible detail row', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([
      month({ canApply: false, blockedReason: 'blocked', reconciliation: UNMATCHED_RECON }),
      month({ month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-31', reconciliation: EMPTY_MONTH_RECONCILIATION }),
    ])));
    render(<ImportPage />);
    const nov = await screen.findByRole('button', { name: 'November 2026' });
    expect(await screen.findByTestId('month-detail-2026-11')).toBeInTheDocument();
    expect(nov).toHaveAttribute('aria-expanded', 'true');
    expect(nov).toHaveAttribute('aria-controls', 'month-detail-2026-11');
    const oct = await screen.findByRole('button', { name: 'October 2026' });
    expect(screen.queryByTestId('month-detail-2026-10')).not.toBeInTheDocument();
    expect(oct).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(oct);
    expect(screen.getByTestId('month-detail-2026-10')).toBeInTheDocument();
    expect(oct).toHaveAttribute('aria-expanded', 'true');
  });

  it('L6: a ticked good month has no blockers; a blocked month is listed separately under "Not available:"', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([
      month({ canApply: false, blockedReason: 'Focus names could not be matched', reconciliation: UNMATCHED_RECON }),
      month({ month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-31', reconciliation: EMPTY_MONTH_RECONCILIATION }),
    ])));
    render(<ImportPage />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Apply October 2026' }));
    expect(screen.getByTestId('sales-import-apply')).not.toBeDisabled();
    expect(screen.queryByTestId('sales-import-apply-blockers')).not.toBeInTheDocument();
    const unavailable = screen.getByTestId('sales-import-unavailable-months');
    expect(unavailable).toHaveTextContent('Not available:');
    expect(unavailable).toHaveTextContent('November 2026 cannot be applied: Focus names could not be matched.');
  });

  it('outlet type display names are loaded for the focus table', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: false, blockedReason: 'blocked', reconciliation: UNMATCHED_RECON })])));
    render(<ImportPage />);
    await waitFor(() => expect(screen.getByTestId('focus-name-FB2-ADHO50&XYZ')).toHaveTextContent('2,300 Wholesaler · 38 outlets without a type'));
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
    expect(await screen.findByTestId('recalc-apply')).toBeDisabled();
    fireEvent.click(screen.getByTestId('recon-blocker-accept-FB2-XYZ'));
    await waitFor(() => expect(screen.getByTestId('recalc-apply')).not.toBeDisabled());
    expect(apiMock.recalcPreview).toHaveBeenCalledTimes(2);
  });

  it('M6: after a successful recalculation the preview reloads, so "apply again / recalculate" disappears', async () => {
    apiMock.months.mockResolvedValue(ok([row({ targetsChangedSinceApply: true })]));
    apiMock.recalcPreview
      .mockResolvedValueOnce(ok(recalc({ reconciliation: recon({ targets: { ...recon().targets, newerThanLastApply: true } }) })))
      .mockResolvedValue(ok(recalc()));
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-11', ok: true, outletsWritten: 5, outletsZeroFilled: 0 }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-11'));
    expect(await screen.findByTestId('recon-targets-newer')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect(await screen.findByTestId('recalc-result')).toHaveTextContent('November 2026 recalculated');
    await waitFor(() => expect(screen.queryByTestId('recon-targets-newer')).not.toBeInTheDocument());
    expect(apiMock.recalcPreview).toHaveBeenCalledTimes(2);
  });

  it('M6: if the reload after recalculating fails, the stale reconciliation is hidden (not shown as current)', async () => {
    apiMock.months.mockResolvedValue(ok([row()]));
    apiMock.recalcPreview
      .mockResolvedValueOnce(ok(recalc({ reconciliation: recon({ targets: { ...recon().targets, newerThanLastApply: true } }) })))
      .mockResolvedValue({ success: false, error: 'Server busy', status: 503 });
    apiMock.recalculate.mockResolvedValue(ok({ month: '2026-11', ok: true, outletsWritten: 5, outletsZeroFilled: 0 }));
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-11'));
    expect(await screen.findByTestId('recon-targets-newer')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('recalc-apply')); });
    expect(await screen.findByTestId('recalc-recon-stale')).toHaveTextContent('could not be reloaded');
    expect(screen.queryByTestId('recon-targets-newer')).not.toBeInTheDocument();
  });

  it('M2: Accept in Recalculate whose reload failed says how to recover on THIS screen', async () => {
    apiMock.months.mockResolvedValue(ok([row()]));
    apiMock.recalcPreview
      .mockResolvedValueOnce(ok(recalc({ canApply: false, blockedReason: 'blocked', reconciliation: UNMATCHED_RECON })))
      .mockResolvedValue({ success: false, error: 'Server busy', status: 503 });
    apiMock.acceptFocusToken.mockResolvedValue({ success: false, error: 'The month is closed.', status: 409 });
    render(<MonthsPage />);
    fireEvent.click(await screen.findByTestId('recalc-open-2026-11'));
    fireEvent.click(await screen.findByTestId('recon-blocker-accept-FB2-XYZ'));
    expect(await screen.findByTestId('recon-action-error')).toHaveTextContent(
      'Not accepted: The month is closed. The preview could not be refreshed — close the recalculation and open it again before recalculating.',
    );
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

  it('L2: a KPI without a name column warns AND blocks Save (no round-trip to be refused)', async () => {
    renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB9' } });
    fireEvent.click(screen.getByRole('radio', { name: 'From the target file, per outlet' }));
    expect(screen.getByTestId('product-source-no-name-column')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent(
      'Turn on the per-outlet name column for No names under Targets → KPI settings first, or pick the products here.',
    );
    const save = screen.getByRole('button', { name: 'Save KPI' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(apiMock.createKpi).not.toHaveBeenCalled();
  });

  it('L2: the API refusal is still shown if the server refuses anyway', async () => {
    apiMock.createKpi.mockResolvedValue({ success: false, error: 'Turn on the per-outlet name column for this KPI in KPI settings first.', status: 400 });
    renderEditor();
    fireEvent.change(screen.getByRole('combobox', { name: 'KPI' }), { target: { value: 'FB1' } });
    fireEvent.click(screen.getByRole('radio', { name: 'From the target file, per outlet' }));
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

  it('L1: switching a saved TARGET_NAMES KPI to "Pick products here" with NO products blocks Save until "ALL products" is ticked', async () => {
    apiMock.patchKpi.mockImplementation(async (_id: string, d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    renderEditor({ ...NEW, id: 'k1', kpiCode: 'FB1', productSource: 'TARGET_NAMES', filter: {} });
    expect(screen.getByTestId('product-source-target-names')).toBeInTheDocument();
    expect(screen.queryByTestId('kpi-all-products-confirm')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Pick products here' }));
    expect(screen.queryByTestId('product-source-target-names')).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save KPI' });
    expect(save).toBeDisabled();
    expect(screen.getByTestId('kpi-editor-blockers')).toHaveTextContent(
      'No products are picked, so this KPI would count ALL products. Pick the products it counts, or tick “This KPI counts ALL products”.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /This KPI counts ALL products/ }));
    expect(save).not.toBeDisabled();
    await act(async () => { fireEvent.click(save); });
    expect(apiMock.patchKpi).toHaveBeenCalledWith('k1', expect.objectContaining({ productSource: 'FILTER', filter: {} }));
  });

  it('L1: switching a saved TARGET_NAMES KPI back with products picked needs no tick', async () => {
    apiMock.patchKpi.mockImplementation(async (_id: string, d: SalesKpiDefinitionDto) => ok({ ...d, id: 'k1' }));
    renderEditor({ ...NEW, id: 'k1', kpiCode: 'FB1', productSource: 'TARGET_NAMES', filter: { anyOf: [{ brand: 'P' }] } });
    fireEvent.click(screen.getByRole('radio', { name: 'Pick products here' }));
    expect(screen.queryByTestId('kpi-all-products-confirm')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save KPI' })); });
    expect(apiMock.patchKpi).toHaveBeenCalledWith('k1', expect.objectContaining({ productSource: 'FILTER', filter: { anyOf: [{ brand: 'P' }] } }));
  });
});
