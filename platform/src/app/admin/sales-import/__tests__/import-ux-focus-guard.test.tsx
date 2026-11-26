/// <reference types="vitest/globals" />
/**
 * Owner 2026-11-26 (Bajaj Nov import: "1011.2697 & ADHO500" in the Focus Brand name → hundreds of "not found" rows, Apply
 * far below): the summary + Apply sit in a sticky bar at the TOP; large sections start collapsed with their count in the
 * header; "Accept all N" first SHOWS the list and needs a confirm tick; names that look like numbers get a red hint and
 * no Accept unless an explicit override is ticked. API mocked.
 * Run: npx vitest run src/app/admin/sales-import/__tests__/import-ux-focus-guard.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  FocusBlocker, FocusTokenResolution, MonthPreview, MonthReconciliation, SalesImportDetail, SalesImportPreview,
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
  getProfile: vi.fn(), acceptFocusToken: vi.fn(), acceptFocusTokens: vi.fn(), undoFocusAcceptance: vi.fn(),
  getApplyJob: vi.fn(), findApplyJob: vi.fn(), segmentOptions: vi.fn(),
  unmatchedCsvUrl: (id: string) => `/u/${id}`, errorsXlsxUrl: (id: string) => `/e/${id}`,
}));
vi.mock('@/lib/sales-import/api', () => ({ salesImportApi: apiMock, fetchDownload: vi.fn() }));
vi.mock('@/lib/use-permissions', () => ({
  usePermissions: () => ({ role: 'CLIENT_ADMIN', permissions: [], ready: true, error: false, retry: () => {}, has: () => true }),
}));

import ImportPage from '../[id]/page';
import {
  MonthReconciliationPanel, focusKpiStatusText, reconciliationProblems,
} from '../_components/month-reconciliation-panel';
import { looksLikeNumber } from '@/lib/sales-import/format';

const ok = <T,>(data: T) => ({ success: true as const, data });

/** Bajaj-shaped month: 3 real unmatched products + `numbers` numeric names in Focus Brand 1, `extraNames` rows. */
function badMonth(numbers = 3, extraNames = 12): MonthReconciliation {
  const real = ['NEWBRAND', 'CNO GOLD', 'ADHO 1L'];
  const nums = Array.from({ length: numbers }, (_, i) => `${1011 + i}.2697`);
  const tokens: FocusTokenResolution[] = [...real, ...nums].map((t) => ({ token: t, key: t.replace(/\s+/g, ''), status: 'UNMATCHED' }));
  const names = tokens.map((t) => ({
    name: `${t.token} & ADHO500`, key: `${t.key}&ADHO500`, outlets: 2, outletsByType: {},
    tokens: [t, { token: 'ADHO500', key: 'ADHO500', status: 'MATCHED' as const, product: { brand: 'ADHO', skuGroup: '500' } }],
    achieved: { total: 0, outletsZero: 2 },
  }));
  for (let i = 0; i < extraNames; i++) {
    names.push({ name: `CNO${i}`, key: `CNO${i}`, outlets: 1, outletsByType: {},
      tokens: [{ token: `CNO${i}`, key: `CNO${i}`, status: 'MATCHED', product: { brand: `CNO${i}` } }], achieved: { total: 1, outletsZero: 0 } });
  }
  const blockers: FocusBlocker[] = tokens.map((t) => ({
    code: 'FOCUS_UNMATCHED', kpiCode: 'FB1', token: t.token, key: t.key, outlets: 2, sampleOutletCodes: ['R1', 'R2'],
    message: `"${t.token}" in Focus Brand 1 is not a product in the sales data (2 outlets). Fix the target file, or accept it as not sold yet.`,
  }));
  return {
    targets: { kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', outletsWithTarget: 20, totalTarget: 1000, measure: 'AMOUNT' }],
      targetUploadedAt: '2026-11-06T05:00:00.000Z', newerThanLastApply: false },
    focus: [{ kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT', names, missingName: { outlets: 0, sampleOutletCodes: [] } }],
    blockers,
    gaps: { targetNoSales: { outlets: 0, sampleOutletCodes: [] }, salesNoTarget: { outlets: 0, sampleOutletCodes: [] } },
    focusFingerprint: 'fp',
  };
}

function renderPanel(r: MonthReconciliation) {
  const onRefresh = vi.fn(async () => true);
  render(<MonthReconciliationPanel month="2026-11" reconciliation={r} canAct monthOpen onRefresh={onRefresh} />);
  return { onRefresh };
}

beforeEach(() => {
  Object.values(apiMock).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as ReturnType<typeof vi.fn>).mockReset());
  apiMock.getProfile.mockResolvedValue(ok({ dimensions: [] }));
  apiMock.segmentOptions.mockResolvedValue(ok({ outletTypes: [], programs: [], subPrograms: [] }));
  window.sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('looksLikeNumber (same rule as the API)', () => {
  it('numbers vs product names', () => {
    for (const t of ['1011.2697', ' 42 ', '₹1,011.50']) expect(looksLikeNumber(t)).toBe(true);
    for (const t of ['ADHO500', 'CNO 1L', '.', '', null]) expect(looksLikeNumber(t)).toBe(false);
  });
});

describe('not-found names: collapsible group + numbers', () => {
  it('a large group starts COLLAPSED; its header says the count and how many look like numbers', () => {
    renderPanel(badMonth(3));
    const toggle = screen.getByTestId('recon-unmatched-toggle-2026-11-FB1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Focus Brand 1 — 6 names not found in sales data (3 look like numbers)');
    expect(screen.queryByTestId('recon-blocker-accept-FB1-NEWBRAND')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('recon-blocker-accept-FB1-NEWBRAND')).toBeInTheDocument();
  });

  it('a name that looks like a number: red hint, NO Accept until the override is ticked', () => {
    renderPanel(badMonth(1, 0)); // 4 names → open
    const blockers = screen.getByTestId('recon-blockers-2026-11');
    const line = within(blockers).getAllByTestId('recon-blocker').find((li) => li.textContent!.includes('"1011.2697"'))!;
    expect(line).toHaveTextContent('This looks like a number, not a product — fix the target file.');
    expect(within(line).queryByRole('button', { name: /^Accept 1011\.2697/ })).not.toBeInTheDocument();
    fireEvent.click(within(line).getByRole('checkbox', { name: /Override: 1011\.2697 \(Focus Brand 1\) really is a product/ }));
    expect(within(line).getByRole('button', { name: 'Accept 1011.2697 (Focus Brand 1) as not sold yet' })).toBeInTheDocument();
    // a real product name keeps its Accept straight away
    const real = within(blockers).getAllByTestId('recon-blocker').find((li) => li.textContent!.includes('"NEWBRAND"'))!;
    expect(within(real).getByRole('button', { name: 'Accept NEWBRAND (Focus Brand 1) as not sold yet' })).toBeInTheDocument();
    // the focus table chip gets the same treatment
    const chip = screen.getByTestId('focus-token-FB1-1011.2697');
    expect(chip).toHaveTextContent('This looks like a number, not a product');
    expect(within(chip).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('"Accept all N" — shows the list, needs a confirm tick, numbers left out unless overridden', () => {
  async function openBulk() {
    renderPanel(badMonth(3));
    fireEvent.click(screen.getByTestId('recon-unmatched-toggle-2026-11-FB1'));
    const btn = screen.getByTestId('recon-accept-all-2026-11-FB1');
    expect(btn).toHaveTextContent('Accept all 3 as not sold yet…');
    fireEvent.click(btn);
    expect(apiMock.acceptFocusTokens).not.toHaveBeenCalled(); // opening the list sends nothing
    return screen.getByTestId('recon-accept-all-confirm-2026-11-FB1');
  }

  it('lists exactly the 3 product names (not the numbers); Accept stays disabled until the tick; then ONE bulk call + refresh', async () => {
    apiMock.acceptFocusTokens.mockResolvedValue(ok({ month: '2026-11', acceptances: [], acceptedCount: 3 }));
    const box = await openBulk();
    const list = within(box).getByTestId('recon-accept-all-list-2026-11-FB1');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'NEWBRAND (2 outlets)', 'CNO GOLD (2 outlets)', 'ADHO 1L (2 outlets)',
    ]);
    expect(box).toHaveTextContent('3 names look like numbers, not products — they are left out. Fix the target file.');
    const go = within(box).getByTestId('recon-accept-all-go-2026-11-FB1');
    expect(go).toBeDisabled();
    fireEvent.click(within(box).getByRole('checkbox', { name: 'I checked these 3 names: they are products that have not sold yet' }));
    expect(go).toBeEnabled();
    await act(async () => { fireEvent.click(go); });
    expect(apiMock.acceptFocusTokens).toHaveBeenCalledTimes(1);
    expect(apiMock.acceptFocusTokens).toHaveBeenCalledWith('2026-11', { kpiCode: 'FB1', keys: ['NEWBRAND', 'CNOGOLD', 'ADHO1L'] });
    expect(apiMock.acceptFocusToken).not.toHaveBeenCalled();
  });

  it('the override adds the numeric names to the list and un-ticks the confirm (it must be re-confirmed)', async () => {
    apiMock.acceptFocusTokens.mockResolvedValue(ok({ month: '2026-11', acceptances: [], acceptedCount: 6 }));
    const box = await openBulk();
    fireEvent.click(within(box).getByRole('checkbox', { name: /I checked these 3 names/ }));
    fireEvent.click(within(box).getByRole('checkbox', { name: 'Override: also accept the 3 names that look like numbers' }));
    expect(within(box).getAllByRole('listitem')).toHaveLength(6);
    const go = within(box).getByTestId('recon-accept-all-go-2026-11-FB1');
    expect(go).toBeDisabled();
    fireEvent.click(within(box).getByRole('checkbox', { name: /I checked these 6 names/ }));
    await act(async () => { fireEvent.click(go); });
    expect(apiMock.acceptFocusTokens.mock.calls[0][1].keys).toHaveLength(6);
  });

  it('a refused bulk accept says none were accepted (never optimistic)', async () => {
    apiMock.acceptFocusTokens.mockResolvedValue({ success: false, error: '"ZZZ" is not a product name', status: 400 });
    const box = await openBulk();
    fireEvent.click(within(box).getByRole('checkbox', { name: /I checked these 3 names/ }));
    await act(async () => { fireEvent.click(within(box).getByTestId('recon-accept-all-go-2026-11-FB1')); });
    expect(await screen.findByTestId('recon-action-error'))
      .toHaveTextContent('None of the 3 names were accepted: "ZZZ" is not a product name. The preview has been reloaded.');
  });
});

describe('focus brand section: collapsed when large, count + status in the header', () => {
  it('more than 10 names → collapsed; header "Focus Brand 1 — 6 names not found (3 look like numbers)"', () => {
    renderPanel(badMonth(3, 12));
    const toggle = screen.getByTestId('focus-kpi-toggle-FB1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('focus-kpi-title-FB1').textContent).toBe('Focus Brand 1');
    expect(screen.getByTestId('focus-kpi-status-FB1')).toHaveTextContent('— 6 names not found (3 look like numbers)');
    expect(screen.queryByTestId('focus-table-FB1')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId('focus-table-FB1')).toBeInTheDocument();
  });

  it('status text when everything is fine', () => {
    const r = badMonth(0, 2);
    const k = { ...r.focus[0], names: r.focus[0].names.filter((n) => n.tokens.every((t) => t.status === 'MATCHED')) };
    expect(focusKpiStatusText(k)).toBe('all names found');
  });
});

// ── The import page: sticky bar at the top ───────────────────────────────────

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
    unmatchedQuantity: 0, monthState: 'OPEN', canApply: false, blockedReason: 'Focus product names need fixing', warnings: [],
    zeroFillOutlets: 1,
    kpis: [{ kpiCode: 'FB1', label: 'Focus Brand 1', measure: 'AMOUNT', newTotal: 1200, currentTotal: 0, delta: 1200, outletsNonZero: 3, outletsNegative: 0 }],
    lastApplied: null, reconciliation: badMonth(3), activeJob: null, lastJob: null, ...over,
  };
}
const preview = (months: MonthPreview[]): SalesImportPreview =>
  ({ importId: 'imp1', definitionsHash: 'h1', processingVersion: 7, mappingChanged: false, rosterOutletsAddedSinceProcessing: 0, rosterOutletsNotIncluded: 0, months });

describe('import page: summary + Apply in a sticky bar ABOVE the months', () => {
  it('the bar comes before the months table, says what is left per KPI, and Apply is disabled with the reason', async () => {
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month()])));
    render(<ImportPage />);
    const bar = await screen.findByTestId('sales-import-apply-bar');
    expect(bar.className).toMatch(/\bsticky\b/);
    const apply = within(bar).getByTestId('sales-import-apply');
    expect(apply).toBeDisabled();
    // the bar precedes the month row in the document
    const row = screen.getByTestId('month-row-2026-11');
    expect(bar.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bar).getByTestId('sales-import-problem-2026-11-FB1')).toHaveTextContent(
      'November 2026 · Focus Brand 1: 6 names not found — accept as not sold yet or fix the target file (3 look like numbers — fix the target file)',
    );
    expect(within(bar).getByTestId('sales-import-unavailable-months')).toHaveTextContent('November 2026');
  });

  it('a clean month: no problem list, a "tick the months" hint, Apply enabled once ticked', async () => {
    const clean: MonthReconciliation = { ...badMonth(0, 2), blockers: [] };
    clean.focus = [{ ...clean.focus[0], names: clean.focus[0].names.filter((n) => n.tokens.every((t) => t.status === 'MATCHED')) }];
    apiMock.get.mockResolvedValue(ok(detail()));
    apiMock.preview.mockResolvedValue(ok(preview([month({ canApply: true, blockedReason: undefined, reconciliation: clean })])));
    render(<ImportPage />);
    const bar = await screen.findByTestId('sales-import-apply-bar');
    expect(within(bar).queryByTestId('sales-import-problem-summary')).not.toBeInTheDocument();
    expect(within(bar).getByTestId('sales-import-problem-summary-none')).toHaveTextContent('No focus product problems in this file.');
    expect(within(bar).getByTestId('sales-import-apply-hint')).toHaveTextContent('Tick the months to apply in the table below.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Apply November 2026' }));
    await waitFor(() => expect(within(bar).getByTestId('sales-import-apply')).toBeEnabled());
    expect(within(bar).queryByTestId('sales-import-apply-hint')).not.toBeInTheDocument();
  });
});

describe('reconciliationProblems', () => {
  it('nothing blocking → []', () => expect(reconciliationProblems({ ...badMonth(0, 0), blockers: [] })).toEqual([]));
});
