/// <reference types="vitest/globals" />
/**
 * Points Engine — COMPUTE → PREVIEW → EXPORT / COMMIT screen.
 *  - PE-C1: running a preview renders the summary cards + an OK row + an ERROR row.
 *  - PE-C2: engineDisabled shows the amber "engine is disabled" banner.
 *  - PE-C3: the direct-credit block is hidden when the preview has no OK rows.
 *  - PE-C4: clicking "Credit in portal" calls commitCompute and renders the returned
 *           batchCode + the "review & confirm in Credits & Payouts" link.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ComputePage from '../page';
import {
  previewCompute,
  commitCompute,
  downloadExport,
  downloadPreviewReport,
} from '@/lib/points-engine/api';
import type { ComputePreview, ComputeCommitResult } from '@/lib/points-engine/types';

vi.mock('@/lib/points-engine/api', () => ({
  previewCompute: vi.fn(),
  commitCompute: vi.fn(),
  downloadExport: vi.fn(),
  downloadPreviewReport: vi.fn(),
}));

// next/link → a plain anchor so href is assertable.
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

const previewMock = previewCompute as unknown as ReturnType<typeof vi.fn>;
const commitMock = commitCompute as unknown as ReturnType<typeof vi.fn>;
const exportMock = downloadExport as unknown as ReturnType<typeof vi.fn>;
const reportMock = downloadPreviewReport as unknown as ReturnType<typeof vi.fn>;

function makePreview(over: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'deoleo',
    period: '2026-09',
    counts: { total: 2, ok: 1, skip: 0, error: 1, noRule: 0 },
    totalPoints: 1300,
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

beforeEach(() => {
  vi.clearAllMocks();
  previewMock.mockResolvedValue({ success: true, data: makePreview() });
  commitMock.mockResolvedValue({ success: true, data: COMMIT_RESULT });
  exportMock.mockResolvedValue(null);
  reportMock.mockResolvedValue(null);
});

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
});
