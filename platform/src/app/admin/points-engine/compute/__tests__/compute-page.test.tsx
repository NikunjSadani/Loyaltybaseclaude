/// <reference types="vitest/globals" />
/**
 * Points Engine — COMPUTE → PREVIEW → EXPORT / COMMIT screen.
 *  - PE-C1: running a preview renders the summary cards + an OK row + an ERROR row.
 *  - PE-C2: engineDisabled shows the amber "engine is disabled" banner.
 *  - PE-C3: the direct-credit block is hidden when the preview has no OK rows.
 *  - PE-C4: clicking "Credit in portal" calls commitCompute and renders the returned
 *           batchCode + the "review & confirm in Credits & Payouts" link.
 *  - PE-C11..C13: the Program + KPI filters are searchable dropdowns (options from
 *           outletPrograms + /api/admin/kpis); a selection drives the preview param; empty = no filter.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import ComputePage from '../page';
import {
  previewCompute,
  commitCompute,
  downloadExport,
  downloadPreviewReport,
  downloadPayoutReport,
} from '@/lib/points-engine/api';
import type { ComputePreview, ComputeCommitResult, ComputePreviewRow } from '@/lib/points-engine/types';

vi.mock('@/lib/points-engine/api', () => ({
  previewCompute: vi.fn(),
  commitCompute: vi.fn(),
  downloadExport: vi.fn(),
  downloadPreviewReport: vi.fn(),
  downloadPayoutReport: vi.fn(),
}));

// next/link → a plain anchor so href is assertable.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

// Program options come from the tenant's configured programs (same source as the rule builder).
vi.mock('@/lib/gifsy-settings', () => ({
  useGifsySettings: () => ({ outletPrograms: ['BSC', 'Unnati', 'SAMT'] }),
}));

const previewMock = previewCompute as unknown as ReturnType<typeof vi.fn>;
const commitMock = commitCompute as unknown as ReturnType<typeof vi.fn>;
const exportMock = downloadExport as unknown as ReturnType<typeof vi.fn>;
const reportMock = downloadPreviewReport as unknown as ReturnType<typeof vi.fn>;
const payoutReportMock = downloadPayoutReport as unknown as ReturnType<typeof vi.fn>;

function makePreview(over: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'deoleo',
    period: '2026-09',
    counts: { total: 2, ok: 1, skip: 0, error: 1, noRule: 0 },
    totalPoints: 1300,
    totalPayoutRupees: 0,
    engineDisabled: false,
    directCreditEnabled: true,
    sourceKey: 'deoleo|2026-09|cf_x|v7',
    ruleVersionsUsed: [{ ruleId: 'rule_cases_q3', version: 7 }],
    rows: [
      {
        outletCode: 'OUT-001',
        outletName: 'Alpha Store',
        kpiCode: 'CASES_SOLD',
        status: 'OK',
        points: 1300,
        achievement: 120,
        target: 100,
        explanation: 'Gate passed → slab 100%+ → milestone +1000',
      },
      {
        outletCode: 'OUT-002',
        outletName: 'Beta Store',
        kpiCode: 'CASES_SOLD',
        status: 'ERROR',
        reason: 'Missing target value',
      },
    ],
    ...over,
  };
}

const COMMIT_RESULT: ComputeCommitResult = {
  batchId: 'b1',
  batchCode: 'PEB-2026-09-001',
  status: 'PENDING_CONFIRM',
  period: '2026-09',
  totalPoints: 1300,
  totalOutlets: 1,
  counts: { total: 2, ok: 1, skip: 0, error: 1, noRule: 0 },
  sourceKey: 'deoleo|2026-09|cf_x|v7',
  idempotentHit: false,
  priorBatchesThisPeriod: 0,
};

// KPI options are fetched from GET /api/admin/kpis (same source as the rule builder); one disabled KPI
// is included to prove `enabled === false` codes are filtered out.
const KPI_RESPONSE = {
  success: true,
  data: [
    { code: 'CASES_SOLD', enabled: true },
    { code: 'LITRES_SOLD', enabled: true },
    { code: 'DISABLED_KPI', enabled: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  previewMock.mockResolvedValue({ success: true, data: makePreview() });
  commitMock.mockResolvedValue({ success: true, data: COMMIT_RESULT });
  exportMock.mockResolvedValue(null);
  reportMock.mockResolvedValue(null);
  payoutReportMock.mockResolvedValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        typeof url === 'string' && url.includes('/api/admin/kpis')
          ? KPI_RESPONSE
          : { success: true, data: [] },
    })) as unknown as typeof fetch,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A preview that mixes a POINTS OK row, a PAYOUT OK row, and (optionally) nothing else.
const PAYOUT_ROW: ComputePreviewRow = {
  outletCode: 'OUT-003',
  outletName: 'Gamma Store',
  kpiCode: 'CASES_SOLD',
  status: 'OK',
  awardType: 'PAYOUT',
  payoutRupees: 2500,
  achievement: 150,
  target: 100,
  explanation: 'Gate passed → slab 100%+ → ₹2,500',
};
const POINTS_ROW: ComputePreviewRow = {
  outletCode: 'OUT-001',
  outletName: 'Alpha Store',
  kpiCode: 'CASES_SOLD',
  status: 'OK',
  awardType: 'POINTS',
  points: 1300,
  achievement: 120,
  target: 100,
  explanation: 'Gate passed → slab 100%+ → milestone +1000',
};

async function runPreview() {
  fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
  await waitFor(() => expect(previewMock).toHaveBeenCalledTimes(1));
}

describe('Points Engine compute page', () => {
  it('PE-C1: a preview renders the summary cards + an OK row + an ERROR row', async () => {
    render(<ComputePage />);
    await runPreview();

    // Summary cards (labels).
    await waitFor(() => expect(screen.getByText('Total points')).toBeInTheDocument());
    expect(screen.getByText('No rule')).toBeInTheDocument();
    // 1,300 appears in both the Total-points card and the OK row's points cell — assert presence, not uniqueness.
    expect(screen.getAllByText('1,300').length).toBeGreaterThan(0);

    // OK row (table) + ERROR row (panel).
    expect(screen.getByTestId('group-OK')).toBeInTheDocument();
    expect(screen.getByText('OUT-001')).toBeInTheDocument();
    expect(screen.getByTestId('group-ERROR')).toBeInTheDocument();
    expect(screen.getByText('OUT-002')).toBeInTheDocument();
    expect(screen.getByText(/missing target value/i)).toBeInTheDocument();

    // Rule versions chip.
    expect(screen.getByText('rule_cases_q3@7')).toBeInTheDocument();
  });

  it('PE-C2: engineDisabled shows the amber banner', async () => {
    previewMock.mockResolvedValue({ success: true, data: makePreview({ engineDisabled: true }) });
    render(<ComputePage />);
    await runPreview();

    await waitFor(() => expect(screen.getByTestId('engine-disabled')).toBeInTheDocument());
    expect(screen.getByText(/points engine is disabled for this tenant/i)).toBeInTheDocument();
    // No direct-credit affordance when the engine is disabled.
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
  });

  it('PE-C3: the direct-credit block is hidden when there are no OK rows', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 1, ok: 0, skip: 0, error: 1, noRule: 0 },
        totalPoints: 0,
        rows: [
          {
            outletCode: 'OUT-002',
            outletName: 'Beta Store',
            kpiCode: 'CASES_SOLD',
            status: 'ERROR',
            reason: 'Missing target value',
          },
        ],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    await waitFor(() => expect(screen.getByTestId('group-ERROR')).toBeInTheDocument());
    // Export is still available, direct credit is not.
    expect(screen.getByRole('button', { name: /download credit-upload file/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
  });

  it('PE-C4: Credit in portal calls commitCompute and renders the batch + confirm link', async () => {
    render(<ComputePage />);
    await runPreview();

    const creditBtn = await screen.findByRole('button', { name: /credit in portal/i });
    fireEvent.click(creditBtn);

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    // TOCTOU: the previewed run's sourceKey is passed back as expectedKey so a stale run 409s.
    expect(commitMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: expect.any(String), expectedKey: 'deoleo|2026-09|cf_x|v7' }),
    );

    await waitFor(() => expect(screen.getByTestId('commit-result')).toBeInTheDocument());
    expect(screen.getByText('PEB-2026-09-001')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /review .* confirm this batch in credits/i });
    expect(link).toHaveAttribute('href', '/admin/credits-payouts/status');
  });

  it('PE-C5: a commit returning a 409 surfaces the "computation changed" message', async () => {
    commitMock.mockResolvedValue({
      success: false,
      status: 409,
      error: 'The computation changed since you last previewed it. Re-preview and review the new result.',
    });
    render(<ComputePage />);
    await runPreview();

    const creditBtn = await screen.findByRole('button', { name: /credit in portal/i });
    fireEvent.click(creditBtn);

    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/computation changed since you last previewed/i)).toBeInTheDocument();
    // No success batch panel on a rejected commit.
    expect(screen.queryByTestId('commit-result')).not.toBeInTheDocument();
  });

  it('PE-C6: the prior-batches warning counts ANY credit batch for the period', async () => {
    commitMock.mockResolvedValue({
      success: true,
      data: { ...COMMIT_RESULT, priorBatchesThisPeriod: 2 },
    });
    render(<ComputePage />);
    await runPreview();

    fireEvent.click(await screen.findByRole('button', { name: /credit in portal/i }));
    await waitFor(() => expect(screen.getByTestId('commit-result')).toBeInTheDocument());
    expect(screen.getByText(/already 2 credit batches for this period/i)).toBeInTheDocument();
  });

  it('PE-C7: engineDisabled OK-group footer omits the credit-upload file reference', async () => {
    // >25 OK rows so the "showing the first N" footer renders, with the engine disabled.
    const okRows = Array.from({ length: 30 }, (_, i) => ({
      outletCode: `OUT-${i}`,
      kpiCode: 'CASES_SOLD',
      status: 'OK' as const,
      points: 100,
      achievement: 10,
      target: 10,
      explanation: 'ok',
    }));
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        engineDisabled: true,
        counts: { total: 30, ok: 30, skip: 0, error: 0, noRule: 0 },
        rows: okRows,
      }),
    });
    render(<ComputePage />);
    await runPreview();

    await waitFor(() => expect(screen.getByTestId('group-OK')).toBeInTheDocument());
    const footer = screen.getByText(/showing the first/i);
    expect(footer.textContent).toMatch(/review report/i);
    expect(footer.textContent).not.toMatch(/credit-upload file/i);
  });

  it('PE-C8: a payout preview renders the "Total payout" card + the payout group with ₹ amounts', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 2, ok: 2, skip: 0, error: 0, noRule: 0 },
        totalPoints: 1300,
        totalPayoutRupees: 2500,
        rows: [POINTS_ROW, PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    // Total payout card. ₹2,500 shows in both the card and the payout row — assert presence, not uniqueness.
    await waitFor(() => expect(screen.getByText('Total payout')).toBeInTheDocument());
    expect(screen.getAllByText('₹2,500').length).toBeGreaterThan(0);

    // The payout group renders its rows with ₹ amounts.
    const payoutGroup = screen.getByTestId('group-PAYOUT');
    expect(payoutGroup).toBeInTheDocument();
    expect(screen.getByText('OUT-003')).toBeInTheDocument();
    expect(payoutGroup.textContent).toMatch(/to pay out/i);
  });

  it('PE-C9: Download payout report calls downloadPayoutReport with the applied filter', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        filter: { program: 'TRADE', kpiCode: 'CASES_SOLD' },
        counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 },
        totalPoints: 0,
        totalPayoutRupees: 2500,
        rows: [PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    const payoutBtn = await screen.findByRole('button', { name: /download payout report/i });
    fireEvent.click(payoutBtn);

    await waitFor(() => expect(payoutReportMock).toHaveBeenCalledTimes(1));
    expect(payoutReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ period: '2026-09' }),
    );
    expect(await screen.findByText(/payout report downloaded/i)).toBeInTheDocument();
  });

  it('PE-C10: a PAYOUT-only preview disables the credit-upload file + offers no in-portal credit', async () => {
    previewMock.mockResolvedValue({
      success: true,
      data: makePreview({
        counts: { total: 1, ok: 1, skip: 0, error: 0, noRule: 0 },
        totalPoints: 0,
        totalPayoutRupees: 2500,
        rows: [PAYOUT_ROW],
      }),
    });
    render(<ComputePage />);
    await runPreview();

    await waitFor(() => expect(screen.getByTestId('group-PAYOUT')).toBeInTheDocument());
    // No points rows → the credit-upload file is disabled and in-portal crediting is not offered.
    expect(screen.getByRole('button', { name: /download credit-upload file/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /credit in portal/i })).not.toBeInTheDocument();
    // The payout report is still available.
    expect(screen.getByRole('button', { name: /download payout report/i })).toBeInTheDocument();
  });

  it('PE-C11: the Program filter is a searchable dropdown listing the tenant\'s configured programs', async () => {
    render(<ComputePage />);
    // The free-text input is gone; the searchable combobox input is present.
    const programInput = screen.getByTestId('pe-program-input');
    expect(programInput).toHaveAttribute('role', 'combobox');

    // Open the list → the configured programs (from outletPrograms) are the options.
    fireEvent.click(programInput);
    expect(await screen.findByTestId('pe-program-option-Unnati')).toBeInTheDocument();
    expect(screen.getByTestId('pe-program-option-BSC')).toBeInTheDocument();
    expect(screen.getByTestId('pe-program-option-SAMT')).toBeInTheDocument();
  });

  it('PE-C12: the KPI filter dropdown lists the enabled codes from /api/admin/kpis and omits disabled ones', async () => {
    render(<ComputePage />);
    // Wait for the KPI fetch to populate options.
    const kpiInput = screen.getByTestId('pe-kpi-input');
    expect(kpiInput).toHaveAttribute('role', 'combobox');
    fireEvent.click(kpiInput);

    expect(await screen.findByTestId('pe-kpi-option-CASES_SOLD')).toBeInTheDocument();
    expect(screen.getByTestId('pe-kpi-option-LITRES_SOLD')).toBeInTheDocument();
    // enabled:false is filtered out (parity with the rule builder).
    expect(screen.queryByTestId('pe-kpi-option-DISABLED_KPI')).not.toBeInTheDocument();
  });

  it('PE-C13: selecting a Program + KPI drives the preview request params', async () => {
    render(<ComputePage />);

    // Pick a program from the dropdown.
    fireEvent.click(screen.getByTestId('pe-program-input'));
    fireEvent.mouseDown(await screen.findByTestId('pe-program-option-Unnati'));

    // Pick a KPI from the dropdown.
    fireEvent.click(screen.getByTestId('pe-kpi-input'));
    fireEvent.mouseDown(await screen.findByTestId('pe-kpi-option-LITRES_SOLD'));

    await runPreview();
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'Unnati', kpiCode: 'LITRES_SOLD' }),
    );
  });

  it('PE-C14: leaving both filters empty previews with no program/KPI filter (null)', async () => {
    render(<ComputePage />);
    await runPreview();
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: null, kpiCode: null }),
    );
  });
});
